// oathe — the notch install lifecycle. The invariant under test: the LaunchAgent NEVER
// points at a directory that upgrades or packs rewrite in place (npm replaces the package
// tree; a re-signed binary under a running process is killed by the kernel and, without
// KeepAlive, stays dead). init materializes ONE immutable, version+content-keyed copy under
// the oathe home and points launchd there; a new version materializes a NEW key; uninstall
// removes exactly what was recorded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  NOTCH_LABEL, notchLabel, launchAgentPath, launchAgentPlist, packagedNotchApp,
  materializeNotchApp, wireNotch, unwireNotch,
} from '../src/notch.mjs';
import { InstallManifest } from '../src/manifest.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-notch-')); }

/** A fake packaged app bundle with distinguishable binary bytes. */
function plantApp(root, bytes = 'binary-v1') {
  const macos = path.join(root, 'notch', 'Oathe Notch.app', 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(root, 'notch', 'Oathe Notch.app', 'Contents', 'Info.plist'), '<plist/>');
  fs.writeFileSync(path.join(macos, 'OatheNotch'), bytes);
  return path.join(macos, 'OatheNotch');
}

function fakeExec() {
  const calls = [];
  return { calls, run: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; } };
}

function manifestIn(home) {
  return new InstallManifest({
    manifestPath: path.join(home, '.oathe', 'install-manifest.json'),
    backupsDir: path.join(home, '.oathe', 'backups'),
  });
}

const fakeConfig = (overrides = {}) => ({ get: (k) => overrides[k] ?? null });

test('launchAgentPlist keeps the agent alive and launches at load — a dead notch is a silent notch', () => {
  const plist = launchAgentPlist('/x/OatheNotch', { nodeBinDir: '/n/bin' });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<string>\/n\/bin:/, 'the running node bin dir leads the agent PATH');
});

test('materializeNotchApp copies the bundle to a version+content key and returns the materialized binary', () => {
  const home = tmp(); const root = tmp();
  try {
    const packaged = plantApp(root);
    const out = materializeNotchApp({ home, appBinary: packaged, version: '9.9.9' });
    assert.ok(out.binary.startsWith(path.join(home, '.oathe', 'notch', '9.9.9-')), out.binary);
    assert.ok(fs.existsSync(out.binary), 'binary exists at the materialized path');
    assert.ok(fs.existsSync(path.join(out.dir, 'Oathe Notch.app', 'Contents', 'Info.plist')),
      'the WHOLE bundle is materialized, not just the binary');
    // Same bytes → same key → idempotent, no churn.
    const again = materializeNotchApp({ home, appBinary: packaged, version: '9.9.9' });
    assert.equal(again.binary, out.binary);
    // New bytes → NEW key: a running process is never overwritten in place.
    fs.writeFileSync(packaged, 'binary-v2');
    const next = materializeNotchApp({ home, appBinary: packaged, version: '9.9.9' });
    assert.notEqual(next.dir, out.dir, 'changed bytes materialize a fresh key');
    assert.ok(fs.existsSync(out.binary), 'materialize alone never deletes the prior copy');
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
});

test('wireNotch points launchd at the MATERIALIZED copy, records both rows, prunes stale keys, restarts the agent', { skip: process.platform !== 'darwin' && 'LaunchAgents are a darwin surface' }, () => {
  const home = tmp(); const root = tmp();
  try {
    plantApp(root);
    const manifest = manifestIn(home);
    const exec = fakeExec();
    const actions = wireNotch({ home, manifest, config: fakeConfig(), version: 'v1', exec, uid: 501, packageRoot: root });
    assert.ok(actions.some((a) => a.action === 'launch-agent-written'));

    const agentFile = launchAgentPath(home);
    const plist = fs.readFileSync(agentFile, 'utf8');
    assert.ok(plist.includes(path.join(home, '.oathe', 'notch')),
      'the agent runs the materialized copy, never the package tree');
    assert.ok(!plist.includes(root), 'the mutable package tree appears NOWHERE in the agent');

    // The bin FACT rides the install: a hand-started app (no launchd PATH) reads the
    // stamped answer instead of gambling on a login shell that never sources .zshrc.
    const stamped = fs.readFileSync(path.join(home, '.oathe', 'notch',
      fs.readdirSync(path.join(home, '.oathe', 'notch'))[0], 'oathe-bin'), 'utf8').trim();
    assert.ok(stamped.startsWith(path.dirname(process.execPath)), 'the stamp names the wiring node\'s bin dir');
    assert.ok(stamped.endsWith('/oathe'), 'and the oathe bin inside it');

    const rows = manifest.rows;
    const agentRow = rows.find((r) => r.kind === 'launch-agent');
    const appRow = rows.find((r) => r.kind === 'notch-app');
    assert.ok(agentRow && appRow, 'both surfaces are manifest-owned');
    assert.ok(fs.existsSync(appRow.file), 'the notch-app row names the materialized dir');

    assert.deepEqual(exec.calls.map((c) => c[1]), ['bootout', 'bootstrap'], 're-run is the restart');

    // An upgrade (new bytes) re-wires to a NEW key and PRUNES the old one — launchd is
    // already off it (bootout precedes), so nothing yanks a running binary.
    fs.writeFileSync(packagedNotchApp(root), 'binary-v2');
    wireNotch({ home, manifest, config: fakeConfig(), version: 'v1', exec, uid: 501, packageRoot: root });
    const keys = fs.readdirSync(path.join(home, '.oathe', 'notch'));
    assert.equal(keys.length, 1, `exactly one materialized key survives, got: ${keys}`);
    const appRows = manifest.rows.filter((r) => r.kind === 'notch-app');
    assert.equal(appRows.length, 1, 'one notch-app row — the manifest tracks what exists');
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
});

test('wireNotch without the packaged binary reports the fact and touches nothing', { skip: process.platform !== 'darwin' && 'LaunchAgents are a darwin surface' }, () => {
  const home = tmp(); const root = tmp();
  try {
    const actions = wireNotch({ home, manifest: manifestIn(home), config: fakeConfig(), version: 'v1', exec: fakeExec(), uid: 501, packageRoot: root });
    assert.deepEqual(actions.map((a) => a.action), ['notch-binary-missing']);
    assert.ok(!fs.existsSync(launchAgentPath(home)));
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
});

test('unwireNotch boots the agent out and removes exactly the recorded files — materialized copy included', { skip: process.platform !== 'darwin' && 'LaunchAgents are a darwin surface' }, () => {
  const home = tmp(); const root = tmp();
  try {
    plantApp(root);
    const manifest = manifestIn(home);
    const exec = fakeExec();
    wireNotch({ home, manifest, config: fakeConfig(), version: 'v1', exec, uid: 501, packageRoot: root });
    exec.calls.length = 0;
    unwireNotch({ manifest, exec, uid: 501 });
    assert.ok(!fs.existsSync(launchAgentPath(home)), 'agent plist removed');
    assert.ok(!fs.existsSync(path.join(home, '.oathe', 'notch')) || fs.readdirSync(path.join(home, '.oathe', 'notch')).length === 0,
      'materialized copies removed');
    assert.equal(manifest.rows.filter((r) => r.kind === 'launch-agent' || r.kind === 'notch-app').length, 0);
    assert.ok(exec.calls.some((c) => c[1] === 'bootout' && c[2] === `gui/501/${notchLabel(home)}`));
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the launchd label derives from the HOME — a sandbox init can never bootout the real notch', () => {
  // The founder watched a full-suite run kill the live notch: the install-contract lane's
  // sandboxed init spoke the same fixed label as the real job. The label now NAMES the
  // installation, and installations are per-home.
  // No bare-label special case: sameness cannot be judged from inside an environment
  // (os.homedir() follows $HOME), so EVERY home hashes — the real one included.
  const sandboxHome = tmp();
  try {
    const derived = notchLabel(sandboxHome);
    assert.notEqual(derived, NOTCH_LABEL, 'never the bare product label');
    assert.ok(derived.startsWith(`${NOTCH_LABEL}.`), 'namespaced under the product label');
    assert.equal(derived, notchLabel(sandboxHome), 'deterministic per home');
    assert.notEqual(derived, notchLabel(os.homedir()), 'distinct homes, distinct labels');
    assert.notEqual(notchLabel(os.homedir()), NOTCH_LABEL, 'the real home hashes too');
  } finally { fs.rmSync(sandboxHome, { recursive: true, force: true }); }
});

test('wire and unwire speak the derived label end to end — file name, Label key, launchctl targets', { skip: process.platform !== 'darwin' && 'LaunchAgents are a darwin surface' }, () => {
  const home = tmp(); const root = tmp();
  try {
    plantApp(root);
    const manifest = manifestIn(home);
    const exec = fakeExec();
    wireNotch({ home, manifest, config: fakeConfig(), version: 'v1', exec, uid: 501, packageRoot: root });
    const label = notchLabel(home);
    const agentFile = launchAgentPath(home);
    assert.ok(agentFile.endsWith(`${label}.plist`), 'the plist file is named by the derived label');
    assert.ok(fs.readFileSync(agentFile, 'utf8').includes(`<string>${label}</string>`), 'the Label key matches');
    assert.ok(exec.calls.some((c) => c[1] === 'bootout' && c[2] === `gui/501/${label}`), 'bootout targets the derived label');
    assert.ok(!exec.calls.some((c) => String(c[2]).endsWith(`/${NOTCH_LABEL}`)), 'the REAL label is never touched from a sandbox home');
    exec.calls.length = 0;
    unwireNotch({ manifest, exec, uid: 501 });
    assert.ok(exec.calls.some((c) => c[1] === 'bootout' && c[2] === `gui/501/${label}`), 'unwire boots out what wire named');
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
});
