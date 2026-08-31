// OatheNotch — every token, named once. The taxonomy (house rule: never hardcode):
//
//   DESIGN TOKENS   live HERE — colors, sizes, radii, springs. A design system is a set of
//                   named constants; changing the design means changing this file.
//   BEHAVIOR        lives in oathe's own config (`oathe config <key> --global`):
//   TUNABLES        notchApp, notchMotionMinutes, notchHeartbeatSeconds. Swift reads the
//                   feed; it never decides meaning.
//   ENVIRONMENT     is MEASURED, never pinned: the hardware notch from the screen, the
//   FACTS           menubar from frame vs visibleFrame, the oathe bin from PATH.

import SwiftUI

enum Glass {
    static let ground = Color(red: 0.039, green: 0.043, blue: 0.047) // #0a0b0c — founder's pick over pure black
    static let ink = Color(red: 0.949, green: 0.945, blue: 0.929)    // #f2f1ed
    static let muted = Color(red: 0.522, green: 0.529, blue: 0.541)  // #85878a
    static let amber = Color(red: 0.851, green: 0.627, blue: 0.329)  // #d9a054 — needs you
    static let sage = Color(red: 0.498, green: 0.733, blue: 0.596)   // #7fbb98 — a receipt
    static let hairline = Color.white.opacity(0.09)
}

enum Metrics {
    static let openWidth: CGFloat = 372
    static let barHeight: CGFloat = 36
    static let radius: CGFloat = 14
    static let rowCap = 8
    static let notchlessWidth: CGFloat = 180 // no hardware fact exists to derive a sliver from
    static let sliverHeight: CGFloat = 26 // the island's thickness when docked away from a menubar
    static let wing: CGFloat = 44 // one compact element beside the housing (HIG compact presentation)
    static let sheetMax: CGFloat = 372 // open-sheet height budget: 8 rows + detail + overflow + padding
    static let welcomeSheetHeight: CGFloat = 64 // a fixed stage — line swaps never bounce the container
}

/// The motion table (founder tuning 2026-08-30: "more alive" — real bounce on expand,
/// springy hover, collapse quick and flat; everything ≤0.5s; Reduce Motion → instant).
/// The two scars every contributor must know:
///   1. THE FREEZE — never animate window frames from state changes; overlapping
///      animator groups wedge the panel. Content animates; the window holds still.
///   2. THE OSCILLATION — hover must never change window geometry; a frame that flees
///      the pointer flickers forever.
enum Motion {
    static let open = Animation.spring(duration: 0.45, bounce: 0.25)   // the stretch — springiest
    static let event = Animation.spring(duration: 0.40, bounce: 0.20)  // a line arriving
    static let collapse = Animation.smooth(duration: 0.30)             // exits never linger
    static let hover = Animation.snappy(duration: 0.35, extraBounce: 0.1)
    static let textSwap = Animation.easeInOut(duration: 0.22)
    static let detail = Animation.smooth(duration: 0.25)
    static let snapSeconds = 0.25 // the ONE window-frame animation: the drag-release snap
    static let pulseSeconds = 0.5     // the island's event glow — one breath, never a beacon
    static let pulseTintSeconds = 2.0 // the lock wears the event's tone this long — color, not motion
    static let settle = Animation.smooth(duration: 0.7) // wings and tone come HOME on this — hover leaving, a pulse ending, the welcome folding: every goodbye is the same unhurried settle (founder, 2026-08-31)

    // The one-time welcome (founder feature 2026-08-31) — every beat named here.
    static let welcomeReveal = Animation.easeOut(duration: welcomeRevealSeconds)
    static let welcomeOpenSeconds = 0.5      // the sheet lands before the first word
    static let welcomeRevealSeconds = 0.8    // one line's left-to-right fade
    static let welcomeSwapSeconds = 0.22     // textSwap's own clock, named for the beat math
    static let welcomeLineHoldSeconds = 1.2  // a line stands long enough to read
    static let welcomeLastHoldSeconds = 1.6  // the send-off lingers a touch longer
    static let welcomeWingHoldSeconds = 2.0  // the closing pose: rest lock, wings out
    static let welcomeShowAllSeconds = 4.0   // Reduce Motion: every line at once, then rest
}

func rounded(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    .system(size: size, weight: weight, design: .rounded) // SF Pro Rounded, natively
}
