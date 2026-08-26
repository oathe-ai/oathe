#!/usr/bin/env node
// oathe — the DDL vendoring script (Stage 1 A4-A6 prep, ruling R-B). Copies each DDL_FILES entry
// BYTE-IDENTICAL from the monorepo's DDL directory into an out dir, with provenance recorded in a
// sidecar manifest.json — never per-file headers, because the substrate's DDL_DRIFT law
// (Substrate#applyDdl) compares bytes, and a header would make a vendored file diverge from the
// source it is supposed to be identical to.
//
// This script is PREPARED, not performed: it is never run with its default output during
// development or CI — dropping vendor/ddl into the tree is a founder-gated estate decision (see
// the task brief). Tests always pass an explicit --out pointed at a temp dir.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildPaths } from '../src/paths.mjs';
import { Substrate, DDL_FILES } from '../src/substrate.mjs';

export const MANIFEST_SOURCE = Object.freeze({
  repo: 'firia-monorepo',
  path: 'packages/firia-cell-domain/firia_cell_domain/ddl',
});

export const MANIFEST_LICENSE_PENDING = 'PENDING-FOUNDER-DECISION';

function fail(message) {
  process.stderr.write(`vendor-ddl: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let out = null;
  let force = false;
  let license = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      out = argv[++i];
      if (out === undefined) fail('--out requires a directory argument');
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--license') {
      license = argv[++i];
      if (license === undefined) fail('--license requires an SPDX identifier argument');
    } else {
      fail(`unrecognized argument: ${arg}`);
    }
  }
  return { out, force, license };
}

function run(argv, env) {
  const paths = buildPaths(env);
  const { out, force, license } = parseArgs(argv);
  const manifestLicense = license || MANIFEST_LICENSE_PENDING;
  const outDir = out ? path.resolve(out) : path.join(paths.packageRoot, 'vendor/ddl');

  if (!paths.ddlDir) {
    fail(
      'no DDL source resolves on this machine — set OATHE_DDL_DIR or OATHE_MONOREPO to a '
      + 'firia-monorepo checkout; vendoring copies FROM a real DDL source, it cannot invent one');
  }

  if (fs.existsSync(outDir)) {
    const existing = fs.readdirSync(outDir);
    if (existing.length > 0 && !force) {
      fail(`${outDir} already exists and is non-empty — refusing to overwrite without --force`);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });

  // shaOf reads through the same #ddlRoot resolver applyDdl uses, from paths.ddlDir — the one
  // hashing implementation, never duplicated here.
  const substrate = new Substrate({ database: 'vendor-ddl-unused', paths, env });

  const files = [];
  for (const name of DDL_FILES) {
    const src = path.join(paths.ddlDir, name);
    const dest = path.join(outDir, name);
    fs.copyFileSync(src, dest); // byte-identical copy — no per-file provenance header (R-B)
    files.push({ name, sha256: substrate.shaOf(name) });
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    source: MANIFEST_SOURCE,
    license: manifestLicense,
    files,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(
    `vendor-ddl: vendored ${files.length} DDL files from ${paths.ddlDir} to ${outDir} `
    + `(license: ${manifestLicense})\n`);
  return { outDir, manifest };
}

// Only execute when run as a script (tests import parseArgs/run without side effects otherwise).
// import.meta.url is percent-encoded AND resolved through realpath (a symlinked tmpdir, e.g.
// macOS's /tmp -> /private/tmp, otherwise still breaks the match) — compare against
// pathToFileURL(realpath(argv[1])), never a raw `file://${argv[1]}` template, or a path with a
// space/non-ASCII char (or a symlinked ancestor dir) silently fails the guard.
if (import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  run(process.argv.slice(2), process.env);
}

export { run, parseArgs };
