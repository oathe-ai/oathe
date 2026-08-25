import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { resolveRuntimeProvider, FiriaRuntimeProvider, StandaloneRuntimeProvider } from '../src/runtime/provider.mjs';
import { buildPaths } from '../src/paths.mjs';
import { OatheConfig } from '../src/config.mjs';

const HERE = buildPaths({});                      // real machine: monorepo present
const NOWHERE = buildPaths({ OATHE_MONOREPO: path.join(os.tmpdir(), 'no-such-monorepo') });

function configWith(env) { return new OatheConfig({ env, cwd: os.tmpdir() }); }

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
