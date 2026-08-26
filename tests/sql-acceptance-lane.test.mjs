import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

import { SqlAcceptanceLane, SETTLE } from '../src/runtime/sql-acceptance-lane.mjs';
import { RuntimeError } from '../src/runtime/provider.mjs';
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
  await substrate.seed({ orgId: 'oathe', principalId: 'founder', department: 'founder' });
  await substrate.seedVerifier({ orgId: 'oathe', verifierPrincipal: 'oathe-verifier',
    operatorPrincipal: 'founder', department: 'verification' });
  await substrate.registerYieldCause();
  await substrate.registerAcceptanceAuthority({
    orgId: 'oathe', seats: ['oathe-verifier', 'founder'],
    clauseSpecs: standardPlan().clause_spec,
    checkerRefs: { 'checker://acceptance_package': 'verification-clause' },
    registeredBy: 'oathe-test' });
  pool = new pg.Pool(substrate.connectionConfig());
  tools = createOatheTools({ client: substrate,
    identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' }, workspace: WS });
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
      verification_plan: standardPlan(), author_principal: 'founder',
      executor_principal: 'oathe-operator', seat_principal: null,
      evidence_refs: [`verdict://${taskId}`], trace_ref: '/traces/fake-session.jsonl',
      privacy_class: 'org_internal', transfer_scope: 'exportable',
      checker: RECORDED_VERDICT_CHECKER, oathe_recorded_verdict: recorded },
  };
}

function lane(seat) {
  return new SqlAcceptanceLane({ pool, orgId: 'oathe', seatPrincipal: seat,
    specs: standardPlan().clause_spec });
}

test('accepted: ONE verified row and the claim settles in the SAME transaction (FC113 by equality)', async () => {
  const stmt = await assertedCompletion('lane-accept');
  const input = laneInput('lane-accept', stmt, 'accepted');
  const out = await lane('oathe-verifier').verify(input, { settle: SETTLE.CLAIM });
  assert.equal(out.settled, true);
  assert.equal(out.verification.verdict, 'accepted');
  const { rows: vs } = await substrate.query(
    "SELECT org_id, statement_id, result, verifier_principal, verifier_type, source, "
    + "verification_plan_ref, checks, evidence_refs, trace_ref, privacy_class, transfer_scope, "
    + "state_version, recorded_at FROM cell.verification WHERE task_id = 'lane-accept'");
  assert.equal(vs.length, 1, 'exactly ONE verification row per settlement');
  assert.equal(vs[0].org_id, 'oathe');
  assert.equal(vs[0].statement_id, stmt.statement_id, 'statement_id === the completion statement id');
  assert.equal(vs[0].result, 'verified');
  assert.equal(vs[0].verifier_principal, 'oathe-verifier');
  assert.equal(vs[0].verifier_type, 'seat');
  assert.equal(vs[0].source, 'acceptance_package');
  assert.equal(vs[0].verification_plan_ref, ACCEPTANCE_CLAUSE_KEY);
  assert.deepEqual(vs[0].checks,
    [{ kind: 'statement_kind', pass: true }, { kind: 'evidence_present', pass: true },
      { kind: 'trace_ref_present', pass: true }],
    'checks parses back as the discharge\'s own array, in order');
  assert.deepEqual(vs[0].evidence_refs, input.clause.evidence_refs,
    'evidence_refs deep-equals the clause\'s, not the statement\'s');
  assert.equal(vs[0].trace_ref, input.clause.trace_ref);
  assert.equal(vs[0].privacy_class, 'org_internal');
  assert.equal(vs[0].transfer_scope, 'exportable',
    'privacy_class and transfer_scope are DISTINCT values here — a positional $11/$12 swap would fail this');
  assert.equal(vs[0].state_version, null, 'state_version is bound to confirm_token_consume only');
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
  const out = await lane('founder').verify(laneInput('lane-self', stmt, 'accepted'),
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

test('rollback: a substrate refusal inside the transaction is typed AND leaves NO row (ROLLBACK held)', async () => {
  const stmt = await assertedCompletion('lane-rollback');
  const input = laneInput('lane-rollback', stmt, 'accepted');
  // A statement_ref with no matching cell.agent_statement row: the composite (org_id, task_id,
  // statement_id) FK on cell.verification raises INSIDE the transaction, after the discharge
  // check has already passed (discharge never looks at statement_ref) — this is the FC* raise
  // path, not the pre-substrate blocked path.
  input.agent_statement.statement_ref = crypto.randomUUID();
  await assert.rejects(
    () => lane('oathe-verifier').verify(input, { settle: SETTLE.CLAIM }),
    (e) => e instanceof RuntimeError
      && e.code === 'OATHE_SETTLEMENT_REFUSED'
      && typeof e.details.sqlstate === 'string' && e.details.sqlstate.length > 0);
  const { rows: vs } = await substrate.query(
    "SELECT 1 FROM cell.verification WHERE task_id = 'lane-rollback'");
  assert.equal(vs.length, 0, 'the rollback held — no partial row survives the refused transaction');
  const { rows: [claim] } = await substrate.query(
    'SELECT settled_at FROM cell.work_claim WHERE work_claim_id = $1', [stmt.work_claim_id]);
  assert.equal(claim.settled_at, null, 'settlement never ran either — the whole transaction unwound');
});
