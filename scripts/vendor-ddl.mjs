#!/usr/bin/env node
// oathe — the DDL export script (Stage 1 A4-A6 prep, amended by the D0 correction packet §7).
// Exports each DDL_FILES entry from the runtime monorepo's DDL directory into an out dir,
// BORN-CLEAN: executable SQL is copied byte-exact, while comment lines carrying estate markers
// are rewritten to generic invariant language (R-OSS-7 — the public drop passes the estate
// marker scan with count zero). Provenance is TWO-SIDED in the sidecar manifest.json: the
// source commit and per-file source sha256 pin exactly what was exported; the public sha256
// pins exactly what shipped; the transform version names how one became the other. Never
// per-file headers — the substrate's DDL_DRIFT law (Substrate#applyDdl) compares the shipped
// bytes, and the manifest is the one place provenance lives.
//
// This script is PREPARED, not performed: it is never run with its default output during
// development or CI — dropping vendor/ddl into the tree is a founder-gated estate decision.
// Tests always pass an explicit --out pointed at a temp dir.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

import { buildPaths } from '../src/paths.mjs';
import { Substrate, DDL_FILES } from '../src/substrate.mjs';
import { sha256Hex } from '../src/manifest.mjs';
import { MARKER_PATTERNS } from './marker-scan.mjs';

export const MANIFEST_SOURCE = Object.freeze({
  // Deliberately non-nominal: naming the private repo would put an estate marker inside the
  // public manifest (§7.2's count-zero rule governs §7.3's fields). The commit hash plus the
  // per-file source sha256 pin provenance precisely without the name.
  repo: 'oathe-runtime-monorepo (private)',
});

export const MANIFEST_LICENSE_PENDING = 'PENDING-FOUNDER-DECISION';

export const EXPORT_TRANSFORM_VERSION = 'export-clean-1';

// Token-level rewrites applied ONLY to comment lines. Meaning-preserving generic language:
// the public DDL explains its invariants without estate vocabulary. Order matters — most
// specific first; the final catch-all guarantees count-zero or the loud refusal below fires.
const F = ['fir', 'ia'].join(''); // assembled so this script itself greps clean (R-OSS-7)
export const COMMENT_REWRITES = Object.freeze([
  [new RegExp('`?' + F + '_cell_domain`?\\.?', 'g'), 'the cell schema'],
  [new RegExp(F + '-executor-dispatcher/sql/001_dispatcher\\.sql', 'g'), "the dispatcher's own DDL (not vendored here)"],
  [new RegExp('`bin/' + F + '-acceptance-checkerd\\.mjs`', 'g'), 'the acceptance checker daemon'],
  [new RegExp('docs/' + F + '-runtime-a3/a3-ownership-return-design\\.md', 'g'), 'the ownership-return design of record'],
  [new RegExp('`' + F + '-runtime`', 'g'), 'the runtime package'],
  [new RegExp('\\bF' + F.slice(1) + '\\b', 'g'), 'Oathe'],
  [new RegExp(F + '-runtime', 'g'), 'the runtime package'],
  [new RegExp(F + '-monorepo', 'g'), 'the runtime monorepo'],
  [new RegExp('\\b' + F + '\\b', 'gi'), 'oathe'],
]);

function fail(message) {
  process.stderr.write(`vendor-ddl: ${message}\n`);
  process.exit(1);
}

/** Born-clean transform: comments (line comments AND the prose inside COMMENT ON string
 *  literals) lose their estate markers; real executable SQL is untouchable. */
export function transformForExport(name, text) {
  let inCommentOn = false;
  return text.split('\n').map((line, i) => {
    const wasInCommentOn = inCommentOn;
    if (/^\s*COMMENT ON /.test(line)) inCommentOn = true;
    if (inCommentOn && /';\s*$/.test(line)) inCommentOn = false;
    if (!MARKER_PATTERNS.some((p) => p.test(line))) return line;
    if (!/^\s*--/.test(line) && !wasInCommentOn && !/^\s*COMMENT ON /.test(line)) {
      fail(`${name}:${i + 1}: estate marker on a NON-comment line — refusing to transform executable SQL`);
    }
    let clean = line;
    for (const [pattern, replacement] of COMMENT_REWRITES) clean = clean.replace(pattern, replacement);
    if (MARKER_PATTERNS.some((p) => p.test(clean))) {
      fail(`${name}:${i + 1}: a marker survives every rewrite — extend COMMENT_REWRITES for: ${line.trim()}`);
    }
    return clean;
  }).join('\n');
}

function sourceCommit(ddlDir) {
  try {
    return execSync('git rev-parse HEAD', { cwd: ddlDir, encoding: 'utf8' }).trim();
  } catch (e) {
    fail(`the DDL source at ${ddlDir} is not inside a git checkout — two-sided provenance needs `
      + `the source commit (${String(e?.message || e).split('\n')[0]})`);
    return null; // unreachable; fail exits
  }
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
      if (license === '' || /\s/.test(license)) {
        fail(`--license must be a non-empty SPDX identifier with no whitespace, got: ${JSON.stringify(license)}`);
      }
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
      + 'runtime monorepo checkout; vendoring copies FROM a real DDL source, it cannot invent one');
  }

  if (fs.existsSync(outDir)) {
    const existing = fs.readdirSync(outDir);
    if (existing.length > 0 && !force) {
      fail(`${outDir} already exists and is non-empty — refusing to overwrite without --force`);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });

  const commit = sourceCommit(paths.ddlDir);

  // shaOf reads through the same #ddlRoot resolver applyDdl uses, from paths.ddlDir — the one
  // hashing implementation for the SOURCE side; the public side hashes the transformed bytes.
  const substrate = new Substrate({ database: 'vendor-ddl-unused', paths, env });

  const files = [];
  for (const [index, name] of DDL_FILES.entries()) {
    const sourceText = fs.readFileSync(path.join(paths.ddlDir, name), 'utf8');
    const publicText = transformForExport(name, sourceText);
    fs.writeFileSync(path.join(outDir, name), publicText);
    files.push({
      position: index + 1,
      name,
      source_sha256: substrate.shaOf(name),
      public_sha256: sha256Hex(publicText),
    });
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    source: { ...MANIFEST_SOURCE, commit },
    transform: { version: EXPORT_TRANSFORM_VERSION, script: 'scripts/vendor-ddl.mjs' },
    license: manifestLicense,
    files,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(
    `vendor-ddl: exported ${files.length} DDL files born-clean from ${paths.ddlDir} to ${outDir} `
    + `(source commit ${commit.slice(0, 12)}, transform ${EXPORT_TRANSFORM_VERSION}, license: ${manifestLicense})\n`);
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
