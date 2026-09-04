// oathe — the harness base class. One base holds what every harness shares (detection inputs,
// exec seam, config-home convention); each subclass owns EVERYTHING harness-specific as a named
// member — identity, wiring, context files, project-dir env var, hook dialect, engine surface —
// so no `if (name === 'x')` exists anywhere outside src/harnesses/. The catalog
// (./catalog.mjs) is the one registry over the subclasses.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { globalFenceBody, writeFence } from '../fence.mjs';

export class HarnessOnboardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HarnessOnboardError';
    this.code = code;
    this.details = details;
  }
}

export const defaultExec = {
  run(cmd, args) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  },
};

export class Harness {
  // ------------------------------------------------------------ identity facts
  /** The CLI on PATH (null: no CLI — a GUI-only or hosted surface). */
  static bin = null;
  /** MCP clientInfo.name values that mean this harness (catalog.harnessForClient). */
  static clientNames = Object.freeze([]);
  /** Context files a project folder carries for this harness (the fence targets). */
  static contextFiles = Object.freeze([]);
  /** The env var this harness sets to name the project dir for hooks/servers, or null. */
  static projectDirEnvVar = null;
  /** Manual steps for a detect-only surface (wiring null), or null. */
  static note = null;
  /** The surfaces this wiring serves, as the init row states them (e.g. 'CLI/Desktop App'); null for detect-only. */
  static covers = null;

  // ------------------------------------------------------------ capabilities (frozen or null)
  /** {needsCli} — the install writes this harness's config through its CLI (true) or our own files. */
  static wiring = null;
  /** {dialect} — the hook payload/reply dialect this harness speaks. */
  static hooks = null;
  /** {splash, bin} — `oathe <name>` launches it in the cage; splash: print the board to
   *  scrollback first; bin: the adapter's OWN interactive binary (never assumed from the
   *  harness name — the same primitive, each harness's unique adapter). */
  static launch = null;
  /** {store, newest, projector, ownsPath} — the session-record store the verifier and doctor read. */
  static traces = null;
  /** {ownsExec, name} — recognizing this harness's session PROCESSES (exec predicate) and
   *  NAMING the surface they speak from over facts (exec + nearest app bundle). Facts are
   *  recorded at SessionStart; naming happens at READ, so it evolves without rewriting
   *  history. null: no local process of ours to meet in an ancestry walk. */
  static surfaces = null;
  /** Attestation (ruling 2026-09-04) — per owned surface NAME: 'hooks' when the harness's
   *  sessions register through the lifecycle hooks (a claim with no registered session is
   *  refused), 'hookless' when the surface never runs hooks by design (the claim is admitted
   *  and its evidence is discovered). A surface that never speaks declares null. */
  static attestation = null;

  /**
   * @param {{name?: string, home: string, envPath?: string, paths: object,
   *          exec?: {run: (cmd: string, args: string[]) => {status: number, stdout: string, stderr: string}}}} o
   */
  constructor({ name, home, envPath = process.env.PATH ?? '', paths, exec = defaultExec }) {
    this.name = name ?? this.constructor.harnessName;
    this.home = home;
    this.envPath = envPath;
    this.paths = paths;
    this.exec = exec;
  }

  /** The config-home convention (~/.<name>) — the ONE place it is spelled. */
  static configHomeFor(home, name = this.harnessName) {
    return path.join(home, `.${name}`);
  }

  /**
   * R-BOARD-SCOPE: is `dir` a SYNTHETIC workspace — a directory this harness stages for a
   * session that has no real project folder (ChatGPT desktop's per-conversation cwd), so no
   * board of its own? Base: no harness stages such directories. An adapter that does names
   * them here; the resolver derives the fact once and every surface threads it.
   * @param {{dir: string, home: string}} _o
   */
  static isSyntheticWorkspaceDir(_o) {
    return false;
  }

  /**
   * The harness's GLOBAL instructions files, relative to its config home, in the harness's
   * OWN precedence order (the first that exists is the one it reads; the last is the default
   * to create); [] = the harness has none. A harness whose sessions can open with no project
   * folder (Codex: ChatGPT desktop) declares them, and `oathe init` puts the managed block
   * where the harness will actually read it — the standing rule those sessions would
   * otherwise never see, since a staging dir never carries a fence.
   */
  static globalContextFiles = Object.freeze([]);

  /**
   * The harness-docs snapshot pages this adapter's facts derive from, as `<harness>/<slug>`
   * keys of DOC_SOURCES (scripts/pull-harness-docs.mjs). The docs-drift lane re-pulls those
   * pages and, when one changes, names THIS adapter as the thing to re-verify. Every adapter
   * declares at least one; the contract suite refuses orphan pins in either direction.
   */
  static docs = Object.freeze([]);

  /**
   * How a fresh Linux runner gets this harness's REAL CLI — the install-contract lane installs
   * it and proves `oathe init` against it: `{ npm, bin, versionArgs }` for an npm package,
   * `{ installer, bin, versionArgs }` for a vendor install script, null when the harness has no
   * CLI to install (its wiring is then our own file writes, pinned by the suite).
   */
  static install = null;

  /**
   * The harness's one-shot (headless) run — what the live-behaviour lane drives to make a
   * REAL session fire our hooks and leave a transcript: `{ auth, command, extract }` — the env
   * vars its non-interactive mode authenticates with (pinned from the docs snapshot), the
   * argv for a prompt, and the extraction of the model's text from stdout; null for none.
   */
  static headless = null;

  /** `--output-format json` on Claude Code and Cursor wraps the text in {result}. */
  static extractJsonResult(stdout) {
    try {
      return JSON.parse(stdout).result ?? '';
    } catch {
      throw new Error('--output-format json did not return JSON');
    }
  }

  /**
   * Install the global fence when the adapter declares where it is read — through THE fence
   * writer, recorded as a plain fence row (owner 'global') so `oathe uninstall` strips it
   * exactly like a folder fence. Idempotent.
   * @returns {Array<{action: string, file: string, changed: boolean}>}
   */
  installGlobalFence({ manifest, version }) {
    const files = this.constructor.globalContextFiles;
    if (files.length === 0) return [];
    const candidates = files.map((file) => path.join(this.configHome, file));
    const target = candidates.find((file) => fs.existsSync(file)) ?? candidates.at(-1);
    const { changed } = writeFence({
      manifest, file: target, version, body: globalFenceBody(), scope: 'user', harness: 'global',
    });
    return [{ action: 'global-fence', file: target, changed }];
  }

  /**
   * The plugin version this harness has CACHED for itself, or null when it keeps no
   * version-keyed copy. A fact the doctor prints beside the package version — the code that
   * runs is always the `oathe` bin on PATH; the cache holds manifests only.
   * @returns {string|null}
   */
  installedPluginVersion() {
    return null;
  }

  /** The harness's config home (e.g. ~/.claude). */
  get configHome() {
    return this.constructor.configHomeFor(this.home, this.name);
  }

  /** The CLI names that count as this harness's CLI on PATH (subclasses may accept aliases). */
  static get cliBins() {
    return this.bin ? [this.bin] : [];
  }

  /** The adapter's OWN rule for "installed", over structured presence. Base: CLI and config home. */
  static installedFrom(presence) {
    return presence.cli && presence.configHome !== null;
  }

  binOnPath(bin) {
    return this.envPath.split(':').filter(Boolean).some((dir) => {
      try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch { return false; }
    });
  }

  /**
   * STRUCTURED detection: what is actually here — the app (GUI surfaces; null when the
   * question does not apply), the CLI, the config home — and the adapter's own verdict on
   * "installed" over those facts. Consumers pick the fact their capability needs (a headless
   * run needs `cli`; wiring needs `configHome`), never the one bit.
   * @returns {{name: string, presence: {app: boolean|null, cli: boolean, configHome: string|null}, installed: boolean}}
   */
  detect() {
    const cli = this.constructor.cliBins.some((bin) => this.binOnPath(bin));
    const configHome = fs.existsSync(this.configHome) ? this.configHome : null;
    const presence = { app: null, cli, configHome };
    return { name: this.name, presence, installed: this.constructor.installedFrom(presence) };
  }

  /** What init will write for this harness, one line per file — from the SAME data onboard() writes. */
  describe() {
    return [];
  }
}

/** @returns {Array<{name: string, installed: boolean, evidence: object}>} */
export function census(harnesses) {
  return harnesses.map((h) => h.detect());
}
