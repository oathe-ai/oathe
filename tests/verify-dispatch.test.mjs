// The MCP verify dispatcher: verification runs DETACHED (the session never freezes), the
// substrate's claim stays the mutex, and an in-flight review is a typed refusal — never a
// lying {started: true}. docs/UX.md: refusals are typed and name the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dispatchVerification } from '../src/verify-dispatch.mjs';
import { buildPaths } from '../src/paths.mjs';

function world({ claimRow = null } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-dispatch-')));
  const paths = buildPaths({ OATHE_HOME: path.join(home, '.oathe') });
  const spawned = [];
  const child = { unref() { this.unrefd = true; }, pid: 4242 };
  return {
    home,
    paths,
    spawned,
    child,
    query: async (sql, params) => {
      assert.match(sql, /work_claim/);
      assert.equal(params[1], 'verify:t-1');
      return { rows: claimRow ? [claimRow] : [] };
    },
    spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return child; },
  };
}

const base = (w, extra = {}) => ({
  taskId: 't-1', orgId: 'oathe', query: w.query, paths: w.paths, cwd: '/work/space',
  env: { PATH: '/usr/bin', HOME: w.home, OATHE_EXECUTION_ATTEMPT_ID: 'attempt-9', OATHE_LAUNCHED_HARNESS: 'claude', OATHE_DB: 'db' },
  spawn: w.spawn, ...extra,
});

test('no in-flight review: spawns the bin verb DETACHED with the workspace cwd, a log file, a scrubbed env — and answers with the durable addresses', async () => {
  const w = world();
  const out = await dispatchVerification(base(w, { engine: 'codex' }));
  assert.equal(out.started, true);
  assert.equal(out.verification_task, 'verify:t-1');
  assert.equal(w.spawned.length, 1);
  const { cmd, args, opts } = w.spawned[0];
  assert.equal(cmd, process.execPath);
  assert.equal(args[0], path.join(w.paths.packageRoot, 'bin/oathe.mjs'));
  assert.deepEqual(args.slice(1), ['verify', 't-1', '--engine', 'codex']);
  assert.equal(opts.detached, true, 'own process group — survives the session');
  assert.equal(opts.cwd, '/work/space', 'the bin derives the workspace from cwd');
  assert.equal(w.child.unrefd, true, 'unref — the server never waits on it');
  assert.equal(opts.env.OATHE_EXECUTION_ATTEMPT_ID, undefined, 'the judged session attempt id must not stamp the verifier');
  assert.equal(opts.env.OATHE_LAUNCHED_HARNESS, undefined);
  assert.equal(opts.env.OATHE_DB, 'db', 'substrate env rides along');
  assert.equal(opts.stdio[0], 'ignore');
  assert.equal(typeof opts.stdio[1], 'number', 'stdout goes to a real fd (the log)');
  assert.ok(out.log.startsWith(w.paths.logsDir), `log under logsDir: ${out.log}`);
  assert.ok(fs.existsSync(out.log), 'the log file exists');
  assert.match(out.note, /board/, 'the answer points at the durable address');
  assert.match(out.note, /reopen/i, 'and says what a rejection does');
});

test('an ACTIVE review with a live lease is OATHE_VERIFY_IN_FLIGHT naming holder and lease — and does NOT spawn', async () => {
  const w = world({ claimRow: { principal_id: 'oathe-verifier', state: 'active', ownership_valid_until: new Date(Date.now() + 3600e3).toISOString() } });
  await assert.rejects(dispatchVerification(base(w)),
    (e) => e.code === 'OATHE_VERIFY_IN_FLIGHT' && /oathe-verifier/.test(e.message));
  assert.equal(w.spawned.length, 0, 'never a lying started:true');
});

test('an ACTIVE review with an EXPIRED lease refuses too and names the manual fix — no auto-heal', async () => {
  const w = world({ claimRow: { principal_id: 'oathe-verifier', state: 'active', ownership_valid_until: new Date(Date.now() - 3600e3).toISOString() } });
  await assert.rejects(dispatchVerification(base(w)),
    (e) => e.code === 'OATHE_VERIFY_IN_FLIGHT' && /expired/.test(e.message) && /oathe yield/.test(e.message));
  assert.equal(w.spawned.length, 0);
});

test('a terminal prior review (settled/asserted) does not block a new dispatch; the log is overwritten per run and its name is sanitized', async () => {
  const w = world({ claimRow: { principal_id: 'oathe-verifier', state: 'completion_asserted', ownership_valid_until: null } });
  const out = await dispatchVerification(base(w));
  assert.equal(out.started, true);
  assert.doesNotMatch(path.basename(out.log), /[:]/, 'no colon in a filename');
  fs.writeFileSync(out.log, 'OLD RUN\n');
  const again = await dispatchVerification(base(w));
  assert.equal(again.log, out.log, 'one log per task');
  assert.equal(fs.readFileSync(out.log, 'utf8'), '', 'overwritten, not appended — no retention machinery');
});
