import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Substrate, DDL_FILES } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';

const paths = buildPaths({});
const SCRATCH_DB = `oathe_test_${process.pid}`;

// The estate cross-checks below need the monorepo checked out beside this repo.
// On a machine without it, skip LOUDLY — never silently.
const skip = paths.monorepo === null && 'estate cross-check: monorepo not on this machine';

const VENDOR_MANIFEST_PATH = path.join(paths.packageRoot, 'vendor/ddl/manifest.json');
const skipNoVendorManifest = !fs.existsSync(VENDOR_MANIFEST_PATH)
  && 'vendored-manifest cross-check: no vendor/ddl/manifest.json in this tree';

let substrate;

before(() => {
  substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
});

after(async () => {
  await substrate.close();
  await substrate.dropDatabase(); // scratch cleanup — the real verb set never drops
});

test('DDL_FILES mirrors apply.py exactly — same names, same order (house rule: never glob)', { skip }, () => {
  const applyPy = fs.readFileSync(
    path.join(paths.monorepo, 'packages/oathe-cell-domain/oathe_cell_domain/apply.py'), 'utf8');
  const declared = [...applyPy.matchAll(/^\s*"(\d{3}_[a-z0-9_]+\.sql)",/gm)].map((m) => m[1]);
  assert.deepEqual(DDL_FILES, declared);
});

test('DDL_FILES all exist on disk and nothing undeclared sits in the ddl dir', { skip }, () => {
  const onDisk = fs.readdirSync(paths.ddlDir).filter((f) => f.endsWith('.sql')).sort();
  assert.deepEqual([...DDL_FILES].sort(), onDisk);
});

test('vendored manifest cross-checks against DDL_FILES and shaOf (machine-independent)', { skip: skipNoVendorManifest }, () => {
  const manifest = JSON.parse(fs.readFileSync(VENDOR_MANIFEST_PATH, 'utf8'));
  assert.deepEqual(manifest.files.map((f) => f.name), DDL_FILES,
    'manifest.files must name-and-order-match DDL_FILES exactly');
  const vendorSubstrate = new Substrate({ database: 'vendor-manifest-crosscheck-unused', paths, env: process.env });
  manifest.files.forEach((entry, i) => {
    assert.equal(entry.position, i + 1, `${entry.name}: explicit application position`);
    assert.equal(entry.public_sha256, vendorSubstrate.shaOf(entry.name),
      `${entry.name} public_sha256 must equal shaOf of the shipped bytes (the ONE hashing implementation)`);
    assert.match(entry.source_sha256, /^[0-9a-f]{64}$/, `${entry.name}: source side pinned`);
  });
  assert.equal(manifest.transform.version, 'export-clean-1');
  assert.equal(manifest.license, 'Apache-2.0');
});

test('DDL_FILES shape is pinned machine-independently: unique, name-lawful, prefix-ascending', () => {
  const NAME_RE = /^\d{3}_[a-z0-9_]+\.sql$/;
  assert.equal(new Set(DDL_FILES).size, DDL_FILES.length, 'names must be unique');
  for (const name of DDL_FILES) {
    assert.match(name, NAME_RE, `${name} must match ${NAME_RE}`);
  }
  const prefixes = DDL_FILES.map((name) => Number(name.slice(0, 3)));
  for (let i = 1; i < prefixes.length; i++) {
    assert.ok(prefixes[i] > prefixes[i - 1],
      `prefixes must strictly ascend: ${prefixes[i - 1]} then ${prefixes[i]}`);
  }
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
  const first = await substrate.seed({ orgId: 'oathe', principalId: 'founder', department: 'founder' });
  assert.equal(first.inserted, true);
  const second = await substrate.seed({ orgId: 'oathe', principalId: 'founder', department: 'founder' });
  assert.equal(second.inserted, false);
  const { rows } = await substrate.query(
    "SELECT role FROM cell.principal WHERE org_id = 'oathe' AND principal_id = 'founder'");
  assert.equal(rows[0].role, 'ceo'); // schema root vocabulary (004:82), not an org assumption
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
      reachable: true, database_exists: true, ddl_applied: 0, ddl_expected: DDL_FILES.length,
      ddl_source: paths.ddlSource ?? 'ABSENT', yield_cause_registered: false,
    });
  } finally {
    await bare.close();
    await bare.dropDatabase();
  }
});

test('seedVerifier creates the non-author verifier principal, idempotently', async () => {
  const first = await substrate.seedVerifier({
    orgId: 'oathe', verifierPrincipal: 'oathe-verifier', operatorPrincipal: 'founder', department: 'verification',
  });
  assert.equal(first.inserted, true);
  const second = await substrate.seedVerifier({
    orgId: 'oathe', verifierPrincipal: 'oathe-verifier', operatorPrincipal: 'founder', department: 'verification',
  });
  assert.equal(second.inserted, false);
  const { rows } = await substrate.query(
    "SELECT role, assigner_principal_id FROM cell.principal WHERE principal_id = 'oathe-verifier'");
  assert.equal(rows[0].role, 'lead');
  assert.equal(rows[0].assigner_principal_id, 'founder');
});

test('registerAcceptanceAuthority registers the seat roster through the governed verb', async () => {
  await substrate.registerAcceptanceAuthority({
    orgId: 'oathe',
    seats: ['oathe-verifier', 'founder'],
    clauseSpecs: { acceptance_package: { conditions: [{ kind: 'evidence_present', min: 1 }] } },
    checkerRefs: { 'checker://acceptance_package': 'verification-clause' },
    registeredBy: 'oathe-init',
  });
  const { rows } = await substrate.query(
    "SELECT seats, registered_by FROM cell.acceptance_authority WHERE org_id = 'oathe'");
  assert.deepEqual(rows[0].seats, ['oathe-verifier', 'founder']);
  assert.equal(rows[0].registered_by, 'oathe-init');
  // re-register upserts (the verb's contract), no error
  await substrate.registerAcceptanceAuthority({
    orgId: 'oathe', seats: ['oathe-verifier', 'founder'],
    clauseSpecs: {}, checkerRefs: {}, registeredBy: 'oathe-init',
  });
});

test('a substrate with NO ddl source refuses typed at first use — never a raw ENOENT', async () => {
  // Substrate takes a plain paths object — no need to fight buildPaths's real fallback chain
  // (which, once vendor/ddl ships in-tree, always resolves a source) to exercise the null branch.
  // Machine-independent on every checkout, vendor/ddl or not.
  const p = { ...buildPaths({}), ddlDir: null, ddlSource: null };
  const s = new Substrate({ database: `oathe_noddl_${process.pid}`, paths: p, env: process.env });
  try {
    await assert.rejects(() => s.applyDdl(),
      (e) => e.name === 'SubstrateError' && e.code === 'DDL_SOURCE_UNAVAILABLE'
        && /OATHE_DDL_DIR|vendor\/ddl|monorepo/.test(e.message));
    assert.throws(() => s.shaOf('001_core.sql'),
      (e) => e.code === 'DDL_SOURCE_UNAVAILABLE');
  } finally {
    await s.close();
    await s.dropDatabase().catch(() => {});
  }
});

test('a substrate whose DDL source is NAMED but the directory does not exist refuses typed — never a raw ENOENT', async () => {
  const wrongDdlDir = path.join(os.tmpdir(), `nonexistent-ddl-${process.pid}`);
  const p = buildPaths({ OATHE_DDL_DIR: wrongDdlDir });
  assert.equal(p.ddlDir, wrongDdlDir);
  assert.equal(fs.existsSync(wrongDdlDir), false, 'precondition: the dir must not exist');
  const s = new Substrate({ database: `oathe_ddlgone_${process.pid}`, paths: p, env: process.env });
  try {
    await assert.rejects(() => s.applyDdl(),
      (e) => e.name === 'SubstrateError' && e.code === 'DDL_SOURCE_UNAVAILABLE'
        && e.message.includes(wrongDdlDir) && /does not exist/.test(e.message)
        && !/no DDL source resolves/.test(e.message),
        'the message must distinguish "named but absent" from "no source resolves"');
    assert.throws(() => s.shaOf('001_core.sql'),
      (e) => e.code === 'DDL_SOURCE_UNAVAILABLE' && e.message.includes(wrongDdlDir));
  } finally {
    await s.close();
    await s.dropDatabase().catch(() => {});
  }
});

test('status reports the substrate a doctor can print', async () => {
  const seen = await substrate.status();
  assert.equal(seen.reachable, true);
  assert.equal(seen.database_exists, true);
  assert.equal(seen.ddl_applied, DDL_FILES.length);
  assert.equal(seen.ddl_source, paths.ddlSource);
  assert.equal(seen.yield_cause_registered, true);
});
