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
import { standardPlan, ACCEPTANCE_CLAUSE_KEY } from '../src/plans.mjs';
import { FiriaRuntimeProvider, StandaloneRuntimeProvider } from '../src/runtime/provider.mjs';

const paths = buildPaths({});
const WS = 'ws-verify0000000';
const OPERATOR = 'firia';
const VERIFIER = 'oathe-verifier';

const PROVIDERS = [
  ['firia', () => new FiriaRuntimeProvider({ paths })],
  ['standalone', () => new StandaloneRuntimeProvider()],
];

/** A minimal REAL claude-shaped transcript the trace contract accepts. */
function fixtureTranscript(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-vtrace-'));
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
      });
      engineCalls = [];
      verifier = new Verifier({
        substrate,
        paths,
        workspace: WS,
        config: new OatheConfig({ env: process.env }),
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
        'settled work no longer shows as asserted');
      assert.ok(!sections.open.some((r) => r.task_id === 'settle-me'));

      // the engine saw the ALIGNED evidence: objective, assertion, and SAID/DID/GOT per step
      const prompt = engineCalls.at(-1).prompt;
      assert.match(prompt, /be verified for real/);
      assert.match(prompt, /work complete/);
      assert.match(prompt, /SAID: did the work/, 'the claim channel');
      assert.match(prompt, /DID: Bash\(/, 'the action channel');
      assert.match(prompt, /GOT \[exit 0\]: made it/, 'the outcome channel');
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

      // R8: rejection reopens work — the task is claimable again
      const reclaim = await workerTools.oathe_claim({ task_id: 'reject-me', objective: 'second attempt' });
      assert.equal(reclaim.claimed, true);
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
  });
}
