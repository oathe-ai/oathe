import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { SqlAcceptanceLane, SETTLE } from '../src/runtime/sql-acceptance-lane.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';
import { standardPlan, ACCEPTANCE_CLAUSE_KEY } from '../src/plans.mjs';
import { RECORDED_VERDICT_CHECKER } from '../src/runtime/discharge.mjs';
import { createOatheTools } from '../src/mcp/oathe-tools.mjs';

const require = createRequire(import.meta.url);
const pg = require('pg');

const paths = buildPaths({});
const SCRATCH_DB = `oathe_sql_lane_test_${process.pid}`;
const WS = 'ws-abcdef123456';
let substrate; let pool; let tools;

before(async () => {
  substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await substrate.ensureDatabase();
  await substrate.applyDdl();
  await substrate.seed({ orgId: 'oathe', principalId: 'firia', department: 'founder' });
  await substrate.seedVerifier({ orgId: 'oathe', verifierPrincipal: 'oathe-verifier',
    operatorPrincipal: 'firia', department: 'verification' });
  await substrate.registerYieldCause();
  await substrate.registerAcceptanceAuthority({
    orgId: 'oathe', seats: ['oathe-verifier', 'firia'],
    clauseSpecs: standardPlan().clause_spec,
    checkerRefs: { 'checker://acceptance_package': 'verification-clause' },
    registeredBy: 'oathe-test' });
  pool = new pg.Pool(substrate.connectionConfig());
  tools = createOatheTools({ client: substrate,
    identity: { orgId: 'oathe', principalId: 'firia', department: 'founder' }, workspace: WS });
});

after(async () => {
  await pool.end();
  await substrate.close();
  await substrate.dropDatabase();
});

/** Claim + done, then return the completion statement row for the lane input. */
async function assertedCompletion(taskId) {
  await tools.oathe_claim({ task_id: taskId, objective: `objective for ${taskId}` });
  await tools.oathe_done({ task_id: taskId, proposition: `done: ${taskId}`, evidence_ref: `evidence://${taskId}` });
  const { rows: [stmt] } = await substrate.query(
    `SELECT statement_id, work_claim_id, evidence_refs FROM cell.agent_statement
      WHERE task_id = $1 AND statement_type = 'completion'`, [taskId]);
  return stmt;
}

function laneInput(taskId, stmt, recorded) {
  return {
    agent_statement: { statement_ref: stmt.statement_id, work_claim_id: stmt.work_claim_id,
      evidence_refs: stmt.evidence_refs, trace_ref: '/traces/fake-session.jsonl',
      kind: 'completion', statement_type: 'completion' },
    task_id: taskId,
    clause: { org_id: 'oathe', task_id: taskId, clause_key: ACCEPTANCE_CLAUSE_KEY,
      verification_plan: standardPlan(), author_principal: 'firia',
      executor_principal: 'oathe-operator', seat_principal: null,
      evidence_refs: [`verdict://${taskId}`], trace_ref: '/traces/fake-session.jsonl',
      privacy_class: 'org_internal', transfer_scope: 'org_internal',
      checker: RECORDED_VERDICT_CHECKER, oathe_recorded_verdict: recorded },
  };
}

function lane(seat) {
  return new SqlAcceptanceLane({ pool, orgId: 'oathe', seatPrincipal: seat,
    specs: standardPlan().clause_spec });
}

test('accepted: ONE verified row and the claim settles in the SAME transaction (FC113 by equality)', async () => {
  const stmt = await assertedCompletion('lane-accept');
  const out = await lane('oathe-verifier').verify(laneInput('lane-accept', stmt, 'accepted'),
    { settle: SETTLE.CLAIM });
  assert.equal(out.settled, true);
  assert.equal(out.verification.verdict, 'accepted');
  const { rows: vs } = await substrate.query(
    "SELECT result, verifier_principal, verifier_type, source, verification_plan_ref, recorded_at "
    + "FROM cell.verification WHERE task_id = 'lane-accept'");
  assert.equal(vs.length, 1, 'exactly ONE verification row per settlement');
  assert.equal(vs[0].result, 'verified');
  assert.equal(vs[0].verifier_principal, 'oathe-verifier');
  assert.equal(vs[0].verifier_type, 'seat');
  assert.equal(vs[0].source, 'acceptance_package');
  assert.equal(vs[0].verification_plan_ref, ACCEPTANCE_CLAUSE_KEY);
  const { rows: [claim] } = await substrate.query(
    'SELECT settled_at FROM cell.work_claim WHERE work_claim_id = $1', [stmt.work_claim_id]);
  assert.ok(claim.settled_at, 'cell.settle_work_claim ran — FC113/FC114 held');
  assert.equal(String(claim.settled_at), String(vs[0].recorded_at),
    'settled_at equals recorded_at: one transaction, one now()');
});

test('rejected: the rejected row is written, the claim does NOT settle, nothing throws', async () => {
  const stmt = await assertedCompletion('lane-reject');
  const out = await lane('oathe-verifier').verify(laneInput('lane-reject', stmt, 'rejected'),
    { settle: SETTLE.CLAIM });
  assert.equal(out.settled, false);
  assert.equal(out.verification.verdict, 'rejected');
  const { rows: vs } = await substrate.query(
    "SELECT result FROM cell.verification WHERE task_id = 'lane-reject'");
  assert.equal(vs.length, 1);
  assert.equal(vs[0].result, 'rejected');
  const { rows: [claim] } = await substrate.query(
    'SELECT settled_at FROM cell.work_claim WHERE work_claim_id = $1', [stmt.work_claim_id]);
  assert.equal(claim.settled_at, null, 'a rejected claim never settles');
});

test('blocked: a garbage recorded verdict writes NO row and settles nothing', async () => {
  const stmt = await assertedCompletion('lane-block');
  const out = await lane('oathe-verifier').verify(laneInput('lane-block', stmt, 'maybe'),
    { settle: SETTLE.CLAIM });
  assert.equal(out.settled, false);
  assert.equal(out.verification.verdict, 'blocked');
  const { rows: vs } = await substrate.query(
    "SELECT 1 FROM cell.verification WHERE task_id = 'lane-block'");
  assert.equal(vs.length, 0, 'blocked means the substrate was never asked');
});

test('the seat law: an author seat is BLOCKED before the substrate ever sees it (pre-FC010)', async () => {
  const stmt = await assertedCompletion('lane-self');
  const out = await lane('firia').verify(laneInput('lane-self', stmt, 'accepted'),
    { settle: SETTLE.CLAIM });
  assert.equal(out.verification.verdict, 'blocked');
  assert.match(out.verification.reason, /author/i);
});

test('the seat law: a seat outside the registered roster is BLOCKED', async () => {
  const stmt = await assertedCompletion('lane-stranger');
  const out = await lane('nobody-registered').verify(laneInput('lane-stranger', stmt, 'accepted'),
    { settle: SETTLE.CLAIM });
  assert.equal(out.verification.verdict, 'blocked');
  assert.match(out.verification.reason, /roster|seats/i);
});
