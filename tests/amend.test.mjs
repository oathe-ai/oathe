// R-AMEND: changing an open obligation's definition of done is RECORDED, never laundered.
// Amend works only while a claim is active, only from an acceptance seat that is not the
// judge, inside one transaction that locks the claim row — so the amend-vs-done race is
// decided by the lock, and "the version in force at assertion" is exact. The version is
// DERIVED from the trail; contract_ref stays @v1 (src/home.mjs untouched, by design).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Substrate } from '../src/substrate.mjs';
import { createOatheTools } from '../src/mcp/oathe-tools.mjs';
import { Verifier } from '../src/verifier.mjs';
import { buildPaths } from '../src/paths.mjs';
import { OatheConfig } from '../src/config.mjs';
import { standardPlan } from '../src/plans.mjs';
import { StandaloneRuntimeProvider } from '../src/runtime/provider.mjs';

const paths = buildPaths({});
const SCRATCH_DB = `oathe_amend_test_${process.pid}`;
const WS = 'ws-amend00000000';
const OPERATOR = 'founder';
const VERIFIER = 'oathe-verifier';
const IDENTITY = { orgId: 'oathe', principalId: OPERATOR, department: 'founder' };

let substrate;
let tools;
let verifier;
let engineVerdict;
let enginePrompts;

function scratchConfig(extraEnv = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-amend-cfg-')));
  return new OatheConfig({ env: { HOME: home, OATHE_HOME: path.join(home, '.oathe'), ...extraEnv }, cwd: home });
}

async function linkTrace(taskId, workClaimId) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-amend-trace-')), '.claude', 'projects', 'fixture');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${taskId}.jsonl`);
  const sessionId = crypto.randomUUID();
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId, cwd: dir, message: { role: 'user', content: 'work' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId, cwd: dir,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'make it' } }] } }),
    JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId, cwd: dir,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'made it\nExit code 0' }] } }),
  ].join('\n'));
  await substrate.query(
    `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
            execution_actor, claim_principal, statement_type, subject_ref, proposition,
            evidence_refs, epistemic_status, asserted_at)
     VALUES ($1, 'oathe', $2, $3, $4, $5, 'progress', $6, 'trace', $7::jsonb, 'observed', now())`,
    [crypto.randomUUID(), taskId, workClaimId, `session:${sessionId}`, OPERATOR, `trace:${sessionId}`,
      JSON.stringify([file])]);
}

before(async () => {
  substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await substrate.ensureDatabase();
  await substrate.applyDdl();
  await substrate.seed({ orgId: 'oathe', principalId: OPERATOR, department: 'founder' });
  await substrate.seedVerifier({
    orgId: 'oathe', verifierPrincipal: VERIFIER, operatorPrincipal: OPERATOR, department: 'verification',
  });
  await substrate.registerYieldCause();
  tools = createOatheTools({ client: substrate, identity: IDENTITY, workspace: WS, config: scratchConfig() });
  enginePrompts = [];
  verifier = new Verifier({
    substrate, paths, workspace: WS, config: scratchConfig(), operatorPrincipal: OPERATOR,
    provider: new StandaloneRuntimeProvider({ paths }),
    engineRunner: async ({ prompt }) => { enginePrompts.push(prompt); return engineVerdict; },
  });
});

after(async () => {
  await verifier.close();
  await substrate.close();
  await substrate.dropDatabase();
});

test('BEFORE the roster exists: an absent acceptance-authority row is its own typed refusal', async () => {
  await tools.oathe_claim({ task_id: 'amend-noroster', objective: 'v1 words' });
  await assert.rejects(tools.oathe_amend({ task_id: 'amend-noroster', objective: 'v2 words', why: 'scope moved' }),
    (e) => e.code === 'OATHE_AMEND_UNAUTHORIZED' && /no acceptance authority/i.test(e.message));
  // Register the roster for everything after (mirrors init).
  await substrate.registerAcceptanceAuthority({
    orgId: 'oathe',
    seats: [VERIFIER, OPERATOR],
    clauseSpecs: standardPlan().clause_spec,
    checkerRefs: { 'checker://acceptance_package': 'verification-clause' },
    registeredBy: 'oathe-test',
  });
  await tools.oathe_yield({ task_id: 'amend-noroster', note: 'fixture done' });
});

test('the refusal matrix: unclaimed, after-done, verify:*, non-seat amender, and the JUDGE are each typed refusals', async () => {
  // Unclaimed (never claimed): active-claim-only is the pinned policy.
  await substrate.query(
    `INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan, verify_by, claim_mode, created_at)
     VALUES ('oathe', 'amend-unclaimed', 'founder', 'nobody holds this', 'minted_at_claim', '{"plan_status":"unknown"}'::jsonb,
             now() + interval '1 day', 'exclusive', now())`);
  await assert.rejects(tools.oathe_amend({ task_id: 'amend-unclaimed', objective: 'x', why: 'y' }),
    (e) => e.code === 'OATHE_AMEND_AFTER_DONE' && /active claim/i.test(e.message));

  // After done: the definition of done is frozen at assertion.
  const c = await tools.oathe_claim({ task_id: 'amend-late', objective: 'freeze me' });
  await linkTrace('amend-late', c.work_claim_id);
  await tools.oathe_done({ task_id: 'amend-late', proposition: 'done', evidence_ref: 'x' });
  await assert.rejects(tools.oathe_amend({ task_id: 'amend-late', objective: 'moved goalposts', why: 'no' }),
    (e) => e.code === 'OATHE_AMEND_AFTER_DONE');

  // verify:* — generated objectives are owned by plans.mjs.
  await assert.rejects(tools.oathe_amend({ task_id: 'verify:amend-late', objective: 'x', why: 'y' }),
    (e) => e.code === 'OATHE_AMEND_VERIFY_TASK');

  // A principal outside the seats roster.
  const stranger = createOatheTools({
    client: substrate, identity: { orgId: 'oathe', principalId: 'stranger', department: 'founder' },
    workspace: WS, config: scratchConfig(),
  });
  await tools.oathe_claim({ task_id: 'amend-seatless', objective: 'held by founder' });
  await assert.rejects(stranger.oathe_amend({ task_id: 'amend-seatless', objective: 'x', why: 'y' }),
    (e) => e.code === 'OATHE_AMEND_UNAUTHORIZED' && /stranger/.test(e.message) && /roster|seats/.test(e.message));

  // The judge must not move the bar it judges.
  const judge = createOatheTools({
    client: substrate, identity: { orgId: 'oathe', principalId: VERIFIER, department: 'verification' },
    workspace: WS, config: scratchConfig(),
  });
  await assert.rejects(judge.oathe_amend({ task_id: 'amend-seatless', objective: 'x', why: 'y' }),
    (e) => e.code === 'OATHE_AMEND_UNAUTHORIZED' && /judge|verifier/i.test(e.message));
  await tools.oathe_yield({ task_id: 'amend-seatless', note: 'fixture done' });
});

test('a lawful amend RECORDS: the trail statement carries old→new and why, the objective updates, the version derives from the trail, contract_ref stays @v1', async () => {
  await tools.oathe_claim({ task_id: 'amend-happy', objective: 'ship the alpha widget' });
  const first = await tools.oathe_amend({ task_id: 'amend-happy', objective: 'ship the beta widget', why: 'alpha was descoped' });
  assert.equal(first.amended, true);
  assert.ok(first.work_claim_id, 'an amendment fingerprints the claim whose bar moved');
  assert.equal(first.version, 2, 'v2 = one amendment, derived');
  assert.match(first.note, /original definition stays on record/i, "the product copy: changing one's mind is recorded");
  const { rows: task } = await substrate.query(
    "SELECT objective FROM cell.task WHERE org_id='oathe' AND task_id='amend-happy'");
  assert.equal(task[0].objective, 'ship the beta widget');
  const { rows: trail } = await substrate.query(
    `SELECT statement_type, proposition FROM cell.agent_statement
      WHERE org_id='oathe' AND task_id='amend-happy' AND subject_ref = 'amend:amend-happy'`);
  assert.equal(trail.length, 1);
  assert.equal(trail[0].statement_type, 'observation');
  assert.match(trail[0].proposition, /ship the alpha widget/, 'the OLD definition stays on record');
  assert.match(trail[0].proposition, /ship the beta widget/);
  assert.match(trail[0].proposition, /alpha was descoped/, 'the why is recorded');
  const second = await tools.oathe_amend({ task_id: 'amend-happy', objective: 'ship the beta widget, documented', why: 'docs ruled in' });
  assert.equal(second.version, 3);
  const board = await tools.oathe_board({});
  const row = board.board.find((r) => r.task_id === 'amend-happy');
  assert.equal(row.objective, 'ship the beta widget, documented');
  assert.ok(!/alpha was descoped/.test(row.last_progress ?? ''), 'an amendment is never the last word of progress');
  assert.match(row.contract_ref, /@v1$/, 'the ref grammar is untouched — the version lives in the trail');
  await tools.oathe_yield({ task_id: 'amend-happy', note: 'fixture done' });
});

test('the RACE is decided by the claim-row lock, both interleavings lawful — no amendment may postdate the completion assertion', async () => {
  const other = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  const otherTools = createOatheTools({ client: other, identity: IDENTITY, workspace: WS, config: scratchConfig() });
  try {
    // Interleaving 1: done first (lock held through statement+terminal) — the amend must refuse.
    const c1 = await tools.oathe_claim({ task_id: 'race-1', objective: 'v1' });
    await linkTrace('race-1', c1.work_claim_id);
    const { rows: claimRow1 } = await substrate.query(
      "SELECT work_claim_id FROM cell.work_claim WHERE org_id='oathe' AND task_id='race-1' AND state='active'");
    await substrate.query('BEGIN');
    await substrate.query('SELECT 1 FROM cell.work_claim WHERE work_claim_id = $1 FOR UPDATE', [claimRow1[0].work_claim_id]);
    // The handler attaches AT CREATION: the loser's refusal can fire while doneNow is still
    // blocking through verification (done's commit frees the row lock early on this shared
    // connection), and a rejection that waits for a later assert.rejects is an unhandled
    // rejection on a fast scheduler — the runner kills the test with the refusal as the error.
    const amendBlocked = otherTools.oathe_amend({ task_id: 'race-1', objective: 'v2', why: 'racing' })
      .then(() => null, (e) => e);
    const doneNow = tools.oathe_done({ task_id: 'race-1', proposition: 'done first', evidence_ref: 'x' });
    // The same-connection done shares our transaction's lock; the other-connection amend waits.
    await doneNow;
    await substrate.query('COMMIT');
    const amendErr = await amendBlocked;
    assert.ok(amendErr, 'the racing amend must refuse — the completion assertion won');
    assert.equal(amendErr.code, 'OATHE_AMEND_AFTER_DONE',
      'the blocked amend re-reads after the winner commits and refuses');

    // Interleaving 2: amend first — done proceeds against the amended definition, in order.
    const c2 = await tools.oathe_claim({ task_id: 'race-2', objective: 'v1' });
    await linkTrace('race-2', c2.work_claim_id);
    await otherTools.oathe_amend({ task_id: 'race-2', objective: 'v2 amended', why: 'racing again' });
    await tools.oathe_done({ task_id: 'race-2', proposition: 'done after amend', evidence_ref: 'x' });
    const { rows: order } = await substrate.query(
      `SELECT (SELECT max(asserted_at) FROM cell.agent_statement WHERE org_id='oathe' AND task_id='race-2' AND subject_ref='amend:race-2')
              < (SELECT max(asserted_at) FROM cell.agent_statement WHERE org_id='oathe' AND task_id='race-2' AND statement_type='completion') AS lawful`);
    assert.equal(order[0].lawful, true, 'every amendment predates the completion assertion');
  } finally {
    await other.close();
  }
});

test('END TO END: a late amendment is VISIBLE EVIDENCE — the engine judges the amended objective with the trail in its prompt', async () => {
  const c = await tools.oathe_claim({ task_id: 'amend-e2e', objective: 'original: build the drab thing' });
  await linkTrace('amend-e2e', c.work_claim_id);
  await tools.oathe_amend({ task_id: 'amend-e2e', objective: 'amended: build the shiny thing', why: 'the founder saw the drab thing' });
  await tools.oathe_done({ task_id: 'amend-e2e', proposition: 'shiny thing built', evidence_ref: 'x' });
  engineVerdict = { verdict: 'accepted', reason: 'the shiny thing is there' };
  const out = await verifier.verify({ taskId: 'amend-e2e' });
  assert.equal(out.settled, true);
  const prompt = enginePrompts.at(-1);
  assert.match(prompt, /amended: build the shiny thing/, 'the engine judges the definition in force at assertion');
  assert.match(prompt, /AMENDMENT/i, 'the trail is announced');
  assert.match(prompt, /original: build the drab thing/, 'the old bar is visible');
  assert.match(prompt, /the founder saw the drab thing/, 'and the why');
});

test('BOARD TRUTH: a reclaimed-and-reasserted task renders as ASSERTED — stale origin=reopened must not lie about a pending verification', async () => {
  const c = await tools.oathe_claim({ task_id: 'stale-origin', objective: 'reject, reclaim, reassert' });
  await linkTrace('stale-origin', c.work_claim_id);
  await tools.oathe_done({ task_id: 'stale-origin', proposition: 'first try', evidence_ref: 'x' });
  engineVerdict = { verdict: 'rejected', reason: 'not yet' };
  await verifier.verify({ taskId: 'stale-origin' });
  const re = await tools.oathe_claim({ task_id: 'stale-origin' }); // reclaim (origin stays reopened underneath)
  await linkTrace('stale-origin', re.work_claim_id);
  await tools.oathe_done({ task_id: 'stale-origin', proposition: 'second try', evidence_ref: 'x' });
  const board = await tools.oathe_board({});
  const row = board.board.find((r) => r.task_id === 'stale-origin');
  assert.equal(row.state, 'completion_asserted', 'awaiting verification is the truth — no verdict landed on the second try');
  assert.ok(board.sections.asserted.some((r) => r.task_id === 'stale-origin'));
  assert.ok(!board.sections.open.some((r) => r.task_id === 'stale-origin'), 'not rendered as back-on-the-board');
});
