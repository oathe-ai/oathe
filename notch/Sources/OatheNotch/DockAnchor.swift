// OatheNotch — where the island lives. A seat is a screen, an edge, and how far along it;
// it persists across launches and clears back to the hardware notch on demand.

import AppKit

enum DockEdge: String, Codable { case top, left, right }

/// A screen, an edge, and how far along it (0…1, from left / from top).
struct NotchAnchor: Codable {
    var displayID: CGDirectDisplayID
    var edge: DockEdge
    var fraction: CGFloat

    private static let key = "notchAnchor"

    static func load() -> NotchAnchor? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(NotchAnchor.self, from: data)
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) {
            UserDefaults.standard.set(data, forKey: NotchAnchor.key)
        }
    }

    /// The escape hatch: forget the seat and go home to the hardware notch.
    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}

extension NSScreen {
    var displayID: CGDirectDisplayID {
        (deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    }
}
