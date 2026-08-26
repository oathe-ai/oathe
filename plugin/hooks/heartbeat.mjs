// Stop — the turn-end heartbeat. ONE duty: LINK the session's trace to this workspace's
// claims (one statement per claim x session, keyed by subject_ref 'trace:<session_id>') so a
// verifier can later read exactly the transcripts behind the work. It does NOT touch
// ownership_valid_until: session liveness is not an organizational act (R1, correction
// packet 2026-08-26); the horizon is set at claim time by the substrate's claim verb.

import crypto from 'node:crypto';
import { failSoft } from './lib.mjs';
import { projectorFor, claimIntervals } from '../../src/atif.mjs';

await failSoft(async ({ substrate, workspace, identity, config, session }) => {
  if (!session?.transcriptPath) return; // no identity handed to this hook — nothing to link
  // R3 (§5): evidence is claim-specific and interval-specific. The session's own structured
  // trace names the tasks it ACTED on (the projector's claim_events); only those claims get
  // this trace linked. No readable trace, or no oathe acts in it → nothing to attribute —
  // a planning-only session leaves no claim evidence.
  let touched;
  try {
    const trajectory = projectorFor(session.transcriptPath).project(session.transcriptPath);
    touched = new Set(claimIntervals(trajectory).map((i) => i.task_id));
  } catch {
    return; // fail-soft: an unreadable or unprojectable trace attributes nothing
  }
  if (touched.size === 0) return;
  // Linkage covers ASSERTED claims too: a claim taken and completed inside a single turn has
  // never seen a heartbeat while active — the turn-end hook is its only chance to leave the
  // trace evidence the verifier will demand. (Settled claims are closed; nothing to link.)
  const { rows } = await substrate.query(
    `SELECT work_claim_id, task_id FROM cell.work_claim
      WHERE org_id = $1 AND principal_id = $2 AND settled_at IS NULL
        AND state IN ('active', 'completion_asserted') AND contract_ref LIKE $3
        AND task_id = ANY($4)`,
    [identity.orgId, identity.principalId, `workspace:${workspace};%`, [...touched]]);
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
