// oathe — packaging tests: the public package stands alone. oathe-runtime is
// reached by the monorepo re-link step (scripts/link-runtime.mjs), never by a `file:`
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

test('the two test lanes cover every test file exactly once — a new file cannot silently skip the suite', () => {
  // `npm test` = a fully parallel unit lane + a bounded-concurrency heavy lane (the cage/
  // Postgres/spawn files saturate the machine's process layer when they stack — the same
  // never-by-glob discipline as DDL_FILES: explicit lists, cross-checked against the dir).
  const paths = buildPaths({});
  const pkg = JSON.parse(fs.readFileSync(path.join(paths.packageRoot, 'package.json'), 'utf8'));
  const laneFiles = (script) => (pkg.scripts[script] ?? '')
    .split(/\s+/).filter((word) => word.startsWith('tests/')).map((word) => path.basename(word));
  const unit = laneFiles('test:unit');
  const heavy = laneFiles('test:heavy');
  assert.ok(unit.length > 0, 'test:unit names its files');
  assert.ok(heavy.length > 0, 'test:heavy names its files');
  assert.match(pkg.scripts['test:heavy'], /--test-concurrency=\d/,
    'the heavy lane bounds its parallelism — cage tests must not stack');
  assert.match(pkg.scripts.test, /test:unit/, 'npm test runs the unit lane');
  assert.match(pkg.scripts.test, /test:heavy/, 'npm test runs the heavy lane');
  const onDisk = fs.readdirSync(path.join(paths.packageRoot, 'tests'))
    .filter((f) => f.endsWith('.test.mjs')).sort();
  const listed = [...unit, ...heavy].sort();
  assert.deepEqual(listed, onDisk, 'every tests/*.test.mjs is in exactly one lane');
  const overlap = unit.filter((f) => heavy.includes(f));
  assert.deepEqual(overlap, [], 'no file runs in both lanes');
});

/** The package README's home follows the layout: the package-tree root in the tarball, and
 *  docs/PACKAGE.md in the assembled public repo, where the launch README owns the root.
 *  Its contracts (upgrade path, live doc links) travel with the file. */
function packageReadme(root) {
  const moved = path.join(root, 'docs', 'PACKAGE.md');
  return fs.existsSync(moved) ? { file: moved, moved: true } : { file: path.join(root, 'README.md'), moved: false };
}

test('the README states the one-line upgrade path — init is idempotent and evicts the version-keyed plugin cache', () => {
  const readme = fs.readFileSync(packageReadme(buildPaths({}).packageRoot).file, 'utf8');
  assert.match(readme, /npm i -g @oathe\/oathe@latest && oathe init/);
});

test('the tarball carries BOTH plugin manifests — the marketplace root and the plugin itself (live fix #4, 0.2.1)', async () => {
  const { execSync } = await import('node:child_process');
  const out = execSync('npm pack --dry-run --ignore-scripts --json', { encoding: 'utf8', cwd: buildPaths({}).packageRoot });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  assert.ok(files.includes('.claude-plugin/marketplace.json'),
    'claude plugin marketplace add <packageRoot> needs .claude-plugin/marketplace.json IN THE TARBALL');
  assert.ok(files.includes('plugin/.claude-plugin/plugin.json'), 'the plugin manifest ships');
  assert.ok(!files.some((f) => f.startsWith('docs/D0-PREVIEW')), 'the D0 preview note left the public tree (live main deleted it)');
});

test('the bin entry is the normalized form npm publishes without a warning (live fix #2)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(buildPaths({}).packageRoot, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.bin, { oathe: 'bin/oathe.mjs' });
  assert.match(pkg.scripts['pack:dry-run'], /--ignore-scripts/);
});

test('every docs/ path the README links SHIPS — a tarball must never carry a dead link to its own documentation', () => {
  const root = buildPaths({}).packageRoot;
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const home = packageReadme(root);
  const readme = fs.readFileSync(home.file, 'utf8');
  // At the root the links carry docs/; moved INSIDE docs/ they must be sibling-relative
  // (a docs/ prefix there would resolve to docs/docs/ on the public repo — a dead link).
  const linked = home.moved
    ? [...readme.matchAll(/\]\((?!https?:)([\w][^)#/]*\.md)\)/g)].map((m) => `docs/${m[1]}`)
    : [...readme.matchAll(/\]\((docs\/[^)#]+)\)/g)].map((m) => m[1]);
  assert.ok(linked.length > 0, 'the README links its docs — the pin has teeth');
  if (home.moved) assert.ok(!/\]\(docs\//.test(readme), 'no docs/-prefixed link survives the move into docs/');
  for (const doc of linked) {
    assert.ok(pkg.files.includes(doc), `${doc} is linked by the README but missing from the files allowlist`);
  }
});

test('ONE version: every plugin manifest moves with package.json — a bump that forgets one strands its installs at the old code', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // Both manifests, one loop — the 0.3.1 bump forked them one at a time (claude caught
  // live at init, cursor caught by review): the sweep is the guard, not per-file memory.
  for (const manifest of ['../plugin/.claude-plugin/plugin.json', '../plugin/.cursor-plugin/plugin.json']) {
    const plugin = JSON.parse(fs.readFileSync(new URL(manifest, import.meta.url), 'utf8'));
    assert.equal(plugin.version, pkg.version, `${manifest} must carry the package version`);
  }
});
