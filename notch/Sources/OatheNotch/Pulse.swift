// OatheNotch — the pulse (founder feature, 2026-08-31): the island announces an EVENT with
// one brief ring glow — a new claim (sage), a verdict or failure (the notice's own tone).
// ONE implementation: NotchModel.apply() decides WHEN (single source of truth — the frame),
// PulseDriver carries the tick, the `.pulse` modifier renders it. Content-only animation
// inside the static-max window — both motion scars are impossible here by construction.

import SwiftUI

final class PulseDriver: ObservableObject {
    @Published private(set) var tick = 0
    @Published private(set) var tone: NotchModel.Tone = .sage
    @Published private(set) var tinting = false    // the lock wears the event's tone briefly — color, not motion
    @Published private(set) var announcing = false // a VERDICT wings the island out with ✓/✗ (founder: the ring alone went unseen)

    /// `glyph: true` for accept/reject — the island wings out with the symbol for the tint
    /// window (the hover-peek geometry, reused). Everything else stays ring + tint only.
    func fire(_ tone: NotchModel.Tone, glyph: Bool = false) {
        self.tone = tone
        tick += 1
        tinting = true
        // Each event owns the WHOLE window: a ring-only claim landing inside a verdict's
        // two seconds must end the glyph, not inherit it — announcing carried over with
        // the new tone turned a claim into a lying ✓ (caught by the verifier reading
        // this very file).
        announcing = glyph
        let generation = tick
        DispatchQueue.main.asyncAfter(deadline: .now() + Motion.pulseTintSeconds) { [weak self] in
            guard let self, self.tick == generation else { return } // a newer event owns the window now
            // The release DRAINS (founder, 2026-08-31: the bare flip snapped the tone off).
            // Onset stays instant — the event lands NOW; only the goodbye is unhurried. The
            // transaction carries the tone; the wings settle on the view's own wing clock,
            // the same Motion.settle — one goodbye, everywhere.
            withAnimation(Motion.settle) {
                self.tinting = false
                self.announcing = false
            }
        }
    }
}

private struct PulseModifier: ViewModifier {
    @ObservedObject var driver: PulseDriver
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var glowing = false

    func body(content: Content) -> some View {
        content
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.radius, style: .continuous)
                    .strokeBorder(color.opacity(glowing ? 0.9 : 0), lineWidth: 1.5)
                    .scaleEffect(glowing ? 1.0 : 0.97)
                    .allowsHitTesting(false)
            )
            .onChange(of: driver.tick) {
                guard driver.tick > 0 else { return }
                if reduceMotion {
                    // A single opacity blink — presence without motion.
                    glowing = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + Motion.pulseSeconds) { glowing = false }
                    return
                }
                withAnimation(.easeOut(duration: Motion.pulseSeconds * 0.3)) { glowing = true }
                withAnimation(.easeIn(duration: Motion.pulseSeconds * 0.7).delay(Motion.pulseSeconds * 0.3)) {
                    glowing = false
                }
            }
    }

    private var color: Color { driver.tone == .amber ? Glass.amber : Glass.sage }
}

extension View {
    /// The island's event announcement — attach ONCE to the island chain.
    func pulse(_ driver: PulseDriver) -> some View {
        modifier(PulseModifier(driver: driver))
    }
}
