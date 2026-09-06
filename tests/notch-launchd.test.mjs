// oathe — the notch lifecycle against the REAL launchd (darwin; skipped elsewhere). Every other
// notch test plays launchd with a fake; 0.4.3 shipped a notch that did not come back after an
// upgrade because no gate ever asked the real supervisor. This one does, in a sandbox home
// (its own hashed label — it can never touch the machine's notch) with a stand-in app that just
// sleeps: wire twice (the second wire IS the upgrade — bootout, then bootstrap while launchd is
// still tearing the old job down), and each time launchd itself must report a pid; unwire, and
// launchd must report nothing. Runs in the heavy lane on a Mac and in CI's macOS lane.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { wireNotch, unwireNotch, notchStatus, notchLabel } from '../src/notch.mjs';
import { InstallManifest } from '../src/manifest.mjs';
import { OatheConfig } from '../src/config.mjs';

const darwin = process.platform === 'darwin';

test('against the real launchd: wire, re-wire (the upgrade), each time a pid launchd reports; unwire, and launchd holds nothing', { skip: !darwin && 'launchd is a darwin surface' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-launchd-'));
  const app = path.join(home, 'OatheNotch');
  fs.writeFileSync(app, '#!/bin/sh\nexec sleep 3600\n');
  fs.chmodSync(app, 0o755);
  const env = { HOME: home, OATHE_HOME: path.join(home, '.oathe'), OATHE_NOTCH_APP: app };
  const config = new OatheConfig({ env, cwd: home });
  const manifest = new InstallManifest({ manifestPath: path.join(home, '.oathe', 'install-manifest.json'), backupsDir: path.join(home, '.oathe', 'backups') });
  const uid = process.getuid();
  const label = notchLabel(home);
  try {
    const pids = [];
    for (const wire of ['install', 'upgrade']) {
      const actions = wireNotch({ home, manifest, config, version: wire, uid, packageRoot: home });
      const outcome = actions.find((a) => /^notch-/.test(a.action));
      assert.equal(outcome?.action, 'notch-running', `${wire}: ${JSON.stringify(actions)}`);
      const launchd = notchStatus({ home, uid });
      assert.equal(launchd.pid, outcome.pid, `${wire}: the row says what launchd says`);
      // The pid above IS the supervisor's answer; `state` passes through xpcproxy while the
      // spawn takes off (seen live under suite load, 2026-09-04) — poll the settle briefly
      // rather than race launchd's own bookkeeping.
      let printed = '';
      for (let i = 0; i < 50; i += 1) {
        printed = spawnSync('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8' }).stdout;
        if (/state = running/.test(printed)) break;
        spawnSync('sleep', ['0.1']);
      }
      assert.match(printed, /state = running/, `${wire}: launchd runs the job`);
      pids.push(outcome.pid);
    }
    assert.notEqual(pids[0], pids[1], 'the upgrade restarted the job — a new pid, not the old copy kept');
    unwireNotch({ manifest, uid });
    assert.equal(notchStatus({ home, uid }).loaded, false, 'after unwire launchd holds nothing under the label');
  } finally {
    spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' }); // result unread: best-effort sweep after the assertions — a job already gone answers 'Could not find service'
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the SERVE DAEMON against the real launchd: wire, re-wire (the upgrade), a fresh pid each time; unwire, and launchd holds nothing', { skip: !darwin && 'launchd is a darwin surface' }, async () => {
  // Phase 2's own wire-twice pin (the verifier caught its absence, 2026-09-04): the daemon
  // rides the same asynchronous-bootout race the notch shipped dead through in 0.4.3, so the
  // same real supervisor must answer for it. The stand-in shim just sleeps — the daemon's
  // own behavior is pinned in tests/daemon.test.mjs; THIS lane pins launchd custody.
  const { wireServe, unwireServe, serveStatus, serveLabel } = await import('../src/serve.mjs');
  const { shimPath } = await import('../src/shim.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-launchd-srv-'));
  const shim = shimPath(home);
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, '#!/bin/sh\nexec sleep 3600\n');
  fs.chmodSync(shim, 0o755);
  const env = { HOME: home, OATHE_HOME: path.join(home, '.oathe') };
  const config = new OatheConfig({ env, cwd: home });
  const manifest = new InstallManifest({ manifestPath: path.join(home, '.oathe', 'install-manifest.json'), backupsDir: path.join(home, '.oathe', 'backups') });
  const uid = process.getuid();
  const label = serveLabel(home);
  try {
    const pids = [];
    for (const wire of ['install', 'upgrade']) {
      const actions = wireServe({ home, manifest, config, version: wire, uid });
      const outcome = actions.find((a) => /^serve-(running|not-running)/.test(a.action));
      assert.equal(outcome?.action, 'serve-running', `${wire}: ${JSON.stringify(actions)}`);
      const launchd = serveStatus({ home, uid });
      assert.equal(launchd.pid, outcome.pid, `${wire}: the row says what launchd says`);
      pids.push(outcome.pid);
    }
    assert.notEqual(pids[0], pids[1], 'the upgrade restarted the daemon — a new pid, and every forwarder pipe ends with the old one');
    unwireServe({ manifest, uid });
    assert.equal(serveStatus({ home, uid }).loaded, false, 'after unwire launchd holds nothing under the label');
  } finally {
    spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' }); // result unread: best-effort sweep after the assertions — a job already gone answers 'Could not find service'
    fs.rmSync(home, { recursive: true, force: true });
  }
});
