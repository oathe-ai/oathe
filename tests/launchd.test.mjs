// oathe — the launchd machinery, generalized out of the notch (connection-lane phase 2):
// ONE module wires any oathe LaunchAgent — per-home hashed labels, an escaped plist with
// arbitrary ProgramArguments, the bootstrap-retried-inside-a-budget restart with the pid
// read back from launchd (the 0.4.4 lesson, carried not re-derived), and the job probe.
// The notch and the serve daemon are its two consumers; their tests stay their own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  serviceLabel, agentPathFor, launchAgentPlistFor, bootstrapWithRetry, launchdJob,
} from '../src/launchd.mjs';

test('serviceLabel: base + 12 hex of the REAL home — stable per home, distinct per home and per base', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-ld-'));
  try {
    const label = serviceLabel(home, 'ai.oathe.serve');
    assert.match(label, /^ai\.oathe\.serve\.[0-9a-f]{12}$/);
    assert.equal(serviceLabel(home, 'ai.oathe.serve'), label, 'stable');
    assert.notEqual(serviceLabel(home, 'ai.oathe.notch'), label, 'the base names the service');
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-ld2-'));
    assert.notEqual(serviceLabel(other, 'ai.oathe.serve'), label, 'the hash keeps homes apart');
    fs.rmSync(other, { recursive: true, force: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('agentPathFor: the plist lives in the home LaunchAgents dir, NAMED BY ITS LABEL — doctor derives the label back from the filename', () => {
  assert.equal(agentPathFor('/Users/x', 'ai.oathe.serve.abcdef123456'),
    '/Users/x/Library/LaunchAgents/ai.oathe.serve.abcdef123456.plist');
});

test('launchAgentPlistFor: arbitrary ProgramArguments in order, RunAtLoad + KeepAlive, node bin dir leading PATH', () => {
  const plist = launchAgentPlistFor({
    label: 'ai.oathe.serve.abc', programArguments: ['/Users/x/.oathe/bin/oathe', 'serve'], nodeBinDir: '/n/bin',
  });
  assert.match(plist, /<string>\/Users\/x\/\.oathe\/bin\/oathe<\/string>\s*<string>serve<\/string>/,
    'every argument its own string, in order');
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<string>\/n\/bin:/, 'the running node bin dir leads the agent PATH');
});

test('launchAgentPlistFor ESCAPES the interpolations — a path with & or < must not produce an invalid plist (latent in 0.4.4)', () => {
  const plist = launchAgentPlistFor({
    label: 'ai.oathe.serve.abc', programArguments: ['/Users/a & b/<oathe>', 'serve'], nodeBinDir: '/n/bin',
  });
  assert.ok(plist.includes('/Users/a &amp; b/&lt;oathe&gt;'), plist);
  assert.ok(!plist.includes('a & b'), 'no raw ampersand survives into the XML');
});

/** launchd as it behaves live: bootstrap refused while the old job drains, then taken; print
 *  answers a pid only once loaded. */
function launchdFake({ refusals }) {
  let left = refusals;
  let loaded = false;
  const calls = [];
  return {
    calls,
    run(cmd, args) {
      calls.push([cmd, ...args]);
      if (args[0] === 'bootstrap') {
        if (left > 0) { left -= 1; return { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\n' }; }
        loaded = true;
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'print') {
        return loaded ? { status: 0, stdout: '\tstate = running\n\tpid = 777\n', stderr: '' }
          : { status: 113, stdout: '', stderr: 'Could not find service\n' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

test('bootstrapWithRetry: retries the refused bootstrap inside the budget, then reads the pid back from launchd', () => {
  const exec = launchdFake({ refusals: 3 });
  const sleeps = [];
  const out = bootstrapWithRetry({
    label: 'ai.oathe.serve.abc', file: '/tmp/x.plist', uid: 501, exec,
    deadlineMs: 1000, pollMs: 10, sleep: (ms) => sleeps.push(ms), now: (() => { let t = 0; return () => (t += 5); })(),
  });
  assert.equal(out.pid, 777, 'the SUPERVISOR answered, not the program');
  assert.equal(exec.calls.filter(([, a]) => a === 'bootstrap').length, 4, 'three refusals, one take');
  assert.ok(sleeps.every((ms) => ms <= 10), 'polls at the configured pace');
});

test('bootstrapWithRetry: past the budget the answer is NOT RUNNING with launchd\'s own last word — never a silent written', () => {
  const exec = launchdFake({ refusals: Infinity });
  const out = bootstrapWithRetry({
    label: 'ai.oathe.serve.abc', file: '/tmp/x.plist', uid: 501, exec,
    deadlineMs: 50, pollMs: 10, sleep: () => {}, now: (() => { let t = 0; return () => (t += 20); })(),
  });
  assert.equal(out.pid, null);
  assert.match(out.detail, /Input\/output error/, 'launchd\'s last word rides the report');
});

test('bootstrapWithRetry: the poll never sleeps past the deadline — the budget is the budget', () => {
  const exec = launchdFake({ refusals: 2 });
  const sleeps = [];
  let clock = 0;
  bootstrapWithRetry({
    label: 'l', file: '/tmp/x.plist', uid: 501, exec,
    deadlineMs: 25, pollMs: 10, sleep: (ms) => sleeps.push(ms), now: () => (clock += 8),
  });
  assert.ok(sleeps.every((ms) => ms >= 0), 'never negative');
  assert.ok(sleeps.length > 0 && Math.min(...sleeps) < 10, 'the final poll is clamped to what remains');
});

test('launchdJob (moved home): {label, loaded, pid} from launchctl print', () => {
  const exec = launchdFake({ refusals: 0 });
  exec.run('launchctl', ['bootstrap', 'gui/501', '/tmp/x.plist']);
  assert.deepEqual(launchdJob({ label: 'l', exec, uid: 501 }), { label: 'l', loaded: true, pid: 777 });
});
