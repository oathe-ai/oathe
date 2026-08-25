// oathe — the harness layer. One base class holds what every harness shares (detection inputs,
// manifest access, exec seam); each subclass owns the ONE way its harness is onboarded:
// Claude via owned JSON paths in ~/.claude/settings.json, Codex via its sanctioned CLIs with
// post-verification (its config stanzas are Codex-managed bookkeeping — writing them by hand
// is how two managers end up owning one file).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { JsonEntries } from './blocks.mjs';
import { sha256Hex } from './manifest.mjs';

export class HarnessOnboardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HarnessOnboardError';
    this.code = code;
    this.details = details;
  }
}

const defaultExec = {
  run(cmd, args) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  },
};

export class Harness {
  /**
   * @param {{name: string, home: string, envPath?: string, paths: object,
   *          exec?: {run: (cmd: string, args: string[]) => {status: number, stdout: string, stderr: string}}}} o
   */
  constructor({ name, home, envPath = process.env.PATH ?? '', paths, exec = defaultExec }) {
    this.name = name;
    this.home = home;
    this.envPath = envPath;
    this.paths = paths;
    this.exec = exec;
  }

  /** The harness's config home (e.g. ~/.claude) — subclasses name theirs. */
  get configHome() {
    return path.join(this.home, `.${this.name}`);
  }

  binOnPath(bin) {
    return this.envPath.split(':').filter(Boolean).some((dir) => {
      try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch { return false; }
    });
  }

  /** @returns {{name: string, installed: boolean, evidence: object}} */
  detect() {
    const binFound = this.binOnPath(this.name);
    const homeFound = fs.existsSync(this.configHome);
    return {
      name: this.name,
      installed: binFound && homeFound,
      evidence: { bin_on_path: binFound, config_home: homeFound ? this.configHome : null },
    };
  }
}

export class ClaudeHarness extends Harness {
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

  #marketplaceKnown() {
    return this.#readRegistry(path.join(this.registryDir, 'known_marketplaces.json'))?.oathe !== undefined;
  }

  #cli(args) {
    const result = this.exec.run('claude', args);
    if (result.status !== 0) {
      throw new HarnessOnboardError('CLAUDE_CLI_FAILED',
        `claude ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`, { args });
    }
    return result;
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
    let materialized = false;
    if (installed !== version) {
      if (!this.#marketplaceKnown()) this.#cli(['plugin', 'marketplace', 'add', this.paths.packageRoot]);
      if (installed !== null) this.#cli(['plugin', 'uninstall', 'oathe@oathe']);
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

export class CodexHarness extends Harness {
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
        add: ['plugin', 'add', 'oathe@oathe'],
        proof: '[plugins."oathe@oathe"]',
        undo: ['plugin', 'remove', 'oathe@oathe'],
      },
      {
        id: 'mcp-server',
        add: ['mcp', 'add', 'oathe', '--', 'oathe', 'mcp'],
        proof: '[mcp_servers.oathe]',
        undo: ['mcp', 'remove', 'oathe'],
      },
    ];
  }

  onboard({ manifest, version }) {
    manifest.backupOnce(this.configPath);
    for (const reg of this.#registrations()) {
      const result = this.exec.run('codex', reg.add);
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
    return actions;
  }
}

/** @returns {Array<{name: string, installed: boolean, evidence: object}>} */
export function census(harnesses) {
  return harnesses.map((h) => h.detect());
}
