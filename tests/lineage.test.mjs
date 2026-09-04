// Lineage (founder ruling 2026-09-01: provenance now, delegation later). Work claimed while a
// session already holds a claim is recorded as SPAWNED under it — one observation statement
// on the parent's claim, `spawn:<child>`, riding the statement transport every other fact
// rides. The board folds children under their parent (UX rule 21: siblings are one row), the
// digest groups their breaches, attention names the parent once. The delegation column
// (cell.work_claim.parent_work_claim_id) stays reserved for accountable cross-principal
// delegation; the one read fragment (spawnParentSql) will union both edges when it ships.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createOatheTools } from '../src/mcp/oathe-tools.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';
import { OatheConfig } from '../src/config.mjs';
import { Verifier } from '../src/verifier.mjs';
import { StandaloneRuntimeProvider } from '../src/runtime/provider.mjs';
import { standardPlan } from '../src/plans.mjs';
import { Pager } from '../src/pager.mjs';
import { renderBoard } from '../src/board-render.mjs';
import { spawnSubjectRef } from '../src/statements.mjs';

const paths = buildPaths({});
const SCRATCH_DB = `oathe_lineage_test_${process.pid}`;
const WS = 'ws-lineage0000000';
const OPERATOR = 'founder';
const VERIFIER = 'oathe-verifier';
const IDENTITY = { orgId: 'oathe', principalId: OPERATOR, department: 'founder' };
const seam = { register: async () => ({}), activate: async () => ({}) };

let substrate;
let config;
let transcript;
let verifier;
let engineVerdict;

function scratchConfig() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-lineage-cfg-')));
  return new OatheConfig({ env: { HOME: home, OATHE_HOME: path.join(home, '.oathe') }, cwd: home });
}

/** A serving surface speaking from `session` (null: a bare terminal, no session at all). */
function toolsFor(session) {
  return createOatheTools({
    client: substrate, identity: IDENTITY, workspace: WS, config, activation: seam,
    // null: a surface with no hooks (the ChatGPT desktop app) — the one session-less speaker
    // the claim gate admits (ruling 2026-09-04); a bare terminal can no longer claim.
    speaker: session ? { surface: 'claude', app: null, session } : { surface: 'chatgpt', app: { bundle: '/Applications/ChatGPT.app', pid: 4242 }, session: null, walked: true, client: 'codex', pid: 4242, device: null },
  });
}
const session = (sessionId) => ({ sessionId, transcriptPath: transcript, harness: 'claude' });
const spawnRows = (child) => substrate.query(
  `SELECT task_id AS parent, work_claim_id, statement_type, evidence_refs
     FROM cell.agent_statement WHERE org_id = 'oathe' AND subject_ref = $1`, [spawnSubjectRef(child)]);

before(async () => {
  substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await substrate.ensureDatabase();
  await substrate.applyDdl();
  await substrate.seed({ orgId: 'oathe', principalId: OPERATOR, department: 'founder' });
  await substrate.seedVerifier({ orgId: 'oathe', verifierPrincipal: VERIFIER, operatorPrincipal: OPERATOR, department: 'verification' });
  await substrate.registerYieldCause();
  await substrate.registerAcceptanceAuthority({
    orgId: 'oathe', seats: [VERIFIER, OPERATOR], clauseSpecs: standardPlan().clause_spec,
    checkerRefs: { 'checker://acceptance_package': 'verification-clause' }, registeredBy: 'oathe-test',
  });
  config = scratchConfig();
  // One transcript for the session's every claim — a Claude transcript lives in Claude's
  // store layout (ownership is by path), carrying enough for the verifier lane to judge.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-lineage-trace-')), '.claude', 'projects', 'fixture');
  fs.mkdirSync(dir, { recursive: true });
  transcript = path.join(dir, 'sess-lin-1.jsonl');
  const sessionId = crypto.randomUUID();
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId, cwd: dir, message: { role: 'user', content: 'work' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId, cwd: dir,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'make it' } }] } }),
    JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId, cwd: dir,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'made it\nExit code 0' }] } }),
  ].join('\n'));
  verifier = new Verifier({
    substrate, paths, workspace: WS, config, operatorPrincipal: OPERATOR,
    provider: new StandaloneRuntimeProvider({ paths }),
    engineRunner: async () => engineVerdict,
  });
});

after(async () => {
  await verifier.close();
  await substrate.close();
  await substrate.dropDatabase();
});

test('a session\'s first claim is a root: lineage null, no spawn statement', async () => {
  const tools = toolsFor(session('sess-lin-1'));
  const a = await tools.oathe_claim({ task_id: 'A', objective: 'the root' });
  assert.equal(a.lineage, null);
  assert.equal((await spawnRows('A')).rows.length, 0);
});

test('work claimed while the session holds a claim is spawned under it — one observation on the parent\'s claim; siblings share the root', async () => {
  const tools = toolsFor(session('sess-lin-1'));
  const b1 = await tools.oathe_claim({ task_id: 'B1', objective: 'child one' });
  assert.deepEqual(b1.lineage, { parent: 'A' });
  const { rows } = await spawnRows('B1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].parent, 'A');
  assert.equal(rows[0].statement_type, 'observation');
  assert.deepEqual(rows[0].evidence_refs, ['task:B1']);
  const { rows: [claim] } = await substrate.query("SELECT work_claim_id FROM cell.work_claim WHERE task_id = 'A' AND state = 'active'");
  assert.equal(rows[0].work_claim_id, claim.work_claim_id, 'on the parent\'s active claim');
  const b2 = await tools.oathe_claim({ task_id: 'B2', objective: 'child two' });
  assert.deepEqual(b2.lineage, { parent: 'A' }, 'a recorded child is never a candidate parent');
});

test('yield and reclaim leave ONE spawn statement — idempotent by (claim, subject)', async () => {
  const tools = toolsFor(session('sess-lin-1'));
  await tools.oathe_yield({ task_id: 'B1', note: 'stepping off' });
  const again = await tools.oathe_claim({ task_id: 'B1' });
  assert.deepEqual(again.lineage, { parent: 'A' });
  assert.equal((await spawnRows('B1')).rows.length, 1);
});

test('parent: null opts out; parent: <id> names it; a parent this principal does not hold, or the task itself, refuses BEFORE any claim lands', async () => {
  const tools = toolsFor(session('sess-lin-1'));
  const c = await tools.oathe_claim({ task_id: 'C', objective: 'standalone', parent: null });
  assert.equal(c.lineage, null);
  assert.equal((await spawnRows('C')).rows.length, 0);
  const d = await tools.oathe_claim({ task_id: 'D', objective: 'named parent', parent: 'A' });
  assert.deepEqual(d.lineage, { parent: 'A' });
  await assert.rejects(tools.oathe_claim({ task_id: 'E', objective: 'orphan', parent: 'nope' }),
    (e) => e.code === 'OATHE_SPAWN_PARENT_NOT_HELD');
  await assert.rejects(tools.oathe_claim({ task_id: 'E', objective: 'itself', parent: 'E' }),
    (e) => e.code === 'OATHE_SPAWN_PARENT_NOT_HELD');
  assert.equal((await substrate.query("SELECT 1 FROM cell.task WHERE task_id = 'E'")).rows.length, 0, 'the refusal came before the mint');
});

test('no session, no lineage: a bare surface\'s claim is a root', async () => {
  const f = await toolsFor(null).oathe_claim({ task_id: 'F', objective: 'from a bare terminal' });
  assert.equal(f.lineage, null);
});

test('the board folds children under their parent: sections hold roots, the root carries the counts line; a settled child counts as settled', async () => {
  const tools = toolsFor(session('sess-lin-1'));
  const board = await tools.oathe_board({});
  assert.deepEqual(board.sections.mine.map((r) => r.task_id).sort(), ['A', 'C', 'F'], 'children never surface top-level while the parent is in view');
  const a = board.sections.mine.find((r) => r.task_id === 'A');
  assert.deepEqual(a.children, { n: 3, by: { active: 3 }, line: 'spawned 3 — 3 active' });
  assert.ok(board.board.some((r) => r.task_id === 'B1' && r.parent === 'A'), 'the raw rows carry the parent');
  assert.ok(!('children' in board.sections.mine.find((r) => r.task_id === 'C')), 'a root without children carries no line');

  await tools.oathe_done({ task_id: 'B1', proposition: 'child one done', evidence_ref: 'x' });
  engineVerdict = { verdict: 'accepted', reason: 'fine' };
  assert.equal((await verifier.verify({ taskId: 'B1' })).settled, true);
  const after = (await tools.oathe_board({})).sections.mine.find((r) => r.task_id === 'A');
  assert.deepEqual(after.children, { n: 3, by: { active: 2, settled: 1 }, line: 'spawned 3 — 2 active · 1 settled' });
});

test('the rendered board: one ↳ line under the root, no child bullets', async () => {
  const { context } = await renderBoard({ client: substrate, identity: IDENTITY, workspace: WS, config });
  assert.match(context, /^  ↳ spawned 3 — 2 active · 1 settled$/m);
  assert.doesNotMatch(context, /^- \[(B1|B2|D)\]/m, 'children are counted, never listed, while the parent is in view');
});

test('rejected children are ONE digest row under the parent, and attention names the parent once', async () => {
  const tools = toolsFor(session('sess-lin-1'));
  for (const id of ['B2', 'D']) {
    await tools.oathe_done({ task_id: id, proposition: `${id} done`, evidence_ref: 'x' });
    engineVerdict = { verdict: 'rejected', reason: `${id} is not it` };
    await verifier.verify({ taskId: id });
  }
  const pager = new Pager({ client: substrate, identity: IDENTITY, config });
  const kids = (await pager.breaches()).filter((b) => ['B2', 'D'].includes(b.task_id));
  assert.equal(kids.length, 2);
  assert.ok(kids.every((b) => b.kind === 'reopened' && b.parent === 'A' && b.parent_objective === 'the root'), JSON.stringify(kids));
  const digest = await pager.digest();
  const group = digest.rows.find((r) => r.task_id === 'A');
  assert.ok(group, 'one row for the parent');
  assert.deepEqual([group.group.n, group.kind_word, group.objective], [2, '2 rejected', 'the root']);
  assert.ok(!digest.rows.some((r) => ['B2', 'D'].includes(r.task_id)), 'no child has its own row');

  const board = await tools.oathe_board({});
  const lines = board.attention.filter((l) => /'A'|'B2'|'D'/.test(l));
  assert.equal(lines.length, 1, JSON.stringify(board.attention));
  assert.match(lines[0], /^spawned under 'A': 2 rejected — /);
  assert.equal(board.breaches.find((b) => b.task_id === 'A')?.group?.n, 2, 'the pull carries the group whole');
});
