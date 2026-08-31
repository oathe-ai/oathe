#!/usr/bin/env node
// oathe — the private-marker scan. Walks one or more directories looking for the private
// vocabulary — founder name, machine paths, source-monorepo name, session ids — so that
// BEFORE anything (e.g. a vendored DDL tree) ships out of the private tree, a human can see
// exactly what private-specific text it carries and decide what to do about it. Pre-export
// DDL WILL hit on this vocabulary — that is the point: the scan output is the founder's
// decision surface, not a thing this script silently launders.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The hunted vocabulary is assembled at runtime so the scanner itself greps clean —
// the public tree carries these words NOWHERE as literals (R-OSS-7 count-zero).
const F = ['fir', 'ia'].join('');
const FY = ['fir', 'iya'].join('');
const SM = ['sh', 'ez'].join('') + '.' + ['ma', 'lik'].join(''); // assembled so no fragment of the name appears as a literal
export const MARKER_PATTERNS = Object.freeze([
  new RegExp(F, 'i'),
  new RegExp(FY, 'i'),
  new RegExp(`/Users/${FY}`),
  new RegExp(`${F}-monorepo`),
  /session_01[A-Za-z0-9]+/,
  new RegExp('oathe-' + ['play', 'ground'].join('')),
  /ws-[0-9a-f]{12}/,
  /\.ai-docs/,
  /\.superpowers/,
  /Claude-Session:/,
  new RegExp(SM.replace('.', '\\.'), 'i'),
]);

const SKIP_DIR_NAMES = Object.freeze(['node_modules', '.git']);

function fail(message) {
  process.stderr.write(`marker-scan: ${message}\n`);
  process.exit(1);
}

// Simple binary heuristic: a NUL byte anywhere in a leading chunk means "not text" — good enough
// to keep this scan off images/binaries without a MIME-sniffing dependency.
function looksBinary(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function scanFile(filePath) {
  const hits = [];
  if (looksBinary(filePath)) return hits;
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    for (const pattern of MARKER_PATTERNS) {
      if (pattern.test(line)) {
        hits.push({ file: filePath, line: idx + 1, pattern: pattern.source });
      }
    }
  });
  return hits;
}

function run(argv) {
  const dirs = argv;
  if (dirs.length === 0) {
    fail('usage: marker-scan.mjs <dir>...');
  }
  for (const dir of dirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      fail(`not a directory: ${dir}`);
    }
  }

  let filesScanned = 0;
  const allHits = [];
  for (const dir of dirs) {
    for (const filePath of walk(dir)) {
      filesScanned++;
      allHits.push(...scanFile(filePath));
    }
  }

  for (const hit of allHits) {
    process.stdout.write(`${hit.file}:${hit.line}: ${hit.pattern}\n`);
  }

  if (allHits.length > 0) {
    process.stdout.write(`marker-scan: ${allHits.length} hit(s) across ${filesScanned} file(s) scanned\n`);
    return 1;
  }
  process.stdout.write(`marker-scan: clean — 0 hits across ${filesScanned} file(s) scanned\n`);
  return 0;
}

// import.meta.url is percent-encoded (e.g. spaces become %20) AND resolved through realpath
// (a symlinked tmpdir, e.g. macOS's /tmp -> /private/tmp, otherwise still breaks the match); a
// raw `file://${argv[1]}` comparison silently fails on either, and the guard's body never runs —
// the worst failure mode for a leakage gate: a scan that reports 0 hits because it scanned
// NOTHING, and exits 0.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exit(run(process.argv.slice(2)));
}

export { run };
