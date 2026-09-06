// oathe — the serve daemon's install lifecycle (connection-lane phase 2): wired exactly like
// the notch, through the ONE launchd machinery (src/launchd.mjs) — per-home hashed label,
// manifest-owned plist, bootstrap retried inside a config budget with the pid read back from
// launchd — and launchd runs THE SHIM (`~/.oathe/bin/oathe serve`): the durable address is
// the program, so a node move re-stamps one file and the daemon follows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SERVE_LABEL, serveLabel, serveSocketPath, wireServe, unwireServe, serveStatus } from '../src/serve.mjs';
import { notchLabel } from '../src/notch.mjs';
import { agentPathFor } from '../src/launchd.mjs';
import { shimPath } from '../src/shim.mjs';
import { InstallManifest } from '../src/manifest.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-serve-')); }

function manifestIn(home) {
  return new InstallManifest({
    manifestPath: path.join(home, '.oathe', 'install-manifest.json'),
    backupsDir: path.join(home, '.oathe', 'backups'),
  });
}

function fakeExec() {
  const calls = [];
  return {
    calls,
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: args[0] === 'print' ? '\tpid = 909\n' : '', stderr: '' };
    },
  };
}

const fakeConfig = (overrides = {}) => ({
  get: (k) => ({ serveRestartSeconds: 1, serveRestartPollMs: 1, serveSocket: null, ...overrides })[k] ?? null,
});

function plantShim(home) {
  const file = shimPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
  return file;
}

test('serveLabel rides the shared per-home hashing and never collides with the notch\'s', () => {
  const home = tmp();
  try {
    assert.match(serveLabel(home), new RegExp(`^${SERVE_LABEL.replaceAll('.', '\\.')}\\.[0-9a-f]{12}$`));
    assert.notEqual(serveLabel(home), notchLabel(home), 'two services, two labels, one home hash');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('serveSocketPath: the config key wins; the default lives under the oathe home', () => {
  assert.equal(serveSocketPath({ oatheHome: '/x/.oathe' }, fakeConfig()), '/x/.oathe/serve.sock');
  assert.equal(serveSocketPath({ oatheHome: '/x/.oathe' }, fakeConfig({ serveSocket: '/tmp/other.sock' })), '/tmp/other.sock');
});

test('wireServe writes the shim-addressed agent, records it as harness serve, and reads the pid back from launchd', { skip: process.platform !== 'darwin' && 'LaunchAgents are a darwin surface' }, () => {
  const home = tmp();
  try {
    const shim = plantShim(home);
    const manifest = manifestIn(home);
    const exec = fakeExec();
    const actions = wireServe({ home, manifest, config: fakeConfig(), version: '9.9.9', exec, sleep: () => {} });
    const file = agentPathFor(home, serveLabel(home));
    assert.ok(fs.existsSync(file), 'the agent landed, named by its label (doctor derives it back)');
    const plist = fs.readFileSync(file, 'utf8');
    assert.ok(plist.includes(`<string>${shim}</string><string>serve</string>`),
      'launchd runs the SHIM with the serve verb — the durable address is the program');
    const row = manifest.rows.find((r) => r.harness === 'serve' && r.kind === 'launch-agent');
    assert.equal(row?.file, file, 'manifest-owned under the serve harness — the notch\'s sweep never touches it');
    assert.deepEqual(actions.at(-1), { action: 'serve-running', pid: 909, label: serveLabel(home) },
      'the SUPERVISOR answered, not the program');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('wireServe without the shim states the fact and touches nothing — the address must exist before the daemon points at it', { skip: process.platform !== 'darwin' && 'LaunchAgents are a darwin surface' }, () => {
  const home = tmp();
  try {
    const manifest = manifestIn(home);
    const actions = wireServe({ home, manifest, config: fakeConfig(), version: '9.9.9', exec: fakeExec(), sleep: () => {} });
    assert.deepEqual(actions, [{ action: 'serve-shim-missing', file: shimPath(home) }]);
    assert.ok(!fs.existsSync(agentPathFor(home, serveLabel(home))));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('unwireServe boots out and removes exactly ITS rows — the notch\'s agent is another owner\'s', { skip: process.platform !== 'darwin' && 'LaunchAgents are a darwin surface' }, () => {
  const home = tmp();
  try {
    plantShim(home);
    const manifest = manifestIn(home);
    const notchPlist = path.join(home, 'Library', 'LaunchAgents', `${notchLabel(home)}.plist`);
    manifest.upsert({ harness: 'notch', file: notchPlist, kind: 'launch-agent', detail: {}, blockVersion: '9', sha256: 'x' });
    const exec = fakeExec();
    wireServe({ home, manifest, config: fakeConfig(), version: '9.9.9', exec, sleep: () => {} });
    const actions = unwireServe({ manifest, exec });
    assert.ok(actions.some((a) => a.action === 'serve-agent-removed'));
    assert.ok(!fs.existsSync(agentPathFor(home, serveLabel(home))));
    assert.ok(exec.calls.some((c) => c[1] === 'bootout' && c[2].includes(serveLabel(home))));
    assert.ok(manifest.rows.some((r) => r.harness === 'notch'), 'the notch row stays for unwireNotch');
    assert.ok(!manifest.rows.some((r) => r.harness === 'serve'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('serveStatus asks launchd about the serve label', () => {
  const home = tmp();
  try {
    const exec = fakeExec();
    const status = serveStatus({ home, exec, uid: 501 });
    assert.deepEqual(status, { label: serveLabel(home), loaded: true, pid: 909 });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
