// OatheNotch — the bootstrap. No dock icon, no status item: this is not an app you visit.
// launchd owns the process (oathe init writes the LaunchAgent); the app owns its feed
// child; the model owns state; the panel owns the window.

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = NotchModel()
    let feed: FeedClient = OatheFeed()
    var controller: NotchPanelController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        seat()
        model.onChange = { [weak self] in self?.controller?.refresh() }
        model.onReseat = { [weak self] in self?.seat() }
        model.onResetSeat = { [weak self] in
            NotchAnchor.clear()
            self?.seat()
        }
        feed.onFrame = { [weak self] frame in self?.model.apply(frame) }
        feed.onFailure = { [weak self] line in self?.model.fail(line) }
        feed.start()
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil, queue: .main) { [weak self] _ in self?.seat()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        feed.stop()
    }

    private func seat() {
        controller = NotchPanelController(model: model, anchor: NotchAnchor.load())
        NSLog("oathe-notch: seated on \(controller!.screen.localizedName) \(controller!.anchor.edge.rawValue), notch \(controller!.notchSize)")
    }
}

@main
enum OatheNotchApp {
    /// ONE notch per INSTALL: two instances of the same install (a launchd copy plus a
    /// hand-opened one) stack panels on the same rect and neither renders sanely. The
    /// NEWEST instance wins — it terminates elders and takes the rect; newest-wins is the
    /// only direction that composes with KeepAlive (elder-wins makes every restart exit and
    /// churn). Kinship is the INSTALL ROOT — the `<home>/.oathe/notch/` ancestor of the
    /// executable — never the bare process name: a name-wide supersede killed the
    /// founder's live notch every time the test suite bootstrapped a sandbox-home app
    /// (2026-08-31, the same lesson as the per-home launchd label).
    static func installRoot(of url: URL?) -> String? {
        guard let path = url?.resolvingSymlinksInPath().path else { return nil }
        guard let range = path.range(of: "/.oathe/notch/") else { return nil }
        return String(path[..<range.upperBound])
    }

    static func supersedeElders() {
        let me = ProcessInfo.processInfo.processIdentifier
        guard let myRoot = installRoot(of: Bundle.main.executableURL) else { return } // a dev run outside a materialized key supersedes nothing
        for elder in NSWorkspace.shared.runningApplications
        where elder.processIdentifier != me && installRoot(of: elder.executableURL) == myRoot {
            FileHandle.standardError.write(Data("Oathe notch: superseding pid \(elder.processIdentifier)\n".utf8))
            elder.forceTerminate()
        }
    }

    static func main() {
        supersedeElders()
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
