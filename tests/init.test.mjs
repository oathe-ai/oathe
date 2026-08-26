import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sandbox as sharedSandbox } from './helpers.mjs';
import { runInit } from '../src/init.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { runUninstall } from '../src/uninstall.mjs';
import { Substrate, DDL_FILES } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';

const SCRATCH_DB = `oathe_init_test_${process.pid}`;
const paths = buildPaths({});

function sandbox() {
  const sb = sharedSandbox({ scratchDb: SCRATCH_DB });
  return { home: sb.home, env: sb.env, exec: sb.exec };
}

after(async () => {
  const substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await substrate.close();
  await substrate.dropDatabase();
});

test('init end-to-end: substrate up, both harnesses onboarded, manifest written, and a re-run is byte-idempotent', async () => {
  const { home, env, exec } = sandbox();
  const result = await runInit({ env, exec });

  assert.deepEqual(result.census.map((c) => [c.name, c.installed]), [['claude', true], ['codex', true]]);
  assert.equal(result.substrate.database_exists, true);
  assert.equal(result.substrate.ddl_applied, DDL_FILES.length);
  assert.equal(result.substrate.ddl_expected, DDL_FILES.length);
  assert.equal(result.substrate.yield_cause_registered, true);
  assert.equal(result.principal.principal_id, 'firia');
  assert.equal(result.verifier.principal_id, 'oathe-verifier');
  assert.deepEqual(result.verifier.seats, ['oathe-verifier', 'firia']);

  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.enabledPlugins['oathe@oathe'], true);
  assert.equal(settings.extraKnownMarketplaces.oathe.source.path, paths.packageRoot);
  const toml = fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
  assert.ok(toml.includes('[marketplaces.oathe]'));
  assert.ok(toml.includes('[mcp_servers.oathe]'));

  const manifest = JSON.parse(fs.readFileSync(path.join(env.OATHE_HOME, 'install-manifest.json'), 'utf8'));
  assert.ok(manifest.rows.length >= 4);

  const before = {
    settings: fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'),
    toml,
  };
  await runInit({ env, exec });
  assert.equal(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'), before.settings);
  assert.equal(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8'), before.toml);
  const manifest2 = JSON.parse(fs.readFileSync(path.join(env.OATHE_HOME, 'install-manifest.json'), 'utf8'));
  assert.equal(manifest2.rows.length, manifest.rows.length);
});

test('init with the substrate unreachable instructs and refuses instead of onboarding half a world', async () => {
  const { env, exec } = sandbox();
  const dead = { ...env, OATHE_PG_HOST: '/nonexistent-socket-dir' };
  await assert.rejects(() => runInit({ env: dead, exec }), (e) => {
    assert.equal(e.code, 'OATHE_SUBSTRATE_UNREACHABLE');
    assert.match(e.message, /postgres/i);
    return true;
  });
});

test('init refuses BEFORE creating the database when no DDL source resolves', async () => {
  const { env, exec } = sandbox();
  const noSource = { ...env, OATHE_MONOREPO: '', OATHE_DB: `oathe_noddl_init_${process.pid}` };
  await assert.rejects(() => runInit({ env: noSource, exec }),
    (e) => e.code === 'DDL_SOURCE_UNAVAILABLE');
  const admin = new Substrate({ database: 'postgres', paths, env: process.env });
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1',
      [`oathe_noddl_init_${process.pid}`]);
    assert.equal(rows.length, 0, 'no half-created database left behind');
  } finally { await admin.close(); }
});

test('init refuses BEFORE creating the database when OATHE_DDL_DIR names a directory that does not exist', async () => {
  const { env, exec } = sandbox();
  const wrongDdlDir = `/nonexistent-ddl-dir-${process.pid}`;
  const dbName = `oathe_ddlgone_init_${process.pid}`;
  const named = { ...env, OATHE_DDL_DIR: wrongDdlDir, OATHE_DB: dbName };
  await assert.rejects(() => runInit({ env: named, exec }),
    (e) => e.code === 'DDL_SOURCE_UNAVAILABLE' && e.message.includes(wrongDdlDir)
      && /does not exist/.test(e.message));
  const admin = new Substrate({ database: 'postgres', paths, env: process.env });
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    assert.equal(rows.length, 0, 'no half-created database left behind');
  } finally { await admin.close(); }
});

test('doctor over a healthy install reports every row ok; after a user edit inside our keys it REPORTS, never overwrites', async () => {
  const { home, env, exec } = sandbox();
  await runInit({ env, exec });
  const healthy = await runDoctor({ env });
  assert.equal(healthy.substrate.reachable, true);
  // the trace-contract monitor derives store paths from env HOME (nothing hardcoded): the
  // sandbox home has no session stores, and the doctor says so VISIBLY instead of skipping.
  assert.equal(healthy.traces.claude.status, 'store-absent', JSON.stringify(healthy.traces));
  assert.equal(healthy.traces.codex.status, 'store-absent', JSON.stringify(healthy.traces));
  assert.ok(healthy.rows.length >= 4);
  assert.ok(healthy.rows.every((r) => r.status === 'ok'), JSON.stringify(healthy.rows));
  assert.equal(healthy.plugin.resolves, true);
  // The runtime probe (Finding 1: a firia selection that does not actually resolve
  // firia-runtime must show unhealthy, never a HEALTHY doctor line over a broken checkout).
  assert.equal(healthy.runtime.provider !== null, true);
  assert.equal(healthy.runtime.probe.ok, true, JSON.stringify(healthy.runtime));

  const settingsPath = path.join(home, '.claude/settings.json');
  const doc = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  doc.enabledPlugins['oathe@oathe'] = false; // the user's own hand
  fs.writeFileSync(settingsPath, `${JSON.stringify(doc, null, 2)}\n`);
  const edited = await runDoctor({ env });
  const row = edited.rows.find((r) => r.file === settingsPath);
  assert.equal(row.status, 'user-edited');
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).enabledPlugins['oathe@oathe'], false,
    'doctor must not have overwritten the user edit');
});

test('uninstall removes exactly the recorded entries, restores nothing else, and keeps the database', async () => {
  const { home, env, exec } = sandbox();
  await runInit({ env, exec });
  const result = await runUninstall({ env, exec });
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.theme, 'dark');
  assert.equal('extraKnownMarketplaces' in settings, false);
  assert.equal('enabledPlugins' in settings, false);
  const toml = fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
  assert.ok(toml.includes('# user config'));
  assert.ok(!toml.includes('[marketplaces.oathe]'));
  const manifest = JSON.parse(fs.readFileSync(path.join(env.OATHE_HOME, 'install-manifest.json'), 'utf8'));
  assert.equal(manifest.rows.length, 0);
  assert.equal(result.database_dropped, false);
  const substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  try {
    const seen = await substrate.status();
    assert.equal(seen.database_exists, true, 'the cell database outlives uninstall');
  } finally {
    await substrate.close();
  }
});
