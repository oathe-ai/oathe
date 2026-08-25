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
    assert.match(seen, /^FIRIA_EXECUTION_ATTEMPT_ID=.+$/m, 'the cage stamps the fence itself');
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
