// OatheNotch — the state machine. Three states (rest = nothing, event = one line,
// open = work in motion); amber persists until seen, receipts show once and fade, a
// broken feed is a typed amber line, never silence (fail loud). The model is motion-free:
// choreography lives in the view, geometry in the panel.

import AppKit

// Two geometries only (founder ruling 2026-08-31): rest, and open — BY CLICK. Events are
// the pulse; standing conditions are the lock's tint; words live in the sheet. Nothing
// expands on its own, so nothing needs dismissing or fading. (.event died here.)
enum NotchState { case rest, open }

struct WorkRow: Identifiable {
    let id: String        // the task
    let objective: String? // what is owed — the card's first line
    let holder: String    // the surface speaking on the claim, else who holds it
    let age: String       // since the last word — the motion signal
    let amber: Bool       // deviant state (reopened) only
    let childrenLine: String? // the claim's spawned work, counted by the board
    let progress: String? // the last recorded word, for the expanded row
    let homePath: String? // where the work lives — the copy-only fallback
    let resume: Resume?   // the package-owned resumption continue executes
}

/// ONE anatomy for every sheet row — a breach and a working claim are the same object on
/// the glass: a name, a state word, an age, one act, and an expandable why. The sheet is
/// a BUDGETED list of these (rowCap — what a person can act on now); the board holds the
/// rest behind one "+N more" line. The dashboard is not a state this surface can enter.
enum SheetEntry: Identifiable {
    case breach(Breach)
    case work(WorkRow)

    var id: String {
        switch self {
        case .breach(let b): b.task_id
        case .work(let w): w.id
        }
    }
}

final class NotchModel: ObservableObject {
    enum Tone { case amber, sage }

    // THE FRAME IS THE ONLY TRUTH (founder ruling 2026-08-31). The model stores the
    // latest frame plus interaction state — everything the view renders is COMPUTED from
    // them, so a stale read ("1 to fix" beside "verified — settled", caught live) is
    // impossible by construction: the same fact never exists twice.
    @Published private(set) var frame: Frame?
    @Published private(set) var failure: String? // a dead feed is a standing condition — amber until it heals
    @Published private(set) var state: NotchState = .rest
    @Published private(set) var lastNotice: Notice? // the most recent event's words — read in the sheet, never on the bar
    @Published private(set) var defaultAgent: String? // rides every frame; the empty-board invite names it
    @Published private(set) var expandedId: String?
    @Published private(set) var flashTask: String? // which row just acted…
    @Published private(set) var flashWord = ""     // …and what actually happened
    @Published private(set) var hoverArmed = false

    let pulse = PulseDriver() // WHEN it fires is decided in apply() — the frame is the one source
    let welcome = WelcomeDriver() // WHEN it plays is decided in apply() — the frame carries the lines

    var onChange: (() -> Void)?
    var onReseat: (() -> Void)?
    var onResetSeat: (() -> Void)?
    var onDragChanged: ((CGSize) -> Void)?
    var onDragEnded: (() -> Void)?

    private var knownTasks: Set<String>? // last frame's task ids — a NEW id is the claim event

    init() {
        welcome.onChange = { [weak self] in self?.onChange?() } // beats reach the panel's mouse policy
    }

    /// The welcome presents OPEN geometry without the model leaving .rest — tap/close
    /// semantics stay honest while the tour plays.
    var presentingWelcome: Bool { welcome.active }

    /// ONE list: breaches lead (the pager already ordered them sharpest-first — that order
    /// is the package's, never re-derived here), work follows, one row per task. Derived
    /// per read; the sheet scrolls past the window — never a wall.
    var entries: [SheetEntry] {
        guard let frame else { return [] }
        let breachIds = Set(frame.breaches.map { $0.task_id })
        let work = (frame.motion + frame.idle)
            .filter { !breachIds.contains($0.task_id) }
            .map { row in
                WorkRow(id: row.task_id,
                        objective: row.objective,
                        // The surface speaking on the claim carries the information; the person
                        // is the constant. Live session identity outranks the wire's word.
                        holder: row.session?.surface ?? row.surface ?? row.holder ?? "open",
                        age: Self.age(from: row.last_word_at),
                        amber: row.state == "reopened",
                        childrenLine: row.children_line,
                        progress: row.last_progress,
                        homePath: row.home_path,
                        resume: row.resume)
            }
        return frame.breaches.map(SheetEntry.breach) + work.map(SheetEntry.work)
    }

    /// The sheet's budget (UX rule 20): the first rowCap entries — what a person can act on
    /// now — and one count for everything past them, the feed's own `more` included.
    var visibleEntries: [SheetEntry] { Array(entries.prefix(Metrics.rowCap)) }
    var overflow: Int { (frame?.more ?? 0) + max(0, entries.count - Metrics.rowCap) }

    var mineCount: Int { frame?.sections.mine.count ?? 0 } // the hover peek: how much you hold

    /// The STANDING tone — a quiet fact worn by the lock, never motion: amber while
    /// breaches stand or the feed is broken; nil when all is well.
    var standingTone: Tone? {
        (failure != nil || (frame?.breaches.isEmpty == false)) ? .amber : nil
    }

    func apply(_ frame: Frame) {
        failure = nil
        // The pulse is the ONLY event announcement (nothing expands but the click): a
        // notice fires its own tone; otherwise a task never seen before is the claim event
        // (sage). The first frame is baseline — presence, not an event.
        let seen = Set(frame.breaches.map { $0.task_id }
            + (frame.motion + frame.idle).map { $0.task_id })
        if let notice = frame.notice {
            // A verdict earns the winged glyph (✓/✗) — the ring alone went unseen.
            pulse.fire(notice.tone == "amber" ? .amber : .sage, glyph: true)
        } else if let known = knownTasks, !seen.subtracting(known).isEmpty {
            pulse.fire(.sage) // a new claim stays a quiet breath
        }
        knownTasks = seen
        if let notice = frame.notice { lastNotice = notice }
        defaultAgent = frame.default_agent
        self.frame = frame
        if let open = expandedId, !visibleEntries.contains(where: { $0.id == open }) { expandedId = nil }
        // The one-time welcome rides the frame like everything else — the frame is the only
        // truth, and the feed already consumed the marker, so a replay needs a new plant.
        // Its arrival announces like any event: the existing pulse, sage — a receipt.
        if let welcome = frame.welcome {
            pulse.fire(.sage)
            self.welcome.play(welcome.lines)
        }
        onChange?()
    }

    /// A dead feed is a standing condition, not a one-time event — amber until it heals.
    func fail(_ typedLine: String) {
        failure = typedLine
        onChange?()
    }

    /// Close the open sheet — the bar tap and a click anywhere off the island both land here.
    func close() {
        guard state == .open else { return }
        expandedId = nil
        state = .rest
        onChange?()
    }

    /// The one dismissal: with only two geometries (rest, open-by-click), dismissing IS
    /// closing — and a playing welcome is skipped, never trapped behind a click.
    func dismiss() {
        if welcome.active {
            welcome.skip()
            onChange?()
            return
        }
        close()
    }

    func tap() {
        if welcome.active {
            welcome.skip() // the tour yields to the pointer — straight to rest
            onChange?()
            return
        }
        if state == .open {
            close()
        } else {
            // An empty board answers too (founder, 2026-08-31): the sheet holds the
            // no-claims invite, so a click is never ignored.
            state = .open // the sheet answers "which ones" — and holds the latest words
            onChange?()
        }
    }

    /// Pointer over the resting glass: presence, not performance.
    func setHover(_ inside: Bool) {
        guard hoverArmed != inside else { return }
        hoverArmed = inside
        onChange?()
    }

    /// One expansion for one anatomy: a row's tap answers WHY — a working claim's progress
    /// and home, a breach's verdict or failure sentence, whole.
    func toggle(_ id: String) {
        expandedId = expandedId == id ? nil : id
        onChange?()
    }

    /// The one act a row offers: RESUMPTION, never a shrug (founder ruling 2026-08-30) —
    /// activate the living app; spawn the agent at the task's home in a terminal; open the
    /// desktop app; else the folder. The clipboard is filled in every branch; the package
    /// decided which branch (frame.resume) — the glass only executes, and the flash says
    /// what actually happened.
    func continueAct(_ row: WorkRow) {
        let word = execute(row.resume, clipboard: "continue \(row.id)", folder: row.homePath)
        flash(row.id, word)
    }

    /// A breach's act: verify for overdue/stalled, the resumption otherwise (frame.act).
    func breachAct(_ breach: Breach) {
        let word = execute(breach.act, clipboard: breach.act?.command ?? "continue \(breach.task_id)", folder: nil)
        flash(breach.task_id, word)
    }

    private func execute(_ resume: Resume?, clipboard: String, folder: String?) -> String {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(clipboard, forType: .string)
        switch resume?.kind {
        case "activate":
            // Cooperative activation can DENY a background app's request — the Bool is the
            // truth, and opening the running app's bundle is the permission-free fallback
            // that still switches (open -a semantics). The flash never claims what didn't happen.
            if let pid = resume?.app_pid, let app = NSRunningApplication(processIdentifier: pid_t(pid)),
               app.activate() {
                return "switched"
            }
            if let bundle = resume?.bundle {
                NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: bundle),
                                                   configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
                return "switched"
            }
            return openFolder(folder) ? "opened" : "copied"
        case "spawn-terminal":
            spawnTerminal(resume!)
            return "launched"
        case "open-app":
            if let bundle = resume?.bundle {
                NSWorkspace.shared.open(URL(fileURLWithPath: bundle))
                return "opened"
            }
            return "copied"
        default:
            return openFolder(folder) ? "opened" : "copied"
        }
    }

    private func flash(_ id: String, _ word: String) {
        flashTask = id
        flashWord = word
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
            if self?.flashTask == id { self?.flashTask = nil; self?.onChange?() }
        }
        onChange?()
    }

    @discardableResult
    private func openFolder(_ path: String?) -> Bool {
        guard let path, path.hasPrefix("/") else { return false }
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
        return true
    }

    /// Open the session's own terminal (else the system one) at the task's home running the
    /// resumption — via a `.command` file the terminal executes natively (Terminal.app
    /// built-in; iTerm registers the extension). Zero Apple Events, so zero Automation
    /// permissions: an unauthorized send needs a usage-description key and a stable code
    /// identity, and an ad-hoc-signed open-source app has neither. PATH is prepended from
    /// the resolved oathe bin because login shells on nvm-in-.zshrc machines can't see it.
    private func spawnTerminal(_ resume: Resume) {
        guard let command = resume.command, let cwd = resume.cwd else { return }
        let bundle = URL(fileURLWithPath: resume.terminal_bundle ?? "/System/Applications/Utilities/Terminal.app")
        var script = "#!/bin/zsh\n"
        if let bin = OatheFeed.resolveBin() {
            script += "export PATH=\(shellQuote(Installation.binDir(of: bin))):$PATH\n"
        }
        script += "cd \(shellQuote(cwd)) && \(command)\n"
        let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".oathe/resume.command")
        do {
            try script.write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
        } catch {
            NSLog("oathe-notch: resume script write failed (\(error)) — opening the terminal plain")
            NSWorkspace.shared.open(bundle)
            return
        }
        NSWorkspace.shared.open([file], withApplicationAt: bundle, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            guard let error else { return }
            NSLog("oathe-notch: terminal declined the act (\(error.localizedDescription)) — opening it plain")
            DispatchQueue.main.async { NSWorkspace.shared.open(bundle) }
        }
    }

    private func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    static func age(from utc: String?) -> String {
        guard let utc else { return "" }
        let f = DateFormatter()
        // QA1480: without en_US_POSIX a user 12/24-hour override rewrites fixed formats and
        // a non-Gregorian system calendar mis-parses the year — every age on the glass
        // blanked or absurd. The POSIX locale pins format AND calendar.
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm'Z'"
        f.timeZone = TimeZone(identifier: "UTC")
        guard let d = f.date(from: utc) else { return "" }
        let s = Int(-d.timeIntervalSinceNow)
        if s < 90 { return "now" }
        if s < 3600 { return "\(s / 60)m" }
        if s < 86400 { return "\(s / 3600)h" }
        return "\(s / 86400)d"
    }
}
