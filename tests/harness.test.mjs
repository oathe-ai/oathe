import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClaudeHarness, CodexHarness, census } from '../src/harness.mjs';
import { InstallManifest } from '../src/manifest.mjs';
import { buildPaths } from '../src/paths.mjs';

const CLOCK = () => '2026-08-25T00:00:00.000Z';

function scratchHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-home-'));
  const oatheHome = path.join(home, '.oathe');
  const manifest = InstallManifest.load({
    manifestPath: path.join(oatheHome, 'install-manifest.json'),
    backupsDir: path.join(oatheHome, 'backups'),
    clock: CLOCK,
  });
  return { home, manifest };
}

/** A PATH dir containing an executable named `name`. */
function fakeBinDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-bin-'));
  fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n');
  fs.chmodSync(path.join(dir, name), 0o755);
  return dir;
}

function fakeExec(script = {}) {
  const calls = [];
  return {
    calls,
    run(cmd, args) {
      calls.push([cmd, ...args]);
      const key = [cmd, ...args].join(' ');
      for (const [prefix, result] of Object.entries(script)) {
        if (key.startsWith(prefix)) return { status: 0, stdout: '', stderr: '', ...result };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

const paths = buildPaths({});

// ---------------------------------------------------------------- detection

test('ClaudeHarness detects only when the claude binary AND ~/.claude both exist', () => {
  const { home } = scratchHome();
  const bin = fakeBinDir('claude');
  const none = new ClaudeHarness({ home, envPath: '/nonexistent', paths });
  assert.equal(none.detect().installed, false);
  const binOnly = new ClaudeHarness({ home, envPath: bin, paths });
  assert.equal(binOnly.detect().installed, false);
  fs.mkdirSync(path.join(home, '.claude'));
  const both = new ClaudeHarness({ home, envPath: bin, paths });
  assert.equal(both.detect().installed, true);
});

test('CodexHarness detects on ~/.codex plus the codex binary', () => {
  const { home } = scratchHome();
  const bin = fakeBinDir('codex');
  assert.equal(new CodexHarness({ home, envPath: bin, paths }).detect().installed, false);
  fs.mkdirSync(path.join(home, '.codex'));
  assert.equal(new CodexHarness({ home, envPath: bin, paths }).detect().installed, true);
  assert.equal(new CodexHarness({ home, envPath: '/nonexistent', paths }).detect().installed, false);
});

test('census reports each harness with its detection result', () => {
  const { home } = scratchHome();
  const results = census([
    new ClaudeHarness({ home, envPath: '/nonexistent', paths }),
    new CodexHarness({ home, envPath: '/nonexistent', paths }),
  ]);
  assert.deepEqual(results.map((r) => r.name), ['claude', 'codex']);
  assert.deepEqual(results.map((r) => r.installed), [false, false]);
});

// ---------------------------------------------------------------- Claude onboarding

test('ClaudeHarness.onboard writes marketplace + enablement into settings.json via owned paths, backs up, records manifest rows', () => {
  const { home, manifest } = scratchHome();
  fs.mkdirSync(path.join(home, '.claude'));
  const settingsPath = path.join(home, '.claude/settings.json');
  fs.writeFileSync(settingsPath, `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`);

  const h = new ClaudeHarness({ home, envPath: '/nonexistent', paths });
  const actions = h.onboard({ manifest, version: '0.1.0' });

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.theme, 'dark');
  assert.deepEqual(settings.extraKnownMarketplaces.oathe, {
    source: { source: 'local', path: paths.packageRoot },
  });
  assert.equal(settings.enabledPlugins['oathe@oathe'], true);

  const backup = manifest.backups.find((b) => b.file === settingsPath);
  assert.ok(backup && backup.backup, 'settings.json backed up before first write');
  assert.equal(fs.readFileSync(backup.backup, 'utf8'), `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`);

  const row = manifest.rows.find((r) => r.harness === 'claude' && r.file === settingsPath);
  assert.equal(row.kind, 'json-path');
  assert.equal(row.block_version, '0.1.0');
  assert.ok(actions.length > 0);
});

test('ClaudeHarness.onboard twice is byte-idempotent', () => {
  const { home, manifest } = scratchHome();
  fs.mkdirSync(path.join(home, '.claude'));
  const settingsPath = path.join(home, '.claude/settings.json');
  const h = new ClaudeHarness({ home, envPath: '/nonexistent', paths });
  h.onboard({ manifest, version: '0.1.0' });
  const first = fs.readFileSync(settingsPath, 'utf8');
  h.onboard({ manifest, version: '0.1.0' });
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), first);
  assert.equal(manifest.rows.filter((r) => r.harness === 'claude').length, 1);
  assert.equal(manifest.backups.filter((b) => b.file === settingsPath).length, 1);
});

test('ClaudeHarness.offboard removes exactly the owned keys and drops its manifest rows', () => {
  const { home, manifest } = scratchHome();
  fs.mkdirSync(path.join(home, '.claude'));
  const settingsPath = path.join(home, '.claude/settings.json');
  fs.writeFileSync(settingsPath, `${JSON.stringify({ theme: 'dark', enabledPlugins: { 'x@y': true } }, null, 2)}\n`);
  const h = new ClaudeHarness({ home, envPath: '/nonexistent', paths });
  h.onboard({ manifest, version: '0.1.0' });
  h.offboard({ manifest });
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.theme, 'dark');
  assert.deepEqual(settings.enabledPlugins, { 'x@y': true });
  assert.equal('extraKnownMarketplaces' in settings, false);
  assert.equal(manifest.rows.filter((r) => r.harness === 'claude').length, 0);
});

// ---------------------------------------------------------------- Codex onboarding

test('CodexHarness.onboard runs the sanctioned CLIs, verifies config.toml, and records cli-managed rows', () => {
  const { home, manifest } = scratchHome();
  fs.mkdirSync(path.join(home, '.codex'));
  const configPath = path.join(home, '.codex/config.toml');
  const exec = {
    calls: [],
    run(cmd, args) {
      this.calls.push([cmd, ...args]);
      // The real CLIs write config.toml; the fake mirrors that so verification has bytes to read.
      fs.writeFileSync(configPath, [
        '[marketplaces.oathe]', 'source_type = "local"', `source = "${paths.packageRoot}"`,
        '[plugins."oathe@oathe"]', 'enabled = true',
        '[mcp_servers.oathe]', 'command = "node"',
      ].join('\n'));
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  const h = new CodexHarness({ home, envPath: '/nonexistent', paths, exec });
  h.onboard({ manifest, version: '0.1.0' });

  const flat = exec.calls.map((c) => c.join(' '));
  assert.ok(flat.some((c) => c.startsWith(`codex plugin marketplace add ${paths.packageRoot}`)), flat.join('|'));
  assert.ok(flat.some((c) => c.startsWith('codex plugin add oathe@oathe')));
  assert.ok(flat.some((c) => c.startsWith(`codex mcp add oathe -- node ${paths.mcpServerPath}`)));

  const rows = manifest.rows.filter((r) => r.harness === 'codex');
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.kind === 'cli-managed'));
  assert.ok(manifest.backups.find((b) => b.file === configPath), 'config.toml backed up before the CLIs touch it');
});

test('CodexHarness.onboard fails loudly when verification cannot find the stanza the CLI claimed to write', () => {
  const { home, manifest } = scratchHome();
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex/config.toml'), '# untouched\n');
  const exec = fakeExec(); // succeeds but writes nothing
  const h = new CodexHarness({ home, envPath: '/nonexistent', paths, exec });
  assert.throws(() => h.onboard({ manifest, version: '0.1.0' }), /verif/i);
});

test('CodexHarness.offboard runs the inverse CLIs and drops its rows', () => {
  const { home, manifest } = scratchHome();
  fs.mkdirSync(path.join(home, '.codex'));
  const configPath = path.join(home, '.codex/config.toml');
  const exec = {
    calls: [],
    run(cmd, args) {
      this.calls.push([cmd, ...args]);
      fs.writeFileSync(configPath, [
        '[marketplaces.oathe]', '[plugins."oathe@oathe"]', '[mcp_servers.oathe]',
      ].join('\n'));
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  const h = new CodexHarness({ home, envPath: '/nonexistent', paths, exec });
  h.onboard({ manifest, version: '0.1.0' });
  exec.calls.length = 0;
  h.offboard({ manifest });
  const flat = exec.calls.map((c) => c.join(' '));
  assert.ok(flat.some((c) => c.startsWith('codex mcp remove oathe')));
  assert.ok(flat.some((c) => c.startsWith('codex plugin remove oathe@oathe')));
  assert.ok(flat.some((c) => c.startsWith('codex plugin marketplace remove oathe')));
  assert.equal(manifest.rows.filter((r) => r.harness === 'codex').length, 0);
});
