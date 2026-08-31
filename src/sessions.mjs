// oathe — the session liveness registry (~/.oathe/sessions.json): which LIVING process
// speaks for each harness session on THIS device. Written by hooks (SessionStart and the
// heartbeat both speak ensure() — the one convergence verb), read by the notch feed. FACTS
// ONLY —
// pids, exec paths, the nearest focusable app bundle; surface NAMES are resolved at read
// time by the harness adapters, so naming evolves without rewriting history.
//
// Liveness is device-local by ruling (2026-08-30): pids mean nothing off-device, so when
// the substrate moves to the cloud this file stays beside the processes it describes.
// It cleans itself: register() sweeps dead rows in the same mutation, and every reader
// checks pid-aliveness — no cron, no migration, no dead-process ledger.

import fs from 'node:fs';

import { atomicWriteJson, withFileLock } from './fslock.mjs';
import { defaultExec } from './harnesses/harness.mjs';

const SESSIONS_FORMAT = 1;
const ANCESTRY_DEPTH_CAP = 32; // loop guard for a corrupt ps snapshot — a bound, not a tunable

export class SessionRegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SessionRegistryError';
    this.code = code;
    this.details = details;
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The process ancestry of `pid` to pid 1 — ONE `ps` snapshot walked in memory. A darwin
 * fact (`comm=` is the full exec path there; elsewhere it truncates): other platforms get
 * `[]`, and so does any ps failure — the walk is fail-soft, a session without ancestry
 * still registers and its pid-aliveness still serves.
 * @returns {Array<{pid: number, exec: string}>} ancestry[0] is `pid` itself
 */
export function processAncestry({ pid, exec = defaultExec, platform = process.platform }) {
  if (platform !== 'darwin') return [];
  const out = exec.run('ps', ['-axo', 'pid=,ppid=,comm=']);
  if (out.status !== 0) return [];
  const table = new Map();
  for (const line of out.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), exec: m[3] });
  }
  const chain = [];
  let cursor = pid;
  for (let depth = 0; depth < ANCESTRY_DEPTH_CAP; depth += 1) {
    const row = table.get(cursor);
    if (!row) break;
    chain.push({ pid: cursor, exec: row.exec });
    if (cursor === 1 || row.ppid === 0) break;
    cursor = row.ppid;
  }
  return chain;
}

/**
 * The nearest FOCUSABLE app process in an ancestry: exec inside `<bundle>.app/Contents/MacOS/`
 * where the bundle itself is not nested inside another bundle — a helper's own `.app` is
 * skipped for its host (Cursor Helper → Cursor.app). null: nothing focusable (a daemon).
 * @returns {{bundle: string, pid: number}|null}
 */
export function nearestAppBundle(ancestry) {
  for (const { pid, exec } of ancestry) {
    const m = exec.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/);
    if (m && !m[1].slice(0, -4).includes('.app/')) return { bundle: m[1], pid };
  }
  return null;
}

export class SessionRegistry {
  /** @param {{sessionsPath: string, clock?: () => string, isAlive?: (pid: number) => boolean}} o */
  constructor({ sessionsPath, clock = () => new Date().toISOString(), isAlive = pidAlive }) {
    this.sessionsPath = sessionsPath;
    this.clock = clock;
    this.isAlive = isAlive;
  }

  /** @returns {{format: number, saved_at?: string, sessions: object}} */
  load() {
    if (!fs.existsSync(this.sessionsPath)) return { format: SESSIONS_FORMAT, sessions: {} };
    try {
      return JSON.parse(fs.readFileSync(this.sessionsPath, 'utf8'));
    } catch (e) {
      throw new SessionRegistryError('OATHE_SESSIONS_MALFORMED',
        `${this.sessionsPath} is not valid JSON: ${e.message}`, { file: this.sessionsPath });
    }
  }

  /**
   * The ONE convergence verb — "this session is alive right now", from whichever hook
   * fires. Unknown row → full register (the facts thunk pays for its one ps walk, and the
   * same mutation sweeps every row whose pid has died — the file cleans itself). Known row
   * in a NEW body (a resumed harness: same session, different pid) → re-register: process
   * facts refresh, registered_at survives (first-seen is the session's birthday), and a
   * fact this observer cannot know survives from the old row. Known row, same pid → a
   * cheap beat: last_seen_at only, the thunk never runs.
   *
   * A registry with a single write moment is not a registry: a session that outlives a
   * deploy, or whose file was wiped, must become visible again at its next signal.
   * @param {{sessionId: string, pid: number,
   *          facts: () => {ancestry?: Array, app?: object|null, transcriptPath?: string, workspace?: string}}} o
   */
  async ensure({ sessionId, pid, facts }) {
    return this.#mutate((doc, now) => {
      const existing = doc.sessions[sessionId];
      if (existing && existing.pid === pid) {
        existing.last_seen_at = now;
        return existing;
      }
      for (const [sid, row] of Object.entries(doc.sessions)) {
        if (!this.isAlive(row.pid)) delete doc.sessions[sid];
      }
      const { ancestry = [], app = null, transcriptPath, workspace } = facts() ?? {};
      const next = {
        pid, ancestry, app,
        transcript_path: transcriptPath ?? existing?.transcript_path ?? null,
        workspace: workspace ?? existing?.workspace ?? null,
        registered_at: existing?.registered_at ?? now,
        last_seen_at: now,
      };
      doc.sessions[sessionId] = next;
      return next;
    });
  }

  /** @returns {object|null} */
  get(sessionId) {
    return this.load().sessions[sessionId] ?? null;
  }

  /**
   * The writer's self-identification: which registered session's pid appears in MY OWN
   * ancestry (nearest ancestor wins — the harness process is the speaker's parent chain).
   * An unknown chain is null, never a guess; a malformed file refuses typed via load().
   * @returns {{sessionId: string, row: object}|null}
   */
  byAncestry(ancestry) {
    const { sessions } = this.load();
    for (const { pid } of ancestry) {
      for (const [sessionId, row] of Object.entries(sessions)) {
        if (row.pid === pid) return { sessionId, row };
      }
    }
    return null;
  }

  // One clock read per mutation: row timestamps and saved_at describe the same instant.
  async #mutate(fn) {
    return withFileLock(this.sessionsPath, () => {
      const doc = this.load();
      const now = this.clock();
      const result = fn(doc, now);
      atomicWriteJson(this.sessionsPath, { format: SESSIONS_FORMAT, saved_at: now, sessions: doc.sessions });
      return result;
    });
  }
}
