// R-NODE-FLOOR: the engines.node floor is an EXECUTED gate, not advisory prose. npm treats
// `engines` as a warning, so a below-floor runtime installs and runs — until the codex trace
// lane asks for node:sqlite (unflagged only from 22.13.0 / 23.4.0) and every verify on the
// machine stalls (the 22-verify pileup, 2026-08-31). The bin refuses below-floor runtimes
// itself, with the floor read from package.json — one declaration, executed at the door.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { nodeFloor, assertNodeFloor } from '../src/node-floor.mjs';
import { buildPaths } from '../src/paths.mjs';

const { packageRoot } = buildPaths({});
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'oathe.mjs');

const parse = (v) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v).slice(1, 4).map(Number);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

test('the declared floor covers the codex trace lane: node:sqlite is unflagged only from 22.13.0', () => {
  const floor = nodeFloor({ packageRoot });
  assert.ok(cmp(floor.parts, [22, 13, 0]) >= 0,
    `engines.node '${floor.raw}' admits runtimes with no usable node:sqlite — the codex thread index would be unreadable`);
});

test('a runtime below the floor is a typed refusal naming both versions', () => {
  assert.throws(() => assertNodeFloor({ version: 'v22.3.0', packageRoot }), (e) => {
    assert.equal(e.code, 'ERROR_NODE_VERSION');
    assert.match(e.message, /refused/, 'the trailer classifier reads refusals by their own word');
    assert.match(e.message, /v22\.3\.0/, 'names the runtime it found');
    assert.match(e.message, new RegExp(nodeFloor({ packageRoot }).raw.replace(/[.>=]/g, '\\$&')),
      'names the floor it holds');
    return true;
  });
});

test('a runtime at or above the floor passes', () => {
  assertNodeFloor({ version: 'v22.13.0', packageRoot });
  assertNodeFloor({ version: 'v24.14.0', packageRoot });
});

test('an engines shape the gate cannot read fails loud — never a silent pass', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-floor-'));
  fs.writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ name: 'x', engines: { node: '^22 || >=23' } }));
  assert.throws(() => assertNodeFloor({ version: 'v99.0.0', packageRoot: root }),
    (e) => e.code === 'OATHE_ENGINES_UNREADABLE');
});

/** A below-floor node this machine carries (nvm), or null — the refusal is proven for real
 *  where one exists and is n/a where none does, never a stolen pass. */
function belowFloorNodeOnThisMachine(floor) {
  const versionsDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  if (!fs.existsSync(versionsDir)) return null;
  const candidates = fs.readdirSync(versionsDir)
    .filter((d) => /^v\d+\.\d+\.\d+$/.test(d) && cmp(parse(d), floor.parts) < 0)
    .map((d) => path.join(versionsDir, d, 'bin', 'node'))
    .filter((bin) => fs.existsSync(bin));
  return candidates.at(-1) ?? null;
}

test('the install door executes the same gate: npm runs the floor before the package lands', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.preinstall, 'node bin/node-floor.mjs', 'preinstall names the shipped entry');
  assert.ok(pkg.files.includes('bin/'), 'the entry ships in the tarball');
  const ENTRY = path.join(packageRoot, 'bin', 'node-floor.mjs');
  assert.ok(fs.existsSync(ENTRY), 'the entry exists');
  const floor = nodeFloor({ packageRoot });
  const here = spawnSync(process.execPath, [ENTRY], { encoding: 'utf8' });
  if (cmp(parse(process.version), floor.parts) < 0) {
    assert.equal(here.status, 1, 'a below-floor runtime is refused at install');
    assert.match(here.stderr, /ERROR_NODE_VERSION/);
  } else {
    assert.equal(here.status, 0, `an at-floor runtime installs silently (stderr: ${here.stderr})`);
    assert.equal(here.stderr, '', 'nothing to say when the floor holds');
  }
  const old = belowFloorNodeOnThisMachine(floor);
  if (old) {
    const refused = spawnSync(old, [ENTRY], { encoding: 'utf8' });
    assert.equal(refused.status, 1, `${old} must be refused (stderr: ${refused.stderr})`);
    assert.match(refused.stderr, /ERROR_NODE_VERSION/, 'the typed code, not a crash');
    assert.match(refused.stderr, /nvm install 24/, 'the fix is named');
  }
});

test('the bin door executes the gate before any verb runs', () => {
  // The expectation follows the runtime the suite runs under, honestly: below the floor the
  // bin must refuse with the typed code and the refused trailer; at or above it, version runs.
  const floor = nodeFloor({ packageRoot });
  const below = cmp(parse(process.version), floor.parts) < 0;
  const out = spawnSync(process.execPath, [BIN, 'version'], { encoding: 'utf8' });
  if (below) {
    assert.equal(out.status, 1, `a below-floor runtime is refused (stderr: ${out.stderr})`);
    assert.match(out.stderr, /ERROR_NODE_VERSION/);
    assert.match(out.stderr, /oathe: version refused/, 'the trailer still lands');
  } else {
    assert.equal(out.status, 0, `an at-floor runtime runs (stderr: ${out.stderr})`);
    assert.match(out.stdout, /oathe: version ok/);
  }
});
