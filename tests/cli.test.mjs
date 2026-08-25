import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { sandbox } from './helpers.mjs';
import { runInit } from '../src/init.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';

const paths = buildPaths({});
const SCRATCH_DB = `oathe_cli_test_${process.pid}`;
const BIN = path.join(paths.packageRoot, 'bin/oathe.mjs');

let sb;

function oathe(args, env = sb.env) {
  return spawnSync('node', [BIN, ...args], { encoding: 'utf8', env, cwd: sb.home });
}

before(async () => {
  sb = sandbox({ scratchDb: SCRATCH_DB });
  await runInit({ env: sb.env, exec: sb.exec });
});

after(async () => {
  const substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await substrate.close();
  await substrate.dropDatabase();
});

test('oathe with no verb prints usage and the verb list', () => {
  const out = oathe([]);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /usage/i);
  for (const verb of ['init', 'claude', 'claim', 'ls', 'note', 'yield', 'doctor', 'uninstall', 'status']) {
    assert.match(out.stderr, new RegExp(`\\b${verb}\\b`));
  }
});

test('claim → ls → note → yield: the play loop, productized, with the machine-parseable ready line', () => {
  const claim = oathe(['claim', 'cli-task', 'Prove the CLI loop']);
  assert.equal(claim.status, 0, claim.stderr);
  assert.match(claim.stdout, /claimed: cli-task/);
  assert.match(claim.stdout, /^oathe: claim ok$/m);

  const ls = oathe(['ls']);
  assert.equal(ls.status, 0);
  assert.match(ls.stdout, /cli-task/);
  assert.match(ls.stdout, /active/);

  const note = oathe(['note', 'cli-task', 'progress happened', 'ref:test']);
  assert.equal(note.status, 0, note.stderr);
  assert.match(note.stdout, /statement recorded/);

  const yieldOut = oathe(['yield', 'cli-task', 'handing off']);
  assert.equal(yieldOut.status, 0, yieldOut.stderr);
  assert.match(yieldOut.stdout, /back on the board/);
});

test('claim → done closes the loop from the CLI', () => {
  const claim = oathe(['claim', 'done-cli-task', 'Close me properly']);
  assert.equal(claim.status, 0, claim.stderr);
  const done = oathe(['done', 'done-cli-task', 'closed properly', 'ref:cli-test']);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /completion ASSERTED, not settled/);
  assert.match(done.stdout, /^oathe: done ok$/m);
});

test('a second claim is the substrate refusal, faithfully non-zero', () => {
  oathe(['claim', 'twice-task', 'claim me once']);
  const second = oathe(['claim', 'twice-task', 'claim me twice']);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /oathe: claim refused/);
});

test('doctor prints per-row verdicts and the substrate summary', () => {
  const out = oathe(['doctor']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /substrate.*reachable/i);
  assert.match(out.stdout, /ddl.*26/i);
  assert.match(out.stdout, /ok/);
  assert.match(out.stdout, /^oathe: doctor ok$/m);
});

test('status is the doctor substrate half', () => {
  const out = oathe(['status']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /database.*oathe_cli_test/i);
  assert.match(out.stdout, /^oathe: status ok$/m);
});

test('ls --all widens beyond the workspace', () => {
  const out = oathe(['ls', '--all']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^oathe: ls ok$/m);
});
