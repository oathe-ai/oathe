import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { Verifier, VerifierError } from '../src/verifier.mjs';
import { createOatheTools } from '../src/mcp/oathe-tools.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';
import { OatheConfig } from '../src/config.mjs';
import { standardPlan } from '../src/plans.mjs';
import { OatheRuntimeProvider, StandaloneRuntimeProvider } from '../src/runtime/provider.mjs';

const paths = buildPaths({});
const WS = 'ws-verify0000000';
const OPERATOR = 'founder';
const VERIFIER = 'oathe-verifier';

/** A scratch-home config — tools require one, and tests never read the real ~/.oathe. */
function scratchConfig() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-vcfg-')));
  return new OatheConfig({ env: { HOME: home, OATHE_HOME: path.join(home, '.oathe') }, cwd: home });
}

// The oathe provider's settlement lane runs only where oathe-runtime actually resolves —
// the same machine-truth guard as runtime-provider.test.mjs; standalone always runs.
const RUNTIME_LINKED = new OatheRuntimeProvider({ paths }).probe().ok;
const PROVIDERS = [
  ...(RUNTIME_LINKED ? [['oathe', () => new OatheRuntimeProvider({ paths })]] : []),
  ['standalone', () => new StandaloneRuntimeProvider()],
];

/** A minimal REAL claude-shaped transcript the trace contract accepts. */
function fixtureTranscript(name) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-vtrace-')), '.claude', 'projects', 'fixture');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  const sessionId = crypto.randomUUID();
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId, cwd: dir, message: { role: 'user', content: 'work' } }),
    JSON.stringify({
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId, cwd: dir,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_f1', name: 'Bash', input: { command: 'make it' } }, { type: 'text', text: 'did the work' }] },
    }),
    JSON.stringify({
      type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId, cwd: dir,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_f1', content: 'made it\nExit code 0' }] },
    }),
  ].join('\n'));
  return { file, sessionId };
}

/** A transcript with a planning prefix, then an explicit oathe_claim act, then the work —
 *  the R3 slicing fixture: everything before the claim is context, not evidence. */
function fixtureTranscriptWithInterval(name) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-vtrace-int-')), '.claude', 'projects', 'fixture');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  const sessionId = crypto.randomUUID();
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId, cwd: dir,
      message: { role: 'user', content: 'PLANNING-ONLY-DISCUSSION-MARKER — compare approaches first' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a0', parentUuid: 'u1', sessionId, cwd: dir,
      message: { role: 'assistant', content: [{ type: 'text', text: 'weighing options (PLANNING-ONLY-DISCUSSION-MARKER)' }] } }),
    JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a0', sessionId, cwd: dir,
      message: { role: 'user', content: 'proceed with the task' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u2', sessionId, cwd: dir,
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_c1', name: 'mcp__oathe__oathe_claim', input: { task_id: name, objective: 'sliced work' } },
        { type: 'text', text: 'claiming and starting' }] } }),
    JSON.stringify({ type: 'user', uuid: 'r1', parentUuid: 'a1', sessionId, cwd: dir,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c1', content: 'claimed' }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'r1', sessionId, cwd: dir,
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_w1', name: 'Bash', input: { command: 'make it' } },
        { type: 'text', text: 'INTERVAL-WORK-MARKER: doing the claimed work' }] } }),
    JSON.stringify({ type: 'user', uuid: 'r2', parentUuid: 'a2', sessionId, cwd: dir,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_w1', content: 'made it\nExit code 0' }] } }),
  ].join('\n'));
  return { file, sessionId };
}

for (const [providerName, makeProvider] of PROVIDERS) {
  describe(`settlement under the ${providerName} provider`, () => {
    const SCRATCH_DB = `oathe_verif_test_${process.pid}_${providerName}`;

    let substrate;
    let workerTools;
    let engineCalls;
    let engineVerdict;
    let verifier;

    async function linkTrace(taskId, workClaimId) {
      const { file, sessionId } = fixtureTranscript(taskId);
      await substrate.query(
        `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
                execution_actor, claim_principal, statement_type, subject_ref, proposition,
                evidence_refs, epistemic_status, asserted_at)
         VALUES ($1, 'oathe', $2, $3, $4, $5, 'progress', $6, $7, $8::jsonb, 'observed', now())`,
        [crypto.randomUUID(), taskId, workClaimId, `session:${sessionId}`, OPERATOR,
          `trace:${sessionId}`, `claude session worked this claim — transcript at ${file}`,
          JSON.stringify([file])]);
      return { file, sessionId };
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
      await substrate.registerAcceptanceAuthority({
        orgId: 'oathe',
        seats: [VERIFIER, OPERATOR],
        clauseSpecs: standardPlan().clause_spec,
        checkerRefs: { 'checker://acceptance_package': 'verification-clause' },
        registeredBy: 'oathe-test',
      });
      workerTools = createOatheTools({
        client: substrate,
        identity: { orgId: 'oathe', principalId: OPERATOR, department: 'founder' },
        workspace: WS,
        config: scratchConfig(),
      });
      engineCalls = [];
      verifier = new Verifier({
        substrate,
        paths,
        workspace: WS,
        config: scratchConfig(),
        operatorPrincipal: OPERATOR,
        provider: makeProvider(),
        engineRunner: async ({ engine, prompt }) => {
          engineCalls.push({ engine, prompt });
          return engineVerdict;
        },
      });
    });

    after(async () => {
      await verifier.close();
      await substrate.close();
      await substrate.dropDatabase();
    });

    it('R3 §5.4: the verifier sees only the claim interval — pre-claim planning never reaches the engine', async () => {
      const claim = await workerTools.oathe_claim({ task_id: 'sliced-task', objective: 'prove evidence slicing' });
      const { file, sessionId } = fixtureTranscriptWithInterval('sliced-task');
      await substrate.query(
        `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
                execution_actor, claim_principal, statement_type, subject_ref, proposition,
                evidence_refs, epistemic_status, asserted_at)
         VALUES ($1, 'oathe', 'sliced-task', $2, $3, $4, 'progress', $5, 'trace', $6::jsonb, 'observed', now())`,
        [crypto.randomUUID(), claim.work_claim_id, `session:${sessionId}`, OPERATOR,
          `trace:${sessionId}`, JSON.stringify([file])]);
      await workerTools.oathe_done({ task_id: 'sliced-task', proposition: 'sliced work complete', evidence_ref: 'x' });
      engineVerdict = { verdict: 'accepted', reason: 'interval evidence suffices' };
      await verifier.verify({ taskId: 'sliced-task' });
      const prompt = engineCalls.at(-1).prompt;
      assert.match(prompt, /INTERVAL-WORK-MARKER/, 'the claimed interval IS the evidence');
      assert.doesNotMatch(prompt, /PLANNING-ONLY-DISCUSSION-MARKER/,
        'pre-claim planning is context, not execution evidence — it never reaches the engine');
    });

    it('the evidence section of the engine prompt respects verifierEvidenceBudget — the render bound holds through the verifier', async () => {
      const claim = await workerTools.oathe_claim({ task_id: 'budget-task', objective: 'prove the prompt bound' });
      await linkTrace('budget-task', claim.work_claim_id);
      await workerTools.oathe_done({ task_id: 'budget-task', proposition: 'done', evidence_ref: 'x' });
      engineVerdict = { verdict: 'accepted', reason: 'fine' };
      const budget = 600;
      const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-vbudget-')));
      const tight = new Verifier({
        substrate, paths, workspace: WS, operatorPrincipal: OPERATOR,
        config: new OatheConfig({
          env: { HOME: home, OATHE_HOME: path.join(home, '.oathe'), OATHE_VERIFIER_EVIDENCE_BUDGET: String(budget) },
          cwd: home,
        }),
        provider: new StandaloneRuntimeProvider({ paths }),
        engineRunner: async ({ prompt }) => { engineCalls.push({ prompt }); return engineVerdict; },
      });
      try {
        await tight.verify({ taskId: 'budget-task' });
      } finally {
        await tight.close();
      }
      const prompt = engineCalls.at(-1).prompt;
      const start = prompt.indexOf('SESSION TRACES');
      const end = prompt.lastIndexOf('Reply with ONLY');
      assert.ok(start >= 0 && end > start, 'the prompt carries its evidence section');
      const section = prompt.slice(prompt.indexOf('\n', start) + 1, end);
      // one linked trace → one render ≤ budget; the section adds only its joining newlines
      assert.ok(section.length <= budget + 4,
        `evidence section is ${section.length} chars against a ${budget} budget`);
    });

    it('a claim linked from a RESUMED session is judged on the file its rows live in — the ghost <new-id>.jsonl the hook was told resolves through the store', async () => {
      // Live 2026-09-01: every claim spoken in a resumed/compacted session linked a transcript
      // the harness never wrote; the verifier died at the evidence stage (TRACE_UNREADABLE).
      // Ghost links already on the record heal at read time through the same resolver.
      const claim = await workerTools.oathe_claim({ task_id: 'resumed-judged', objective: 'judged after a resume' });
      const { file } = fixtureTranscript(crypto.randomUUID());
      const rotated = crypto.randomUUID();
      fs.appendFileSync(file, `\n${JSON.stringify({
        type: 'user', uuid: 'u9', sessionId: path.basename(file, '.jsonl'), session_id: rotated, cwd: path.dirname(file),
        message: { role: 'user', content: 'after the resume' },
      })}`);
      const ghost = path.join(path.dirname(file), `${rotated}.jsonl`);
      await substrate.query(
        `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
                execution_actor, claim_principal, statement_type, subject_ref, proposition,
                evidence_refs, epistemic_status, asserted_at)
         VALUES ($1, 'oathe', 'resumed-judged', $2, $3, $4, 'progress', $5, 'claude session worked this claim', $6::jsonb, 'observed', now())`,
        [crypto.randomUUID(), claim.work_claim_id, `session:${rotated}`, OPERATOR, `trace:${rotated}`, JSON.stringify([ghost])]);
      await workerTools.oathe_done({ task_id: 'resumed-judged', proposition: 'done after a resume', evidence_ref: 'x' });
      engineVerdict = { verdict: 'accepted', reason: 'the original file holds the work' };
      const out = await verifier.verify({ taskId: 'resumed-judged' });
      assert.equal(out.verdict, 'accepted', 'the evidence stage read the original, not the ghost');
      assert.equal(out.settled, true);
      assert.ok(!fs.existsSync(ghost), 'the read resolved; nothing wrote the ghost and the record did not change');
    });

    it('ACCEPTED: the whole lane — verdict recorded, verification row signed by the seat, claim SETTLED', async () => {
      const claim = await workerTools.oathe_claim({ task_id: 'settle-me', objective: 'be verified for real' });
      await linkTrace('settle-me', claim.work_claim_id);
      await workerTools.oathe_done({ task_id: 'settle-me', proposition: 'work complete', evidence_ref: 'commit:real' });

      engineVerdict = { verdict: 'accepted', reason: 'traces show the work was done' };
      const out = await verifier.verify({ taskId: 'settle-me' });

      assert.equal(out.verdict, 'accepted');
      assert.equal(out.settled, true);

      const claimRow = (await substrate.query(
        "SELECT settled_at FROM cell.work_claim WHERE work_claim_id = $1", [claim.work_claim_id])).rows[0];
      assert.ok(claimRow.settled_at, 'cell.settle_work_claim actually ran — FC113/FC114 held');

      const verification = (await substrate.query(
        "SELECT result, verifier_principal, verifier_type, source FROM cell.verification "
        + "WHERE org_id = 'oathe' AND task_id = 'settle-me'")).rows;
      assert.equal(verification.length, 1);
      assert.equal(verification[0].result, 'verified');
      assert.equal(verification[0].verifier_principal, VERIFIER, 'FC010: a NON-author signed');
      assert.equal(verification[0].verifier_type, 'seat');
      assert.equal(verification[0].source, 'acceptance_package');

      // the verification task itself was claimed by the verifier, completed, and settled by the OPERATOR seat
      const vclaim = (await substrate.query(
        "SELECT principal_id, state, settled_at FROM cell.work_claim WHERE task_id = 'verify:settle-me' "
        + 'ORDER BY claimed_at DESC LIMIT 1')).rows[0];
      assert.equal(vclaim.principal_id, VERIFIER);
      assert.ok(vclaim.settled_at, 'the review itself settled — non-author all the way down');

      // a SETTLED task leaves the board — the obligation is closed
      const { sections } = await workerTools.oathe_board({});
      assert.ok(!sections.asserted.some((r) => r.task_id === 'settle-me'),
        'settled work does not show as asserted');
      assert.ok(!sections.open.some((r) => r.task_id === 'settle-me'));

      // the engine saw the ALIGNED evidence: objective, assertion, and SAID/DID/GOT per step
      const prompt = engineCalls.at(-1).prompt;
      assert.match(prompt, /be verified for real/);
      assert.match(prompt, /work complete/);
      assert.match(prompt, /SAID: did the work/, 'the claim channel');
      assert.match(prompt, /DID: Bash\(/, 'the action channel');
      assert.match(prompt, /GOT \[exit 0\]: made it/, 'the outcome channel');
      assert.match(prompt, /FROM lines are messages other agents sent/, 'the legend names the inbound channel — a child\'s answer is never this agent\'s claim');
    });

    it('the substrate itself refuses a self-signed verification (FC010) beneath whichever lane runs', async () => {
      const { rows: [stmt] } = await substrate.query(
        "SELECT org_id, task_id, statement_id, claim_principal FROM cell.agent_statement "
        + "WHERE statement_type = 'completion' LIMIT 1");
      await assert.rejects(
        () => substrate.query(
          `INSERT INTO cell.verification
             (verification_id, org_id, task_id, statement_id, source, result,
              verifier_principal, verifier_type, verification_plan_ref, checks,
              evidence_refs, trace_ref, privacy_class, transfer_scope, state_version, recorded_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'acceptance_package', 'verified',
                   $4, 'seat', 'acceptance_package', '[]'::jsonb,
                   '["evidence://self"]'::jsonb, '/traces/x.jsonl',
                   'org_internal', 'org_internal', NULL, now())`,
          [stmt.org_id, stmt.task_id, stmt.statement_id, stmt.claim_principal]),
        (e) => e.code === 'FC010' || /AUTHOR_SELF/.test(String(e.message)));
    });

    it('REJECTED: verification row records the rejection and the task REOPENS (R8)', async () => {
      const claim = await workerTools.oathe_claim({ task_id: 'reject-me', objective: 'be found wanting' });
      await linkTrace('reject-me', claim.work_claim_id);
      await workerTools.oathe_done({ task_id: 'reject-me', proposition: 'claimed done', evidence_ref: 'commit:fake' });

      engineVerdict = { verdict: 'rejected', reason: 'the traces show no such work' };
      const out = await verifier.verify({ taskId: 'reject-me' });

      assert.equal(out.verdict, 'rejected');
      assert.equal(out.settled, false);

      const verification = (await substrate.query(
        "SELECT result FROM cell.verification WHERE org_id = 'oathe' AND task_id = 'reject-me'")).rows;
      assert.equal(verification[0].result, 'rejected');

      const claimRow = (await substrate.query(
        'SELECT settled_at FROM cell.work_claim WHERE work_claim_id = $1', [claim.work_claim_id])).rows[0];
      assert.equal(claimRow.settled_at, null, 'a rejected claim never settles');

      // R8 on the BOARD: a reopened task is OPEN again (not stuck in asserted), and the settled
      // review is off the board entirely
      const { sections } = await workerTools.oathe_board({});
      assert.ok(sections.open.some((r) => r.task_id === 'reject-me'), JSON.stringify(sections.open));
      assert.ok(!sections.asserted.some((r) => r.task_id === 'reject-me'));
      assert.ok(!Object.values(sections).flat().some((r) => r.task_id === 'verify:reject-me'),
        'the settled review left the board');

      // R8: rejection reopens work — the task is claimable again. R-HOME-BOARD: the reclaim verb
      // TRANSCRIBES the prior interval's ref (016), so a re-claim from a FOREIGN folder reports
      // the work's home, never the claiming session's — and the return says so honestly.
      const foreignTools = createOatheTools({
        client: substrate,
        identity: { orgId: 'oathe', principalId: OPERATOR, department: 'founder' },
        workspace: 'ws-fedcba654321',
        config: scratchConfig(),
      });
      const reclaim = await foreignTools.oathe_claim({ task_id: 'reject-me', objective: 'second attempt' });
      assert.equal(reclaim.claimed, true);
      assert.equal(reclaim.contract_ref, `workspace:${WS};contract:oathe/reject-me@v1`);
      assert.equal(reclaim.home, WS);
    });

    it('CURSOR judges too: an engine override of cursor runs the cursor headless command and settles', async () => {
      const claim = await workerTools.oathe_claim({ task_id: 'cursor-judged', objective: 'judged by cursor' });
      await linkTrace('cursor-judged', claim.work_claim_id);
      await workerTools.oathe_done({ task_id: 'cursor-judged', proposition: 'done', evidence_ref: 'x' });
      engineVerdict = { verdict: 'accepted', reason: 'cursor says fine' };
      const out = await verifier.verify({ taskId: 'cursor-judged', engine: 'cursor' });
      assert.equal(out.engine, 'cursor');
      assert.equal(out.settled, true);
      assert.equal(engineCalls.at(-1).engine, 'cursor');
    });

    it('a VERDICT rides the wire the moment it lands — fail-soft: the settlement stands even if the wire is down', async () => {
      const claim = await workerTools.oathe_claim({ task_id: 'wired-verdict', objective: 'emit on settle' });
      await linkTrace('wired-verdict', claim.work_claim_id);
      await workerTools.oathe_done({ task_id: 'wired-verdict', proposition: 'done', evidence_ref: 'x' });
      engineVerdict = { verdict: 'accepted', reason: 'fine' };
      const notifies = [];
      const realQuery = substrate.query.bind(substrate);
      substrate.query = async (sql, params) => {
        if (/pg_notify/i.test(String(sql))) { notifies.push(JSON.parse(params[1])); if (notifies.length === 999) throw new Error('wire down'); }
        return realQuery(sql, params);
      };
      try {
        const out = await verifier.verify({ taskId: 'wired-verdict' });
        assert.equal(out.settled, true);
      } finally {
        substrate.query = realQuery;
      }
      const verdictNudge = notifies.find((n) => n.task_id === 'wired-verdict' && n.kind === 'settled');
      assert.ok(verdictNudge, `the settle nudged the wire: ${JSON.stringify(notifies.map((n) => n.kind))}`);
    });

    it('the engine runs IN the task workspace — cwd resolved by the one home resolver, prompt invites file inspection', async () => {
      const claim = await workerTools.oathe_claim({ task_id: 'workspace-eyes', objective: 'judge with the folder in view' });
      await linkTrace('workspace-eyes', claim.work_claim_id);
      await workerTools.oathe_done({ task_id: 'workspace-eyes', proposition: 'artifact on disk', evidence_ref: 'x' });
      engineVerdict = { verdict: 'accepted', reason: 'the artifact is on disk' };
      const seen = [];
      const eyed = new Verifier({
        substrate, paths, workspace: WS, config: scratchConfig(), operatorPrincipal: OPERATOR,
        provider: makeProvider(),
        engineRunner: async ({ engine, prompt, cwd }) => { seen.push({ engine, prompt, cwd }); return engineVerdict; },
        homePathFor: () => '/tmp/the-task-home', // the ONE resolver, injected
      });
      try {
        await eyed.verify({ taskId: 'workspace-eyes' });
      } finally {
        await eyed.close();
      }
      assert.equal(seen[0].cwd, '/tmp/the-task-home', 'the engine judges FROM the task home, never the caller\'s folder');
      assert.match(seen[0].prompt, /task's workspace — check asserted artifacts against the files on disk/,
        'the prompt invites workspace inspection — the engine is the evidence reader');
    });

    it('a pre-verdict failure EMITS verify_failed on the wire — the glass hears it, not just a log', async () => {
      const claim = await workerTools.oathe_claim({ task_id: 'loud-death', objective: 'die loudly' });
      await linkTrace('loud-death', claim.work_claim_id);
      await workerTools.oathe_done({ task_id: 'loud-death', proposition: 'done', evidence_ref: 'x' });
      const notifies = [];
      const spyClient = {
        query: (sql, params) => {
          if (/pg_notify/i.test(String(sql))) notifies.push(JSON.parse(params[1]));
          return substrate.query(sql, params);
        },
        connectionConfig: () => substrate.connectionConfig(),
      };
      const failing = new Verifier({
        substrate: spyClient, paths, workspace: WS, config: scratchConfig(), operatorPrincipal: OPERATOR,
        provider: new StandaloneRuntimeProvider({ paths }),
        engineRunner: async () => { const e = new Error('engine evaporated'); e.code = 'OATHE_ENGINE_FAILED'; throw e; },
      });
      try {
        await assert.rejects(failing.verify({ taskId: 'loud-death' }), /evaporated/);
      } finally {
        await failing.close();
      }
      const failed = notifies.find((n) => n.kind === 'verify_failed');
      assert.ok(failed, `verify_failed rode the wire: ${JSON.stringify(notifies.map((n) => n.kind))}`);
      assert.equal(failed.task_id, 'loud-death', 'named by the ORIGINAL task — the row the glass shows');
    });

    it('ENGINE DEATH releases: a pre-verdict engine failure records a durable statement and YIELDS the verify claim — no wedge, retry names another engine', async () => {
      const claim = await workerTools.oathe_claim({ task_id: 'engine-dies', objective: 'survive the engine' });
      await linkTrace('engine-dies', claim.work_claim_id);
      await workerTools.oathe_done({ task_id: 'engine-dies', proposition: 'done', evidence_ref: 'x' });
      engineVerdict = null; // the runner throws instead
      const failing = new Verifier({
        substrate, paths, workspace: WS, config: scratchConfig(), operatorPrincipal: OPERATOR,
        provider: new StandaloneRuntimeProvider({ paths }),
        engineRunner: async () => { const e = new Error('codex exited 1: usage limit reached — try again at 2:56 AM'); e.code = 'OATHE_ENGINE_FAILED'; throw e; },
      });
      try {
        await assert.rejects(failing.verify({ taskId: 'engine-dies' }), /usage limit reached/);
      } finally {
        await failing.close();
      }
      const { rows: claimRows } = await substrate.query(
        "SELECT state FROM cell.work_claim WHERE org_id='oathe' AND task_id='verify:engine-dies' ORDER BY claimed_at DESC LIMIT 1");
      assert.notEqual(claimRows[0].state, 'active', 'the dead run RELEASED its claim — a re-dispatch is not wedged');
      const { rows: stmts } = await substrate.query(
        `SELECT proposition, evidence_refs FROM cell.agent_statement
          WHERE org_id='oathe' AND task_id='verify:engine-dies' AND statement_type='progress'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(evidence_refs) er WHERE er LIKE 'engine-failure:%')`);
      assert.equal(stmts.length, 1, 'the failure is DURABLE in the substrate, not only in a log');
      assert.match(stmts[0].proposition, /usage limit reached/, 'the real error text, not a banner');
    });

    it('EVIDENCE DEATH releases: a failure BEFORE the engine launches records evidence-failure — no engine ran, so its stall never blames one', async () => {
      const claim = await workerTools.oathe_claim({ task_id: 'evidence-dies', objective: 'survive an unreadable record' });
      // The linked trace names a file NO store owns — projection dies in evidence-gathering,
      // exactly where a runtime-bound store (node:sqlite missing) dies (the 2026-08-31 pileup).
      const bogus = path.join(os.tmpdir(), 'oathe-nowhere', 'rollout-that-never-was.jsonl');
      const sessionId = crypto.randomUUID();
      await substrate.query(
        `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
                execution_actor, claim_principal, statement_type, subject_ref, proposition,
                evidence_refs, epistemic_status, asserted_at)
         VALUES ($1, 'oathe', $2, $3, $4, $5, 'progress', $6, 'trace', $7::jsonb, 'observed', now())`,
        [crypto.randomUUID(), 'evidence-dies', claim.work_claim_id, `session:${sessionId}`,
          OPERATOR, `trace:${sessionId}`, JSON.stringify([bogus])]);
      await workerTools.oathe_done({ task_id: 'evidence-dies', proposition: 'done', evidence_ref: 'x' });
      let engineLaunched = false;
      const failing = new Verifier({
        substrate, paths, workspace: WS, config: scratchConfig(), operatorPrincipal: OPERATOR,
        provider: new StandaloneRuntimeProvider({ paths }),
        engineRunner: async () => { engineLaunched = true; return { verdict: 'accepted', reason: 'must never run' }; },
      });
      try {
        await assert.rejects(failing.verify({ taskId: 'evidence-dies' }), /no trace store owns/);
      } finally {
        await failing.close();
      }
      assert.equal(engineLaunched, false, 'the failure is the record, not the judge — no engine launched');
      const { rows: claimRows } = await substrate.query(
        "SELECT state FROM cell.work_claim WHERE org_id='oathe' AND task_id='verify:evidence-dies' ORDER BY claimed_at DESC LIMIT 1");
      assert.notEqual(claimRows[0].state, 'active', 'the dead run RELEASED its claim');
      const { rows: stmts } = await substrate.query(
        `SELECT proposition, evidence_refs FROM cell.agent_statement
          WHERE org_id='oathe' AND task_id='verify:evidence-dies' AND statement_type='progress'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(evidence_refs) er WHERE er LIKE 'evidence-failure:%')`);
      assert.equal(stmts.length, 1, 'the failure is DURABLE, marked as an evidence failure — not an engine one');
      assert.match(stmts[0].proposition, /failed before the \S+ engine launched/,
        'the stall says the engine never ran');
      assert.match(stmts[0].proposition, /no trace store owns/, 'and carries the real cause');
      assert.doesNotMatch(stmts[0].proposition, /^engine \S+ failed/,
        'never worded as an engine failure — that wording advises the wrong retry');
    });

    it('RECOVERY: re-verifying an ALREADY-SETTLED task recovers instead of OATHE_SETTLEMENT_BLOCKED — the kill-window wedge', async () => {
      const claim = await workerTools.oathe_claim({ task_id: 'wedge-me', objective: 'settle once, recover on retry' });
      await linkTrace('wedge-me', claim.work_claim_id);
      await workerTools.oathe_done({ task_id: 'wedge-me', proposition: 'done', evidence_ref: 'x' });
      engineVerdict = { verdict: 'accepted', reason: 'fine' };
      const first = await verifier.verify({ taskId: 'wedge-me' });
      assert.equal(first.settled, true);
      // The kill window: a child dies after the accepted settle, before the review settles.
      // A re-run re-claims verify:wedge-me, re-judges, and must RECOGNIZE the settled claim.
      const again = await verifier.verify({ taskId: 'wedge-me' });
      assert.equal(again.settled, true, 'already-settled reads as settled, never OATHE_SETTLEMENT_BLOCKED');
      assert.equal(again.verdict, 'accepted');
    });

    it('RECOVERY: a second REJECTED verify is idempotent-safe — duplicate verification rows lawful, reopen idempotent', async () => {
      const claim = await workerTools.oathe_claim({ task_id: 'rewedge', objective: 'reject twice safely' });
      await linkTrace('rewedge', claim.work_claim_id);
      await workerTools.oathe_done({ task_id: 'rewedge', proposition: 'done', evidence_ref: 'x' });
      engineVerdict = { verdict: 'rejected', reason: 'not enough' };
      const first = await verifier.verify({ taskId: 'rewedge' });
      assert.equal(first.reopened, true);
      const again = await verifier.verify({ taskId: 'rewedge' });
      assert.equal(again.reopened, true, 'the reopen path never throws on a re-run');
      const { rows } = await substrate.query(
        "SELECT origin FROM cell.task WHERE org_id = 'oathe' AND task_id = 'rewedge'");
      assert.equal(rows[0].origin, 'reopened');
    });

    it('a malformed engine verdict is a typed refusal — the lane never guesses', async () => {
      const claim = await workerTools.oathe_claim({ task_id: 'garbled', objective: 'engine goes weird' });
      await linkTrace('garbled', claim.work_claim_id);
      await workerTools.oathe_done({ task_id: 'garbled', proposition: 'done', evidence_ref: 'x' });
      engineVerdict = { verdict: 'maybe', reason: 'shrug' };
      await assert.rejects(
        () => verifier.verify({ taskId: 'garbled' }),
        (e) => e instanceof VerifierError && e.code === 'OATHE_VERDICT_MALFORMED');
    });

    it('verifying a task with no verification task on the board is a typed refusal', async () => {
      await assert.rejects(
        () => verifier.verify({ taskId: 'never-done' }),
        (e) => e instanceof VerifierError && e.code === 'OATHE_NOTHING_TO_VERIFY');
    });
    it("R-HOME-BOARD: the verification task inherits the WORK's home, not the verifier's folder", async () => {
      const claim = await workerTools.oathe_claim({ task_id: 'homed-verify', objective: 'homed in WS' });
      await linkTrace('homed-verify', claim.work_claim_id);
      await workerTools.oathe_done({ task_id: 'homed-verify', proposition: 'done in WS', evidence_ref: 'commit:h' });
      // A verifier standing in ANOTHER folder judges it — its claim on verify:homed-verify must
      // carry WS (the parent's home), never the verifier's own workspace (leak #2).
      const foreign = new Verifier({
        substrate, paths, workspace: 'ws-fedcba654321', config: scratchConfig(),
        operatorPrincipal: OPERATOR, provider: makeProvider(),
        engineRunner: async () => ({ verdict: 'accepted', reason: 'fine' }),
      });
      try {
        await foreign.verify({ taskId: 'homed-verify' });
      } finally {
        await foreign.close();
      }
      const { rows } = await substrate.query(
        "SELECT contract_ref FROM cell.work_claim WHERE task_id = 'verify:homed-verify' ORDER BY claimed_at ASC LIMIT 1");
      assert.equal(rows[0].contract_ref, `workspace:${WS};contract:oathe/verify:homed-verify@v1`);
    });
  });
}

it('OATHE_ENGINE_FAILED carries the TAIL of stderr — the banner must not eat the actual error', async () => {
  const { defaultEngineRunner } = await import('../src/verifier.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-tail-eng-'));
  fs.mkdirSync(path.join(home, 'bin'));
  fs.writeFileSync(path.join(home, 'bin', 'claude'),
    `#!/bin/sh\nfor i in $(seq 1 40); do echo "BANNER LINE $i padding padding padding" 1>&2; done\necho "usage limit reached - try again at 2:56 AM" 1>&2\nexit 1\n`);
  fs.chmodSync(path.join(home, 'bin', 'claude'), 0o755);
  await assert.rejects(
    defaultEngineRunner({ engine: 'claude', prompt: 'p', env: { ...process.env, PATH: `${path.join(home, 'bin')}:${process.env.PATH}` } }),
    (e) => e.code === 'OATHE_ENGINE_FAILED' && /usage limit reached/.test(e.message));
});

it('defaultEngineRunner hands the engine a CLOSED stdin — an engine that reads stdin to EOF must not wait forever', async () => {
  const { defaultEngineRunner } = await import('../src/verifier.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-stdin-eng-'));
  fs.mkdirSync(path.join(home, 'bin'));
  const payload = JSON.stringify({ result: JSON.stringify({ verdict: 'accepted', reason: 'stdin closed' }) });
  // Many CLIs (codex exec among them, live 2026-08-30) drain stdin to EOF before answering,
  // and async spawn defaults to an OPEN pipe nobody ends.
  fs.writeFileSync(path.join(home, 'bin', 'claude'), `#!/bin/sh\ncat > /dev/null\ncat <<'JSON'\n${payload}\nJSON\n`);
  fs.chmodSync(path.join(home, 'bin', 'claude'), 0o755);
  const out = await Promise.race([
    defaultEngineRunner({ engine: 'claude', prompt: 'p', env: { ...process.env, PATH: `${path.join(home, 'bin')}:${process.env.PATH}` } }),
    new Promise((_, reject) => { setTimeout(() => reject(new Error('runner hung — stdin pipe never closed')), 8000).unref(); }),
  ]);
  assert.equal(out.verdict, 'accepted');
});

it('defaultEngineRunner resolves on ENGINE EXIT even when a grandchild keeps the stdio pipes open — the codex-helper hang', async () => {
  const { defaultEngineRunner } = await import('../src/verifier.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-hang-eng-'));
  fs.mkdirSync(path.join(home, 'bin'));
  const payload = JSON.stringify({ result: JSON.stringify({ verdict: 'accepted', reason: 'exited fine' }) });
  // The engine backgrounds a long-lived helper that INHERITS stdout, then exits. 'close' never
  // fires while the helper lives; the runner must resolve on 'exit' after draining (found live
  // 2026-08-30: a detached verify sat at 0% CPU for 20 minutes after codex finished).
  fs.writeFileSync(path.join(home, 'bin', 'claude'), `#!/bin/sh\nsleep 300 &\ncat <<'JSON'\n${payload}\nJSON\nexit 0\n`);
  fs.chmodSync(path.join(home, 'bin', 'claude'), 0o755);
  const out = await Promise.race([
    defaultEngineRunner({ engine: 'claude', prompt: 'p', env: { ...process.env, PATH: `${path.join(home, 'bin')}:${process.env.PATH}` } }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('runner hung on close — the grandchild pipe hang')), 8000).unref?.() ?? undefined),
  ]);
  assert.equal(out.verdict, 'accepted');
});

it('defaultEngineRunner does not block the event loop — a timer ticks while the engine runs', async () => {
  const { defaultEngineRunner } = await import('../src/verifier.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-async-eng-'));
  fs.mkdirSync(path.join(home, 'bin'));
  const payload = JSON.stringify({ result: JSON.stringify({ verdict: 'accepted', reason: 'slept fine' }) });
  fs.writeFileSync(path.join(home, 'bin', 'claude'), `#!/bin/sh\nsleep 0.4\ncat <<'JSON'\n${payload}\nJSON\n`);
  fs.chmodSync(path.join(home, 'bin', 'claude'), 0o755);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 25);
  try {
    const out = await defaultEngineRunner({
      engine: 'claude', prompt: 'p', env: { ...process.env, PATH: `${path.join(home, 'bin')}:${process.env.PATH}` },
    });
    assert.equal(out.verdict, 'accepted');
  } finally { clearInterval(timer); }
  assert.ok(ticks >= 4, `the loop must keep turning during the engine run (ticks: ${ticks})`);
});
