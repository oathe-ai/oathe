// R-PAGER: the session-start digest of BREACHED promises — condition-based, org-wide, no read
// state. Three breach kinds, each a fact the substrate already holds: a verification overdue
// (asserted, unverified, past verify_by — cell.unverified_past_verify_by, the R2 clock leg),
// a rejection nobody reclaimed (origin reopened, the latest claim is the rejected one), and a
// claim gone quiet (active, no non-trace progress statement inside pagerQuietHours). Lifecycle
// facts (a lapsed lease) are NOT breaches. The instant is injected: a pager that reads now()
// cannot be tested at a stated instant.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { Pager } from '../src/pager.mjs';
import { Verifier } from '../src/verifier.mjs';
import { createOatheTools } from '../src/mcp/oathe-tools.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';
import { OatheConfig } from '../src/config.mjs';
import { WorkspaceRegistry } from '../src/registry.mjs';
import { standardPlan } from '../src/plans.mjs';
import { StandaloneRuntimeProvider } from '../src/runtime/provider.mjs';

const paths = buildPaths({});
const SCRATCH_DB = `oathe_pager_test_${process.pid}`;
const WS = 'ws-pager00000000';
const OPERATOR = 'founder';
const VERIFIER = 'oathe-verifier';
const IDENTITY = { orgId: 'oathe', principalId: OPERATOR, department: 'founder' };
const HOURS = 3_600_000;

let substrate;
let tools;
let verifier;
let engineVerdict;

function scratchConfig(extraEnv = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-pager-cfg-')));
  return new OatheConfig({ env: { HOME: home, OATHE_HOME: path.join(home, '.oathe'), ...extraEnv }, cwd: home });
}

function pager({ at = new Date(), registry = null, config = scratchConfig() } = {}) {
  return new Pager({ client: substrate, identity: IDENTITY, config, registry, clock: () => at });
}

const hoursFromNow = (h) => new Date(Date.now() + h * HOURS);

/** A transcript carrying one claim interval — what the verifier lane needs to judge at all. */
async function linkTrace(taskId, workClaimId) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-pager-trace-')), '.claude', 'projects', 'fixture'); // a Claude transcript lives in Claude's store layout — ownership is by path
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

async function assertDone(taskId, objective) {
  const claim = await tools.oathe_claim({ task_id: taskId, objective });
  await linkTrace(taskId, claim.work_claim_id);
  await tools.oathe_done({ task_id: taskId, proposition: `${objective} — done`, evidence_ref: 'commit:fake' });
  return claim;
}

/** A claim taken `hoursAgo` hours ago by `principal`, straight through the governed verb. */
async function seedClaim(taskId, { hoursAgo, principal = OPERATOR, leaseHours = 4, workspace = WS }) {
  await substrate.query(
    `INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                            verify_by, claim_mode, created_at)
     VALUES ('oathe', $1, 'founder', $2, 'minted_at_claim', '{"plan_status":"unknown"}'::jsonb,
             now() + interval '30 days', 'exclusive', now() - make_interval(hours => $3))`,
    [taskId, `seeded ${taskId}`, hoursAgo]);
  await substrate.query(
    `SELECT cell.claim_work('oathe', $1, gen_random_uuid(), NULL, NULL, $2, 'founder', 'exclusive',
            now() - make_interval(hours => $3) + make_interval(hours => $4), $5,
            now() - make_interval(hours => $3), gen_random_uuid())`,
    [taskId, principal, hoursAgo, leaseHours, `workspace:${workspace};contract:oathe/${taskId}@v1`]);
}

const ids = (rows, kind) => rows.filter((r) => r.kind === kind).map((r) => r.task_id);

before(async () => {
  substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await substrate.ensureDatabase();
  await substrate.applyDdl();
  await substrate.seed({ orgId: 'oathe', principalId: OPERATOR, department: 'founder' });
  await substrate.seedVerifier({
    orgId: 'oathe', verifierPrincipal: VERIFIER, operatorPrincipal: OPERATOR, department: 'verification',
  });
  await substrate.registerYieldCause();
  await substrate.registerAcceptanceAuthority({
    orgId: 'oathe',
    seats: [VERIFIER, OPERATOR],
    clauseSpecs: standardPlan().clause_spec,
    checkerRefs: { 'checker://acceptance_package': 'verification-clause' },
    registeredBy: 'oathe-test',
  });
  tools = createOatheTools({ client: substrate, identity: IDENTITY, workspace: WS, config: scratchConfig() });
  verifier = new Verifier({
    substrate, paths, workspace: WS, config: scratchConfig(), operatorPrincipal: OPERATOR,
    provider: new StandaloneRuntimeProvider({ paths }),
    engineRunner: async () => engineVerdict,
  });
});

after(async () => {
  await verifier.close();
  await substrate.close();
  await substrate.dropDatabase();
});

test('a clean substrate breaches nothing', async () => {
  assert.deepEqual(await pager().breaches(), []);
});

test('an asserted task past verify_by is an OVERDUE verification; before verify_by it is not', async () => {
  await assertDone('overdue-1', 'asserted, never verified');
  const late = await pager({ at: hoursFromNow(48) }).breaches();
  const row = late.find((r) => r.task_id === 'overdue-1');
  assert.ok(row, JSON.stringify(late));
  assert.equal(row.kind, 'overdue');
  assert.match(row.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/,
    'every breach carries its clock in UTC — the glass shows an age, not a truncated sentence');
  assert.equal(row.home, WS, 'no registry: the raw ref stands in');
  assert.match(row.detail, /verification overdue since \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.equal(row.objective, 'asserted, never verified');
  assert.ok(!late.some((r) => r.task_id.startsWith('verify:')), 'the review task never pages on its own — the parent line is the fact');
  assert.ok(!(await pager().breaches()).some((r) => r.task_id === 'overdue-1'), 'still inside its verify_by window');
});

test('an ACCEPTED verdict settles the promise — never overdue again, however late the clock', async () => {
  await assertDone('settled-1', 'accepted work');
  engineVerdict = { verdict: 'accepted', reason: 'fine' };
  const out = await verifier.verify({ taskId: 'settled-1' });
  assert.equal(out.settled, true);
  assert.ok(!(await pager({ at: hoursFromNow(48) }).breaches()).some((r) => r.task_id === 'settled-1'));
});

test('a REJECTED task nobody reclaimed is listed ONCE (reopened, not also overdue); a reclaim clears it', async () => {
  await assertDone('rejected-1', 'found wanting');
  engineVerdict = { verdict: 'rejected', reason: 'no' };
  const out = await verifier.verify({ taskId: 'rejected-1' });
  assert.equal(out.verdict, 'rejected');
  const now = await pager().breaches();
  const row = now.find((r) => r.task_id === 'rejected-1');
  assert.equal(row?.kind, 'reopened', JSON.stringify(now));
  assert.match(row.detail, /rejected/i);
  assert.match(row.detail, new RegExp(OPERATOR), 'names who last held it');
  const late = await pager({ at: hoursFromNow(48) }).breaches().then((rows) => rows.filter((r) => r.task_id === 'rejected-1'));
  assert.equal(late.length, 1, 'one line per task — the sharper breach wins over the overdue clock');
  assert.equal(late[0].kind, 'reopened');
  await tools.oathe_claim({ task_id: 'rejected-1', objective: 'second attempt' });
  assert.ok(!(await pager().breaches()).some((r) => r.task_id === 'rejected-1'), 'reclaimed — the breach is over');
  await tools.oathe_yield({ task_id: 'rejected-1', note: 'test teardown' });
});

test('JUDGED work never re-pages overdue: rejected → reclaimed → YIELDED returns to REOPENED with the verdict\'s FULL words (the founder\'s live loop, killed)', async () => {
  await assertDone('rejudge-1', 'asserted big');
  const longReason = 'The trace supports the posted replies but does not evidence the asserted scouting table '
    + 'with detail-page verifications, view counts, reply counts, or the clearance results the assertion names.';
  engineVerdict = { verdict: 'rejected', reason: longReason };
  await verifier.verify({ taskId: 'rejudge-1' });
  // The exact live sequence: reclaim (breach clears — someone is on it)…
  await tools.oathe_claim({ task_id: 'rejudge-1', objective: 'second attempt' });
  assert.ok(!(await pager().breaches()).some((r) => r.task_id === 'rejudge-1'), 'actively redone — silent');
  // …then yield (nobody is on it again). The truth: still a judged rejection awaiting redo.
  await tools.oathe_yield({ task_id: 'rejudge-1', note: 'not tonight' });
  const rows = (await pager({ at: hoursFromNow(48) }).breaches()).filter((r) => r.task_id === 'rejudge-1');
  assert.equal(rows.length, 1, `one line, one truth: ${JSON.stringify(rows.map((r) => r.kind))}`);
  assert.equal(rows[0].kind, 'reopened', 'a judged task NEVER reads "verification overdue" again');
  assert.ok(rows[0].detail.includes(longReason), 'the verdict\'s words, whole — never clipped mid-word at 160');
});

test('a QUIET claim: active past pagerQuietHours with no non-trace progress — any progress statement clears it', async () => {
  await seedClaim('quiet-1', { hoursAgo: 72 });
  const rows = await pager().breaches();
  const row = rows.find((r) => r.task_id === 'quiet-1');
  assert.equal(row?.kind, 'quiet', JSON.stringify(rows));
  assert.match(row.detail, new RegExp(`${OPERATOR} holds it, quiet for 7[12]h`));
  assert.match(row.detail, /last word \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  await tools.oathe_statement({ task_id: 'quiet-1', proposition: 'still on it' });
  assert.ok(!(await pager().breaches()).some((r) => r.task_id === 'quiet-1'), 'a word from the holder ends the silence');
});

test('trace-linkage statements are NOT words — a claim with only heartbeat links stays quiet', async () => {
  await seedClaim('quiet-2', { hoursAgo: 72 });
  const { rows: [claim] } = await substrate.query(
    "SELECT work_claim_id FROM cell.work_claim WHERE task_id = 'quiet-2'");
  await linkTrace('quiet-2', claim.work_claim_id);
  assert.ok((await pager().breaches()).some((r) => r.task_id === 'quiet-2' && r.kind === 'quiet'));
});

test('the threshold is the config key: pagerQuietHours=100 makes a 72h-old claim fresh', async () => {
  const relaxed = pager({ config: scratchConfig({ OATHE_PAGER_QUIET_HOURS: '100' }) });
  assert.ok(!(await relaxed.breaches()).some((r) => r.task_id === 'quiet-2'));
});

test('a LAPSED lease on a claim that spoke recently is lifecycle, not a breach', async () => {
  await seedClaim('lapsed-1', { hoursAgo: 6, leaseHours: 1 }); // lease ended 5h ago, claimed 6h ago
  assert.ok(!(await pager().breaches()).some((r) => r.task_id === 'lapsed-1'));
});

test('condition-based: two renders agree and nothing is written anywhere', async () => {
  const config = scratchConfig();
  const oatheHome = config.get('org') && path.dirname(config.globalPath);
  const before = fs.existsSync(oatheHome) ? fs.readdirSync(oatheHome) : null;
  const p = pager({ config });
  assert.deepEqual(await p.breaches(), await p.breaches());
  const afterwards = fs.existsSync(oatheHome) ? fs.readdirSync(oatheHome) : null;
  assert.deepEqual(afterwards, before, 'no read-state, no cursor file');
});

test('homes are shown as folders through the registry; a homeless task says so', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-pager-reg-')));
  const registry = new WorkspaceRegistry({ registryPath: path.join(home, 'workspaces.json') });
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-pager-folder-')));
  const { workspaceRef } = await import('../src/workspace.mjs');
  await registry.register({ cwd: folder, source: 'test' });
  await seedClaim('homed-1', { hoursAgo: 72, workspace: workspaceRef(folder) });
  const synthetic = createOatheTools({ client: substrate, identity: IDENTITY, workspace: 'ws-synthetic0000', config: scratchConfig(), synthetic: true });
  const minted = await synthetic.oathe_claim({ task_id: 'homeless-1', objective: 'minted from ChatGPT' });
  await linkTrace('homeless-1', minted.work_claim_id);
  await synthetic.oathe_done({ task_id: 'homeless-1', proposition: 'done', evidence_ref: 'x' });
  const rows = await pager({ at: hoursFromNow(48), registry }).breaches();
  assert.equal(rows.find((r) => r.task_id === 'homed-1')?.home, folder);
  assert.equal(rows.find((r) => r.task_id === 'homeless-1')?.home, 'homeless');
  assert.equal(rows.find((r) => r.task_id === 'quiet-2')?.home, WS, 'unregistered refs stay raw');
});

test('ordering: SHARPEST first — rejected/stalled work needs a person; never-verified drains itself (done auto-dispatches). Oldest first within a kind', async () => {
  const rows = await pager({ at: hoursFromNow(48) }).breaches();
  const kinds = rows.map((r) => r.kind);
  const order = ['reopened', 'stalled', 'overdue', 'quiet'];
  assert.deepEqual(kinds, [...kinds].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  assert.ok(ids(rows, 'quiet').length >= 2);
});

test("REJECTION SURFACES: the breach detail carries the verdict's words, attention rides tool responses, and the reclaim returns the recovery bundle", async () => {
  // Self-provisioned: the suite's own rejected-1 is already reclaimed by an earlier test.
  const minted = await tools.oathe_claim({ task_id: 'rejected-att', objective: 'page with the reason' });
  await linkTrace('rejected-att', minted.work_claim_id);
  await tools.oathe_done({ task_id: 'rejected-att', proposition: 'found wanting again', evidence_ref: 'x' });
  engineVerdict = { verdict: 'rejected', reason: 'the attention path is missing' };
  await verifier.verify({ taskId: 'rejected-att' });

  const breaches = await new Pager({ client: substrate, identity: IDENTITY, config: scratchConfig() }).breaches();
  const reopened = breaches.find((b) => b.kind === 'reopened' && b.task_id === 'rejected-att');
  assert.ok(reopened, 'the rejected task pages');
  assert.match(reopened.detail, /rejected: the attention path is missing/, "the reason is in the breach detail — the verdict's own words");
  assert.match(reopened.detail, /nobody has reclaimed/, 'and the reclaim breach is still named');

  const board = await tools.oathe_board({});
  assert.ok(Array.isArray(board.attention), 'tool responses carry attention while a rejection stands');
  const line = board.attention.find((a) => a.includes('rejected-att'));
  assert.ok(line, `rejected-att is in the attention lines: ${JSON.stringify(board.attention)}`);
  assert.match(line, /rejected: the attention path is missing/, 'the attention line carries the reason');
  assert.match(line, /oathe_claim|reclaim/i, 'and names the next act');

  const reclaim = await tools.oathe_claim({ task_id: 'rejected-att' });
  assert.equal(reclaim.claimed, true);
  assert.ok(reclaim.rejection, 'the reclaim returns the recovery bundle');
  assert.match(reclaim.rejection.reason, /rejected: the attention path is missing/);
  assert.ok(reclaim.rejection.verification_started_at, 'when verification was initialized');
  assert.ok(reclaim.rejection.last_statements.some((p) => /found wanting again/.test(p)),
    `the prior interval's own words are in the bundle: ${JSON.stringify(reclaim.rejection.last_statements)}`);
  assert.ok(Array.isArray(reclaim.rejection.trace_refs), 'linked trace refs ride along');

  const after = await tools.oathe_board({});
  assert.ok(!(after.attention ?? []).some((a) => a.includes('rejected-att')),
    'the attention vanishes on reclaim — stateless, repeats-while-true');
});

test('a STALLED verification (engine died, claim released) pages with the retry line and rides attention until an engine settles it', async () => {
  const minted = await tools.oathe_claim({ task_id: 'stall-me', objective: 'survive an engine outage' });
  await linkTrace('stall-me', minted.work_claim_id);
  await tools.oathe_done({ task_id: 'stall-me', proposition: 'done', evidence_ref: 'x' });
  const dying = new Verifier({
    substrate, paths, workspace: WS, config: scratchConfig(), operatorPrincipal: OPERATOR,
    provider: new StandaloneRuntimeProvider({ paths }),
    engineRunner: async () => { const e = new Error('codex: usage limit reached'); e.code = 'OATHE_ENGINE_FAILED'; throw e; },
  });
  try { await assert.rejects(dying.verify({ taskId: 'stall-me' }), /usage limit/); } finally { await dying.close(); }

  const breaches = await new Pager({ client: substrate, identity: IDENTITY, config: scratchConfig() }).breaches();
  const stalled = breaches.find((b) => b.kind === 'stalled' && b.task_id === 'stall-me');
  assert.ok(stalled, `the stall pages: ${JSON.stringify(breaches.map((b) => [b.kind, b.task_id]))}`);
  assert.match(stalled.detail, /usage limit/, 'the real engine error');
  assert.match(stalled.detail, /oathe:verify|--engine/, 'and the retry gesture on another engine');

  const board = await tools.oathe_board({});
  const line = (board.attention ?? []).find((a) => a.includes('stall-me'));
  assert.ok(line, `attention carries the stall: ${JSON.stringify(board.attention)}`);
  assert.match(line, /STALLED/);
  assert.match(line, /\/oathe:verify stall-me/, 'the exact retry line, engine included');

  engineVerdict = { verdict: 'accepted', reason: 'fine on the second engine' };
  const retry = await verifier.verify({ taskId: 'stall-me' });
  assert.equal(retry.settled, true, 'the released claim let another engine claim and settle — no wedge');
  const after = await tools.oathe_board({});
  assert.ok(!(after.attention ?? []).some((a) => a.includes('stall-me')), 'the stall vanishes once settled');
  assert.ok(!(await new Pager({ client: substrate, identity: IDENTITY, config: scratchConfig() }).breaches())
    .some((b) => b.task_id === 'stall-me'), 'and stops paging');
});

test('REDEMPTION silences: rejected → redone → ACCEPTED pages nothing, forever (the founder\'s settled-but-still-rejected glass)', async () => {
  await assertDone('redeemed-1', 'asserted, judged wanting, then redone');
  engineVerdict = { verdict: 'rejected', reason: 'not yet' };
  await verifier.verify({ taskId: 'redeemed-1' });
  await tools.oathe_claim({ task_id: 'redeemed-1', objective: 'second attempt' });
  await tools.oathe_done({ task_id: 'redeemed-1', proposition: 'redone properly', evidence_ref: 'x' });
  engineVerdict = { verdict: 'accepted', reason: 'now it holds' };
  const out = await verifier.verify({ taskId: 'redeemed-1' });
  assert.equal(out.settled, true);
  const rows = (await pager({ at: hoursFromNow(72) }).breaches()).filter((r) => r.task_id === 'redeemed-1');
  assert.deepEqual(rows, [], 'acceptance is the LAST word — a settled task never pages as rejected again');
});
