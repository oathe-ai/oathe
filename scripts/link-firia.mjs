#!/usr/bin/env node
// oathe — the estate re-link step (Stage 1 A6, ruling R-E). `firia-runtime` is no longer a
// `file:` dependency, so npm treats `node_modules/firia-runtime` as extraneous and PRUNES it
// on every `npm install`/`npm ci` (proven in .ai-docs/plans/a6-npm-experiment.md). On any
// estate machine, run this — `npm run link-firia` — after every npm install/ci to put the
// symlink back, computed at the CORRECT relative depth for wherever this checkout actually
// lives (fixes the depth fragility a committed, fixed-depth relative target has across
// clones/worktrees). Standalone machines (no monorepo checkout) never need this.
//
// Scope: this links only the `firia-runtime` package directory. It does NOT recreate
// `node_modules/.bin/firia-*` — those are firia-runtime's own bin shims, irrelevant to oathe.

import fs from 'node:fs';
import path from 'node:path';

import { buildPaths } from '../src/paths.mjs';

function fail(message) {
  process.stderr.write(`link-firia: ${message}\n`);
  process.exit(1);
}

const paths = buildPaths(process.env);

if (paths.monorepo === null) {
  fail(
    'no monorepo resolves — set OATHE_MONOREPO to a firia-monorepo checkout '
    + '(this is an estate-only step; standalone machines do not need it)'
  );
}

const targetDir = path.join(paths.monorepo, 'packages/firia-runtime');
if (!fs.existsSync(targetDir)) {
  fail(`resolved monorepo at ${paths.monorepo} but ${targetDir} does not exist — is OATHE_MONOREPO correct?`);
}

const nodeModulesDir = path.join(paths.packageRoot, 'node_modules');
const linkPath = path.join(nodeModulesDir, 'firia-runtime');
const relativeTarget = path.relative(nodeModulesDir, targetDir);

let existing = null;
try {
  existing = fs.lstatSync(linkPath);
} catch {
  // does not exist — fall through to create
}

if (existing) {
  if (existing.isSymbolicLink() && fs.readlinkSync(linkPath) === relativeTarget) {
    process.stdout.write(`link-firia: node_modules/firia-runtime already -> ${relativeTarget} (correct, nothing to do)\n`);
    process.exit(0);
  }
  const priorTarget = existing.isSymbolicLink() ? fs.readlinkSync(linkPath) : '(not a symlink)';
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(relativeTarget, linkPath, 'dir');
  process.stdout.write(
    `link-firia: repaired node_modules/firia-runtime (was -> ${priorTarget}, now -> ${relativeTarget})\n`
  );
} else {
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  fs.symlinkSync(relativeTarget, linkPath, 'dir');
  process.stdout.write(`link-firia: created node_modules/firia-runtime -> ${relativeTarget}\n`);
}
