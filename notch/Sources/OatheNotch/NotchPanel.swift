// OatheNotch — the window: seat, pointer arming, drag + snap. THE FRAME OWNER, and the
// architecture that keeps motion safe: the panel is sized ONCE per seat to the largest
// state it can ever need and never resizes between states — every transition is pure
// SwiftUI inside a constant window. Both scars (see README) die by construction.
//
// INVARIANT (enforce in review): setFrame/setFrameOrigin appear in exactly three places —
// init (the unanimated seat), drag() (pointer tracking), endDrag() (ONE guarded animated
// one-shot). Nothing reachable from model.onChange touches the frame.
//
// Click-through: a hitTest override cannot forward clicks to other apps (the window server
// routes before we see the event) — so the rule is: the panel ignores mouse events unless
// the pointer is over the visible island. The view reports its island rect; the global
// mouse monitor arms; SwiftUI hover-exit disarms. Fails OPEN: uncertainty leaves the
// panel ignoring — one extra pointer-move to arm, never a swallowed click.

import AppKit
import SwiftUI

final class NotchPanelController {
    let panel: NSPanel
    let model: NotchModel
    let screen: NSScreen
    let anchor: NotchAnchor
    let notchSize: CGSize
    let hardwareSeat: Bool // parked over the actual camera housing
    private var hosting: NSHostingView<NotchView>! // set last in init — its view closure captures self
    private var monitor: Any?
    private var islandFrame: CGRect = .zero // the visible island, in window coords (view-reported)
    private var dragStart: (mouse: NSPoint, origin: NSPoint)?
    private var snapping = false

    init(model: NotchModel, anchor saved: NotchAnchor?) {
        self.model = model
        // The saved seat's screen, else the notched display, else the main one.
        let fallback = NSScreen.screens.first { $0.safeAreaInsets.top > 0 } ?? NSScreen.main ?? NSScreen.screens[0]
        if let saved, let match = NSScreen.screens.first(where: { $0.displayID == saved.displayID }) {
            screen = match
            anchor = saved
        } else {
            screen = fallback
            anchor = NotchAnchor(displayID: fallback.displayID, edge: .top, fraction: 0.5)
        }
        (notchSize, hardwareSeat) = Self.islandSize(on: screen, edge: anchor.edge, fraction: anchor.fraction)
        panel = NSPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.isMovable = false // we move it ourselves, with a snap at the end
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        hosting = NSHostingView(rootView: NotchView(
            model: model, notchSize: notchSize, hardwareNotch: hardwareSeat, dockEdge: anchor.edge,
            onIslandFrame: { [weak self] rect in self?.islandFrame = rect }))
        panel.contentView = hosting
        // One global monitor, two duties: pointer moves arm/disarm the island; a click that
        // lands ANYWHERE ELSE while the sheet is open closes it (own-island clicks never
        // reach a global monitor, so this cannot misfire on the sheet itself).
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDown, .rightMouseDown]) { [weak self] event in
            guard let self else { return }
            if event.type == .mouseMoved {
                self.trackPointer()
            } else if self.model.state != .rest || self.model.presentingWelcome,
                      !self.islandScreenRect.contains(NSEvent.mouseLocation) {
                self.model.dismiss() // one gesture, one meaning: sheet closes, notice acknowledges, welcome skips
            }
        }
        model.onDragChanged = { [weak self] translation in self?.drag(translation) }
        model.onDragEnded = { [weak self] in self?.endDrag() }
        panel.setFrame(seatFrame(), display: true) // the ONE unanimated seat
        panel.ignoresMouseEvents = true
        panel.orderFrontRegardless()
    }

    deinit {
        if let monitor { NSEvent.removeMonitor(monitor) }
        panel.orderOut(nil)
    }

    /// The island's geometry for a seat: hardware mimesis over the housing, a menubar-height
    /// pill on a notchless top, a vertical sliver along a side. ONE implementation — init
    /// and the drag-snap target both ask here.
    static func islandSize(on screen: NSScreen, edge: DockEdge, fraction: CGFloat) -> (CGSize, Bool) {
        let inset = screen.safeAreaInsets.top
        if edge == .top, inset > 0, abs(fraction - 0.5) < 0.06,
           let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            return (CGSize(width: screen.frame.width - left.width - right.width, height: inset), true)
        }
        if edge == .top {
            let menubar = max(screen.frame.maxY - screen.visibleFrame.maxY, 24)
            return (CGSize(width: Metrics.notchlessWidth, height: menubar), false)
        }
        return (CGSize(width: Metrics.sliverHeight, height: Metrics.notchlessWidth), false)
    }

    /// The static-max frame for this seat — set once; overhang past screen edges is fine
    /// (only the island must stay on-screen; the fraction clamps guarantee that).
    private func seatFrame() -> NSRect {
        let f = screen.frame
        let size: NSSize
        switch anchor.edge {
        case .top:
            size = NSSize(width: max(Metrics.openWidth, notchSize.width + Metrics.wing * 2),
                          height: notchSize.height + Metrics.barHeight + Metrics.sheetMax)
            return NSRect(x: f.minX + anchor.fraction * f.width - size.width / 2,
                          y: f.maxY - size.height, width: size.width, height: size.height)
        case .left, .right:
            size = NSSize(width: Metrics.openWidth,
                          height: max(notchSize.height + Metrics.wing * 2, Metrics.barHeight + Metrics.sheetMax))
            let pillTop = f.maxY - anchor.fraction * f.height
            return NSRect(x: anchor.edge == .left ? f.minX : f.maxX - size.width,
                          y: pillTop - size.height, width: size.width, height: size.height)
        }
    }

    /// State changes touch the MOUSE POLICY only — the frame never moves here (scar 1).
    func refresh() {
        guard dragStart == nil, !snapping else { return }
        updateMouse()
    }

    private var islandScreenRect: NSRect {
        NSRect(x: panel.frame.minX + islandFrame.minX,
               y: panel.frame.maxY - islandFrame.maxY, // un-flip SwiftUI's global space
               width: islandFrame.width, height: islandFrame.height)
    }

    private func trackPointer() {
        var arm = islandScreenRect
        if model.state == .rest {
            // The resting arming zone includes where the wings will deploy.
            arm = anchor.edge == .top
                ? arm.insetBy(dx: -Metrics.wing, dy: 0)
                : arm.insetBy(dx: 0, dy: -Metrics.wing)
        }
        model.setHover(arm.contains(NSEvent.mouseLocation)) // self-guards on change
        updateMouse()
    }

    private func updateMouse() {
        panel.ignoresMouseEvents = !(model.hoverArmed || dragStart != nil)
    }

    // ------------------------------------------------------------------ moving the island

    private func drag(_ translation: CGSize) {
        guard !snapping else { return }
        // The gesture's translation is view-relative and the view MOVES with the window —
        // a feedback loop that jitters. Global mouse coordinates are the stable frame of
        // reference; the window tracks the pointer 1:1.
        let mouse = NSEvent.mouseLocation
        if dragStart == nil {
            dragStart = (mouse, panel.frame.origin)
            updateMouse()
        }
        guard let start = dragStart else { return }
        panel.setFrameOrigin(NSPoint(x: start.origin.x + (mouse.x - start.mouse.x),
                                     y: start.origin.y + (mouse.y - start.mouse.y)))
    }

    private func endDrag() {
        guard dragStart != nil, !snapping else { return }
        dragStart = nil
        // Elect the seat from the ISLAND's center (the window's center is far below the pill).
        let island = islandScreenRect
        let center = NSPoint(x: island.midX, y: island.midY)
        let landed = NSScreen.screens.first { $0.frame.contains(center) } ?? screen
        let f = landed.frame
        let dTop = f.maxY - center.y
        let dLeft = center.x - f.minX
        let dRight = f.maxX - center.x
        var next = NotchAnchor(displayID: landed.displayID, edge: .top, fraction: 0.5)
        if dTop <= dLeft, dTop <= dRight {
            next.edge = .top
            // Clamp so the open sheet always fits on-screen; then the housing magnet.
            let halfOpen = Metrics.openWidth / 2
            next.fraction = min(max((center.x - f.minX) / f.width, halfOpen / f.width), 1 - halfOpen / f.width)
            if landed.safeAreaInsets.top > 0, abs(next.fraction - 0.5) < 0.08 { next.fraction = 0.5 }
        } else {
            next.edge = dLeft < dRight ? .left : .right
            let reach = (Metrics.barHeight + Metrics.sheetMax) / f.height
            next.fraction = min(max((f.maxY - center.y) / f.height, 0), 1 - reach)
        }
        next.save()
        // The ONE animated frame move: a guarded, user-initiated one-shot. The old
        // orientation glides to the seat; the rebuild lands the new one.
        let (targetSize, _) = Self.islandSize(on: landed, edge: next.edge, fraction: next.fraction)
        let target = Self.restIslandCenter(on: landed, edge: next.edge, fraction: next.fraction, size: targetSize)
        let delta = NSPoint(x: target.x - island.midX, y: target.y - island.midY)
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            model.onReseat?()
            return
        }
        snapping = true
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = Motion.snapSeconds
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().setFrameOrigin(NSPoint(x: panel.frame.origin.x + delta.x,
                                                    y: panel.frame.origin.y + delta.y))
        }, completionHandler: { [weak self] in
            self?.snapping = false
            self?.model.onReseat?()
        })
    }

    private static func restIslandCenter(on screen: NSScreen, edge: DockEdge, fraction: CGFloat, size: CGSize) -> NSPoint {
        let f = screen.frame
        switch edge {
        case .top:
            return NSPoint(x: f.minX + fraction * f.width, y: f.maxY - size.height / 2)
        case .left:
            return NSPoint(x: f.minX + size.width / 2, y: f.maxY - fraction * f.height - size.height / 2)
        case .right:
            return NSPoint(x: f.maxX - size.width / 2, y: f.maxY - fraction * f.height - size.height / 2)
        }
    }
}
