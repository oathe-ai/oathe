// oathe — vendoring is PREPARED, not performed (Stage 1 A4-A6 Task 7). These tests exercise
// scripts/vendor-ddl.mjs and scripts/marker-scan.mjs ENTIRELY against temp dirs via spawnSync —
// they never touch the tree's own vendor/ddl, and the repo must be left with no vendor/ directory
// after this suite runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildPaths } from '../src/paths.mjs';
import { Substrate, DDL_FILES } from '../src/substrate.mjs';

const paths = buildPaths({});
const VENDOR_SCRIPT = path.join(paths.packageRoot, 'scripts/vendor-ddl.mjs');
const SCAN_SCRIPT = path.join(paths.packageRoot, 'scripts/marker-scan.mjs');

// The vendor tests need a real DDL source (the monorepo checkout) to copy FROM — skip loudly
// when it is not on this machine, the established { skip } idiom used elsewhere in this suite.
const skip = paths.monorepo === null && 'DDL vendoring source: monorepo not on this machine';

function runVendor(args, env = {}) {
  return spawnSync(process.execPath, [VENDOR_SCRIPT, ...args], {
    cwd: paths.packageRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runScan(args) {
  return spawnSync(process.execPath, [SCAN_SCRIPT, ...args], {
    cwd: paths.packageRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

test('vendor-ddl copies every DDL file byte-identical (by sha256) and writes a manifest in DDL_FILES order', { skip }, () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-vendor-ddl-'));
  try {
    const substrate = new Substrate({ database: 'vendor-scripts-unused', paths, env: process.env });
    const result = runVendor(['--out', outDir]);
    assert.equal(result.status, 0, result.stderr + result.stdout);

    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.license, 'PENDING-FOUNDER-DECISION');
    assert.equal(manifest.source.repo, 'firia-monorepo');
    assert.equal(manifest.source.path, 'packages/firia-cell-domain/firia_cell_domain/ddl');
    assert.deepEqual(manifest.files.map((f) => f.name), DDL_FILES);

    for (const name of DDL_FILES) {
      const vendoredBytes = fs.readFileSync(path.join(outDir, name));
      const sourceBytes = fs.readFileSync(path.join(paths.ddlDir, name));
      assert.ok(vendoredBytes.equals(sourceBytes), `${name} must be byte-identical to the source`);
      const expectedSha = substrate.shaOf(name);
      const entry = manifest.files.find((f) => f.name === name);
      assert.equal(entry.sha256, expectedSha, `${name} manifest sha256 must equal shaOf`);
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('vendor-ddl refuses to overwrite a non-empty out dir without --force, and succeeds with it', { skip }, () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-vendor-ddl-force-'));
  try {
    fs.writeFileSync(path.join(outDir, 'pre-existing.txt'), 'do not clobber me\n');

    const refused = runVendor(['--out', outDir]);
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr + refused.stdout, /--force/);
    assert.ok(fs.existsSync(path.join(outDir, 'pre-existing.txt')), 'refusal must leave the dir untouched');

    const forced = runVendor(['--out', outDir, '--force']);
    assert.equal(forced.status, 0, forced.stderr + forced.stdout);
    assert.ok(fs.existsSync(path.join(outDir, 'manifest.json')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('vendor-ddl refuses typed-loud when no DDL source resolves', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-vendor-ddl-nosrc-'));
  try {
    const result = runVendor(['--out', outDir], { OATHE_MONOREPO: '', OATHE_DDL_DIR: '' });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr + result.stdout, /no DDL source resolves/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('marker-scan flags a planted founder-path fixture and exits 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-marker-scan-dirty-'));
  try {
    fs.writeFileSync(path.join(dir, 'leaky.txt'), 'the path is /Users/firiya/x on this machine\n');
    const result = runScan([dir]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /leaky\.txt:1:/);
    assert.match(result.stdout, /1 hit/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('marker-scan passes a clean temp dir with exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-marker-scan-clean-'));
  try {
    fs.writeFileSync(path.join(dir, 'fine.txt'), 'nothing to see here, just plain text\n');
    const result = runScan([dir]);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /clean — 0 hits/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
