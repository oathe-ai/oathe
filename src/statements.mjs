// oathe — the statement vocabulary shared across the tree. Two facts live here and nowhere
// else: the subject_ref grammar of a TRACE-LINKAGE statement ('trace:<session_id>', written by
// the heartbeat hook, read by the verifier and the CLI), and the SQL that finds a claim's
// latest PROGRESS statement in the holder's own words — trace links excluded, because a
// heartbeat is custody evidence, not a word from the holder (the board and the pager both
// read "last word" through this one fragment).

export const TRACE_SUBJECT_PREFIX = 'trace:';

/** The subject_ref of the statement linking a session transcript to a claim. */
export function traceSubjectRef(sessionId) {
  return `${TRACE_SUBJECT_PREFIX}${sessionId}`;
}

/** SQL predicate on a subject_ref column: is this a trace-linkage statement? */
export function isTraceSubjectSql(column) {
  return `${column} LIKE '${TRACE_SUBJECT_PREFIX}%'`;
}

/**
 * THE trace-link writer — attribution rides the speech act (SPEAKER primitive, founder
 * ruling 2026-08-30). Links `session` to the principal's open claim on `taskId`:
 * one link per claim × session, idempotent by (work_claim_id, subject_ref), so the write
 * wrapper stamps it at the act and the turn-end heartbeat's sweep is a no-op for it.
 * A session with no transcript store (cursor) attributes with empty evidence — honestly.
 * No open claim of this principal on the task → nothing to link, {linked: false}.
 * Failures THROW — attribution is part of the act, not a courtesy (retries are idempotent).
 * @param {{client: {query: Function}, identity: {orgId: string, principalId: string},
 *          taskId: string, session: {sessionId: string, transcriptPath: string|null, harness: string|null}}} o
 * @returns {Promise<{linked: boolean}>}
 */
export async function linkTrace({ client, identity, taskId, session }) {
  const { rows } = await client.query(
    `SELECT work_claim_id FROM cell.work_claim
      WHERE org_id = $1 AND principal_id = $2 AND task_id = $3 AND settled_at IS NULL
        AND state IN ('active', 'completion_asserted')
      ORDER BY claimed_at DESC LIMIT 1`,
    [identity.orgId, identity.principalId, taskId]);
  if (rows.length === 0) return { linked: false };
  const { randomUUID } = await import('node:crypto');
  const transcript = session.transcriptPath ?? null;
  await client.query(
    `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
            execution_actor, claim_principal, statement_type, subject_ref, proposition,
            evidence_refs, epistemic_status, asserted_at)
     SELECT $1, $2, $3, $4, $5, $6, 'progress', $7, $8, $9::jsonb, 'observed', now()
      WHERE NOT EXISTS (
        SELECT 1 FROM cell.agent_statement
         WHERE org_id = $2 AND work_claim_id = $4 AND subject_ref = $7)`,
    [randomUUID(), identity.orgId, taskId, rows[0].work_claim_id,
      `session:${session.sessionId}`, identity.principalId, traceSubjectRef(session.sessionId),
      `${session.harness ?? 'unknown'} session ${session.sessionId} worked this claim`
      + (transcript ? ` — transcript at ${transcript} (fan-out derived at read time)` : ' — no transcript store (this surface keeps none)'),
      JSON.stringify(transcript ? [transcript] : [])]);
  return { linked: true };
}

/**
 * The latest non-trace progress statement of one claim, as a LATERAL body:
 * `LEFT JOIN LATERAL (${latestProgressSql({ task: 't', claim: 'w' })}) p ON true` yields
 * p.proposition / p.asserted_at (NULL when the holder has said nothing yet).
 * @param {{task: string, claim: string}} aliases  the cell.task and cell.work_claim aliases in scope
 */
/**
 * The verdict's own words for `task` — the latest completion statement of its verify: twin
 * ("rejected: <reason>" / "accepted: <reason>"). THE owning read for the rejection reason:
 * the pager's breach detail, the tools' attention lines, and the reclaim bundle all consume
 * this one fragment (`task` is a cell.task alias).
 */
/** Engine-failure evidence shape: 'engine-failure:<engine>' — a verify child that lost its
 *  engine records this on the verify task before releasing its claim. */
export function engineFailureRef(engine) {
  return `engine-failure:${engine}`;
}
export function isEngineFailureSql(column) {
  return `EXISTS (SELECT 1 FROM jsonb_array_elements_text(${column}) er WHERE er LIKE 'engine-failure:%')`;
}

/** R-AMEND: the amendment trail's subject shape — 'amend:<task_id>', owned here alone. */
export const AMEND_SUBJECT_PREFIX = 'amend:';
export function amendSubjectRef(taskId) {
  return `${AMEND_SUBJECT_PREFIX}${taskId}`;
}

export function latestVerdictSql({ task }) {
  return `SELECT s.proposition AS verdict, s.asserted_at AS verdict_at
            FROM cell.agent_statement s
           WHERE s.org_id = ${task}.org_id AND s.task_id = 'verify:' || ${task}.task_id
             AND s.statement_type = 'completion'
           ORDER BY s.asserted_at DESC LIMIT 1`;
}

/**
 * The latest trace-link statement's transcript path for `task` — the durable record of
 * WHICH SURFACE last worked the claim (the heartbeat writes one per claim × session,
 * transcript path as evidence_refs[0]; ownerOfTracePath maps it to a harness).
 */
export function latestTracePathSql({ task }) {
  return `SELECT s.evidence_refs->>0 AS trace_path,
                 substr(s.subject_ref, ${TRACE_SUBJECT_PREFIX.length + 1}) AS trace_session_id
            FROM cell.agent_statement s
           WHERE s.org_id = ${task}.org_id AND s.task_id = ${task}.task_id
             AND ${isTraceSubjectSql('s.subject_ref')}
           ORDER BY s.asserted_at DESC LIMIT 1`;
}

export function latestProgressSql({ task, claim }) {
  return `SELECT s.proposition, s.asserted_at FROM cell.agent_statement s
           WHERE s.org_id = ${task}.org_id AND s.task_id = ${task}.task_id
             AND s.work_claim_id = ${claim}.work_claim_id
             AND s.statement_type = 'progress' AND NOT (${isTraceSubjectSql('s.subject_ref')})
           ORDER BY s.asserted_at DESC LIMIT 1`;
}
