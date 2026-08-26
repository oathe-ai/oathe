// oathe — packaging tests (Stage 1 A6): the public package stands alone. firia-runtime is
// reached by the estate's own re-link step (scripts/link-firia.mjs), never by a `file:`
// dependency or any committed machine path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildPaths } from '../src/paths.mjs';

const paths = buildPaths({});

test('the public package declares no private dependencies and no private paths', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(paths.packageRoot, 'package.json'), 'utf8'));
  assert.equal('firia-runtime' in (pkg.dependencies ?? {}), false);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('src/'));
  const lock = fs.readFileSync(path.join(paths.packageRoot, 'package-lock.json'), 'utf8');
  assert.ok(!lock.includes('/Users/firiya'), 'no machine paths in committed metadata');
});

test('LICENSE is the Apache-2.0 text, on record for the oathe authors', () => {
  const license = fs.readFileSync(path.join(paths.packageRoot, 'LICENSE'), 'utf8');
  assert.match(license, /Apache License/);
  assert.match(license, /Version 2\.0/);
  assert.match(license, /Copyright 2026 the oathe authors/);
});

test('scripts/link-firia.mjs refuses typed-loud when the monorepo does not resolve', () => {
  const scriptPath = path.join(paths.packageRoot, 'scripts/link-firia.mjs');
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: paths.packageRoot,
    encoding: 'utf8',
    env: { ...process.env, OATHE_MONOREPO: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /OATHE_MONOREPO/);
});

test('scripts/link-firia.mjs repairs the symlink at the correct relative depth when the monorepo resolves', (t) => {
  const here = buildPaths({});
  if (here.monorepo === null) {
    t.skip('no monorepo checkout on this machine — nothing to repair');
    return;
  }
  const scriptPath = path.join(paths.packageRoot, 'scripts/link-firia.mjs');
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: paths.packageRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(result.status, 0, result.stderr);
  const linkPath = path.join(paths.packageRoot, 'node_modules/firia-runtime');
  const target = fs.readlinkSync(linkPath);
  const resolved = path.resolve(path.dirname(linkPath), target);
  assert.ok(fs.existsSync(resolved), `symlink target ${resolved} does not exist`);
  assert.equal(resolved, path.join(here.monorepo, 'packages/firia-runtime'));
});
