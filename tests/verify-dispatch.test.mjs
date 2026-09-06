// The MCP verify dispatcher: verification runs DETACHED (the session never freezes), the
// substrate's claim stays the mutex, and an in-flight review is a typed refusal — never a
// lying {started: true}. docs/UX.md: refusals are typed and name the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dispatchVerification, dispatchEngineUpdate } from '../src/verify-dispatch.mjs';
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

// ---------------------------------------------------------------- the wait says it is still judging

import { awaitVerdict, verifierSeam } from '../src/verify-dispatch.mjs';

/** A substrate that answers "no verdict yet" `silentPolls` times, then a rejection. */
function verdictAfter(silentPolls) {
  let polls = 0;
  return async (sql) => {
    if (/cell\.verification v/.test(sql)) {
      polls += 1;
      return polls > silentPolls
        ? { rows: [{ result: 'rejected', proposition: 'rejected: not yet' }] }
        : { rows: [] };
    }
    if (/SELECT state FROM cell\.work_claim/.test(sql)) return { rows: [{ state: 'active' }] };
    return { rows: [] };
  };
}

test('awaitVerdict TICKS while it waits — every progress interval, with the elapsed time — so a transport can be told the judgment is still running; no tick after the verdict', async () => {
  let clock = 0;
  const ticks = [];
  const out = await awaitVerdict({
    taskId: 't-1', pid: 4242, orgId: 'oathe', query: verdictAfter(7), since: '2026-09-05T00:00:00Z',
    pollMs: 1000, sleep: async (ms) => { clock += ms; }, now: () => clock, isAlive: () => true,
    onTick: (tick) => ticks.push(tick), tickMs: 3000,
  });
  assert.equal(out.verdict, 'rejected');
  assert.deepEqual(ticks.map((t) => t.elapsedMs), [3000, 6000], 'a tick at every interval crossed while waiting (7 polls = 7s), none at the answer');
  const quiet = await awaitVerdict({
    taskId: 't-1', pid: 4242, orgId: 'oathe', query: verdictAfter(2), since: '2026-09-05T00:00:00Z',
    pollMs: 1000, sleep: async () => {}, isAlive: () => true,
  });
  assert.equal(quiet.verdict, 'rejected', 'no onTick, no ticking — the default is the old behaviour exactly');
});

test('the verifier seam threads a caller\'s progress into the wait: each tick becomes one message naming the task and the seconds elapsed', async () => {
  const w = world();
  const messages = [];
  let clock = 0;
  const seam = verifierSeam({
    orgId: 'oathe', query: verdictAfter(4), paths: w.paths, cwd: '/work/space', env: { PATH: '/usr/bin', HOME: w.home },
    spawn: w.spawn, progressIntervalMs: 2000, pollMs: 1000, sleep: async (ms) => { clock += ms; }, now: () => clock, isAlive: () => true,
  });
  const out = await seam({ taskId: 't-1', progress: (m) => messages.push(m) });
  assert.equal(out.verdict, 'rejected');
  assert.deepEqual(messages, ['verifying t-1 — 2s', 'verifying t-1 — 4s'], 'the words ride from Node; the transport only forwards them');
  const silent = await seam({ taskId: 't-1' });
  assert.equal(silent.verdict, 'rejected', 'no progress callback: nothing said, same answer');
});

test('dispatchEngineUpdate spawns `oathe engine update <harness> --then-verify` through the SAME detached spawn as a verification — own group, log under logsDir, scrubbed env — and refuses while update:<harness> is held', async () => {
  const w = world();
  w.query = async (sql, params) => { assert.match(sql, /work_claim/); assert.equal(params[1], 'update:codex'); return { rows: [] }; };
  const out = await dispatchEngineUpdate({ harness: 'codex', orgId: 'oathe', query: w.query, paths: w.paths, cwd: '/work/space',
    env: { PATH: '/usr/bin', HOME: w.home, OATHE_EXECUTION_ATTEMPT_ID: 'attempt-9', OATHE_DB: 'db' }, spawn: w.spawn });
  assert.equal(out.started, true);
  assert.equal(out.update_task, 'update:codex');
  const { cmd, args, opts } = w.spawned[0];
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args.slice(1), ['engine', 'update', 'codex', '--then-verify']);
  assert.equal(opts.detached, true);
  assert.equal(opts.env.OATHE_EXECUTION_ATTEMPT_ID, undefined);
  assert.equal(opts.env.OATHE_DB, 'db');
  assert.ok(out.log.startsWith(w.paths.logsDir) && out.log.endsWith('update-codex.log'), out.log);
  assert.match(out.note, /updating codex/i);
  const held = world({ claimRow: { principal_id: 'oathe-verifier', lease_until: new Date(Date.now() + 60_000).toISOString(), status: 'active' } });
  held.query = async () => ({ rows: [{ principal_id: 'oathe-verifier', ownership_valid_until: new Date(Date.now() + 60_000).toISOString(), state: 'active' }] });
  await assert.rejects(dispatchEngineUpdate({ harness: 'codex', orgId: 'oathe', query: held.query, paths: held.paths, cwd: '/w', env: { HOME: held.home }, spawn: held.spawn }),
    (e) => e.code === 'OATHE_UPDATE_IN_FLIGHT');
  assert.equal(held.spawned.length, 0);
});
