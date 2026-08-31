// PreCompact — compaction is lossy; leave a durable statement on each active claim so the
// board remembers what the context is about to forget it was doing.

import crypto from 'node:crypto';
import { failSoft } from './lib.mjs';

// Custody is the PRINCIPAL's, not the folder's (R-HOME-BOARD): every claim this principal
// actively holds gets the note, wherever the task is homed.
await failSoft(async ({ substrate, identity }) => {
  const { rows } = await substrate.query(
    `SELECT work_claim_id, task_id FROM cell.work_claim
      WHERE org_id = $1 AND principal_id = $2 AND state = 'active'`,
    [identity.orgId, identity.principalId]);
  for (const claim of rows) {
    await substrate.query(
      `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
              execution_actor, claim_principal, statement_type, subject_ref, proposition,
              evidence_refs, epistemic_status, asserted_at)
       VALUES ($1, $2, $3, $4, 'oathe-precompact-hook', $5, 'progress', $6,
               'context compaction imminent — the session''s working set is being compressed; '
               || 'board state and statements are the durable record', '["hook:PreCompact"]'::jsonb,
               'observed', now())`,
      [crypto.randomUUID(), identity.orgId, claim.task_id, claim.work_claim_id,
        identity.principalId, `task:${claim.task_id}`]);
  }
});
