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
  /** {ownsExec, name, display, resumable} — recognizing this harness's session PROCESSES (exec
   *  predicate), NAMING the surface they speak from over facts (exec + nearest app bundle),
   *  the WORD each named surface wears where work lives (`display: {surface: word}`), and
   *  which surfaces are apps the glass resumes INTO by opening them (`resumable`, ruling
   *  2026-09-05 — a folder's session is never one). Facts are recorded at SessionStart;
   *  naming happens at READ, so it evolves without rewriting history. null: no local process
   *  of ours to meet in an ancestry walk. */
  static surfaces = null;
  /** Attestation (ruling 2026-09-04) — per owned surface NAME: 'hooks' when the harness's
   *  sessions register through the lifecycle hooks (a claim with no registered session is
   *  refused), 'hookless' when the surface never runs hooks by design (the claim is admitted
   *  and its evidence is discovered). A surface that never speaks declares null. */
  static attestation = null;
  /** The blocking exchange declared to the transport (ruling 2026-09-05): `{key, unit: 'sec'}` —
   *  the per-tool timeout KEY this adapter's MCP registration writes where its client reads it,
   *  valued from config `mcpToolTimeoutSec` (a `done` waits minutes for its verdict; codex's
   *  default was 60s). null when the client needs none (Claude Code: ≈28h default, and a call
   *  past two minutes becomes a background task) or documents none (Cursor). */
  static mcpToolTimeout = null;

  /**
   * @param {{name?: string, home: string, envPath?: string, paths: object,
   *          exec?: {run: (cmd: string, args: string[]) => {status: number, stdout: string, stderr: string}},
   *          config?: {get: Function}|null}} o  config — the OatheConfig an adapter's writes are
   *          valued from (the codex timeout budget); null for read-only uses (detect, census)
   */
  constructor({ name, home, envPath = process.env.PATH ?? '', paths, exec = defaultExec, config = null }) {
    this.name = name ?? this.constructor.harnessName;
    this.home = home;
    this.config = config;
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
  /** `{dirs(home), originators}` — the staging dirs an app surface runs sessions from (no project
   *  folder; a measured list, absolute paths for `home`) and the rollout originators that name the
   *  desktop (so `traces.stagingDrift` can say when the app moves). A claim from a staging dir is
   *  picked up by the app and says so in its place statement. null when none. */
  static synthetic = null;

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
   * CLI to install (its wiring is then our own file writes, pinned by the suite). `update`
   * (ruling 2026-09-05): `(address) => [bin, args]` — the CLI's OWN in-place updater, run by
   * `oathe engine update` when a judgment named it out of date; null when the adapter knows no
   * updater (then the glass offers no update act and the stall words stay honest).
   */
  static install = null;

  /**
   * The harness's one-shot (headless) run — what the live-behaviour lane drives to make a
   * REAL session fire our hooks and leave a transcript: `{ auth, command, extract }` — the env
   * vars its non-interactive mode authenticates with (pinned from the docs snapshot), the
   * argv for a prompt, and the extraction of the model's text from stdout; null for none.
   * `diagnose(stderrTail) → 'outdated' | null` (ruling 2026-09-05): the ONLY reader of the
   * engine's own failure words — the verifier records the cause, the pager words it, the glass
   * acts on it. When the CLI changes its message, this predicate changes and nothing else does.
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

  /**
   * The ONE resolver of a CLI's ADDRESS (ruling 2026-09-05, engines are addresses): the first
   * executable named `name` on `envPath`, absolute, or null. Detection, the launcher and the
   * engine runner all ask this — no second reading of PATH anywhere.
   */
  static resolveOnPath(envPath, name) {
    for (const dir of String(envPath ?? '').split(':').filter(Boolean)) {
      const candidate = path.join(dir, name);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
    }
    return null;
  }

  binOnPath(bin) {
    return Harness.resolveOnPath(this.envPath, bin) !== null;
  }

  /** The manifest kind that records a CLI's address — the one kind whose file oathe does not own. */
  static CLI_ADDRESS_KIND = 'cli-address';

  /**
   * offboard()'s first line: take this harness's WIRING rows off the manifest — never its
   * cli-address row, which records a file the harness owns (uninstall forgets it separately;
   * an unwire keeps it: the CLI is still there to verify with).
   */
  takeWiringRows(manifest) {
    return manifest.removeWhere((r) => r.harness === this.name && r.kind !== Harness.CLI_ADDRESS_KIND);
  }

  /**
   * Record WHERE this harness's CLI is (init, every run): one `cli-address` manifest row with the
   * measured address, no sha (the file is the harness's, never ours — the doctor proves it RUNS
   * under the LaunchAgent's PATH instead). Not found → no row, and any stale row goes: a
   * daemon-forwarded judgment must never spawn a bare name into launchd's PATH again.
   * @returns {Array<{action: string, file?: string}>}
   */
  recordCliAddress({ manifest, version }) {
    const { cliPath } = this.detect().presence;
    const stale = manifest.removeWhere((r) => r.kind === Harness.CLI_ADDRESS_KIND && r.harness === this.name);
    if (cliPath === null) return stale.length > 0 ? [{ action: 'cli-address-gone', file: stale[0].file }] : [];
    manifest.upsert({ harness: this.name, file: cliPath, kind: Harness.CLI_ADDRESS_KIND, detail: { bin: path.basename(cliPath) }, blockVersion: version, sha256: null });
    return [{ action: stale.some((r) => r.file === cliPath) ? 'cli-address-current' : 'cli-address-recorded', file: cliPath }];
  }

  /**
   * STRUCTURED detection: what is actually here — the app (GUI surfaces; null when the
   * question does not apply), the CLI, the config home — and the adapter's own verdict on
   * "installed" over those facts. Consumers pick the fact their capability needs (a headless
   * run needs `cli`; wiring needs `configHome`), never the one bit.
   * `cliPath` is the CLI's measured ADDRESS (the first cliBin resolved on this harness's PATH)
   * or null; `cli` is its boolean face.
   * @returns {{name: string, presence: {app: boolean|null, cli: boolean, cliPath: string|null, configHome: string|null}, installed: boolean}}
   */
  detect() {
    const cliPath = this.constructor.cliBins.map((bin) => Harness.resolveOnPath(this.envPath, bin)).find((p) => p !== null) ?? null;
    const configHome = fs.existsSync(this.configHome) ? this.configHome : null;
    const presence = { app: null, cli: cliPath !== null, cliPath, configHome };
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
