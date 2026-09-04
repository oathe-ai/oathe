// oathe — the statement vocabulary shared across the tree. Two facts live here and nowhere
// else: the subject_ref grammar of a TRACE-LINKAGE statement ('trace:<session_id>', written by
// the heartbeat hook, read by the verifier and the CLI), and the SQL that finds a claim's
// latest PROGRESS statement in the holder's own words — trace links excluded, because a
// heartbeat is custody evidence, not a word from the holder (the board and the pager both
// read "last word" through this one fragment).

import fs from 'node:fs';

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
 * No open claim of this principal on the task → nothing to link, {linked: false}. A
 * transcript the harness named but has not written (a resumed session before its first
 * turn end) is NOT linked: a link names a file a verifier can read, or it waits for the
 * heartbeat — {linked: false, why} so the act can disclose it.
 * Failures THROW — attribution is part of the act, not a courtesy (retries are idempotent).
 * @param {{client: {query: Function}, identity: {orgId: string, principalId: string},
 *          taskId: string, session: {sessionId: string, transcriptPath: string|null, harness: string|null}}} o
 * @returns {Promise<{linked: boolean, why?: string}>}
 */
export async function linkTrace({ client, identity, taskId, session }) {
  if (session.transcriptPath && !fs.existsSync(session.transcriptPath)) {
    return { linked: false, why: `transcript not on disk yet (${session.transcriptPath}) — the turn-end heartbeat links the file the session writes` };
  }
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

/** Evidence-failure shape: 'evidence-failure:<code>' — a verify child that could not READ the
 *  record (trace projection died before any engine launched) records this before releasing.
 *  No engine ran, so its stall must never blame one or advise swapping one. */
export function evidenceFailureRef(code) {
  return `evidence-failure:${code || 'unknown'}`;
}
/** Either stall shape — the pager and the attention lines page BOTH kinds of stalled verify. */
export function isVerifyStallSql(column) {
  return `EXISTS (SELECT 1 FROM jsonb_array_elements_text(${column}) er
                   WHERE er LIKE 'engine-failure:%' OR er LIKE 'evidence-failure:%')`;
}

/** R-AMEND: the amendment trail's subject shape — 'amend:<task_id>', owned here alone. */
/**
 * The disclosure an ADMITTED session-less act carries (`trace_link.why`, ruling 2026-09-04):
 * a surface that runs no hooks by design, or a platform where the process tree could not be
 * walked and the client's label stood in. One wording, spoken by the tools; the CLI prints it.
 */
export function attributionWhy({ surface, walked }) {
  return walked
    ? `no session registered for ${surface} (a surface that runs no hooks): nothing links this act to a transcript — its evidence is discovered by fingerprint at verify`
    : `the process ancestry could not be walked on this platform, so the client's own label (${surface}) stood in: nothing links this act to a transcript — its evidence is discovered by fingerprint at verify`;
}

export const AMEND_SUBJECT_PREFIX = 'amend:';
export function amendSubjectRef(taskId) {
  return `${AMEND_SUBJECT_PREFIX}${taskId}`;
}

/**
 * LINEAGE (founder ruling 2026-09-01: provenance now, delegation later). Work claimed while
 * a session holds a claim is recorded as SPAWNED under it: one observation statement on the
 * parent's claim — subject 'spawn:<child>', evidence ['task:<child>'] — riding the statement
 * transport every fact rides, so Cloud State carries it unchanged. The delegation column
 * (cell.work_claim.parent_work_claim_id — 010's forward contract, assert_children_verified)
 * stays reserved for accountable cross-principal delegation; spawnParentSql is the ONE read
 * that will union both edges when the delegate verb ships, so display never knows which
 * edge it read. Limitation, stated: nested fan-out inside one session attaches to the
 * session's root claim — the trace's spawn tree is the exact record.
 */
export const SPAWN_SUBJECT_PREFIX = 'spawn:';
export function spawnSubjectRef(childTaskId) {
  return `${SPAWN_SUBJECT_PREFIX}${childTaskId}`;
}

export class SpawnParentError extends Error {
  constructor(parent, why) {
    super(`'${parent}' cannot be the parent: ${why} — pass the id of a claim you hold, or parent: null for standalone work`);
    this.name = 'SpawnParentError';
    this.code = 'OATHE_SPAWN_PARENT_NOT_HELD';
    this.parent = parent;
  }
}

/**
 * LATERAL body: the parent `task` was spawned under (the latest spawn statement naming it)
 * with the parent's objective — `parent_task_id` / `parent_objective`, NULL for a root.
 * @param {{task: string}} aliases  the cell.task alias in scope
 */
export function spawnParentSql({ task }) {
  return `SELECT s.task_id AS parent_task_id, pt.objective AS parent_objective
            FROM cell.agent_statement s
            JOIN cell.task pt ON pt.org_id = s.org_id AND pt.task_id = s.task_id
           WHERE s.org_id = ${task}.org_id AND s.subject_ref = '${SPAWN_SUBJECT_PREFIX}' || ${task}.task_id
           ORDER BY s.asserted_at DESC LIMIT 1`;
}

/** This principal's active claim on `taskId`, else null. */
async function heldClaim(client, identity, taskId) {
  const { rows } = await client.query(
    `SELECT work_claim_id FROM cell.work_claim
      WHERE org_id = $1 AND principal_id = $2 AND task_id = $3 AND state = 'active' AND settled_at IS NULL
      ORDER BY claimed_at DESC LIMIT 1`,
    [identity.orgId, identity.principalId, taskId]);
  return rows[0]?.work_claim_id ?? null;
}

/**
 * Which claim a new claim is spawned under — decided BEFORE the claim lands, so a refusal
 * leaves nothing behind. `parent` an id: that claim, which this principal must hold (never
 * the task itself). `parent` null: standalone, on purpose. `parent` omitted: the session's
 * root — the oldest active claim this principal holds that is linked to this session,
 * excluding recorded children; no session, no lineage.
 * @returns {Promise<{parent: string}|null>}
 */
export async function spawnParentFor({ client, identity, session, taskId, parent }) {
  if (parent === null) return null;
  if (parent !== undefined) {
    if (parent === taskId) throw new SpawnParentError(parent, 'a task cannot spawn itself');
    if (await heldClaim(client, identity, parent) === null) throw new SpawnParentError(parent, `${identity.principalId} holds no active claim on it`);
    return { parent };
  }
  if (!session) return null;
  const { rows } = await client.query(
    `SELECT c.task_id FROM cell.work_claim c
      WHERE c.org_id = $1 AND c.principal_id = $2 AND c.task_id <> $3
        AND c.state = 'active' AND c.settled_at IS NULL
        AND EXISTS (SELECT 1 FROM cell.agent_statement s
                     WHERE s.org_id = c.org_id AND s.work_claim_id = c.work_claim_id AND s.subject_ref = $4)
        AND NOT EXISTS (SELECT 1 FROM cell.agent_statement sp
                         WHERE sp.org_id = c.org_id AND sp.subject_ref = $5 || c.task_id)
      ORDER BY c.claimed_at LIMIT 1`,
    [identity.orgId, identity.principalId, taskId, traceSubjectRef(session.sessionId), SPAWN_SUBJECT_PREFIX]);
  return rows.length > 0 ? { parent: rows[0].task_id } : null;
}

/**
 * THE spawn writer: the observation on the parent's active claim, idempotent by
 * (work_claim_id, subject_ref) — a yield-and-reclaim of the child leaves one record.
 * Failures THROW — lineage is part of the act, not a courtesy.
 */
export async function linkSpawn({ client, identity, parent, childTaskId, actor }) {
  const workClaimId = await heldClaim(client, identity, parent);
  if (workClaimId === null) throw new SpawnParentError(parent, `${identity.principalId} holds no active claim on it`);
  const { randomUUID } = await import('node:crypto');
  await client.query(
    `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
            execution_actor, claim_principal, statement_type, subject_ref, proposition,
            evidence_refs, epistemic_status, asserted_at)
     SELECT $1, $2, $3, $4, $5, $6, 'observation', $7, $8, $9::jsonb, 'observed', now()
      WHERE NOT EXISTS (
        SELECT 1 FROM cell.agent_statement
         WHERE org_id = $2 AND work_claim_id = $4 AND subject_ref = $7)`,
    [randomUUID(), identity.orgId, parent, workClaimId, actor, identity.principalId,
      spawnSubjectRef(childTaskId), `spawned '${childTaskId}' under this claim`, JSON.stringify([`task:${childTaskId}`])]);
}

/**
 * THIS interval was judged rejected — the verification row's statement link (003: every
 * verification evaluates a RECORDED statement, and the statement names its claim), never a
 * clock comparison between a verdict and a claim. The one predicate every reader of "was
 * this claim rejected" spells (plan 2026-09-04, Leg A); when the upstream `rejected_at`
 * stamp lands (Leg S) this is the one line that changes.
 */
export function rejectedIntervalSql({ claim }) {
  return `EXISTS (SELECT 1 FROM cell.verification v
                    JOIN cell.agent_statement s
                      ON s.org_id = v.org_id AND s.task_id = v.task_id AND s.statement_id = v.statement_id
                   WHERE s.work_claim_id = ${claim}.work_claim_id AND v.result = 'rejected')`;
}

/**
 * The judge's live hold on `task`: its verify claim, active inside its lease at `asOf` (a SQL
 * expression — `now()`, or a bound parameter for a clock a caller injects). An active verify
 * claim past its lease is a judge that died without releasing, not a running one. The one
 * spelling of "a judgment is in flight" — the pager's busy and the board's `verifying` agree
 * by construction (UX rule 22).
 */
export function judgeHoldSql({ task, asOf }) {
  return `SELECT c.claimed_at FROM cell.work_claim c
           WHERE c.org_id = ${task}.org_id AND c.task_id = 'verify:' || ${task}.task_id
             AND c.state = 'active' AND c.settled_at IS NULL AND c.ownership_valid_until > ${asOf}
           ORDER BY c.claimed_at DESC LIMIT 1`;
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

/**
 * Every trace-link statement on a task, oldest first — evidence is the TASK's record,
 * spanning claims (a re-claim judged blind to its prior interval was a false rejection,
 * live 2026-09-04). The verifier reads it whole; the reclaim bundle shapes it in JS.
 */
export function taskTraceLinksSql() {
  return `SELECT subject_ref, evidence_refs FROM cell.agent_statement
           WHERE org_id = $1 AND task_id = $2 AND ${isTraceSubjectSql('subject_ref')}
           ORDER BY asserted_at`;
}

export function latestProgressSql({ task, claim }) {
  return `SELECT s.proposition, s.asserted_at FROM cell.agent_statement s
           WHERE s.org_id = ${task}.org_id AND s.task_id = ${task}.task_id
             AND s.work_claim_id = ${claim}.work_claim_id
             AND s.statement_type = 'progress' AND NOT (${isTraceSubjectSql('s.subject_ref')})
           ORDER BY s.asserted_at DESC LIMIT 1`;
}
