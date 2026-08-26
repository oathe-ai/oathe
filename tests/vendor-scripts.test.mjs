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
import { MARKER_PATTERNS } from '../scripts/marker-scan.mjs';

const paths = buildPaths({});
const VENDOR_SCRIPT = path.join(paths.packageRoot, 'scripts/vendor-ddl.mjs');
const SCAN_SCRIPT = path.join(paths.packageRoot, 'scripts/marker-scan.mjs');

// The vendor tests need a real DDL source (the monorepo checkout) to copy FROM — skip loudly
// when it is not on this machine, the established { skip } idiom used elsewhere in this suite.
const skip = paths.monorepo === null && 'DDL vendoring source: monorepo not on this machine';

// Once vendor/ddl ships in this tree, the OATHE_DDL_DIR > vendor/ddl > monorepo > null fallback
// chain always resolves a source — "no DDL source at all" is unreachable via env alone (nulling
// both OATHE_MONOREPO and OATHE_DDL_DIR just falls through to vendor/ddl). Skip loudly rather
// than silently rewrite this into a duplicate of the "named source missing" scenario.
const skipNoDdlSource = paths.ddlSource === 'vendor'
  && 'no-DDL-source scenario is unreachable once vendor/ddl ships in-tree (fallback chain always resolves it)';

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

test('vendor-ddl --license Apache-2.0 sets manifest.license; omitting it keeps the PENDING default', { skip }, () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-vendor-ddl-license-'));
  const outDirDefault = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-vendor-ddl-license-default-'));
  try {
    const licensed = runVendor(['--out', outDir, '--license', 'Apache-2.0']);
    assert.equal(licensed.status, 0, licensed.stderr + licensed.stdout);
    const licensedManifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    assert.equal(licensedManifest.license, 'Apache-2.0');

    const unlicensed = runVendor(['--out', outDirDefault]);
    assert.equal(unlicensed.status, 0, unlicensed.stderr + unlicensed.stdout);
    const defaultManifest = JSON.parse(fs.readFileSync(path.join(outDirDefault, 'manifest.json'), 'utf8'));
    assert.equal(defaultManifest.license, 'PENDING-FOUNDER-DECISION');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(outDirDefault, { recursive: true, force: true });
  }
});

test('vendor-ddl rejects an empty or whitespace-containing --license value, typed-loud', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-vendor-ddl-license-bad-'));
  try {
    const empty = runVendor(['--out', outDir, '--license', '']);
    assert.equal(empty.status, 1, empty.stdout);
    assert.match(empty.stderr + empty.stdout, /--license must be a non-empty SPDX identifier/);

    const whitespace = runVendor(['--out', outDir, '--license', 'Apache 2.0']);
    assert.equal(whitespace.status, 1, whitespace.stdout);
    assert.match(whitespace.stderr + whitespace.stdout, /--license must be a non-empty SPDX identifier/);
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

test('vendor-ddl refuses typed-loud when no DDL source resolves', { skip: skipNoDdlSource }, () => {
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
    // Not pinned to an exact count: this line legitimately trips more than one pattern (the
    // full path AND the bare founder username) — the point is that SOMETHING was flagged.
    assert.match(result.stdout, /marker-scan: \d+ hit\(s\) across 1 file\(s\) scanned/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('marker-scan catches each newly-added estate marker pattern, one planted hit per file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-marker-scan-newpatterns-'));
  try {
    const plants = {
      'founder-username.txt': 'run this as firiya on the box\n',
      'workspace-id.txt': 'the board renders at workspace ws-63d60b8f9275 today\n',
      'ai-docs.txt': 'see .ai-docs/plans/foo.md for the plan\n',
      'superpowers.txt': 'loaded from .superpowers/skills on session start\n',
      'claude-session.txt': 'Claude-Session: https://claude.ai/code/session_ABC123\n',
      'founder-email.txt': 'approvals go through shez.malik00@gmail.com\n',
    };
    for (const [name, contents] of Object.entries(plants)) {
      fs.writeFileSync(path.join(dir, name), contents);
    }
    const result = runScan([dir]);
    assert.equal(result.status, 1, result.stdout);
    for (const name of Object.keys(plants)) {
      assert.match(result.stdout, new RegExp(`${name}:1:`), `expected marker-scan to flag ${name}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MARKER_PATTERNS covers the estate vocabulary added for Finding 4', () => {
  const probes = [
    'firiya', 'ws-63d60b8f9275', '.ai-docs/plans/x.md', '.superpowers/skills/y',
    'Claude-Session: https://claude.ai/code/session_x', 'shez.malik00@gmail.com',
  ];
  for (const probe of probes) {
    assert.ok(MARKER_PATTERNS.some((p) => p.test(probe)), `no pattern matches: ${probe}`);
  }
});

test('marker-scan actually runs its main guard from a path containing a space (import.meta.url is percent-encoded)', () => {
  // A script self-invoked from a path with a space is the exact case where
  // `file://${process.argv[1]}` (raw) diverges from `import.meta.url` (percent-encoded) — the
  // stale comparison silently fails the guard, the script loads as a no-op module, and node
  // exits 0 having scanned NOTHING. That is the worst failure mode for a leakage gate.
  const spaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe has space-'));
  try {
    const copiedScript = path.join(spaceRoot, 'marker-scan.mjs');
    fs.copyFileSync(SCAN_SCRIPT, copiedScript);
    const targetDir = fs.mkdtempSync(path.join(spaceRoot, 'target-'));
    fs.writeFileSync(path.join(targetDir, 'leaky.txt'), 'the path is /Users/firiya/x on this machine\n');

    const result = spawnSync(process.execPath, [copiedScript, targetDir], { encoding: 'utf8' });
    assert.equal(result.status, 1, `expected exit 1 (a real scan found a hit); got ${result.status} — `
      + `stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
    assert.match(result.stdout, /leaky\.txt:1:/, 'the guard must have actually run the scan');
  } finally {
    fs.rmSync(spaceRoot, { recursive: true, force: true });
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
