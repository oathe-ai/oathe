// oathe — the central workspace registry (~/.oathe/workspaces.json): the one machine-wide
// record of which folders carry a board. Hooks, the MCP server, CLI verbs, and launchers all
// upsert it on use; the init picker and doctor read it. Every mutation is load → mutate →
// atomic-write inside the shared bounded lock, and every mutation is idempotent — a lost race
// self-heals on the next session.

import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteJson, withFileLock } from './fslock.mjs';
import { workspaceIdentity, workspaceRef, workspaceRoot } from './workspace.mjs';

const REGISTRY_FORMAT = 1;

export class RegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
    this.details = details;
  }
}

export class WorkspaceRegistry {
  /** @param {{registryPath: string, clock?: () => string}} o */
  constructor({ registryPath, clock = () => new Date().toISOString() }) {
    this.registryPath = registryPath;
    this.clock = clock;
  }

  /** @returns {{format: number, saved_at?: string, workspaces: object}} */
  load() {
    if (!fs.existsSync(this.registryPath)) return { format: REGISTRY_FORMAT, workspaces: {} };
    try {
      return JSON.parse(fs.readFileSync(this.registryPath, 'utf8'));
    } catch (e) {
      throw new RegistryError('OATHE_REGISTRY_MALFORMED',
        `${this.registryPath} is not valid JSON: ${e.message}`, { file: this.registryPath });
    }
  }

  /**
   * Upsert the workspace containing `cwd`. First writer owns registered_at/registered_by;
   * every writer refreshes last_seen_at, harnesses_seen, and workspace_config.
   * @param {{cwd: string, source: string, harness?: string|null}} o
   * @returns {Promise<object>} the row, with its `ref`
   */
  async register({ cwd, source, harness = null }) {
    const root = workspaceRoot(cwd);
    const ref = workspaceRef(cwd);
    const identity = workspaceIdentity(cwd);
    const row = await this.#mutate((doc, now) => {
      const existing = doc.workspaces[ref];
      const next = existing ?? {
        root,
        identity,
        registered_at: now,
        registered_by: source,
        harnesses_seen: {},
        fences: {},
      };
      next.last_seen_at = now;
      if (harness) next.harnesses_seen = { ...next.harnesses_seen, [harness]: now };
      next.workspace_config = fs.existsSync(path.join(root, '.oathe.json'));
      doc.workspaces[ref] = next;
      return next;
    });
    return { ref, ...row };
  }

  /** Stamp the fence version written into `file` on the workspace row. */
  async recordFence(ref, file, version) {
    return this.#mutate((doc) => {
      const row = doc.workspaces[ref];
      if (!row) {
        throw new RegistryError('OATHE_REGISTRY_WORKSPACE_UNKNOWN',
          `no registered workspace ${ref} to record a fence on`, { ref, file });
      }
      row.fences = { ...row.fences, [file]: version };
      return row;
    });
  }

  /** @returns {object|null} */
  /** THE home resolver — a ws-ref's root path, or null. Every surface that needs a task's
   *  folder (glass rows, breach acts, the verifier's cwd) asks HERE; nobody re-derives it. */
  rootOf(ref) {
    return this.get(ref)?.root ?? null;
  }

  get(ref) {
    return this.load().workspaces[ref] ?? null;
  }

  /** @returns {object[]} every row, each carrying its ref */
  list() {
    return Object.entries(this.load().workspaces).map(([ref, row]) => ({ ref, ...row }));
  }

  // One clock read per mutation: the row timestamps and saved_at describe the same instant.
  async #mutate(fn) {
    return withFileLock(this.registryPath, () => {
      const doc = this.load();
      const now = this.clock();
      const result = fn(doc, now);
      atomicWriteJson(this.registryPath, { format: REGISTRY_FORMAT, saved_at: now, workspaces: doc.workspaces });
      return result;
    });
  }
}
