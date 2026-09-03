// oathe — the Cursor adapter (IDE and CLI share ~/.cursor). Wiring is installer-written owned
// entries: an object path in ~/.cursor/mcp.json and owned ARRAY elements among the user's own
// hooks in ~/.cursor/hooks.json — both documented user-editable and hot-reloaded, verified
// after every write, backed up once, manifest-recorded, byte-reversible.
// Schema source: .harness-docs/cursor/{mcp,hooks}.md (pinned 2026-08-28).
//
// Cursor quirks the facts encode: hook payloads carry `workspace_roots[]` (not `cwd`) and the
// sessionStart reply is snake_case fire-and-forget; hook scripts see CURSOR_PROJECT_DIR (with
// a CLAUDE_PROJECT_DIR compatibility alias) but MCP servers get NO documented project-dir env
// var — the resolution ladder's roots/cwd steps carry them; a machine can hold ~/.cursor with
// no CLI on PATH (the IDE alone), so detection keys on the config home; user hooks run from
// ~/.cursor and GUI apps read no shell rc, so every command is an ABSOLUTE path.

import fs from 'node:fs';
import path from 'node:path';

import { Harness, HarnessOnboardError } from './harness.mjs';
import { workspaceRootsDialect } from './dialects.mjs';
import { JsonArrayEntries, JsonEntries } from '../blocks.mjs';
import { sha256Hex } from '../manifest.mjs';

const HOOK_EVENTS = Object.freeze([
  { event: 'sessionStart', script: 'render-board' },
  { event: 'stop', script: 'heartbeat' },
  { event: 'preCompact', script: 'frame-note' },
]);

export class CursorHarness extends Harness {
  static harnessName = 'cursor';
  static displayName = 'Cursor';
  static covers = 'CLI/Desktop App';
  // The CLI is `agent` — cursor/cli-installation.md verifies an install with `agent --version`.
  static bin = 'agent';
  static clientNames = Object.freeze(['cursor']);
  static contextFiles = Object.freeze(['AGENTS.md']);
  static projectDirEnvVar = 'CURSOR_PROJECT_DIR';
  // Wiring is our own JSON writes into ~/.cursor — no CLI needed; the IDE alone reads them.
  static wiring = Object.freeze({ needsCli: false });
  static hooks = Object.freeze({ dialect: workspaceRootsDialect });
  // The missing primitive, restored (founder ruling 2026-08-30: all harnesses on the same
  // primitives, each with its own adapter): cursor launches its interactive CLI agent.
  static launch = Object.freeze({ splash: true, bin: 'agent' });
  // The IDE's spawned children live inside Cursor.app (helper bundles). The CLI's process is
  // named by whichever path launched it: `agent`, or `cursor-agent` — the versioned executable
  // the `agent` symlink points to, and the installer's legacy symlink (measured 2026-09-02).
  static cliExecutables = Object.freeze(['agent', 'cursor-agent']);
  static surfaces = Object.freeze({
    ownsExec: (exec) => exec.includes(`${path.sep}Cursor.app${path.sep}`)
      || CursorHarness.cliExecutables.includes(path.basename(exec)),
    name: () => 'cursor',
  });
  // cursor/cli-installation.md:10 (pinned 2026-08-29).
  static install = Object.freeze({ installer: 'curl https://cursor.com/install -fsS | bash', bin: 'agent', versionArgs: ['--version'] });
  // Headless: `agent -p --output-format json` → {type:"result", result} (cursor/cli-output-format.md);
  // CI auth CURSOR_API_KEY (cursor/cli-authentication.md:24-37, cli-github-actions.md:17). A fresh
  // project dir is untrusted — the CLI refuses to run there without --trust (observed live 2026-08-29).
  static headless = Object.freeze({
    auth: ['CURSOR_API_KEY'],
    command: (prompt, model = null) => ['agent', ['-p', prompt, '--trust', '--output-format', 'json', ...(model ? ['--model', model] : [])]],
    extract: (stdout) => CursorHarness.extractJsonResult(stdout),
  });
  static traces = null; // Cursor keeps no session store we read; its hook payload carries transcript_path: null
  static docs = Object.freeze([
    'cursor/mcp', 'cursor/mcp-install-links', 'cursor/hooks', 'cursor/plugins', 'cursor/plugins-reference',
    'cursor/third-party-hooks', 'cursor/rules', 'cursor/cli-mcp', 'cursor/cli-configuration', 'cursor/cli-overview',
    'cursor/cli-installation', 'cursor/cli-using', 'cursor/cli-headless', 'cursor/cli-authentication',
    'cursor/cli-parameters', 'cursor/cli-output-format', 'cursor/cli-slash-commands', 'cursor/cli-permissions',
    'cursor/cli-github-actions', 'cursor/cli-shell-mode',
  ]);

  /** The IDE alone leaves no bin on PATH — the config home is the install evidence. */
  static installedFrom(presence) {
    return presence.configHome !== null;
  }

  constructor(o) {
    super({ ...o, name: 'cursor' });
    this.entries = new JsonEntries();
    this.arrays = new JsonArrayEntries();
  }



  get mcpConfigPath() {
    return path.join(this.configHome, 'mcp.json');
  }

  get hooksConfigPath() {
    return path.join(this.configHome, 'hooks.json');
  }

  /**
   * The absolute oathe address: the bin resolved on PATH, else <node> <packageRoot>/bin/oathe.mjs
   * (npm shims ride `#!/usr/bin/env node`, and a GUI-launched Cursor may not carry node's dir
   * on PATH — the fallback names the runtime explicitly).
   * @returns {{command: string, args: string[], hookPrefix: string}}
   */
  #oatheAddress() {
    for (const dir of this.envPath.split(':').filter(Boolean)) {
      const candidate = path.join(dir, 'oathe');
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return { command: candidate, args: [], hookPrefix: candidate };
      } catch { /* keep looking */ }
    }
    const binPath = path.join(this.paths.packageRoot, 'bin/oathe.mjs');
    return { command: process.execPath, args: [binPath], hookPrefix: `${process.execPath} ${binPath}` };
  }

  #hookEntries(hookPrefix) {
    return HOOK_EVENTS.map(({ event, script }) => {
      const command = `${hookPrefix} hook ${script}`;
      return {
        path: ['hooks', event],
        element: { command },
        owns: (el) => el?.command === command,
        match: command,
      };
    });
  }

  #readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  #applyOwned({ file, before, apply, verify, refuseDetail }) {
    const { content, changed } = apply(before);
    if (changed) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    const now = this.#readJson(file);
    if (now === null || !verify(now)) {
      throw new HarnessOnboardError('CURSOR_VERIFICATION_FAILED',
        `verification failed: ${file} does not carry ${refuseDetail} after the write — refusing `
        + 'to record an install that cannot be proven');
    }
    return changed;
  }

  /** What init writes — from the same address and entries onboard() writes. */
  describe() {
    const address = this.#oatheAddress();
    return [
      `${this.mcpConfigPath}: mcpServers.oathe → ${[address.command, ...address.args, 'mcp'].join(' ')}`,
      `${this.hooksConfigPath}: ${HOOK_EVENTS.map((h) => h.event).join(', ')} → ${address.hookPrefix} hook <script>`,
    ];
  }

  onboard({ manifest, version }) {
    const address = this.#oatheAddress();
    const mcpValue = { command: address.command, args: [...address.args, 'mcp'] };
    const hookEntries = this.#hookEntries(address.hookPrefix);
    const hooksAbsentBefore = !fs.existsSync(this.hooksConfigPath);
    // Version ownership is decided ONCE (the file we created carries our version key) and then
    // carried forward — a re-run must upsert the SAME row identity, never mint a sibling.
    const ownsVersion = hooksAbsentBefore
      || (manifest.rows.find((r) => r.harness === this.name && r.file === this.hooksConfigPath
        && r.kind === 'json-array')?.detail?.owns_version ?? false);

    manifest.backupOnce(this.mcpConfigPath);
    const mcpBefore = fs.existsSync(this.mcpConfigPath) ? fs.readFileSync(this.mcpConfigPath, 'utf8') : '';
    const mcpChanged = this.#applyOwned({
      file: this.mcpConfigPath,
      before: mcpBefore,
      apply: (text) => this.entries.apply(text, [{ path: ['mcpServers', 'oathe'], value: mcpValue }]),
      verify: (doc) => doc?.mcpServers?.oathe?.command === mcpValue.command,
      refuseDetail: 'the mcpServers.oathe entry',
    });
    manifest.upsert({
      harness: this.name,
      file: this.mcpConfigPath,
      kind: 'json-path',
      detail: { paths: [['mcpServers', 'oathe']] },
      blockVersion: version,
      sha256: sha256Hex(JSON.stringify([{ path: ['mcpServers', 'oathe'], value: mcpValue }])),
    });

    manifest.backupOnce(this.hooksConfigPath);
    const hooksBefore = hooksAbsentBefore ? '' : fs.readFileSync(this.hooksConfigPath, 'utf8');
    const hooksChanged = this.#applyOwned({
      file: this.hooksConfigPath,
      before: hooksBefore,
      apply: (text) => {
        let out = this.arrays.apply(text, hookEntries);
        // A file we created carries the schema version; a user's own file keeps their value.
        if (hooksAbsentBefore) out = this.entries.apply(out.content, [{ path: ['version'], value: 1 }]);
        return out;
      },
      verify: (doc) => hookEntries.every((e) => (doc?.hooks?.[e.path[1]] ?? []).some((el) => el?.command === e.match)),
      refuseDetail: 'the three owned oathe hook entries',
    });
    manifest.upsert({
      harness: this.name,
      file: this.hooksConfigPath,
      kind: 'json-array',
      detail: {
        entries: hookEntries.map((e) => ({ path: e.path, match: e.match })),
        owns_version: ownsVersion,
      },
      blockVersion: version,
      sha256: sha256Hex(JSON.stringify(hookEntries.map((e) => e.match))),
    });

    return [
      { action: 'cursor-mcp-entry', file: this.mcpConfigPath, changed: mcpChanged },
      { action: 'cursor-hooks-entries', file: this.hooksConfigPath, changed: hooksChanged },
    ];
  }

  offboard({ manifest }) {
    const rows = manifest.removeWhere((r) => r.harness === this.name);
    const actions = [];
    for (const row of rows) {
      if (!fs.existsSync(row.file)) {
        actions.push({ action: 'cursor-target-absent', file: row.file });
        continue;
      }
      const before = fs.readFileSync(row.file, 'utf8');
      let result;
      if (row.kind === 'json-path') {
        result = this.entries.remove(before, row.detail?.paths ?? []);
      } else {
        const entries = (row.detail?.entries ?? []).map((e) => ({
          path: e.path,
          owns: (el) => el?.command === e.match,
        }));
        result = this.arrays.remove(before, entries);
        if (row.detail?.owns_version) result = this.entries.remove(result.content, [['version']]);
      }
      if (result.changed) fs.writeFileSync(row.file, result.content);
      actions.push({ action: `cursor-removed-${row.kind}`, file: row.file, changed: result.changed });
    }
    return actions;
  }
}
