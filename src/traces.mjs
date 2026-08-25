// oathe — the trace stores: how both harnesses' session records are found, validated, and
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
  constructor({ home } = {}) {
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
      harness: 'claude',
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

  newestTranscript() {
    return this.newestFileIn(this.projectsRoot, (p) => /[0-9a-f-]{36}\.jsonl$/.test(p) && !p.includes('subagents'));
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
      harness: 'codex',
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

  /** Fan-out: children of a thread per thread_spawn_edges, joined to their rollout paths. */
  childThreads(threadId) {
    const db = this.#db();
    try {
      return db.prepare(
        `SELECT e.child_thread_id AS thread_id, t.rollout_path, t.cwd, t.title
           FROM thread_spawn_edges e LEFT JOIN threads t ON t.id = e.child_thread_id
          WHERE e.parent_thread_id = ?`,
      ).all(threadId);
    } finally {
      db.close();
    }
  }

  newestRollout() {
    return this.newestFileIn(this.sessionsRoot, (p) => /rollout-.+\.jsonl(\.zst)?$/.test(p));
  }
}
