// OatheNotch — the one-time welcome (founder feature, 2026-08-31): the first frame after
// `oathe init` CREATES the database carries `welcome.lines` (Node owns the copy —
// src/welcome.mjs; the glass only plays it). The island opens, speaks the lines one at a
// time with a left-to-right fade, then collapses to the rest lock with the wings held out —
// the anatomy tour, once. ONE implementation of timed sequencing: PulseDriver's generation
// token (a later play() or skip() owns the whole window; stale beats bail). Content-only
// animation inside the static-max window — both motion scars impossible here by construction.

import AppKit
import SwiftUI

final class WelcomeDriver: ObservableObject {
    @Published private(set) var active = false       // open geometry, welcome content
    @Published private(set) var lineIndex: Int?      // which line speaks; nil while the sheet lands
    @Published private(set) var holdingWings = false // the closing pose: rest lock, wings out
    @Published private(set) var showAll = false      // Reduce Motion: every line at once, no sweep
    private(set) var lines: [String] = []
    private var generation = 0

    var onChange: (() -> Void)?

    func play(_ lines: [String]) {
        guard !lines.isEmpty else { return }
        self.lines = lines
        generation += 1
        let g = generation
        lineIndex = nil
        holdingWings = false
        active = true
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            showAll = true
            onChange?()
            schedule(Motion.welcomeShowAllSeconds, g) { self.close(g, wingHold: false) }
            return
        }
        showAll = false
        onChange?()
        var t = Motion.welcomeOpenSeconds
        for i in lines.indices {
            schedule(t, g) {
                self.lineIndex = i
                self.onChange?()
            }
            let hold = i == lines.count - 1 ? Motion.welcomeLastHoldSeconds : Motion.welcomeLineHoldSeconds
            t += Motion.welcomeSwapSeconds + Motion.welcomeRevealSeconds + hold
        }
        schedule(t, g) { self.close(g, wingHold: true) }
    }

    /// A click during the welcome skips straight to rest — the tour never traps a pointer.
    func skip() {
        guard active || holdingWings else { return }
        generation += 1
        active = false
        holdingWings = false
        lineIndex = nil
        showAll = false
        onChange?()
    }

    private func close(_ g: Int, wingHold: Bool) {
        active = false
        lineIndex = nil
        showAll = false
        // ONE beat into the pose (founder feedback 2026-08-31, round 2): the sheet folds
        // DIRECTLY into the wings-out rest — lock and count visible the whole way, never
        // a bare-notch stop between. The view's animation order decides the clocks: the
        // state clock carries this mixed beat, the hover clock carries the lone retraction.
        holdingWings = wingHold
        onChange?()
        guard wingHold else { return }
        schedule(Motion.welcomeWingHoldSeconds, g) {
            self.holdingWings = false // wings alone — the hover peek's own retraction
            self.onChange?()
        }
    }

    private func schedule(_ delay: TimeInterval, _ g: Int, _ beat: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.generation == g else { return } // a newer play/skip owns the window
            beat()
        }
    }
}

/// One welcome line, revealed left-to-right: a soft gradient mask sweeps across — a fade,
/// not a wipe. Fresh @State per line (the .id swap) so a reveal can never run backward.
struct WelcomeLine: View {
    let text: String
    @State private var progress: CGFloat = 0

    var body: some View {
        Text(text)
            .font(rounded(12, .medium))
            .foregroundStyle(Glass.ink)
            .fixedSize(horizontal: false, vertical: true)
            .mask(RevealGradient(progress: progress))
            .onAppear {
                withAnimation(Motion.welcomeReveal) { progress = 1 }
            }
    }
}

/// The sweep itself — Animatable so the transaction interpolates the stop locations
/// frame-by-frame (a plain @State jump would snap, not sweep).
private struct RevealGradient: View, Animatable {
    var progress: CGFloat

    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }

    var body: some View {
        // A 0.2-wide soft edge riding ahead of the solid fill: at 0 everything is clear,
        // at 1 everything is ink — the locations stay monotonic the whole way.
        LinearGradient(stops: [
            .init(color: .white, location: 0),
            .init(color: .white, location: max(progress * 1.2 - 0.2, 0)),
            .init(color: .clear, location: min(progress * 1.2, 1.0)),
        ], startPoint: .leading, endPoint: .trailing)
    }
}
