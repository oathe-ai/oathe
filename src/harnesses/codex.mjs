// oathe — the OpenAI Codex adapter (one host serves the CLI, the IDE extension, and the
// ChatGPT desktop app): three sanctioned CLIs register the install, and the config.toml
// stanza each one writes is the proof (its stanzas are Codex-managed bookkeeping — writing
// them by hand is how two managers end up owning one file). Every Codex-specific fact is a
// named member HERE. Codex allowlist-filters the env it hands MCP servers and documents no
// project-dir variable — the resolution ladder's cwd/refusal steps carry this harness.

import fs from 'node:fs';
import path from 'node:path';

import { Harness, HarnessOnboardError } from './harness.mjs';
import { cwdDialect } from './dialects.mjs';
import { sha256Hex } from '../manifest.mjs';

// The id Codex knows the plugin by (plugin@marketplace) — the registrations install it and
// Codex keys its own hook-trust bookkeeping under it.
const PLUGIN_ID = 'oathe@oathe';

/** realpath when the path exists (macOS aliases /var → /private/var), else the normalized path. */
function realpathOr(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

export class CodexHarness extends Harness {
  static harnessName = 'codex';
  static displayName = 'Codex';
  static covers = 'CLI/Desktop App'; // ChatGPT desktop rides the same ~/.codex wiring
  static bin = 'codex';
  static clientNames = Object.freeze(['codex']);
  static contextFiles = Object.freeze(['AGENTS.md']);
  static projectDirEnvVar = null;
  static wiring = Object.freeze({ needsCli: true });
  static hooks = Object.freeze({ dialect: cwdDialect });
  // Codex buries hook output in its ctrl+T transcript overlay, unrendered — the launcher's
  // ANSI splash into terminal scrollback is this harness's quirk.
  static launch = Object.freeze({ splash: true, bin: 'codex' });
  // The ChatGPT desktop app embeds codex (…/ChatGPT.app/Contents/Resources/codex, live
  // trace 2026-08-30) — the SURFACE is chatgpt there, codex in a terminal.
  static surfaces = Object.freeze({
    ownsExec: (exec) => path.basename(exec) === 'codex',
    name: ({ appBundle }) => (appBundle !== null && path.basename(appBundle) === 'ChatGPT.app' ? 'chatgpt' : 'codex'),
  });
  // Codex reads its global instructions before any work, in EVERY session — the one channel
  // that reaches a ChatGPT-desktop session, whose staging cwd carries no folder fence. Its
  // rule (docs, agents-md): AGENTS.override.md if it exists, otherwise AGENTS.md.
  static globalContextFiles = Object.freeze(['AGENTS.override.md', 'AGENTS.md']);
  // The ChatGPT desktop app runs every conversation from a directory it stages under the
  // config home — not a project folder. Sessions there serve the FULL board and are never
  // activated (R-BOARD-SCOPE); this member is the only place the staging path is spelled.
  static syntheticWorkspaceParent = '.chatgpt-projects';

  static isSyntheticWorkspaceDir({ dir, home }) {
    const parent = realpathOr(path.join(this.configHomeFor(home), this.syntheticWorkspaceParent));
    return realpathOr(dir).startsWith(`${parent}${path.sep}`);
  }

  static install = Object.freeze({ npm: '@openai/codex', bin: 'codex', versionArgs: ['--version'] });
  // Non-interactive auth: CODEX_API_KEY "provides an API key to a non-interactive Codex
  // process" (codex/environment-variables.md:49, pinned 2026-08-29).
  static headless = Object.freeze({
    auth: ['CODEX_API_KEY'],
    command: (prompt, model = null) => ['codex', ['exec', '--skip-git-repo-check', ...(model ? ['-m', model] : []), prompt]],
    extract: (stdout) => stdout,
  });
  static traces = Object.freeze({
    store: async ({ home }) => new (await import('../traces.mjs')).CodexTraceStore({ home, harness: this.harnessName }),
    newest: (store) => store.newestRollout(),
    projector: async ({ store }) => new (await import('../atif.mjs')).CodexAtifProjector({ store }),
    ownsPath: (file) => String(file).includes(`${path.sep}.codex${path.sep}`),
  });
  static docs = Object.freeze([
    'codex/mcp', 'codex/config-reference', 'codex/environment-variables', 'codex/agents-md', 'codex/hooks',
    'codex/projects', 'codex/plugins', 'codex/submit-claude-plugin',
  ]);

  constructor(o) {
    super({ ...o, name: 'codex' });
  }

  get configPath() {
    return path.join(this.configHome, 'config.toml');
  }

  /**
   * The sanctioned registrations, each with the CLI that makes it, the config.toml stanza that
   * proves it landed, and the CLI that undoes it.
   */
  #registrations() {
    return [
      {
        id: 'marketplace',
        add: ['plugin', 'marketplace', 'add', this.paths.packageRoot],
        proof: '[marketplaces.oathe]',
        undo: ['plugin', 'marketplace', 'remove', 'oathe'],
      },
      {
        id: 'plugin',
        add: ['plugin', 'add', PLUGIN_ID],
        proof: `[plugins."${PLUGIN_ID}"]`,
        undo: ['plugin', 'remove', PLUGIN_ID],
      },
      {
        id: 'mcp-server',
        add: ['mcp', 'add', 'oathe', '--', 'oathe', 'mcp'],
        proof: '[mcp_servers.oathe]',
        undo: ['mcp', 'remove', 'oathe'],
      },
    ];
  }

  /** What init writes — from the registrations the CLI makes and the global fence target. */
  describe() {
    const globals = this.constructor.globalContextFiles.map((f) => path.join(this.configHome, f)).join(' (or ');
    return [
      `${this.configPath}: ${this.#registrations().map((r) => r.proof).join(', ')} via the codex CLI (marketplace, plugin, MCP server)`,
      `${globals}${this.constructor.globalContextFiles.length > 1 ? ')' : ''}: the standing Oathe rule for every Codex session — ChatGPT desktop reads it too`,
    ];
  }

  onboard({ manifest, version }) {
    manifest.backupOnce(this.configPath);
    for (const reg of this.#registrations()) {
      let result = this.exec.run('codex', reg.add);
      // UPGRADE PATH: the package root MOVED (an nvm node switch, npm link) — the CLI refuses a
      // marketplace "already added from a different source". Re-register from this root: the
      // undo the manifest already records, then the add again, proof-checked below.
      if (result.status !== 0 && /already added from a different source/.test(result.stderr)) {
        this.exec.run('codex', reg.undo);
        result = this.exec.run('codex', reg.add);
      }
      if (result.status !== 0) {
        throw new HarnessOnboardError('CODEX_CLI_FAILED',
          `codex ${reg.add.join(' ')} exited ${result.status}: ${result.stderr.trim()}`, { reg: reg.id });
      }
      const config = fs.existsSync(this.configPath) ? fs.readFileSync(this.configPath, 'utf8') : '';
      if (!config.includes(reg.proof)) {
        throw new HarnessOnboardError('CODEX_VERIFICATION_FAILED',
          `verification failed: codex ${reg.add.join(' ')} reported success but ${this.configPath} `
          + `carries no ${reg.proof} stanza — refusing to record an install that cannot be proven`,
          { reg: reg.id });
      }
      manifest.upsert({
        harness: this.name,
        file: this.configPath,
        kind: 'cli-managed',
        detail: { id: reg.id, proof: reg.proof, undo: reg.undo },
        blockVersion: version,
        sha256: sha256Hex(reg.proof),
      });
    }
    return this.#registrations().map((r) => ({ action: `codex-${r.id}` }));
  }

  offboard({ manifest }) {
    const rows = manifest.removeWhere((r) => r.harness === this.name);
    const actions = [];
    // Undo in reverse install order, so the plugin is gone before its marketplace is.
    for (const row of rows.reverse()) {
      const undo = row.detail?.undo;
      if (!undo) continue;
      const result = this.exec.run('codex', undo);
      actions.push({ action: `codex-undo-${row.detail.id}`, status: result.status });
    }
    // Codex keys hook-trust records under our plugin id; the undo CLIs orphan them, and an
    // orphan carrying 'oathe' is still an oathe entry on this surface (ruling 2026-08-29:
    // delete exactly the keys prefixed by our id, touch nothing else).
    if (this.#clearHooksState() > 0) actions.push({ action: 'codex-hooks-state-cleared', status: 0 });
    return actions;
  }

  /** Remove the `[hooks.state."<PLUGIN_ID>:…"]` tables from config.toml; every other line stays. */
  #clearHooksState() {
    if (!fs.existsSync(this.configPath)) return 0;
    const prefix = `[hooks.state."${PLUGIN_ID}:`;
    const kept = [];
    let removed = 0;
    let skipping = false;
    for (const line of fs.readFileSync(this.configPath, 'utf8').split('\n')) {
      if (line.trimStart().startsWith('[')) {
        skipping = line.trimStart().startsWith(prefix);
        if (skipping) removed += 1;
      }
      if (!skipping) kept.push(line);
    }
    if (removed > 0) fs.writeFileSync(this.configPath, kept.join('\n'));
    return removed;
  }
}
