import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { spawnCaged } from '../src/runtime/simple-cage.mjs';

const SH = '/bin/sh';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'simple-cage-')); }
function exited(cage) {
  return new Promise((resolve) => cage.child.on('exit', (code, signal) => resolve({ code, signal })));
}

test('the child environment is REPLACED: only the passed map plus the fence stamp', async () => {
  const dir = tmp();
  const dump = path.join(dir, 'env.txt');
  process.env.SIMPLE_CAGE_LEAK_PROBE = 'leak-me';
  try {
    const cage = spawnCaged({
      unit: 'test-env', env: { PATH: process.env.PATH, MARKER: 'yes' },
      cmd: SH, args: ['-c', `env > "${dump}"`], cwd: dir, stdio: 'ignore',
    });
    const { code } = await exited(cage);
    assert.equal(code, 0);
    const seen = fs.readFileSync(dump, 'utf8');
    assert.match(seen, /^MARKER=yes$/m);
    assert.match(seen, /^OATHE_EXECUTION_ATTEMPT_ID=.+$/m, 'the cage stamps the fence itself');
    assert.ok(!seen.includes('SIMPLE_CAGE_LEAK_PROBE'), 'process.env must not bleed through');
    await cage.teardownProvenEmpty();
  } finally {
    delete process.env.SIMPLE_CAGE_LEAK_PROBE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exit code and signal reach the caller through child, the contract surface', async () => {
  const dir = tmp();
  try {
    const cage = spawnCaged({
      unit: 'test-exit', env: { PATH: process.env.PATH },
      cmd: SH, args: ['-c', 'exit 7'], cwd: dir, stdio: 'ignore',
    });
    const { code } = await exited(cage);
    assert.equal(code, 7);
    await cage.teardownProvenEmpty();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('enumerate() sees the live child and its DESCENDANTS, then answers empty after exit', async () => {
  const dir = tmp();
  try {
    // parent spawns a grandchild sleeper, then both linger briefly
    const cage = spawnCaged({
      unit: 'test-enum', env: { PATH: process.env.PATH },
      cmd: SH, args: ['-c', 'sleep 0.6 & sleep 0.4'], cwd: dir, stdio: 'ignore',
    });
    await new Promise((r) => setTimeout(r, 150));
    const alive = cage.enumerate();
    assert.ok(alive.length >= 2, `expected parent+grandchild in the group, saw [${alive}]`);
    await exited(cage);
    const done = await cage.teardownProvenEmpty();
    assert.equal(done.empty, true);
    assert.equal(cage.enumerate().length, 0, 'after proven-empty teardown nothing lives');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a SIGSTOPped child still counts as LIVE — held is not gone', async () => {
  const dir = tmp();
  try {
    const cage = spawnCaged({
      unit: 'test-stop', env: { PATH: process.env.PATH },
      cmd: SH, args: ['-c', 'sleep 5'], cwd: dir, stdio: 'ignore',
    });
    await new Promise((r) => setTimeout(r, 100));
    process.kill(cage.child.pid, 'SIGSTOP');
    try {
      assert.ok(cage.enumerate().length > 0, 'stopped processes are enumerated as live');
    } finally {
      process.kill(cage.child.pid, 'SIGCONT');
    }
    const out = await cage.teardownProvenEmpty();
    assert.equal(out.empty, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('teardown escalates SIGTERM → SIGKILL and the result is RE-OBSERVED emptiness', async () => {
  const dir = tmp();
  try {
    // a child that ignores SIGTERM: only the KILL escalation can end it
    const cage = spawnCaged({
      unit: 'test-kill', env: { PATH: process.env.PATH },
      cmd: SH, args: ['-c', "trap '' TERM; sleep 30"], cwd: dir, stdio: 'ignore',
      graceMs: 300,
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(cage.enumerate().length > 0);
    const out = await cage.teardownProvenEmpty();
    assert.equal(out.empty, true, `TERM-immune child must fall to SIGKILL: ${out.detail}`);
    assert.equal(cage.enumerate().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('alive() agrees with enumerate() on both sides of a teardown — and spawns nothing', async () => {
  const { spawnCaged } = await import('../src/runtime/simple-cage.mjs');
  const cage = spawnCaged({
    unit: 'alive-probe', env: { PATH: process.env.PATH }, cmd: 'sleep', args: ['30'],
    cwd: process.cwd(), stdio: 'ignore',
  });
  assert.equal(cage.alive(), true, 'a running group is alive');
  assert.ok(cage.enumerate().length > 0, 'and enumerable');
  const out = await cage.teardownProvenEmpty();
  assert.equal(out.empty, true);
  assert.equal(cage.alive(), false, 'an empty group is dead to the probe too');
});
