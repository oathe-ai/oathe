// OatheNotch — the glass. Three states, no brand accent: the only color is meaning
// (amber = needs you, sage = a receipt). Design tokens are named once here — they are a
// design system, not tunables; behavior tunables live in oathe's own config, environment
// facts are measured, never pinned.

import SwiftUI
import ServiceManagement


struct NotchView: View {
    @ObservedObject var model: NotchModel
    @ObservedObject var pulseDriver: PulseDriver // observed so the lock's tint re-renders
    @ObservedObject var welcome: WelcomeDriver   // observed so the tour's beats re-render
    let notchSize: CGSize
    let hardwareNotch: Bool
    let dockEdge: DockEdge
    let onIslandFrame: (CGRect) -> Void

    init(model: NotchModel, notchSize: CGSize, hardwareNotch: Bool, dockEdge: DockEdge,
         onIslandFrame: @escaping (CGRect) -> Void) {
        self.model = model
        self.pulseDriver = model.pulse
        self.welcome = model.welcome
        self.notchSize = notchSize
        self.hardwareNotch = hardwareNotch
        self.dockEdge = dockEdge
        self.onIslandFrame = onIslandFrame
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                if hardwareNotch, presentedOpen {
                    // The band the camera housing physically covers: nothing readable lives
                    // here — the glass wraps the hardware and speaks BELOW it, island-style.
                    Color.clear.frame(width: barWidth, height: notchSize.height)
                }
                bar
            }
            .background(Glass.ground)
            if welcome.active {
                surface(welcomeStage)
            } else if model.state == .open {
                surface(sheet)
            }
        }
        .clipShape(clip)
        .pulse(model.pulse) // the island announces events — one glow, tone from the frame
        .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { onIslandFrame($0) }
        .contextMenu { menu }
        .onHover { model.setHover($0) }
        .simultaneousGesture(
            DragGesture(minimumDistance: 4)
                .onChanged { model.onDragChanged?($0.translation) }
                .onEnded { _ in model.onDragEnded?() })
        // A side dock's resting sliver sits wing-inset from the window top so wing
        // deployment grows symmetrically — the pad animates opposite the height in the
        // same transaction, and the sliver's center never moves.
        .padding(.top, sideRestPad)
        // ORDER IS LOAD-BEARING: when both values change in one transaction, the INNER
        // .animation(value:) wins for the subtree. State inner, hover outer, so a mixed
        // beat (the welcome folding into its wings-out pose) rides the state clock whole,
        // while a lone wing flip rides the wing clock below. Swapping these re-blends the
        // clocks (caught live, 2026-08-31).
        .animation(stateAnimation, value: stateKey)
        // ONE wing clock, direction-aware: the ternary reads wingsOut at the instant it
        // changes, so flying OUT is snappy (hover, a verdict's glyph) and settling HOME is
        // the same unhurried drain for all three causes — hover leaving, a pulse ending,
        // the welcome folding (founder, 2026-08-31: the retract was abrupt, and the settle
        // is one concept, not three).
        .animation(reduceMotion ? nil : (wingsOut ? Motion.hover : Motion.settle), value: wingsOut)
        // The island floats inside the static-max window, pinned to its dock.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: dockAlignment)
    }

    /// Open geometry has two callers: the click (state) and the one-time welcome. The
    /// model honestly stays at .rest while the tour plays — geometry is presentation.
    private var presentedOpen: Bool {
        model.state == .open || welcome.active
    }

    /// The destination picks the curve: arriving somewhere expansive is springy, arriving
    /// at rest is smooth and quick — the island's own asymmetry (Theme.Motion). The
    /// welcome's own arrival is the same spring; its departure lands on the rest branch.
    private var stateAnimation: Animation? {
        guard !reduceMotion else { return nil }
        if welcome.active { return Motion.open }
        switch model.state {
        case .open: return Motion.open
        case .rest: return Motion.collapse
        }
    }

    // .animation(value:) needs Equatable; NotchState is, but derive one key so a state
    // change, an expansion change, and the welcome's phases all animate under the state clock.
    private var stateKey: String {
        "\(model.state)-\(model.expandedId ?? "")-\(welcome.active)"
    }

    private var dockAlignment: Alignment {
        switch dockEdge {
        case .top: .top
        case .left: .topLeading
        case .right: .topTrailing
        }
    }

    private var sideRestPad: CGFloat {
        verticalForm && !wingsOut ? Metrics.wing : 0
    }

    /// Corners round away from the docked edge — the island grows out of whatever it touches.
    private var clip: UnevenRoundedRectangle {
        let r = Metrics.radius
        switch dockEdge {
        case .top: return UnevenRoundedRectangle(bottomLeadingRadius: r, bottomTrailingRadius: r)
        case .left: return UnevenRoundedRectangle(bottomTrailingRadius: r, topTrailingRadius: r)
        case .right: return UnevenRoundedRectangle(topLeadingRadius: r, bottomLeadingRadius: r)
        }
    }

    /// The expanded surface: Liquid Glass where the OS has it (founder's call), the island's
    /// own black where it doesn't. ONE wrapper — the entries sheet and the welcome stage
    /// both land on it.
    @ViewBuilder private func surface<Content: View>(_ content: Content) -> some View {
        Group {
            if #available(macOS 26.0, *) {
                content.glassEffect(.regular, in: clip)
            } else {
                content.background(Glass.ground)
            }
        }
        .transition(.opacity) // rows arrive WITH the sheet, as one — the container does the stretching
    }

    /// A side dock stays vertical through rest AND event — a tinted lock says enough, and
    /// hover must never change geometry (a frame that flees the pointer oscillates — live,
    /// 2026-08-30). The horizontal line and sheet come out on CLICK, as the open state —
    /// and for the one-time welcome, which plays in the same open form.
    private var verticalForm: Bool {
        dockEdge != .top && !presentedOpen
    }

    /// The lock's color IS the channel (founder ruling 2026-08-31): a fresh event wears
    /// its tone for a breath (the pulse's tint), a standing condition (breaches, a broken
    /// feed) wears quiet amber, and all-well is muted. Color, never text.
    private var lockColor: Color {
        if pulseDriver.tinting { return pulseDriver.tone == .sage ? Glass.sage : Glass.amber }
        return model.standingTone == .amber ? Glass.amber : Glass.muted
    }

    /// The island's peek/announce window: hover slides the wings out, and so does a
    /// VERDICT — for two seconds the leading wing carries ✓ (sage) or ✗ (amber) instead
    /// of the lock. One geometry (the hover peek's own), one symbol, zero words. The
    /// welcome's closing pose holds the same wings: the rest anatomy, shown once.
    private var wingsOut: Bool { model.hoverArmed || pulseDriver.announcing || welcome.holdingWings }

    /// The leading glyph: the verdict symbol while announcing, the lock otherwise.
    private var statusGlyph: some View {
        Image(systemName: pulseDriver.announcing
            ? (pulseDriver.tone == .sage ? "checkmark" : "xmark")
            : "lock.fill")
            .font(.system(size: 11, weight: pulseDriver.announcing ? .bold : .regular))
            .foregroundStyle(lockColor)
            .contentTransition(.symbolEffect(.replace))
    }

    private var bar: some View {
        Group {
            if verticalForm {
                // Side dock: the island lies along the edge — glyph above, count below.
                VStack(spacing: 0) {
                    statusGlyph
                        .frame(height: Metrics.wing)
                    Color.clear.frame(height: notchSize.height)
                    Text("\(model.mineCount)")
                        .font(rounded(12, .semibold))
                        .foregroundStyle(Glass.ink)
                        .frame(height: Metrics.wing)
                }
            } else {
                // The HIG compact presentation: two essential elements flanking the
                // housing — the status glyph leading, how much you hold trailing. Always
                // laid out; the animated width slides them out on hover AND on a verdict.
                HStack(spacing: 0) {
                    statusGlyph
                        .frame(width: Metrics.wing)
                    Color.clear.frame(width: notchSize.width)
                    Text("\(model.mineCount)")
                        .font(rounded(12, .semibold))
                        .foregroundStyle(Glass.ink)
                        .frame(width: Metrics.wing)
                }
            }
        }
        .frame(width: barWidth, height: barHeight)
        .contentShape(Rectangle())
        .onTapGesture { model.tap() }
    }

    /// ONE list, one anatomy: every entry is name · state · age (+ the act that can change
    /// its truth); a tap expands its WHY. A short list hugs; a long one SCROLLS inside the
    /// fixed window (ViewThatFits) — never a wall, never a pointer at the CLI.
    private var sheet: some View {
        ViewThatFits(in: .vertical) {
            sheetList
            ScrollView(showsIndicators: false) { sheetList }
                .frame(height: Metrics.sheetMax)
        }
        .frame(width: barWidth)
    }

    /// The welcome's stage: one line at a time, centered, on a fixed-height floor (swaps
    /// never bounce the container), each revealed left-to-right; under Reduce Motion,
    /// every line at once.
    @ViewBuilder private var welcomeStage: some View {
        Group {
            if welcome.showAll {
                VStack(alignment: .center, spacing: 6) {
                    ForEach(welcome.lines, id: \.self) { line in
                        Text(line)
                            .font(rounded(12, .medium))
                            .foregroundStyle(Glass.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, 12)
            } else {
                ZStack {
                    Color.clear
                    if let index = welcome.lineIndex {
                        WelcomeLine(text: welcome.lines[index])
                            .id(index) // a fresh view per line — the swap crossfades, the reveal restarts
                            .transition(.opacity)
                    }
                }
                .frame(height: Metrics.welcomeSheetHeight)
                .animation(reduceMotion ? nil : Motion.textSwap, value: welcome.lineIndex)
            }
        }
        .padding(.horizontal, 16)
        .frame(width: barWidth)
    }

    private var sheetList: some View {
        VStack(alignment: .leading, spacing: 0) {
            // A broken feed is a standing condition: the lock wears amber, and the WORDS
            // live here — the typed line, verbatim, until it heals.
            if let failure = model.failure {
                Text(failure)
                    .font(rounded(10.5, .medium))
                    .foregroundStyle(Glass.amber)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16).padding(.top, 9).padding(.bottom, 7)
                Divider().overlay(Glass.hairline).padding(.horizontal, 10)
            }
            // The most recent event's words live HERE, not on the bar (the bar only pulsed
            // its tone): open the sheet and read what happened, then the rows carry details.
            if let notice = model.lastNotice {
                Text(notice.text)
                    .font(rounded(10.5, .medium))
                    .foregroundStyle(notice.tone == "amber" ? Glass.amber : Glass.sage)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16).padding(.top, 9).padding(.bottom, 7)
                if !model.entries.isEmpty {
                    Divider().overlay(Glass.hairline).padding(.horizontal, 10)
                }
            }
            ForEach(Array(model.entries.enumerated()), id: \.element.id) { index, entry in
                row(for: entry)
                    .padding(.horizontal, 16).padding(.vertical, 7)
                    .contentShape(Rectangle())
                    .onTapGesture { model.toggle(entry.id) }
                if model.expandedId == entry.id {
                    detail(for: entry)
                }
                if index < model.entries.count - 1 {
                    Divider().overlay(Glass.hairline).padding(.horizontal, 10)
                }
            }
        }
        .padding(.bottom, 10)
    }

    @ViewBuilder private func row(for entry: SheetEntry) -> some View {
        switch entry {
        case .breach(let breach):
            rowLine(title: breach.task_id, tone: Glass.amber,
                    meta: "\(kindWord(breach.kind)) · \(NotchModel.age(from: breach.at))",
                    actFor: breach.act?.kind == "spawn-terminal" ? breach.task_id : nil,
                    actWord: actWord(breach)) { model.breachAct(breach) }
        case .work(let row):
            rowLine(title: row.id, tone: row.amber ? Glass.amber : Glass.ink,
                    meta: "\(row.holder) · \(row.age)", actFor: nil, actWord: "") {}
        }
    }

    private func rowLine(title: String, tone: Color, meta: String,
                         actFor: String?, actWord: String, act: @escaping () -> Void) -> some View {
        HStack(spacing: 10) {
            Text(title).font(rounded(12)).foregroundStyle(tone).lineLimit(1)
            Spacer(minLength: 12)
            Text(meta).font(rounded(10.5)).foregroundStyle(Glass.muted)
            if let id = actFor {
                Button(model.flashTask == id ? model.flashWord : actWord, action: act)
                    .buttonStyle(.plain)
                    .font(rounded(10.5, .medium))
                    .foregroundStyle(model.flashTask == id ? Glass.sage : Glass.ink)
            }
        }
    }

    @ViewBuilder private func detail(for entry: SheetEntry) -> some View {
        switch entry {
        case .breach(let breach):
            // The WHY, whole — the verdict's or failure's own words from the frame,
            // rendered verbatim (composed package-side; the glass never clips data).
            Text(breach.detail)
                .font(rounded(10.5)).foregroundStyle(Glass.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 16).padding(.trailing, 16).padding(.bottom, 8)
        case .work(let row):
            VStack(alignment: .leading, spacing: 5) {
                if let progress = row.progress {
                    Text(progress).font(rounded(10.5)).foregroundStyle(Glass.muted).lineLimit(3)
                }
                HStack(spacing: 10) {
                    Text(tilde(row.homePath))
                        .font(rounded(10)).foregroundStyle(Glass.muted).lineLimit(1)
                    Spacer(minLength: 12)
                    Button(model.flashTask == row.id ? model.flashWord : "continue ↗") {
                        model.continueAct(row)
                    }
                    .buttonStyle(.plain)
                    .font(rounded(10.5, .medium))
                    .foregroundStyle(model.flashTask == row.id ? Glass.sage : Glass.ink)
                }
            }
            .padding(.leading, 16).padding(.trailing, 16).padding(.bottom, 8)
        }
    }

    @ViewBuilder private var menu: some View {
        if Bundle.main.bundleIdentifier != nil, Bundle.main.bundlePath.hasSuffix(".app") {
            Button(SMAppService.mainApp.status == .enabled ? "Start at Login ✓" : "Start at Login") {
                let service = SMAppService.mainApp
                do {
                    if service.status == .enabled { try service.unregister() } else { try service.register() }
                } catch {
                    NSLog("oathe-notch: login item \(error.localizedDescription)")
                }
            }
        }
        Button("Reset Position") { model.onResetSeat?() }
        Button("Quit Oathe Notch") { NSApp.terminate(nil) }
    }

    // Plain kind words + the one act that can change each truth (ruling 2026-08-31):
    // never-judged → verify; engine-died → retry; judged-rejected → continue into the work.
    private func kindWord(_ kind: String) -> String {
        switch kind {
        case "overdue": "never verified"
        case "reopened": "rejected"
        case "stalled": "verify failed"
        case "quiet": "quiet"
        default: kind
        }
    }

    private func actWord(_ breach: Breach) -> String {
        switch breach.kind {
        case "overdue": "verify ↗"
        case "stalled": "retry ↗"
        default: "continue ↗"
        }
    }

    private func tilde(_ path: String?) -> String {
        guard let path else { return "" }
        return path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
    }

    private var barWidth: CGFloat {
        if verticalForm { return notchSize.width }
        // Open (by click or the welcome): the band matches the sheet below — the compact
        // trio stays put.
        if presentedOpen { return Metrics.openWidth }
        // At rest on a top dock: hover, a verdict, or the welcome's closing pose slides
        // the wings out sideways.
        return notchSize.width + (wingsOut ? Metrics.wing * 2 : 0)
    }

    private var barHeight: CGFloat {
        if verticalForm {
            // A side dock's wings slide out along its own axis — vertically.
            return notchSize.height + (wingsOut ? Metrics.wing * 2 : 0)
        }
        if !presentedOpen { return notchSize.height }
        // Open: the housing band (hardware) is drawn separately above; the bar is the
        // compact trio's own height.
        return Metrics.barHeight
    }
}
