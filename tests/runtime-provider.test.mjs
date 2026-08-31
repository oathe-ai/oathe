import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import fs from 'node:fs';

import { resolveRuntimeProvider, OatheRuntimeProvider, StandaloneRuntimeProvider } from '../src/runtime/provider.mjs';
import { buildPaths } from '../src/paths.mjs';
import { OatheConfig } from '../src/config.mjs';
import { Substrate } from '../src/substrate.mjs';

const HERE = buildPaths(process.env);              // whatever THIS machine truthfully has
const NOWHERE = buildPaths({ OATHE_MONOREPO: path.join(os.tmpdir(), 'no-such-monorepo') });

// Two independent facts about this machine, asserted honestly rather than assumed:
// a runtime checkout may expose the cage file, and the oathe-runtime package may resolve.
const CAGE_PRESENT = HERE.cagePath !== null && fs.existsSync(HERE.cagePath);
const RUNTIME_LINKED = (() => {
  try { createRequire(import.meta.url).resolve('oathe-runtime/seam'); return true; }
  catch { return false; }
})();
const NO_CAGE = !CAGE_PRESENT && 'no runtime checkout on this machine (OATHE_MONOREPO unset) — linked-mode lane';

function configWith(env) { return new OatheConfig({ env, cwd: os.tmpdir() }); }

// The DB-backed tests below (acceptanceRuntime, successor) get their own scratch database —
// never the shared admin `postgres` DB — per the repo-wide idiom (see sql-acceptance-lane.test.mjs,
// successor.test.mjs): created and DDL'd in before(), dropped in after(), touching nothing shared.
const SCRATCH_DB = `oathe_rtp_test_${process.pid}`;
let substrate;
let pool;

before(async () => {
  substrate = new Substrate({ database: SCRATCH_DB, paths: HERE, env: process.env });
  await substrate.ensureDatabase();
  await substrate.applyDdl();
  const pg = createRequire(import.meta.url)('pg');
  pool = new pg.Pool(substrate.connectionConfig());
});

after(async () => {
  await pool.end();
  await substrate.close();
  await substrate.dropDatabase();
});

test('auto resolves to oathe when the monorepo cage address exists', { skip: NO_CAGE }, () => {
  const p = resolveRuntimeProvider({ config: configWith({}), paths: HERE });
  assert.ok(p instanceof OatheRuntimeProvider);
  assert.equal(p.name, 'oathe');
  assert.equal(p.capabilities().cage, 'acp-cage');
});

test('auto resolves to standalone on a machine with no monorepo', () => {
  const p = resolveRuntimeProvider({ config: configWith({}), paths: NOWHERE });
  assert.ok(p instanceof StandaloneRuntimeProvider);
  assert.equal(p.name, 'standalone');
  assert.equal(p.capabilities().cage, 'simple-cage');
  assert.equal(p.capabilities().pickup, 'unavailable');
});

test('explicit standalone wins even where the monorepo exists', () => {
  const p = resolveRuntimeProvider({
    config: configWith({ OATHE_RUNTIME_PROVIDER: 'standalone' }), paths: HERE });
  assert.equal(p.name, 'standalone');
});

test('explicit oathe with no monorepo is a TYPED loud refusal, never a silent fallback', () => {
  assert.throws(
    () => resolveRuntimeProvider({ config: configWith({ OATHE_RUNTIME_PROVIDER: 'oathe' }), paths: NOWHERE }),
    (e) => e.name === 'RuntimeError' && e.code === 'OATHE_RUNTIME_UNAVAILABLE'
      && /monorepo/.test(e.message));
});

test('the oathe provider serves the real spawnCaged through cage()', { skip: NO_CAGE }, async () => {
  const { spawnCaged } = await new OatheRuntimeProvider({ paths: HERE }).cage();
  assert.equal(typeof spawnCaged, 'function');
});

test('every available provider serves the same acceptanceRuntime surface: SETTLE.CLAIM and laneFor', async () => {
  const providers = [new StandaloneRuntimeProvider(),
    ...(RUNTIME_LINKED ? [new OatheRuntimeProvider({ paths: HERE })] : [])];
  for (const provider of providers) {
    const runtime = await provider.acceptanceRuntime({ pool, orgId: 'oathe' });
    assert.ok(runtime.SETTLE.CLAIM, `${provider.name}: SETTLE.CLAIM exists`);
    const lane = runtime.laneFor('oathe-verifier');
    assert.equal(typeof lane.verify, 'function', `${provider.name}: laneFor returns a lane`);
  }
});

test('probe() tells the truth about this machine, and standalone always resolves', () => {
  assert.equal(new OatheRuntimeProvider({ paths: HERE }).probe().ok, RUNTIME_LINKED,
    'the oathe probe reports exactly whether oathe-runtime resolves here');
  assert.deepEqual(new StandaloneRuntimeProvider().probe(), { ok: true });
});

test('a oathe provider whose injected resolver throws refuses TYPED with OATHE_RUNTIME_UNLINKED, never a raw module error', async () => {
  const unlinkedError = new Error("Cannot find package 'oathe-runtime'");
  const throwingResolve = () => { throw unlinkedError; };
  const provider = new OatheRuntimeProvider({ paths: HERE, resolve: throwingResolve });

  assert.deepEqual(provider.probe(), { ok: false, error: unlinkedError.message });

  await assert.rejects(
    () => provider.acceptanceRuntime({ pool }),
    (e) => e.name === 'RuntimeError' && e.code === 'OATHE_RUNTIME_UNLINKED'
      && /link-runtime/.test(e.message) && /monorepo/.test(e.message));

  await assert.rejects(
    () => provider.successor({
      substrate, identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' }, paths: HERE,
    }),
    (e) => e.name === 'RuntimeError' && e.code === 'OATHE_RUNTIME_UNLINKED');
});

test('probe() is computed once and cached: a resolver that flips from ok to throwing is not re-consulted', () => {
  let calls = 0;
  const flakyResolve = () => { calls++; if (calls > 1) throw new Error('should not be called again'); };
  const provider = new OatheRuntimeProvider({ paths: HERE, resolve: flakyResolve });
  assert.deepEqual(provider.probe(), { ok: true });
  assert.deepEqual(provider.probe(), { ok: true });
  assert.equal(calls, 1, 'the resolver runs exactly once per provider instance');
});

test('both providers serve the successor surface: the runtime builds it, standalone refuses TYPED', async () => {
  if (RUNTIME_LINKED) {
    const runtime = await new OatheRuntimeProvider({ paths: HERE })
      .successor({ substrate, identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' }, paths: HERE });
    assert.equal(typeof runtime.pickup, 'function');
    assert.equal(typeof runtime.close, 'function');
    await runtime.close();
  }

  const standalone = await new StandaloneRuntimeProvider()
    .successor({ substrate, identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' }, paths: HERE });
  assert.equal(typeof standalone.close, 'function');
  await assert.rejects(
    () => standalone.pickup({ task_id: 't', work_claim_id: '00000000-0000-0000-0000-000000000000' }),
    (e) => e.name === 'RuntimeError' && e.code === 'OATHE_PICKUP_UNAVAILABLE'
      && /oathe_claim/.test(e.message) && /recovery bundle|reason.*statements.*trace/i.test(e.message)
      && /OATHE_MONOREPO/.test(e.message) // live fix #15: the refusal guides continuation
      && /preview limitation/.test(e.message));
  await standalone.close(); // a no-op that must not throw
});
