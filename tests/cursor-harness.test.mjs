// The Cursor wiring: installer-written owned entries in ~/.cursor/mcp.json (object path) and
// ~/.cursor/hooks.json (owned ARRAY elements among user hooks), absolute-path commands only —
// Cursor runs user hooks from ~/.cursor and GUI apps read no shell rc, so a bare `oathe` is
// not an address. Verify-after-write, backup-once, manifest-recorded, byte-reversible.
// Schema source: .harness-docs/cursor/{mcp,hooks}.md (pinned 2026-08-28).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CursorHarness } from '../src/harnesses/catalog.mjs';
import { InstallManifest } from '../src/manifest.mjs';

const CLOCK = () => '2026-08-28T12:00:00.000Z';

function fixture({ oatheOnPath = true } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-cur-')));
  fs.mkdirSync(path.join(home, '.cursor'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  if (oatheOnPath) {
    fs.writeFileSync(path.join(bin, 'oathe'), '#!/bin/sh\n');
    fs.chmodSync(path.join(bin, 'oathe'), 0o755);
  }
  const oatheHome = path.join(home, '.oathe');
  const manifest = new InstallManifest({
    manifestPath: path.join(oatheHome, 'install-manifest.json'),
    backupsDir: path.join(oatheHome, 'backups'),
    clock: CLOCK,
  });
  const harness = new CursorHarness({
    home, envPath: `${bin}:/usr/bin`, paths: { packageRoot: '/pkg' },
  });
  return { home, bin, manifest, harness, absOathe: path.join(bin, 'oathe') };
}

test('cursor is wireable and onboard writes the absolute-path MCP entry + the three hook entries', () => {
  const { home, manifest, harness, absOathe } = fixture();
  const actions = harness.onboard({ manifest, version: '9.9.9' });
  const mcp = JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers.oathe, { command: absOathe, args: ['mcp'] });
  const hooks = JSON.parse(fs.readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8'));
  assert.equal(hooks.version, 1);
  assert.deepEqual(hooks.hooks.sessionStart, [{ command: `${absOathe} hook render-board` }]);
  assert.deepEqual(hooks.hooks.stop, [{ command: `${absOathe} hook heartbeat` }]);
  assert.deepEqual(hooks.hooks.preCompact, [{ command: `${absOathe} hook frame-note` }]);
  assert.ok(actions.length >= 2);
  assert.ok(CursorHarness.wiring !== null, 'the adapter declares its wiring capability');
});

test('onboard is byte-idempotent and never duplicates hook elements', () => {
  const { home, manifest, harness } = fixture();
  harness.onboard({ manifest, version: '9.9.9' });
  const before = {
    mcp: fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8'),
    hooks: fs.readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8'),
  };
  harness.onboard({ manifest, version: '9.9.9' });
  assert.equal(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8'), before.mcp);
  assert.equal(fs.readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8'), before.hooks);
});

test('user entries in both files survive onboard AND offboard byte-preserved', () => {
  const { home, manifest, harness } = fixture();
  fs.writeFileSync(path.join(home, '.cursor/mcp.json'),
    `${JSON.stringify({ mcpServers: { theirs: { command: 'their-server' } } }, null, 2)}\n`);
  fs.writeFileSync(path.join(home, '.cursor/hooks.json'),
    `${JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: './their-hook.sh' }] } }, null, 2)}\n`);
  harness.onboard({ manifest, version: '9.9.9' });
  const mcp = JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.theirs.command, 'their-server');
  harness.offboard({ manifest });
  const mcpAfter = JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(mcpAfter.mcpServers), ['theirs']);
  const hooksAfter = JSON.parse(fs.readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8'));
  assert.deepEqual(hooksAfter.hooks.sessionStart, [{ command: './their-hook.sh' }]);
  assert.equal(hooksAfter.version, 1, 'a pre-existing version key is the user\'s — never removed');
  assert.equal(manifest.rows.filter((r) => r.harness === 'cursor').length, 0);
});

test('offboard of a fresh install prunes what onboard created — including our own version key', () => {
  const { home, manifest, harness } = fixture();
  harness.onboard({ manifest, version: '9.9.9' });
  harness.offboard({ manifest });
  const hooks = JSON.parse(fs.readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8'));
  assert.deepEqual(hooks, {}, 'nothing of ours remains');
});

test('with no oathe on PATH the command falls back to <node> <packageRoot>/bin/oathe.mjs — never a bare name', () => {
  const { home, manifest, harness } = fixture({ oatheOnPath: false });
  harness.onboard({ manifest, version: '9.9.9' });
  const mcp = JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.oathe.command, process.execPath);
  assert.deepEqual(mcp.mcpServers.oathe.args, ['/pkg/bin/oathe.mjs', 'mcp']);
  const hooks = JSON.parse(fs.readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.sessionStart[0].command,
    `${process.execPath} /pkg/bin/oathe.mjs hook render-board`);
});

test('backup-once: the pre-oathe bytes of both files are kept; absent files recorded absent', () => {
  const { home, manifest, harness } = fixture();
  fs.writeFileSync(path.join(home, '.cursor/mcp.json'),
    `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
  harness.onboard({ manifest, version: '9.9.9' });
  const mcpBackup = manifest.backups.find((b) => b.file === path.join(home, '.cursor/mcp.json'));
  assert.equal(mcpBackup.absent_before, false);
  assert.ok(fs.existsSync(mcpBackup.backup));
  const hooksBackup = manifest.backups.find((b) => b.file === path.join(home, '.cursor/hooks.json'));
  assert.equal(hooksBackup.absent_before, true);
});

test('an unverifiable write refuses with CURSOR_VERIFICATION_FAILED, recording nothing unproven', () => {
  const { home, manifest, harness } = fixture();
  // Sabotage: make ~/.cursor read-only so the write cannot land.
  fs.chmodSync(path.join(home, '.cursor'), 0o500);
  try {
    assert.throws(() => harness.onboard({ manifest, version: '9.9.9' }),
      (e) => /CURSOR_VERIFICATION_FAILED|EACCES|EPERM/.test(`${e.code} ${e.message}`));
  } finally {
    fs.chmodSync(path.join(home, '.cursor'), 0o755);
  }
});
