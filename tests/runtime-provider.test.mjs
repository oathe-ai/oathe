import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { resolveRuntimeProvider, FiriaRuntimeProvider, StandaloneRuntimeProvider } from '../src/runtime/provider.mjs';
import { buildPaths } from '../src/paths.mjs';
import { OatheConfig } from '../src/config.mjs';
import { Substrate } from '../src/substrate.mjs';

const HERE = buildPaths({});                      // real machine: monorepo present
const NOWHERE = buildPaths({ OATHE_MONOREPO: path.join(os.tmpdir(), 'no-such-monorepo') });

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

test('auto resolves to firia when the monorepo cage address exists', () => {
  const p = resolveRuntimeProvider({ config: configWith({}), paths: HERE });
  assert.ok(p instanceof FiriaRuntimeProvider);
  assert.equal(p.name, 'firia');
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

test('explicit firia with no monorepo is a TYPED loud refusal, never a silent fallback', () => {
  assert.throws(
    () => resolveRuntimeProvider({ config: configWith({ OATHE_RUNTIME_PROVIDER: 'firia' }), paths: NOWHERE }),
    (e) => e.name === 'RuntimeError' && e.code === 'OATHE_RUNTIME_FIRIA_UNAVAILABLE'
      && /monorepo/.test(e.message));
});

test('the firia provider serves the real spawnCaged through cage()', async () => {
  const { spawnCaged } = await new FiriaRuntimeProvider({ paths: HERE }).cage();
  assert.equal(typeof spawnCaged, 'function');
});

test('both providers serve the same acceptanceRuntime surface: SETTLE.CLAIM and laneFor', async () => {
  for (const provider of [new FiriaRuntimeProvider({ paths: HERE }), new StandaloneRuntimeProvider()]) {
    const runtime = await provider.acceptanceRuntime({ pool, orgId: 'oathe' });
    assert.ok(runtime.SETTLE.CLAIM, `${provider.name}: SETTLE.CLAIM exists`);
    const lane = runtime.laneFor('oathe-verifier');
    assert.equal(typeof lane.verify, 'function', `${provider.name}: laneFor returns a lane`);
  }
});

test('probe(): the real firia provider on this machine resolves ok, and standalone always does', () => {
  assert.deepEqual(new FiriaRuntimeProvider({ paths: HERE }).probe(), { ok: true });
  assert.deepEqual(new StandaloneRuntimeProvider().probe(), { ok: true });
});

test('a firia provider whose injected resolver throws refuses TYPED with OATHE_RUNTIME_FIRIA_UNLINKED, never a raw module error', async () => {
  const unlinkedError = new Error("Cannot find package 'firia-runtime'");
  const throwingResolve = () => { throw unlinkedError; };
  const provider = new FiriaRuntimeProvider({ paths: HERE, resolve: throwingResolve });

  assert.deepEqual(provider.probe(), { ok: false, error: unlinkedError.message });

  await assert.rejects(
    () => provider.acceptanceRuntime({ pool }),
    (e) => e.name === 'RuntimeError' && e.code === 'OATHE_RUNTIME_FIRIA_UNLINKED'
      && /link-firia/.test(e.message) && /firia-monorepo|monorepo/.test(e.message));

  await assert.rejects(
    () => provider.successor({
      substrate, identity: { orgId: 'oathe', principalId: 'firia', department: 'founder' }, paths: HERE,
    }),
    (e) => e.name === 'RuntimeError' && e.code === 'OATHE_RUNTIME_FIRIA_UNLINKED');
});

test('probe() is computed once and cached: a resolver that flips from ok to throwing is not re-consulted', () => {
  let calls = 0;
  const flakyResolve = () => { calls++; if (calls > 1) throw new Error('should not be called again'); };
  const provider = new FiriaRuntimeProvider({ paths: HERE, resolve: flakyResolve });
  assert.deepEqual(provider.probe(), { ok: true });
  assert.deepEqual(provider.probe(), { ok: true });
  assert.equal(calls, 1, 'the resolver runs exactly once per provider instance');
});

test('both providers serve the successor surface: firia builds it, standalone refuses TYPED', async () => {
  const firia = await new FiriaRuntimeProvider({ paths: HERE })
    .successor({ substrate, identity: { orgId: 'oathe', principalId: 'firia', department: 'founder' }, paths: HERE });
  assert.equal(typeof firia.pickup, 'function');
  assert.equal(typeof firia.close, 'function');
  await firia.close();

  const standalone = await new StandaloneRuntimeProvider()
    .successor({ substrate, identity: { orgId: 'oathe', principalId: 'firia', department: 'founder' }, paths: HERE });
  assert.equal(typeof standalone.close, 'function');
  await assert.rejects(
    () => standalone.pickup({ task_id: 't', work_claim_id: '00000000-0000-0000-0000-000000000000' }),
    (e) => e.name === 'RuntimeError' && e.code === 'OATHE_PICKUP_UNAVAILABLE'
      && /preview limitation/.test(e.message));
  await standalone.close(); // a no-op that must not throw
});
