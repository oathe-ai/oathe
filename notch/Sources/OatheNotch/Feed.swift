// OatheNotch — the feed client. The package computes, the notch renders: this file only
// supervises `oathe notch --serve` and decodes its ndjson frames. No business logic lives
// here; a frame is truth because the substrate said so.
//
// Fault tolerance by shape: the child dying is a fact we report (a typed line the view
// shows amber — never silence) and then repair (restart with backoff, reset on the first
// good frame). Stopping closes the child's stdin — the feed's own documented exit.

import Foundation

struct BoardRow: Decodable {
    let task_id: String
    let principal_id: String?
    let state: String?
}

struct Sections: Decodable {
    let mine: [BoardRow]
    let open: [BoardRow]
    let asserted: [BoardRow]
    let held: [BoardRow]
}

struct Breach: Decodable {
    let kind: String // overdue | reopened | stalled | quiet
    let task_id: String
    let detail: String
    let at: String? // the breach's own clock (UTC) — the glass renders an age from it
    let act: Resume? // the package-owned act: verify for overdue/stalled, the resumption else
}

struct SessionRef: Decodable {
    let surface: String?
    let app_pid: Int32?
    let alive: Bool
}

/// The package-owned resumption: the glass EXECUTES, it never decides.
struct Resume: Decodable {
    let kind: String // activate | spawn-terminal | open-app | copy-only
    let app_pid: Int32?
    let bundle: String?
    let command: String?
    let cwd: String?
    let terminal_bundle: String?

    private enum CodingKeys: String, CodingKey { case kind, app_pid, bundle, command, cwd, terminal_bundle }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(String.self, forKey: .kind)
        app_pid = try c.decodeIfPresent(Int32.self, forKey: .app_pid)
        bundle = try c.decodeIfPresent(String.self, forKey: .bundle)
        command = try c.decodeIfPresent(String.self, forKey: .command)
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd)
        terminal_bundle = try c.decodeIfPresent(String.self, forKey: .terminal_bundle)
    }
}

struct MotionRow: Decodable {
    let task_id: String
    let holder: String?
    let state: String?
    let last_word_at: String?
    let last_progress: String?
    let home_path: String?
    let surface: String? // which glass is speaking on the claim — the person stays the holder
    let session: SessionRef? // the living process behind the claim, when the registry knows one
    let resume: Resume?
}

/// The ephemeral notice riding the frame that caused it — the wire vocabulary (noticeFor,
/// src/wire.mjs) owns kind, wording, and tone; the glass only shows and fades it.
struct Notice: Decodable {
    let text: String
    let tone: String // sage — a receipt | amber — a deviation (a rejected verification)
}

/// The one-time welcome riding the first frame after the database is created — Node owns
/// the copy (src/welcome.mjs, consumed on emit); the glass only plays it.
struct Welcome: Decodable {
    let lines: [String]
}

struct Frame: Decodable {
    let push: String?
    let breaches: [Breach]
    let motion: [MotionRow]
    let idle: [MotionRow]
    let sections: Sections
    let notice: Notice?
    let welcome: Welcome? // optional — an old feed's frames stay decodable
    let default_agent: String? // the machine's chosen agent — the glass reads no config
}

protocol FeedClient: AnyObject {
    var onFrame: ((Frame) -> Void)? { get set }
    var onFailure: ((String) -> Void)? { get set }
    func start()
    func stop()
}

final class OatheFeed: FeedClient {
    var onFrame: ((Frame) -> Void)?
    var onFailure: ((String) -> Void)?

    private var child: Process?
    private var stdinPipe: Pipe?
    private var stopped = false
    private var restartDelay: TimeInterval = 1

    func start() {
        stopped = false
        guard let bin = Self.resolveBin() else {
            onFailure?("Oathe notch: no `oathe` on the login shell's PATH — is oathe installed?")
            scheduleRestart()
            return
        }
        spawn(bin: bin)
    }

    func stop() {
        stopped = true
        stdinPipe?.fileHandleForWriting.closeFile() // the feed's documented exit
        child?.terminate()
        child = nil
    }

    /// The agent's own PATH first — init stamps the oathe bin dir into the LaunchAgent, so
    /// under launchd this is authoritative. The login shell is the dev-run fallback only
    /// (and it never sources .zshrc, so nvm-in-zshrc setups won't answer there).
    static func resolveBin() -> String? {
        let fm = FileManager.default
        for dir in (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":") {
            let candidate = String(dir) + "/oathe"
            if fm.isExecutableFile(atPath: candidate) { return candidate }
        }
        // Rung 2: the fact Node stamped at wire time, through the ONE installation object
        // — beside this bundle when materialized, else the served home's install. No
        // launch mode gambles on a shell.
        if let stamped = Installation.current?.stampedBin { return stamped }
        let probe = Process()
        probe.executableURL = URL(fileURLWithPath: "/bin/zsh")
        probe.arguments = ["-lc", "command -v oathe"]
        let out = Pipe()
        let err = Pipe()
        probe.standardOutput = out
        probe.standardError = err
        // Drain BOTH pipes concurrently and bound the wait: waitUntilExit before reading
        // deadlocked the main thread against any login shell chattier than one pipe buffer
        // (~64KB of MOTD/nvm noise) — a silent, permanent no-notch. Never again.
        var data = Data()
        let finished = DispatchGroup()
        finished.enter()
        out.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                out.fileHandleForReading.readabilityHandler = nil
                finished.leave()
            } else {
                data.append(chunk)
            }
        }
        err.fileHandleForReading.readabilityHandler = { handle in
            if handle.availableData.isEmpty { err.fileHandleForReading.readabilityHandler = nil }
        }
        do { try probe.run() } catch { return nil }
        if finished.wait(timeout: .now() + 5) == .timedOut {
            probe.terminate() // a shell that won't answer in 5s doesn't get to hang the glass
            out.fileHandleForReading.readabilityHandler = nil
            err.fileHandleForReading.readabilityHandler = nil
            return nil
        }
        probe.waitUntilExit()
        let found = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (found?.isEmpty == false && probe.terminationStatus == 0) ? found : nil
    }

    private func spawn(bin: String) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bin)
        proc.arguments = ["notch", "--serve"]
        // The bin's own directory leads the child's PATH — the oathe script's `env node`
        // shebang needs node, which lives beside the bin. Installation owns the rule.
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = Installation.nodePath(for: bin, over: env["PATH"])
        proc.environment = env
        let out = Pipe()
        let inp = Pipe()
        proc.standardOutput = out
        proc.standardError = Pipe()
        proc.standardInput = inp
        var buffer = Data()
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.prefix(upTo: nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                guard let frame = try? JSONDecoder().decode(Frame.self, from: line) else { continue }
                DispatchQueue.main.async {
                    self?.restartDelay = 1 // a good frame heals the backoff
                    self?.onFrame?(frame)
                }
            }
        }
        proc.terminationHandler = { [weak self] p in
            out.fileHandleForReading.readabilityHandler = nil
            guard let self, !self.stopped else { return }
            DispatchQueue.main.async {
                self.onFailure?("Oathe notch: feed exited (\(p.terminationStatus)) — retrying")
                self.scheduleRestart()
            }
        }
        do {
            try proc.run()
            child = proc
            stdinPipe = inp
        } catch {
            onFailure?("Oathe notch: cannot start the feed (\(error.localizedDescription))")
            scheduleRestart()
        }
    }

    private func scheduleRestart() {
        guard !stopped else { return }
        let delay = restartDelay
        restartDelay = min(restartDelay * 2, 60)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopped else { return }
            self.start()
        }
    }
}
