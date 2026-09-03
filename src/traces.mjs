// oathe — the trace stores: how Claude Code's and Codex's session records are found, validated, and
// read. The CONTRACT lives in docs/traces.md; both vendors disclaim schema stability, so
// every read validates and REFUSES loudly (TraceContractError) rather than returning less
// evidence than a claim recorded. Nothing is hardcoded: every path derives from the store's
// home (env-overridable), every schema expectation is a named rule here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export class TraceContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TraceContractError';
    this.code = code;
    this.details = details;
  }
}

/** Shared machinery: newline-delimited JSON with optional zstd compression. */
export class TraceStore {
  /** @param {{home?: string}} o home = the user home the store hangs off (default os.homedir()) */
  constructor({ home, harness } = {}) {
    if (!harness) {
      throw new TraceContractError('TRACE_STORE_HARNESS_REQUIRED',
        'a trace store is built by its harness adapter, which names it — no store spells its own harness');
    }
    this.harness = harness;
    this.home = home || os.homedir();
  }

  /** Raw lines of a trace file; handles .zst transparently; refuses unreadable files. */
  readLines(file) {
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch (e) {
      throw new TraceContractError('TRACE_UNREADABLE',
        `trace file cannot be read: ${file} (${e.message})`, { file });
    }
    if (file.endsWith('.zst')) {
      if (typeof zlib.zstdDecompressSync !== 'function') {
        throw new TraceContractError('TRACE_ZSTD_UNSUPPORTED',
          `${file} is zstd-compressed and this node build cannot decompress it — refusing to `
          + 'silently skip evidence', { file });
      }
      bytes = zlib.zstdDecompressSync(bytes);
    }
    return bytes.toString('utf8').split('\n').filter((l) => l.trim() !== '');
  }

  /** Parsed entries; a malformed line is a typed refusal, never a silent drop. */
  entries(file) {
    return this.readLines(file).map((line, at) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new TraceContractError('TRACE_LINE_MALFORMED',
          `${file}:${at + 1} is not valid JSON — the trace contract is broken`, { file, line: at + 1 });
      }
    });
  }

  /** validate() returns {ok, detail} — the doctor/monitor form of describe()'s refusals. */
  validate(file) {
    try {
      this.describe(file);
      return { ok: true, detail: null };
    } catch (e) {
      return { ok: false, detail: String(e?.message || e) };
    }
  }

  #newestIn(dir, matches) {
    if (!fs.existsSync(dir)) return null;
    let best = null;
    for (const entry of fs.readdirSync(dir, { recursive: true })) {
      const full = path.join(dir, String(entry));
      if (!matches(String(entry))) continue;
      const stat = fs.statSync(full, { throwIfNoEntry: false });
      if (stat?.isFile() && (!best || stat.mtimeMs > best.mtimeMs)) best = { full, mtimeMs: stat.mtimeMs };
    }
    return best?.full ?? null;
  }

  /** Protected helper for subclasses. */
  newestFileIn(dir, matches) {
    return this.#newestIn(dir, matches);
  }

  /**
   * Protected: matched files whose mtime falls inside the window, newest first, capped at
   * maxFiles — and the newest match is ALWAYS included, so an idle store still yields its
   * latest record instead of an empty (and therefore silently green) sweep.
   */
  recentFilesIn(dir, matches, { days, maxFiles, now = Date.now() }) {
    if (!fs.existsSync(dir)) return [];
    const hits = [];
    for (const entry of fs.readdirSync(dir, { recursive: true })) {
      const full = path.join(dir, String(entry));
      if (!matches(String(entry))) continue;
      const stat = fs.statSync(full, { throwIfNoEntry: false });
      if (stat?.isFile()) hits.push({ full, mtimeMs: stat.mtimeMs });
    }
    hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const windowed = hits.filter((h) => h.mtimeMs >= now - days * 86_400_000).slice(0, maxFiles);
    if (windowed.length === 0 && hits.length > 0) return [hits[0].full];
    return windowed.map((h) => h.full);
  }
}

const CLAUDE_MESSAGE_TYPES = new Set(['user', 'assistant', 'system']);

export class ClaudeTraceStore extends TraceStore {
  get projectsRoot() {
    return path.join(this.home, '.claude', 'projects');
  }

  /** The encoded project dir for a cwd — verified encoding: /, _ and . become '-'. */
  projectDirFor(cwd) {
    return path.join(this.projectsRoot, cwd.replaceAll(/[/_.]/g, '-'));
  }

  /**
   * @returns {{harness: 'claude', session_id: string, cwd: string|null, title: string|null,
   *            git_branch: string|null, entries: number, path: string}}
   */
  describe(file) {
    const rows = this.entries(file);
    const messages = rows.filter((r) => CLAUDE_MESSAGE_TYPES.has(r.type));
    if (messages.length === 0) {
      throw new TraceContractError('TRACE_CLAUDE_NO_MESSAGES',
        `${file}: no user/assistant/system entries — not a transcript this contract knows`, { file });
    }
    const identity = messages.find((r) => r.sessionId);
    if (!identity) {
      throw new TraceContractError('TRACE_CLAUDE_NO_SESSION',
        `${file}: message entries carry no sessionId — the transcript contract drifted`, { file });
    }
    return {
      harness: this.harness,
      session_id: identity.sessionId,
      cwd: messages.find((r) => r.cwd)?.cwd ?? null,
      title: rows.find((r) => r.type === 'ai-title')?.aiTitle ?? null,
      git_branch: messages.find((r) => r.gitBranch)?.gitBranch ?? null,
      entries: rows.length,
      path: file,
    };
  }

  /** Fan-out traces: <project>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json). */
  subagentsFor(transcriptPath) {
    const sessionId = path.basename(transcriptPath).replace(/\.jsonl(\.zst)?$/, '');
    const dir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => /^agent-.+\.jsonl$/.test(f))
      .map((f) => {
        const agentId = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
        const metaPath = path.join(dir, `agent-${agentId}.meta.json`);
        let meta = null;
        if (fs.existsSync(metaPath)) {
          try {
            meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          } catch (e) {
            throw new TraceContractError('TRACE_CLAUDE_META_MALFORMED',
              `${metaPath}: subagent meta is not valid JSON (${e.message})`, { file: metaPath });
          }
        }
        return { agent_id: agentId, path: path.join(dir, f), meta };
      });
  }

  static #isTranscript = (p) => /[0-9a-f-]{36}\.jsonl$/.test(p) && !p.includes('subagents');

  /**
   * The file a session's rows actually live in. The harness names a transcript per hook
   * (`transcript_path`), but after a resume — and after a context compaction — it rotates the
   * session id, reports `<new-id>.jsonl`, and keeps appending to the ORIGINAL file, stamping
   * each new row with `session_id: <new-id>` beside the file's own `sessionId` (measured
   * 2026-09-01). So: a reported file that exists is the answer; otherwise the newest sibling
   * whose rows carry the id is; otherwise the reported path stands — a fresh session's file
   * is created lazily and nothing carries its id yet. Positive evidence only, never a guess:
   * a file that merely mentions the id in its text is not the session's.
   */
  transcriptFor({ sessionId, reportedPath }) {
    if (reportedPath === null || reportedPath === undefined || fs.existsSync(reportedPath)) return reportedPath ?? null;
    const dir = path.dirname(reportedPath);
    if (!fs.existsSync(dir)) return reportedPath;
    const siblings = fs.readdirSync(dir)
      .filter((f) => ClaudeTraceStore.#isTranscript(f))
      .map((f) => ({ full: path.join(dir, f), mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const carries = (row) => row?.session_id === sessionId || row?.sessionId === sessionId;
    for (const { full } of siblings) {
      const text = fs.readFileSync(full, 'utf8');
      if (!text.includes(sessionId)) continue; // the cheap gate; the rows decide
      for (const line of text.split('\n')) {
        if (!line.includes(sessionId)) continue;
        try { if (carries(JSON.parse(line))) return full; } catch { /* a malformed line is describe()'s refusal, not this scan's */ }
      }
    }
    return reportedPath;
  }

  newestTranscript() {
    return this.newestFileIn(this.projectsRoot, ClaudeTraceStore.#isTranscript);
  }

  recentTranscripts({ days, maxFiles }) {
    return this.recentFilesIn(this.projectsRoot, ClaudeTraceStore.#isTranscript, { days, maxFiles });
  }
}

export class CodexTraceStore extends TraceStore {
  get codexHome() {
    return path.join(this.home, '.codex');
  }

  get sessionsRoot() {
    return path.join(this.codexHome, 'sessions');
  }

  get stateDbPath() {
    return path.join(this.codexHome, 'state_5.sqlite');
  }

  #db() {
    const sqlite = process.getBuiltinModule('node:sqlite');
    if (!sqlite?.DatabaseSync) {
      throw new TraceContractError('TRACE_CODEX_SQLITE_UNSUPPORTED',
        'node:sqlite is unavailable in this runtime — the codex thread index cannot be read', {});
    }
    if (!fs.existsSync(this.stateDbPath)) {
      throw new TraceContractError('TRACE_CODEX_STATE_ABSENT',
        `codex state db not found at ${this.stateDbPath}`, { path: this.stateDbPath });
    }
    return new sqlite.DatabaseSync(this.stateDbPath, { readOnly: true });
  }

  /**
   * @returns {{harness: 'codex', session_id: string, cwd: string|null, source: *,
   *            entries: number, path: string}}
   */
  describe(file) {
    const rows = this.entries(file);
    const head = rows[0];
    if (head?.type !== 'session_meta') {
      throw new TraceContractError('TRACE_CODEX_NO_META',
        `${file}: first line is '${head?.type}', expected session_meta — the rollout contract drifted`,
        { file });
    }
    const meta = head.payload ?? {};
    if (!meta.id && !meta.session_id) {
      throw new TraceContractError('TRACE_CODEX_NO_ID',
        `${file}: session_meta carries neither id nor session_id`, { file });
    }
    return {
      harness: this.harness,
      session_id: meta.id ?? meta.session_id,
      cwd: meta.cwd ?? null,
      source: meta.source ?? null,
      entries: rows.length,
      path: file,
    };
  }

  /** The sqlite index row for a thread — rollout path, git identity, tokens. */
  threadRow(threadId) {
    const db = this.#db();
    try {
      return db.prepare(
        'SELECT id, rollout_path, cwd, title, tokens_used, git_sha, git_branch, source FROM threads WHERE id = ?',
      ).get(threadId) ?? null;
    } finally {
      db.close();
    }
  }

  /**
   * Fan-out: children of a thread per thread_spawn_edges, joined to their rollout paths —
   * with the edge status (a failed child must be distinguishable from a completed one) and
   * the spawn identity from threads.source (`{subagent: {thread_spawn: {agent_nickname,
   * agent_role, agent_path, depth, …}}}`, measured live 2026-08-31). A source that is not
   * JSON is an expected shape gone unreadable — refuse, never project a nameless child.
   */
  childThreads(threadId) {
    const db = this.#db();
    try {
      return db.prepare(
        `SELECT e.child_thread_id AS thread_id, e.status, t.rollout_path, t.cwd, t.title, t.source
           FROM thread_spawn_edges e LEFT JOIN threads t ON t.id = e.child_thread_id
          WHERE e.parent_thread_id = ?`,
      ).all(threadId).map(({ source, ...row }) => {
        let parsed = null;
        if (source != null) {
          try {
            parsed = JSON.parse(source);
          } catch (e) {
            throw new TraceContractError('TRACE_CODEX_SOURCE_MALFORMED',
              `thread ${row.thread_id}: threads.source is not JSON (${e.message}) — the spawn `
              + 'identity this store relies on is unreadable', { thread_id: row.thread_id });
          }
        }
        return { ...row, spawn: parsed?.subagent?.thread_spawn ?? null };
      });
    } finally {
      db.close();
    }
  }

  static #isRollout = (p) => /rollout-.+\.jsonl(\.zst)?$/.test(p);

  /**
   * The rollout a thread's rows live in: the reported path when it exists, else the thread
   * index's own `rollout_path` (the store's record of where it writes), else the reported
   * path — a rollout not written yet. Same contract as the Claude store's.
   */
  transcriptFor({ sessionId, reportedPath }) {
    if (reportedPath === null || reportedPath === undefined || fs.existsSync(reportedPath)) return reportedPath ?? null;
    let indexed = null;
    try { indexed = this.threadRow(sessionId)?.rollout_path ?? null; } catch { indexed = null; } // no index on this machine: nothing to consult
    return indexed !== null && fs.existsSync(indexed) ? indexed : reportedPath;
  }

  newestRollout() {
    return this.newestFileIn(this.sessionsRoot, CodexTraceStore.#isRollout);
  }

  recentRollouts({ days, maxFiles }) {
    return this.recentFilesIn(this.sessionsRoot, CodexTraceStore.#isRollout, { days, maxFiles });
  }
}
