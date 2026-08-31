// The lock/atomic-write helper under the registry and manifest: many sessions' hooks and MCP
// servers write ~/.oathe files concurrently. Writes are temp-then-rename (a reader never sees a
// torn file); the lock is a lockdir spin (mkdir is atomic on POSIX) with a bounded wait — on
// timeout the caller proceeds lock-free, because registration is idempotent and a hook must
// never deadlock a session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicWriteJson, withFileLock } from '../src/fslock.mjs';

function scratchFile(name = 'doc.json') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-lock-')));
  return path.join(dir, name);
}

test('atomicWriteJson creates parent dirs and writes pretty JSON with a trailing newline', () => {
  const file = path.join(path.dirname(scratchFile()), 'deep/nested/doc.json');
  atomicWriteJson(file, { a: 1 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "a": 1\n}\n');
});

test('a reader never sees a torn file: concurrent writers land whole documents only', async () => {
  const file = scratchFile();
  atomicWriteJson(file, { n: 0 });
  const writer = `
    import { atomicWriteJson } from ${JSON.stringify(fileURLToPath(new URL('../src/fslock.mjs', import.meta.url)))};
    const file = process.argv[1];
    for (let i = 0; i < 50; i++) atomicWriteJson(file, { n: i, pad: 'x'.repeat(2000) });
  `;
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ['--input-type=module', '-e', writer, file]));
  let torn = 0;
  const done = Promise.all(children.map((c) => new Promise((r) => c.on('exit', r))));
  for (let i = 0; i < 200; i++) {
    try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch { torn++; }
    await new Promise((r) => setTimeout(r, 1));
  }
  const codes = await done;
  assert.deepEqual(codes, [0, 0, 0, 0]);
  assert.equal(torn, 0, 'every read parsed — rename is the only publish');
});

test('withFileLock serializes writers: interleaved increments are never lost', async () => {
  const file = scratchFile('counter.json');
  atomicWriteJson(file, { n: 0 });
  const bump = () => withFileLock(file, async () => {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    await new Promise((r) => setTimeout(r, 5)); // widen the race window
    atomicWriteJson(file, { n: doc.n + 1 });
  });
  await Promise.all(Array.from({ length: 8 }, bump));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 8);
});

test('a stale lockdir older than staleMs is broken instead of waited on', async () => {
  const file = scratchFile();
  const lockDir = `${file}.lock`;
  fs.mkdirSync(lockDir);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, old, old);
  const ran = await withFileLock(file, () => 'ran', { timeoutMs: 500, staleMs: 10_000 });
  assert.equal(ran, 'ran');
  assert.ok(!fs.existsSync(lockDir), 'the lock is released after fn');
});

test('lock acquisition gives up after the bound and proceeds — a held lock never deadlocks a hook', async () => {
  const file = scratchFile();
  fs.mkdirSync(`${file}.lock`); // fresh foreign lock that never releases
  const started = Date.now();
  const result = await withFileLock(file, () => 'proceeded', { timeoutMs: 300, staleMs: 60_000 });
  assert.equal(result, 'proceeded');
  assert.ok(Date.now() - started >= 250, 'the bound was actually waited');
  assert.ok(fs.existsSync(`${file}.lock`), 'a live foreign lock is not stolen');
});

test('the lock is released even when fn throws', async () => {
  const file = scratchFile();
  await assert.rejects(withFileLock(file, () => { throw new Error('boom'); }), /boom/);
  assert.ok(!fs.existsSync(`${file}.lock`));
  assert.equal(await withFileLock(file, () => 'again'), 'again');
});
