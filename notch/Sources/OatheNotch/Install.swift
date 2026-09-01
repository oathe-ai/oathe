// OatheNotch — the INSTALLATION, as one object. Every fact a copy of this app can derive
// about itself or a peer — whose board it serves, where its materialized key lives, how to
// reach the oathe bin, what PATH lets that bin\'s env-node shebang resolve — is computed
// HERE, once, from an executable path. Five call sites re-derived these by hand before the
// founder\'s zoom-out (2026-08-31); a materialized install lives at
// <home>/.oathe/notch/<version-sha>/Oathe Notch.app/…, and Node\'s wireNotch stamps
// `oathe-bin` beside the bundle at wire time.
import AppKit

struct Installation {
    /// The home whose BOARD this copy serves: a materialized copy names it in its own
    /// path; a bare copy (dev tree, a hand-moved bundle) serves the GUI user\'s own —
    /// Finder never carries OATHE_HOME. Sandbox-home installs are foreign by this rule.
    let home: String
    /// The materialized key dir — where wire-time facts sit beside the bundle; nil bare.
    let keyDir: String?

    var materialized: Bool { keyDir != nil }

    /// THIS running copy — parsed once.
    static let current = Installation(of: Bundle.main.executableURL)

    init?(of url: URL?) {
        guard let path = url?.resolvingSymlinksInPath().path else { return nil }
        if let range = path.range(of: "/.oathe/notch/") {
            home = String(path[..<range.lowerBound])
            let rest = path[range.upperBound...]
            keyDir = rest.firstIndex(of: "/").map { String(path[..<$0]) }
        } else {
            home = NSHomeDirectory()
            keyDir = nil
        }
    }

    /// Kinship for the one-notch rule: two copies are kin when they serve the same board.
    func servesSameBoard(as other: Installation?) -> Bool { other?.home == home }

    /// The oathe bin Node stamped at wire time: beside this bundle when materialized,
    /// else any key under the served home\'s install root. nil = nothing stamped here.
    var stampedBin: String? {
        let fm = FileManager.default
        let root = home + "/.oathe/notch"
        let dirs = keyDir.map { [$0] }
            ?? ((try? fm.contentsOfDirectory(atPath: root)) ?? []).map { root + "/" + $0 }
        for dir in dirs {
            if let line = try? String(contentsOfFile: dir + "/oathe-bin", encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines),
               fm.isExecutableFile(atPath: line) { return line }
        }
        return nil
    }

    /// The bin\'s own directory — where node lives too (why the launchd plist leads PATH
    /// with it). ONE rule; the feed\'s child env and the resume script both ask here.
    static func binDir(of bin: String) -> String { (bin as NSString).deletingLastPathComponent }

    /// A PATH under which `bin`\'s env-node shebang resolves, whatever the caller had.
    static func nodePath(for bin: String, over current: String?) -> String {
        binDir(of: bin) + ":" + (current ?? "/usr/bin:/bin")
    }
}
