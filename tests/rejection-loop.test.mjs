// oathe — the rejection loop, made constitutional (plan 2026-09-04, launch/2026-09-04-rejection-loop-plan.md).
//
// The claim table is the state machine; the tools are thin speech acts over its verbs; every
// surface projects `latest interval per task × its verdict`. Three rulings hold here:
//   1. The verdict rides the BLOCKING exchange: done/verify wait for it where the work is,
//      and a rejection hands the task back to its asserter inside that same response — the
//      done IS the principal speaking (R-PAGER), the rejection is the substrate's answer.
//      Only a verdict rendered elsewhere (a teammate's machine, the cloud) arrives later;
//      then the owner's NEXT act reclaims and speaks. A yield is a deliberate stop — nothing
//      reclaims after one but an explicit claim.
//   2. Someone else on rejected work is told no, and who owns it (R8: reopened work returns
//      to its last holder) — OATHE_RECLAIM_FOREIGN, on every act including oathe_claim.
//   3. The judged interval is a fact about ONE interval (the verification row's statement
//      link, never a clock comparison): a reclaimed-and-reasserted task reads asserted, and
//      the board says which judgment it awaits — `awaiting` until a judge holds it,
//      `verifying` while one does.
// Real substrate, real evaluator lane (016/012 plpgsql), real Verifier — only its engine is faked.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOatheTools, REJECTION_FORK } from '../src/mcp/oathe-tools.mjs';
import { Pager } from '../src/pager.mjs';
import { Verifier } from '../src/verifier.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';
import { OatheConfig } from '../src/config.mjs';
import { standardPlan } from '../src/plans.mjs';
import { StandaloneRuntimeProvider } from '../src/runtime/provider.mjs';
import { linkClaudeTrace } from './helpers.mjs';

const paths = buildPaths({});
const SCRATCH_DB = `oathe_rejection_loop_test_${process.pid}`;
const WS = 'ws-rejloop000000';
const OPERATOR = 'founder';
const OTHER = 'athena';
const VERIFIER = 'oathe-verifier';
const identityOf = (principalId, department = 'founder') => ({ orgId: 'oathe', principalId, department });

let substrate;
let plain; // the operator's tools with NO verifier seam — done returns without a verdict (the remote shape)
let judge; // a real Verifier over the same substrate; the engine answers `engineVerdict`
let engineVerdict;

function scratchConfig(extraEnv = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-rejloop-cfg-')));
  return new OatheConfig({ env: { HOME: home, OATHE_HOME: path.join(home, '.oathe'), ...extraEnv }, cwd: home });
}

/** Tools for `principal` with the LOCAL seam wired: done and verify block on the real judge. */
function judged(principalId = OPERATOR) {
  return createOatheTools({
    client: substrate, identity: identityOf(principalId), workspace: WS, config: scratchConfig(),
    activation: { register: async () => ({}), activate: async () => ({}) },
    verifier: ({ taskId, engine }) => judge.verify({ taskId, engine }),
    speaker: { surface: 'chatgpt', app: { bundle: '/Applications/ChatGPT.app', pid: 4242 }, session: null, walked: true, client: 'codex', pid: 4242, device: null }, // session-less by design (no hooks) — the one shape the claim gate admits without a session
  });
}

async function activeClaims(taskId) {
  const { rows } = await substrate.query(
    "SELECT work_claim_id, principal_id FROM cell.work_claim WHERE org_id = 'oathe' AND task_id = $1 AND state = 'active'", [taskId]);
  return rows;
}

/** Claim, link one interval of evidence, assert done WITHOUT blocking, then judge it elsewhere. */
async function rejectedElsewhere(taskId, tools = plain) {
  const claim = await tools.oathe_claim({ task_id: taskId, objective: `work on ${taskId}` });
  await linkClaudeTrace({ substrate, taskId, workClaimId: claim.work_claim_id, principal: OPERATOR });
  await tools.oathe_done({ task_id: taskId, proposition: `${taskId} done`, evidence_ref: 'commit:fake' });
  engineVerdict = { verdict: 'rejected', reason: `the artifact for ${taskId} is not on disk` };
  const verdict = await judge.verify({ taskId });
  assert.equal(verdict.verdict, 'rejected');
  assert.deepEqual(await activeClaims(taskId), [], 'after the assertion and its rejection nobody holds the work (§16.2)');
  return claim;
}

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
  plain = createOatheTools({ client: substrate, identity: identityOf(OPERATOR), workspace: WS, config: scratchConfig() });
  judge = new Verifier({
    substrate, paths, workspace: WS, config: scratchConfig(), operatorPrincipal: OPERATOR,
    provider: new StandaloneRuntimeProvider({ paths }),
    engineRunner: async () => engineVerdict,
  });
});

after(async () => {
  await judge.close();
  await substrate.close();
  await substrate.dropDatabase();
});

test('THE BLOCKING EXCHANGE: a rejected done hands the task back inside its own response — a new active interval for the asserter, the verdict and the fork in-result, and the next statement lands with no refusal', async () => {
  const mine = judged();
  const claim = await mine.oathe_claim({ task_id: 'loop-blocking', objective: 'judged in the exchange' });
  await linkClaudeTrace({ substrate, taskId: 'loop-blocking', workClaimId: claim.work_claim_id, principal: OPERATOR });
  engineVerdict = { verdict: 'rejected', reason: 'the artifact is not on disk' };
  const done = await mine.oathe_done({ task_id: 'loop-blocking', proposition: 'built it', evidence_ref: 'commit:fake' });
  assert.equal(done.verification.verdict, 'rejected');
  assert.equal(done.verification.your_options, REJECTION_FORK, 'the fork rides the verdict, as before');
  assert.equal(done.reclaimed, true, 'the rejection handed the work back IN THIS EXCHANGE — no orphan window');
  assert.equal(done.judged_claim_id, claim.work_claim_id, 'the judged interval stays on the record, named');
  assert.notEqual(done.work_claim_id, claim.work_claim_id, 'a NEW interval of responsibility — the one the next statement speaks to');
  assert.match(done.rejection.reason, /rejected: the artifact is not on disk/, 'the bundle carries THIS rejection');
  assert.equal(done.rejection.your_options, REJECTION_FORK);
  assert.match(done.lease, /^until \d{4}-\d\d-\d\dT\d\d:\d\dZ$/, 'the lease is the seated row\'s (016: the task\'s verify_by), never the config hours');
  assert.deepEqual(await activeClaims('loop-blocking'), [{ work_claim_id: done.work_claim_id, principal_id: OPERATOR }]);
  // The agent keeps talking: no OATHE_NO_ACTIVE_CLAIM, no second reclaim.
  const note = await mine.oathe_statement({ task_id: 'loop-blocking', proposition: 'writing the artifact now' });
  assert.equal(note.recorded, true);
  assert.equal(note.work_claim_id, done.work_claim_id);
  assert.equal(note.reclaimed, undefined, 'an act against a held claim reclaims nothing');
  const board = await mine.oathe_board({});
  assert.ok(board.sections.mine.some((r) => r.task_id === 'loop-blocking'), 'held again — mine, in motion');
  assert.ok(!board.sections.open.some((r) => r.task_id === 'loop-blocking'), 'never "back on the board" while its holder is on it');
  // Redemption in the same loop: done again → accepted → settled; nothing reclaims.
  engineVerdict = { verdict: 'accepted', reason: 'the artifact is on disk now' };
  const redeemed = await mine.oathe_done({ task_id: 'loop-blocking', proposition: 'artifact written', evidence_ref: 'commit:fake2' });
  assert.equal(redeemed.verification.verdict, 'accepted');
  assert.equal(redeemed.reclaimed, undefined);
  assert.equal(redeemed.rejection, undefined);
  const { rows } = await substrate.query('SELECT settled_at FROM cell.work_claim WHERE work_claim_id = $1', [done.work_claim_id]);
  assert.ok(rows[0].settled_at, 'the redeemed interval settles (014: a stamp)');
  assert.ok(!(await mine.oathe_board({})).board.some((r) => r.task_id === 'loop-blocking' && !r.settled_at), 'off the board');
});

test('THE ASYNC FALLBACK: a verdict rendered elsewhere is picked up by the owner\'s next act — statement, amend, yield, pickup each reclaim and speak; after a YIELD the next act is refused (a yield is deliberate); an explicit claim after it still carries the bundle', async () => {
  // statement
  await rejectedElsewhere('loop-async');
  const note = await plain.oathe_statement({ task_id: 'loop-async', proposition: 'back on it' });
  assert.equal(note.recorded, true);
  assert.equal(note.reclaimed, true, 'the owner\'s next act reclaims');
  assert.match(note.rejection.reason, /rejected: the artifact for loop-async/);
  assert.equal(note.rejection.your_options, REJECTION_FORK);
  assert.ok(Array.isArray(note.rejection.last_statements) && Array.isArray(note.rejection.trace_refs));
  assert.match(note.lease, /^until /);
  assert.deepEqual((await activeClaims('loop-async')).map((r) => r.work_claim_id), [note.work_claim_id]);
  // amend — the descope arm of the fork is reachable: reclaim (the act) then amend, both on record
  await rejectedElsewhere('loop-amend');
  const amended = await plain.oathe_amend({ task_id: 'loop-amend', objective: 'a narrower promise', why: 'descoped after the verdict' });
  assert.equal(amended.amended, true);
  assert.equal(amended.reclaimed, true);
  assert.equal(amended.version, 2);
  assert.deepEqual((await activeClaims('loop-amend')).map((r) => r.work_claim_id), [amended.work_claim_id]);
  // yield — dropping rejected work is a speech act too
  await rejectedElsewhere('loop-yield');
  const yielded = await plain.oathe_yield({ task_id: 'loop-yield', note: 'not mine to finish' });
  assert.equal(yielded.yielded, true);
  assert.equal(yielded.reclaimed, true);
  // pickup — reclaim first; standalone still has no successor seam, and the refusal carries the seat
  await rejectedElsewhere('loop-pickup');
  await assert.rejects(plain.oathe_pickup({ task_id: 'loop-pickup' }), (e) => {
    assert.equal(e.code, 'OATHE_PICKUP_UNAVAILABLE');
    assert.equal(e.details.reclaimed, true, 'the reclaim stands — the refusal is about the successor seam only');
    assert.match(e.details.rejection.reason, /rejected/);
    return true;
  });
  assert.equal((await activeClaims('loop-pickup')).length, 1, 'held after the refused pickup');
  // a yield is a deliberate stop: the last ended interval is the yield, not a rejection
  await plain.oathe_yield({ task_id: 'loop-async', note: 'stepping off' });
  await assert.rejects(plain.oathe_statement({ task_id: 'loop-async', proposition: 'ghost' }),
    (e) => e.code === 'OATHE_NO_ACTIVE_CLAIM');
  // …and the explicit claim after it still carries the bundle: the latest verdict IS a rejection
  const reclaim = await plain.oathe_claim({ task_id: 'loop-async' });
  assert.equal(reclaim.claimed, true);
  assert.match(reclaim.rejection.reason, /rejected: the artifact for loop-async/);
  assert.match(reclaim.lease, /^until /);
  await plain.oathe_yield({ task_id: 'loop-async', note: 'fixture done' });
});

test('SOMEONE ELSE on rejected work is told no, and who owns it — every act including oathe_claim; a foreign verify reseats nobody', async () => {
  await rejectedElsewhere('loop-foreign');
  const other = createOatheTools({ client: substrate, identity: identityOf(OTHER), workspace: WS, config: scratchConfig() });
  const acts = {
    oathe_statement: { task_id: 'loop-foreign', proposition: 'mine now' },
    oathe_done: { task_id: 'loop-foreign', proposition: 'done by me', evidence_ref: 'x' },
    oathe_yield: { task_id: 'loop-foreign', note: 'dropping it' },
    oathe_pickup: { task_id: 'loop-foreign' },
    oathe_claim: { task_id: 'loop-foreign', objective: 'taking over' },
  };
  for (const [name, args] of Object.entries(acts)) {
    await assert.rejects(other[name](args), (e) => {
      assert.equal(e.code, 'OATHE_RECLAIM_FOREIGN', `${name}: a typed refusal, never a seat under another's name`);
      assert.match(e.message, new RegExp(OPERATOR), `${name}: the refusal names the owner`);
      assert.equal(e.details.owner, OPERATOR);
      return true;
    });
  }
  assert.deepEqual(await activeClaims('loop-foreign'), [], 'nothing was seated for anybody');
  // The owner's next act still reclaims — the refusals changed nothing.
  const note = await plain.oathe_statement({ task_id: 'loop-foreign', proposition: 'still mine' });
  assert.equal(note.reclaimed, true);
  await plain.oathe_yield({ task_id: 'loop-foreign', note: 'fixture done' });

  // A verify by someone who is not the asserter blocks and returns the verdict — but reseats nobody.
  const claim = await plain.oathe_claim({ task_id: 'loop-foreign-verify', objective: 'judged by another seat' });
  await linkClaudeTrace({ substrate, taskId: 'loop-foreign-verify', workClaimId: claim.work_claim_id, principal: OPERATOR });
  await plain.oathe_done({ task_id: 'loop-foreign-verify', proposition: 'done', evidence_ref: 'x' });
  engineVerdict = { verdict: 'rejected', reason: 'not there' };
  const verdict = await judged(OTHER).oathe_verify({ task_id: 'loop-foreign-verify' });
  assert.equal(verdict.verdict, 'rejected');
  assert.equal(verdict.reclaimed, undefined, 'the judge\'s caller is not the asserter — the breach shows for the owner instead');
  assert.deepEqual(await activeClaims('loop-foreign-verify'), []);
  const back = await plain.oathe_statement({ task_id: 'loop-foreign-verify', proposition: 'on it' });
  assert.equal(back.reclaimed, true);
  await plain.oathe_yield({ task_id: 'loop-foreign-verify', note: 'fixture done' });
});

test('LEG A: the rejection is a fact about ONE interval — reclaimed-and-reasserted reads ASSERTED (never reopened, no breach), and the board names the judgment it awaits: awaiting, then verifying while a judge holds it', async () => {
  await rejectedElsewhere('loop-exact');
  const note = await plain.oathe_statement({ task_id: 'loop-exact', proposition: 'redone' });
  assert.equal(note.reclaimed, true);
  await plain.oathe_done({ task_id: 'loop-exact', proposition: 'redone, asserting again', evidence_ref: 'commit:fake3' });
  const board = await plain.oathe_board({});
  const row = board.sections.asserted.find((r) => r.task_id === 'loop-exact');
  assert.ok(row, `the reassertion is ASSERTED: ${JSON.stringify(board.sections)}`);
  assert.equal(row.rejected_after, false, 'the rejection was over the PRIOR interval — this one is unjudged');
  assert.equal(row.judgment, 'awaiting', 'asserted, no judge yet');
  assert.ok(!board.sections.open.some((r) => r.task_id === 'loop-exact'));
  const pager = new Pager({ client: substrate, identity: identityOf(OPERATOR), config: scratchConfig() });
  assert.ok(!(await pager.breaches()).some((r) => r.task_id === 'loop-exact'), 'nothing breached: the assertion is awaiting its judge');
  // A judge takes the verify task: the board's word becomes verifying.
  const bench = createOatheTools({ client: substrate, identity: identityOf(VERIFIER, 'verification'), workspace: WS, config: scratchConfig() });
  const hold = await bench.oathe_claim({ task_id: 'verify:loop-exact' });
  assert.equal(hold.claimed, true);
  const judging = (await plain.oathe_board({})).sections.asserted.find((r) => r.task_id === 'loop-exact');
  assert.equal(judging.judgment, 'verifying', 'a judge holds the verify claim inside its lease');
  await bench.oathe_yield({ task_id: 'verify:loop-exact', note: 'bench fixture' });
  assert.equal((await plain.oathe_board({})).sections.asserted.find((r) => r.task_id === 'loop-exact').judgment, 'awaiting');
});
