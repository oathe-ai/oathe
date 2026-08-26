// oathe — packaging tests (Stage 1 A6): the public package stands alone. oathe-runtime is
// reached by the estate's own re-link step (scripts/link-runtime.mjs), never by a `file:`
// dependency or any committed machine path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildPaths } from '../src/paths.mjs';

const paths = buildPaths({});

test('the public package declares no private dependencies and no private paths', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(paths.packageRoot, 'package.json'), 'utf8'));
  assert.equal('oathe-runtime' in (pkg.dependencies ?? {}), false);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('src/'));
  const lock = fs.readFileSync(path.join(paths.packageRoot, 'package-lock.json'), 'utf8');
  assert.ok(!lock.includes(['/Users/fir', 'iya'].join('')), 'no machine paths in committed metadata');
});

test('LICENSE is the Apache-2.0 text, on record for the oathe authors', () => {
  const license = fs.readFileSync(path.join(paths.packageRoot, 'LICENSE'), 'utf8');
  assert.match(license, /Apache License/);
  assert.match(license, /Version 2\.0/);
  assert.match(license, /APPENDIX: How to apply the Apache License to your work\./);
  assert.match(license, /Copyright 2026 the oathe authors/);
});

test('scripts/link-runtime.mjs refuses typed-loud when the monorepo does not resolve', () => {
  const scriptPath = path.join(paths.packageRoot, 'scripts/link-runtime.mjs');
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: paths.packageRoot,
    encoding: 'utf8',
    env: { ...process.env, OATHE_MONOREPO: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /OATHE_MONOREPO/);
});

test('scripts/link-runtime.mjs repairs the symlink at the correct relative depth when the monorepo resolves', (t) => {
  const here = buildPaths({});
  if (here.monorepo === null) {
    t.skip('no monorepo checkout on this machine — nothing to repair');
    return;
  }
  const scriptPath = path.join(paths.packageRoot, 'scripts/link-runtime.mjs');
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: paths.packageRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(result.status, 0, result.stderr);
  const linkPath = path.join(paths.packageRoot, 'node_modules/oathe-runtime');
  const target = fs.readlinkSync(linkPath);
  const resolved = path.resolve(path.dirname(linkPath), target);
  assert.ok(fs.existsSync(resolved), `symlink target ${resolved} does not exist`);
  assert.equal(resolved, path.join(here.monorepo, 'packages/oathe-runtime'));
});

test('scripts/link-runtime.mjs refuses to delete a real (non-symlink) node_modules/oathe-runtime', () => {
  // Isolated from the real worktree entirely: a throwaway package root carrying its own copy
  // of the script and the src/paths.mjs it imports (buildPaths' packageRoot is derived from
  // the SCRIPT's own file location, so running a copy from a temp dir makes it operate on that
  // temp dir's node_modules, never the real one) plus a throwaway fake monorepo (OATHE_MONOREPO
  // already supports pointing anywhere — no new override needed).
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'link-runtime-guard-root-'));
  const tmpMonorepo = fs.mkdtempSync(path.join(os.tmpdir(), 'link-runtime-guard-mono-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'node_modules/oathe-runtime'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'node_modules/oathe-runtime/marker.txt'), 'a real directory, not a symlink\n');
    fs.copyFileSync(
      path.join(paths.packageRoot, 'scripts/link-runtime.mjs'),
      path.join(tmpRoot, 'scripts/link-runtime.mjs'));
    fs.copyFileSync(
      path.join(paths.packageRoot, 'src/paths.mjs'),
      path.join(tmpRoot, 'src/paths.mjs'));
    fs.mkdirSync(path.join(tmpMonorepo, 'packages/oathe-runtime'), { recursive: true });

    const linkPath = path.join(tmpRoot, 'node_modules/oathe-runtime');
    const result = spawnSync(process.execPath, [path.join(tmpRoot, 'scripts/link-runtime.mjs')], {
      cwd: tmpRoot,
      encoding: 'utf8',
      env: { ...process.env, OATHE_MONOREPO: tmpMonorepo },
    });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr + result.stdout, /refusing to delete/);
    assert.ok(fs.lstatSync(linkPath).isDirectory() && !fs.lstatSync(linkPath).isSymbolicLink(),
      'the real directory must survive untouched');
    assert.equal(
      fs.readFileSync(path.join(linkPath, 'marker.txt'), 'utf8'),
      'a real directory, not a symlink\n',
      'contents must survive untouched');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpMonorepo, { recursive: true, force: true });
  }
});
