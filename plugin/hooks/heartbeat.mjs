// Stop — the turn-end heartbeat, two duties: (1) a session still talking is still alive —
// renew the lease on this workspace's active claims; (2) LINK the session's trace to those
// claims (one statement per claim x session, keyed by subject_ref 'trace:<session_id>') so a
// verifier can later read exactly the transcripts behind the work.

import crypto from 'node:crypto';
import { failSoft } from './lib.mjs';

await failSoft(async ({ substrate, workspace, identity, config, session }) => {
  await substrate.query(
    `UPDATE cell.work_claim
        SET ownership_valid_until = now() + make_interval(hours => $4)
      WHERE org_id = $1 AND principal_id = $2 AND state = 'active'
        AND contract_ref LIKE $3`,
    [identity.orgId, identity.principalId, `workspace:${workspace};%`, config.get('leaseHours')]);

  if (!session?.transcriptPath) return; // no identity handed to this hook — nothing to link
  // Linkage covers ASSERTED claims too: a claim taken and completed inside a single turn has
  // never seen a heartbeat while active — the turn-end hook is its only chance to leave the
  // trace evidence the verifier will demand. (Settled claims are closed; nothing to link.)
  const { rows } = await substrate.query(
    `SELECT work_claim_id, task_id FROM cell.work_claim
      WHERE org_id = $1 AND principal_id = $2 AND settled_at IS NULL
        AND state IN ('active', 'completion_asserted') AND contract_ref LIKE $3`,
    [identity.orgId, identity.principalId, `workspace:${workspace};%`]);
  for (const claim of rows) {
    await substrate.query(
      `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
              execution_actor, claim_principal, statement_type, subject_ref, proposition,
              evidence_refs, epistemic_status, asserted_at)
       SELECT $1, $2, $3, $4, $5, $6, 'progress', $7, $8, $9::jsonb, 'observed', now()
        WHERE NOT EXISTS (
          SELECT 1 FROM cell.agent_statement
           WHERE org_id = $2 AND work_claim_id = $4 AND subject_ref = $7)`,
      [crypto.randomUUID(), identity.orgId, claim.task_id, claim.work_claim_id,
        `session:${session.sessionId}`, identity.principalId, `trace:${session.sessionId}`,
        `${session.harness} session ${session.sessionId} worked this claim — transcript at `
        + `${session.transcriptPath} (fan-out derived at read time)`,
        JSON.stringify([session.transcriptPath])]);
  }
});
