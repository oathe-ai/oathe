// oathe — the Claude Code adapter: owned JSON paths in ~/.claude/settings.json declare the
// install, the claude CLI materializes it, and the CLI's own plugin registry is the proof.
// Every Claude-specific fact — context file, project-dir env var, hook dialect, verifier
// command line, trace store — is a named member HERE.

import fs from 'node:fs';
import path from 'node:path';

import { Harness, HarnessOnboardError } from './harness.mjs';
import { cwdDialect } from './dialects.mjs';
import { JsonEntries } from '../blocks.mjs';
import { sha256Hex } from '../manifest.mjs';

export class ClaudeHarness extends Harness {
  static harnessName = 'claude';
  static displayName = 'Claude Code';
  static covers = 'CLI'; // the desktop app exists but the row stays CLI (ruling 2026-08-29 — no confusion)
  static bin = 'claude';
  static clientNames = Object.freeze(['claude-code', 'claude']);
  static contextFiles = Object.freeze(['CLAUDE.md']);
  // Claude Code sets this directly in every spawned stdio server's and hook's environment —
  // the documented way a server learns the project root on this harness.
  static projectDirEnvVar = 'CLAUDE_PROJECT_DIR';
  static wiring = Object.freeze({ needsCli: true });
  static hooks = Object.freeze({ dialect: cwdDialect });
  // Claude Code shows the systemMessage banner inside its own TUI — no scrollback splash needed.
  static launch = Object.freeze({ splash: false, bin: 'claude' });
  // One name everywhere claude runs (founder ruling 2026-08-30: no desktop/CLI split).
  static surfaces = Object.freeze({
    ownsExec: (exec) => path.basename(exec) === 'claude',
    name: () => 'claude',
  });
  static install = Object.freeze({ npm: '@anthropic-ai/claude-code', bin: 'claude', versionArgs: ['--version'] });
  // Non-interactive auth: ANTHROPIC_API_KEY (claude-code/headless.md, pinned 2026-08-29).
  static headless = Object.freeze({
    auth: ['ANTHROPIC_API_KEY'],
    command: (prompt, model = null) => ['claude', ['-p', prompt, '--output-format', 'json', ...(model ? ['--model', model] : [])]],
    extract: (stdout) => ClaudeHarness.extractJsonResult(stdout),
  });
  static traces = Object.freeze({
    store: async ({ home }) => new (await import('../traces.mjs')).ClaudeTraceStore({ home, harness: this.harnessName }),
    newest: (store) => store.newestTranscript(),
    projector: async ({ store }) => new (await import('../atif.mjs')).ClaudeAtifProjector({ store }),
    ownsPath: (file) => String(file).includes(`${path.sep}.claude${path.sep}`),
  });
  static docs = Object.freeze([
    'claude-code/mcp', 'claude-code/plugins', 'claude-code/plugins-reference', 'claude-code/hooks',
    'claude-code/settings', 'claude-code/desktop', 'claude-code/memory', 'claude-code/managed-mcp',
    'claude-code/cli-reference', 'claude-code/headless',
  ]);

  constructor(o) {
    super({ ...o, name: 'claude' });
    this.entries = new JsonEntries();
  }

  get settingsPath() {
    return path.join(this.configHome, 'settings.json');
  }

  /** The exact keys oathe owns in settings.json — the whole Claude install. */
  #ownedEntries() {
    return [
      {
        // "directory" is what the INSTALLED CLI's settings schema accepts (verified empirically
        // on 2.1.241: the pre-existing custom-plugins entry validates, a "local" entry is
        // rejected with "Invalid input" and the whole file is skipped). The docs say "local";
        // the binary outranks the docs.
        path: ['extraKnownMarketplaces', 'oathe'],
        value: { source: { source: 'directory', path: this.paths.packageRoot } },
      },
      { path: ['enabledPlugins', 'oathe@oathe'], value: true },
    ];
  }

  get registryDir() {
    return path.join(this.configHome, 'plugins');
  }

  get installedFile() {
    return path.join(this.registryDir, 'installed_plugins.json');
  }

  #readRegistry(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  #installedVersion() {
    return this.#readRegistry(this.installedFile)?.plugins?.['oathe@oathe']?.[0]?.version ?? null;
  }

  /** The path the CLI's registry records for the oathe marketplace, or null when unknown. */
  #marketplacePath() {
    return this.#readRegistry(path.join(this.registryDir, 'known_marketplaces.json'))?.oathe?.source?.path ?? null;
  }

  installedPluginVersion() {
    return this.#installedVersion();
  }

  #cli(args) {
    const result = this.exec.run('claude', args);
    if (result.status !== 0) {
      throw new HarnessOnboardError('CLAUDE_CLI_FAILED',
        `claude ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`, { args });
    }
    return result;
  }

  /** What init writes — from the owned entries and the registry the CLI materializes into. */
  describe() {
    return [
      `${this.settingsPath}: owns ${this.#ownedEntries().map((e) => e.path.join('.')).join(' and ')}`,
      `\`claude plugin install oathe@oathe\` — the Oathe plugin (board at session start, auto-save hooks, the oathe_* MCP tools), recorded in ${this.installedFile}`,
    ];
  }

  onboard({ manifest, version }) {
    const entries = this.#ownedEntries();
    const before = fs.existsSync(this.settingsPath) ? fs.readFileSync(this.settingsPath, 'utf8') : '';
    manifest.backupOnce(this.settingsPath);
    const { content, changed } = this.entries.apply(before, entries);
    if (changed) {
      fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
      fs.writeFileSync(this.settingsPath, content);
    }
    manifest.upsert({
      harness: this.name,
      file: this.settingsPath,
      kind: 'json-path',
      detail: { paths: entries.map((e) => e.path) },
      blockVersion: version,
      sha256: sha256Hex(JSON.stringify(entries)),
    });

    // MATERIALIZE via the CLI. The settings entries above are the declarative pin, but the CLI's
    // own registry (installed_plugins.json) is what sessions load from — and the install is a
    // CACHED COPY keyed by version, so a version change must evict the stale copy.
    const installed = this.#installedVersion();
    // UPGRADE PATH: the package root MOVES between installs (an nvm node switch, npm link). A
    // marketplace known at another path materializes stale code — even at the same version —
    // so a moved source is a materialization exactly like a version change: re-register the
    // marketplace from this root, then reinstall the plugin from it.
    const known = this.#marketplacePath();
    const moved = known !== null && known !== this.paths.packageRoot;
    let materialized = false;
    if (installed !== version || moved) {
      if (moved) this.#cli(['plugin', 'marketplace', 'remove', 'oathe']);
      if (known === null || moved) this.#cli(['plugin', 'marketplace', 'add', this.paths.packageRoot]);
      // Removing a marketplace takes the plugins installed from it along (observed on the real
      // CLI, 2026-08-29) — decide the uninstall on what is installed NOW, not what was.
      if (this.#installedVersion() !== null) this.#cli(['plugin', 'uninstall', 'oathe@oathe']);
      this.#cli(['plugin', 'install', 'oathe@oathe']);
      if (this.#installedVersion() !== version) {
        throw new HarnessOnboardError('CLAUDE_VERIFICATION_FAILED',
          'verification failed: `claude plugin install oathe@oathe` reported success but '
          + `${this.installedFile} does not record version ${version} — refusing to record an `
          + 'install that cannot be proven');
      }
      materialized = true;
    }
    manifest.upsert({
      harness: this.name,
      file: this.installedFile,
      kind: 'cli-managed',
      detail: {
        id: 'plugin-install',
        proof: 'oathe@oathe',
        undo: [['plugin', 'uninstall', 'oathe@oathe'], ['plugin', 'marketplace', 'remove', 'oathe']],
      },
      blockVersion: version,
      sha256: sha256Hex('oathe@oathe'),
    });
    return [
      { action: 'settings-owned-paths', file: this.settingsPath, changed },
      { action: materialized ? 'plugin-installed' : 'plugin-already-current', file: this.installedFile },
    ];
  }

  offboard({ manifest }) {
    const rows = manifest.removeWhere((r) => r.harness === this.name);
    const actions = [];
    for (const row of rows.filter((r) => r.kind === 'cli-managed')) {
      for (const undo of row.detail?.undo ?? []) {
        const result = this.exec.run('claude', undo);
        actions.push({ action: `claude-undo-${undo.join('-')}`, status: result.status });
      }
    }
    if (!fs.existsSync(this.settingsPath)) return [...actions, { action: 'settings-absent' }];
    const before = fs.readFileSync(this.settingsPath, 'utf8');
    const ownedPaths = rows.flatMap((r) => r.detail?.paths ?? []);
    const { content, changed } = this.entries.remove(before, ownedPaths);
    if (changed) fs.writeFileSync(this.settingsPath, content);
    return [...actions, { action: 'settings-owned-paths-removed', file: this.settingsPath, changed }];
  }
}
