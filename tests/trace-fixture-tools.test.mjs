// The corpus tools (scripts/trace-fixtures.mjs): ONE listing of the fixture dirs, ONE
// materialization of a fixture's home (the state sidecar bound to the scratch), ONE projection
// shared by derive and repin — and `derive-trace-fixtures.mjs --repin <dir>`, which rewrites a
// fixture's expected.json from its record when the projector changes on purpose (lane 1 moves
// fields between extra.record and extra.oathe at several steps). A repin never touches the
// record: the sanitized bytes are the reviewed artifact, the expectation is derived.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CORPUS, fixtureDirs, materialize, projectFixture } from '../scripts/trace-fixtures.mjs';
import { requireSqlite } from './helpers.mjs';

requireSqlite();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DERIVE = path.join(root, 'scripts/derive-trace-fixtures.mjs');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashTree = (dir) => fs.readdirSync(dir, { recursive: true })
  .map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort()
  .map((f) => [f, sha(path.join(dir, f))]);
const withState = () => fixtureDirs('codex').find((d) => fs.existsSync(path.join(d, 'state.sql')));

/** A fixture copied into a scratch corpus, so the test can drift and repin without touching the tree. */
function copied(dir) {
  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-repin-'));
  const dst = path.join(corpus, path.basename(path.dirname(dir)), path.basename(dir));
  fs.cpSync(dir, dst, { recursive: true });
  return dst;
}

test('fixtureDirs lists the corpus per harness — dropping a fixture in adds a case; an unknown harness lists nothing', () => {
  assert.ok(fixtureDirs('codex').length >= 5);
  assert.ok(fixtureDirs('claude').length >= 3);
  assert.ok(fixtureDirs('codex').every((d) => d.startsWith(path.join(CORPUS, 'codex'))));
  assert.deepEqual(fixtureDirs('nope'), []);
});

test('materialize copies home/ to a scratch and binds the state sidecar\'s <home> to it', () => {
  const scratch = materialize(withState());
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(path.join(scratch, '.codex', 'state_5.sqlite'), { readOnly: true });
  const rows = db.prepare('SELECT rollout_path FROM threads').all();
  db.close();
  assert.ok(rows.length > 0 && rows.every((r) => r.rollout_path.startsWith(scratch)), '<home> bound to the scratch');
});

test('projectFixture is the ONE projection derive and repin share — the expectation, home-normalized', async () => {
  for (const dir of [fixtureDirs('codex')[0], fixtureDirs('claude')[0]]) {
    const trajectory = await projectFixture(dir);
    assert.deepEqual(trajectory, JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')).trajectory);
    assert.ok(!JSON.stringify(trajectory).includes(os.tmpdir()), 'no scratch path leaks into an expectation');
  }
});

test('--repin rewrites ONLY expected.json: a drifted expectation is the projection again; the record and the sidecar stay byte-identical', () => {
  const dir = copied(withState());
  const expectedPath = path.join(dir, 'expected.json');
  const before = { home: hashTree(path.join(dir, 'home')), state: sha(path.join(dir, 'state.sql')) };
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const original = expected.trajectory;
  fs.writeFileSync(expectedPath, JSON.stringify({ ...expected, trajectory: { drifted: true } }));
  const out = spawnSync('node', [DERIVE, '--repin', dir], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /repin: .* ok$/m);
  const after = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  assert.deepEqual(after.trajectory, original, 'the projection is the expectation again');
  assert.equal(after.record, expected.record, 'the record pointer is kept');
  assert.match(after._source, /derive-trace-fixtures/, 'the provenance line is kept');
  assert.deepEqual(hashTree(path.join(dir, 'home')), before.home, 'the sanitized record is untouched');
  assert.equal(sha(path.join(dir, 'state.sql')), before.state, 'the sidecar is untouched');
  assert.ok(!fs.existsSync(path.join(dir, 'home', '.codex', 'state_5.sqlite')), 'no materialized db left in the fixture');
});

test('--repin refuses a directory without a record — exit 2, OATHE_FIXTURE_REPIN_NO_HOME, nothing written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-repin-empty-'));
  fs.writeFileSync(path.join(dir, 'expected.json'), '{}');
  const out = spawnSync('node', [DERIVE, '--repin', dir], { encoding: 'utf8' });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /\[OATHE_FIXTURE_REPIN_NO_HOME\]/);
  assert.equal(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'), '{}');
});

// ---- the window: `--from <line>` (step 14) — a fixture cut around the event of interest,
// not from the head; the identity row always rides along.

/** Derive from a corpus fixture's own (already sanitized) record into a scratch corpus. */
function derived(harness, sourceDir, args) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-derive-out-'));
  const record = JSON.parse(fs.readFileSync(path.join(sourceDir, 'expected.json'), 'utf8')).record;
  const res = spawnSync('node', [DERIVE, harness, '--file', path.join(sourceDir, 'home', record), '--name', 'window', '--out', out, ...args], { encoding: 'utf8' });
  const dir = fs.existsSync(path.join(out, harness)) ? path.join(out, harness, fs.readdirSync(path.join(out, harness))[0]) : null;
  return { res, dir, sourceRows: fs.readFileSync(path.join(sourceDir, 'home', record), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}
const shapeOfRow = (r) => `${r.type}:${r.payload?.type ?? r.message?.role ?? ''}`;
const recordRows = (dir) => {
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')).record;
  return fs.readFileSync(path.join(dir, 'home', record), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

test('--from cuts the window at a line: the head row (identity) then the rows from there, capped — the same rule on both trace stores', () => {
  // cut where the projector can pair: the codex user prompt (no result precedes it), the Claude human row
  const codex = derived('codex', fixtureDirs('codex').find((d) => d.includes('exec-wrapped')), ['--from', '6', '--max-lines', '3']);
  assert.equal(codex.res.status, 0, codex.res.stderr);
  const rows = recordRows(codex.dir);
  assert.deepEqual(rows.map(shapeOfRow), [codex.sourceRows[0], ...codex.sourceRows.slice(5, 8)].map(shapeOfRow), 'head + lines 6..8');
  assert.equal(rows[0].type, 'session_meta');
  const claude = derived('claude', fixtureDirs('claude').find((d) => d.includes('tool-pair')), ['--from', '11', '--max-lines', '2']);
  assert.equal(claude.res.status, 0, claude.res.stderr);
  assert.deepEqual(recordRows(claude.dir).map(shapeOfRow), [claude.sourceRows[0], ...claude.sourceRows.slice(10, 12)].map(shapeOfRow));
  const expected = JSON.parse(fs.readFileSync(path.join(claude.dir, 'expected.json'), 'utf8'));
  assert.deepEqual(expected.window, { from: 11, max_lines: 2 }, 'the window is provenance');
});

test('--from outside the record is a typed refusal — exit 2, OATHE_FIXTURE_FROM_OUT_OF_RANGE, nothing written', () => {
  const src = fixtureDirs('codex').find((d) => d.includes('exec-wrapped'));
  for (const from of ['1', '99999', 'x']) {
    const { res, dir } = derived('codex', src, ['--from', from]);
    assert.equal(res.status, 2, `--from ${from}`);
    assert.match(res.stderr, /\[OATHE_FIXTURE_FROM_OUT_OF_RANGE\]/);
    assert.equal(dir, null, 'nothing written');
  }
});

test('a Claude subagent rides along only when the call that launched it is in the window — the fixture carries the children the window spawned, and says which it left out', () => {
  const src = fixtureDirs('claude').find((d) => d.includes('subagent-fanout'));
  const source = JSON.parse(fs.readFileSync(path.join(src, 'expected.json'), 'utf8')).record;
  const rows = fs.readFileSync(path.join(src, 'home', source), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const agentLine = rows.findIndex((r) => r.type === 'assistant' && (r.message?.content ?? []).some((p) => p.type === 'tool_use' && p.name === 'Agent')) + 1;
  assert.ok(agentLine > 0, 'the fan-out fixture launches an Agent');
  const withCall = derived('claude', src, ['--max-lines', '80']);
  assert.equal(withCall.res.status, 0, withCall.res.stderr);
  const subagentsOf = (dir) => {
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')).record;
    const subDir = path.join(dir, 'home', record.replace(/\.jsonl$/, ''), 'subagents');
    return fs.existsSync(subDir) ? fs.readdirSync(subDir).filter((f) => f.endsWith('.jsonl')) : [];
  };
  assert.equal(subagentsOf(withCall.dir).length, 1, 'the window holds the Agent call: its child rides along');
  // the next assistant row after the launch's receipt — a cut the projector can pair
  const after = rows.findIndex((r, i) => i + 1 > agentLine + 1 && r.type === 'assistant') + 1;
  const withoutCall = derived('claude', src, ['--from', String(after), '--max-lines', '80']);
  assert.equal(withoutCall.res.status, 0, withoutCall.res.stderr);
  assert.deepEqual(subagentsOf(withoutCall.dir), [], 'the window starts after the launch: no child, no dangling ref');
  assert.match(withoutCall.res.stderr, /subagent .* left out: its launching call .* is outside the window/);
});
