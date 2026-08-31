#!/usr/bin/env node
// oathe — the monorepo re-link step (ruling R-E). `oathe-runtime` is no longer a
// `file:` dependency, so npm treats `node_modules/oathe-runtime` as extraneous and PRUNES it
// on every `npm install`/`npm ci` (proven by experiment). On any
// monorepo machine, run this — `npm run link-runtime` — after every npm install/ci to put the
// symlink back, computed at the CORRECT relative depth for wherever this checkout actually
// lives (fixes the depth fragility a committed, fixed-depth relative target has across
// clones/worktrees). Standalone machines (no monorepo checkout) never need this.
//
// Scope: this links only the `oathe-runtime` package directory. It does NOT recreate
// `node_modules/.bin/oathe-runtime-*` — those are the runtime's own bin shims, irrelevant to oathe.

import fs from 'node:fs';
import path from 'node:path';

import { buildPaths } from '../src/paths.mjs';

function fail(message) {
  process.stderr.write(`link-runtime: ${message}\n`);
  process.exit(1);
}

const paths = buildPaths(process.env);

if (paths.monorepo === null) {
  fail(
    'no monorepo resolves — set OATHE_MONOREPO to a runtime monorepo checkout '
    + '(this is a monorepo-checkout step; standalone machines do not need it)'
  );
}

const targetDir = path.join(paths.monorepo, 'packages/oathe-runtime');
if (!fs.existsSync(targetDir)) {
  fail(`resolved monorepo at ${paths.monorepo} but ${targetDir} does not exist — is OATHE_MONOREPO correct?`);
}

const nodeModulesDir = path.join(paths.packageRoot, 'node_modules');
const linkPath = path.join(nodeModulesDir, 'oathe-runtime');
const relativeTarget = path.relative(nodeModulesDir, targetDir);

let existing = null;
try {
  existing = fs.lstatSync(linkPath);
} catch {
  // does not exist — fall through to create
}

if (existing) {
  if (!existing.isSymbolicLink()) {
    const kind = existing.isDirectory() ? 'a real directory' : existing.isFile() ? 'a real file' : 'an unrecognized filesystem entry';
    fail(
      `${linkPath} exists and is ${kind}, not a symlink — refusing to delete it. `
      + 'This script only ever repairs a symlink it recognizes as its own; it never deletes a real '
      + `directory or file. If this is stale, remove it yourself (e.g. \`rm -rf ${linkPath}\`) and `
      + 're-run `npm run link-runtime`.'
    );
  }
  const priorTarget = fs.readlinkSync(linkPath);
  if (priorTarget === relativeTarget) {
    process.stdout.write(`link-runtime: node_modules/oathe-runtime already -> ${relativeTarget} (correct, nothing to do)\n`);
    process.exit(0);
  }
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(relativeTarget, linkPath, 'dir');
  process.stdout.write(
    `link-runtime: repaired node_modules/oathe-runtime (was -> ${priorTarget}, now -> ${relativeTarget})\n`
  );
} else {
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  fs.symlinkSync(relativeTarget, linkPath, 'dir');
  process.stdout.write(`link-runtime: created node_modules/oathe-runtime -> ${relativeTarget}\n`);
}
