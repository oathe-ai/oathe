import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Substrate, DDL_FILES } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';

const paths = buildPaths({});
const SCRATCH_DB = `oathe_test_${process.pid}`;

let substrate;

before(() => {
  substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
});

after(async () => {
  await substrate.close();
  await substrate.dropDatabase(); // scratch cleanup — the real verb set never drops
});

test('DDL_FILES mirrors apply.py exactly — same names, same order (house rule: never glob)', () => {
  const applyPy = fs.readFileSync(
    path.join(paths.monorepo, 'packages/firia-cell-domain/firia_cell_domain/apply.py'), 'utf8');
  const declared = [...applyPy.matchAll(/^\s*"(\d{3}_[a-z0-9_]+\.sql)",/gm)].map((m) => m[1]);
  assert.deepEqual(DDL_FILES, declared);
});

test('DDL_FILES all exist on disk and nothing undeclared sits in the ddl dir', () => {
  const onDisk = fs.readdirSync(paths.ddlDir).filter((f) => f.endsWith('.sql')).sort();
  assert.deepEqual([...DDL_FILES].sort(), onDisk);
});

test('detect answers reachable on this machine', async () => {
  const seen = await substrate.detect();
  assert.equal(seen.reachable, true);
});

test('ensureDatabase creates the cell database once, then reports it existing', async () => {
  const first = await substrate.ensureDatabase();
  assert.equal(first.created, true);
  const second = await substrate.ensureDatabase();
  assert.equal(second.created, false);
});

test('applyDdl applies all files in order on a fresh database, and a re-run skips them all', async () => {
  const first = await substrate.applyDdl();
  assert.deepEqual(first.applied, DDL_FILES);
  assert.deepEqual(first.skipped, []);
  const second = await substrate.applyDdl();
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, DDL_FILES);
});

test('applyDdl refuses loudly when an already-applied file has drifted', async () => {
  await substrate.query(
    "UPDATE oathe.ddl_applied SET sha256 = 'not-the-real-hash' WHERE filename = '001_core.sql'");
  await assert.rejects(() => substrate.applyDdl(), /drift/i);
  // restore the truthful record
  const real = substrate.shaOf('001_core.sql');
  await substrate.query('UPDATE oathe.ddl_applied SET sha256 = $1 WHERE filename = $2', [real, '001_core.sql']);
});

test('seed inserts the principal idempotently', async () => {
  const first = await substrate.seed({ orgId: 'oathe', principalId: 'firia', department: 'founder' });
  assert.equal(first.inserted, true);
  const second = await substrate.seed({ orgId: 'oathe', principalId: 'firia', department: 'founder' });
  assert.equal(second.inserted, false);
  const { rows } = await substrate.query(
    "SELECT role FROM cell.principal WHERE org_id = 'oathe' AND principal_id = 'firia'");
  assert.equal(rows[0].role, 'ceo');
});

test('registerYieldCause declares cell.oathe_yield_operator with the operator_decision basis prefix', async () => {
  await substrate.registerYieldCause();
  await substrate.registerYieldCause(); // idempotent
  const cause = await substrate.query(
    "SELECT basis_prefix FROM cell.claim_yield_cause WHERE cause = 'cell.oathe_yield_operator'");
  assert.equal(cause.rows[0].basis_prefix, 'operator_decision');
  const fn = await substrate.query(
    "SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace "
    + "WHERE s.nspname = 'cell' AND p.proname = 'oathe_yield_operator'");
  assert.equal(fn.rows[0].n, 1);
});

test('status on a database that exists but has no DDL yet reports zero without erroring', async () => {
  const bare = new Substrate({ database: `${SCRATCH_DB}_bare`, paths, env: process.env });
  try {
    await bare.ensureDatabase();
    const seen = await bare.status();
    assert.deepEqual(seen, {
      reachable: true, database_exists: true, ddl_applied: 0, yield_cause_registered: false,
    });
  } finally {
    await bare.close();
    await bare.dropDatabase();
  }
});

test('status reports the substrate a doctor can print', async () => {
  const seen = await substrate.status();
  assert.equal(seen.reachable, true);
  assert.equal(seen.database_exists, true);
  assert.equal(seen.ddl_applied, DDL_FILES.length);
  assert.equal(seen.yield_cause_registered, true);
});
