// oathe — the breach pager (R-PAGER): the session-start digest of promises BREACHED anywhere
// on this machine. Condition-based and stateless — three org-wide reads over facts the
// substrate already holds, no cursor, no read-state, no auto-yield; a breach repeats every
// session until its condition clears, because the condition is the fact.
//
//   overdue   a completion asserted and still unverified past its verify_by
//             (cell.unverified_past_verify_by — the R2 clock leg, at the injected instant)
//   reopened  a rejection nobody reclaimed: origin `reopened`, and the task's latest claim
//             predates its latest rejected verification (016's next claimant never came)
//   quiet     an active claim whose holder has said nothing (no non-trace progress statement)
//             for longer than pagerQuietHours — the claim itself counts as the first word
//
// A lapsed lease is lifecycle, not a breach. A task appears once, under its sharpest breach.
// Homes render as folders through the registry (raw ref when unregistered, `homeless` for
// a synthetic mint). The board renderers own the voice; this module owns the facts.

import { HomeBoard } from './home.mjs';
import { VERIFICATION_PREFIX } from './plans.mjs';
import { isEngineFailureSql, latestVerdictSql, latestProgressSql } from './statements.mjs';

export const BREACH_KINDS = Object.freeze(['overdue', 'reopened', 'quiet']);
export const HOMELESS_LABEL = 'homeless';
const STAMP = "'YYYY-MM-DD HH24:MI'";

export class Pager {
  /**
   * @param {{client: {query: Function}, identity: {orgId: string}, config: {get: Function},
   *          registry?: {get: Function}|null, clock?: () => Date}} o
   *   clock — the instant the digest reasons about; injected so a breach can be asserted at a
   *   stated time (a pager reading now() cannot be tested without waiting).
   */
  constructor({ client, identity, config, registry = null, clock = () => new Date() }) {
    this.client = client;
    this.orgId = identity.orgId;
    this.quietHours = config.get('pagerQuietHours');
    this.registry = registry;
    this.clock = clock;
  }

  /**
   * @returns {Promise<Array<{kind: 'overdue'|'reopened'|'quiet', task_id: string, objective: string,
   *                          home: string, detail: string, at: string}>>} kind-ordered, oldest first within a kind;
   *          `at` is the breach's own clock (UTC) — ages render from it, never from the sentence
   */
  async breaches() {
    const asOf = this.clock().toISOString();
    const overdue = await this.#overdue(asOf);
    const reopened = await this.#reopened();
    const stalled = await this.#stalled();
    const quiet = await this.#quiet(asOf);
    // A rejected-and-unreclaimed task is also "asserted past verify_by" — but the verdict
    // landed; what is breached is the reclaim. One line per task, the sharper fact wins —
    // and the SHARPEST kinds lead the list (ruling 2026-08-31): rejected and stalled work
    // needs a person; never-verified drains itself now that done dispatches its own
    // judgment. Every consumer (digest, splash, glass) inherits this one order.
    const reopenedIds = new Set(reopened.map((r) => r.task_id));
    const stalledIds = new Set(stalled.map((r) => r.task_id));
    return [...reopened, ...stalled,
      ...overdue.filter((r) => !reopenedIds.has(r.task_id) && !stalledIds.has(r.task_id)),
      ...quiet]
      .map(({ kind, task_id, objective, home, detail, at }) => ({ kind, task_id, objective, home: this.#homeLabel(home), detail, at }));
  }

  #homeLabel(ref) {
    if (ref === null || ref === undefined) return HOMELESS_LABEL;
    return this.registry?.rootOf(ref) ?? ref;
  }

  // Verification tasks never page on their own: their overdue IS the parent's overdue line.
  async #overdue(asOf) {
    // "Overdue" means exactly: an assertion NOBODY HAS JUDGED. A task whose latest claim
    // already received a verdict is a closed question — re-paging it as overdue invited
    // re-judgment of the same rejected assertion forever (the founder's live loop,
    // 2026-08-31). The substrate function stays the raw clock; this leg owns the meaning.
    const { rows } = await this.client.query(
      `SELECT 'overdue' AS kind, o.task_id, t.objective, ${HomeBoard.homeSql('t')} AS home,
              'verification overdue since ' || to_char(o.verify_by, ${STAMP}) AS detail,
              to_char(o.verify_by AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS at
         FROM cell.unverified_past_verify_by($2::timestamptz) o
         JOIN cell.task t ON t.org_id = o.org_id AND t.task_id = o.task_id
        WHERE o.org_id = $1 AND t.task_id NOT LIKE '${VERIFICATION_PREFIX}%'
          AND NOT EXISTS (
              SELECT 1 FROM cell.verification v
               WHERE v.org_id = o.org_id AND v.task_id = o.task_id
                 AND v.recorded_at > (SELECT max(c.claimed_at) FROM cell.work_claim c
                                       WHERE c.org_id = o.org_id AND c.task_id = o.task_id))
        ORDER BY o.verify_by, o.task_id`,
      [this.orgId, asOf]);
    return rows;
  }

  async #reopened() {
    // Pages while nobody is REDOING the work: no active claim, and no fresh assertion
    // since the last rejection. A reclaim silences it only while it stays active — a
    // reclaim-then-yield returns here (it used to flip to "overdue" and offer re-judgment
    // of the already-rejected assertion). The verdict rides WHOLE: the reason is one
    // sentence by the verdict contract; clipping is the renderer's business, not the data's.
    const { rows } = await this.client.query(
      `SELECT 'reopened' AS kind, t.task_id, t.objective, ${HomeBoard.homeSql('t')} AS home,
              coalesce(v.verdict || ' — ', '') || 'nobody has reclaimed it (last held by ' || w.principal_id || ')' AS detail,
              to_char(r.last_rejected AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS at
         FROM cell.task t
         JOIN LATERAL (
              SELECT max(v2.recorded_at) AS last_rejected FROM cell.verification v2
               WHERE v2.org_id = t.org_id AND v2.task_id = t.task_id AND v2.result = 'rejected'
         ) r ON r.last_rejected IS NOT NULL
            -- …and the rejection is the LAST WORD: a later acceptance is redemption —
            -- a settled task must never page as rejected again (caught on the founder's
            -- own glass: verified-and-settled rows still reading "rejected · continue").
            AND NOT EXISTS (
              SELECT 1 FROM cell.verification va
               WHERE va.org_id = t.org_id AND va.task_id = t.task_id
                 AND va.result <> 'rejected' AND va.recorded_at > r.last_rejected)
         JOIN LATERAL (
              SELECT c.principal_id, c.claimed_at FROM cell.work_claim c
               WHERE c.org_id = t.org_id AND c.task_id = t.task_id
               ORDER BY c.claimed_at DESC LIMIT 1
         ) w ON true
         LEFT JOIN LATERAL (${latestVerdictSql({ task: 't' })}) v ON true
        WHERE t.org_id = $1 AND t.origin = 'reopened'
          AND NOT EXISTS (
              SELECT 1 FROM cell.work_claim c2
               WHERE c2.org_id = t.org_id AND c2.task_id = t.task_id AND c2.settled_at IS NULL
                 AND (c2.state = 'active'
                      OR (c2.state = 'completion_asserted' AND c2.claimed_at > r.last_rejected)))
        ORDER BY w.claimed_at, t.task_id`,
      [this.orgId]);
    return rows;
  }

  // A verification whose engine died before a verdict (the run recorded the failure and
  // RELEASED its claim — ruling 2026-08-30): the promise is stalled on an engine, and the
  // page names the retry gesture on another one.
  async #stalled() {
    const { rows } = await this.client.query(
      `SELECT 'stalled' AS kind, substring(t.task_id from 8) AS task_id, p.objective,
              ${HomeBoard.homeSql('p')} AS home,
              'verification stalled — ' || left(s.proposition, 120)
                || '; retry: /oathe:verify ' || substring(t.task_id from 8) || ' <another engine>' AS detail,
              to_char(s.asserted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS at
         FROM cell.task t
         JOIN cell.task p ON p.org_id = t.org_id AND p.task_id = substring(t.task_id from 8)
         JOIN LATERAL (
              SELECT st.proposition, st.asserted_at FROM cell.agent_statement st
               WHERE st.org_id = t.org_id AND st.task_id = t.task_id
                 AND ${isEngineFailureSql('st.evidence_refs')}
               ORDER BY st.asserted_at DESC LIMIT 1
         ) s ON true
        WHERE t.org_id = $1 AND t.task_id LIKE 'verify:%'
          AND NOT EXISTS (SELECT 1 FROM cell.work_claim c
                           WHERE c.org_id = t.org_id AND c.task_id = t.task_id
                             AND (c.state = 'active' OR c.settled_at IS NOT NULL))
          AND s.asserted_at > coalesce((SELECT max(c2.claimed_at) FROM cell.work_claim c2
                                         WHERE c2.org_id = t.org_id AND c2.task_id = t.task_id
                                           AND c2.settled_at IS NOT NULL), 'epoch')
        ORDER BY s.asserted_at`,
      [this.orgId]);
    return rows;
  }

  async #quiet(asOf) {
    const { rows } = await this.client.query(
      `SELECT 'quiet' AS kind, t.task_id, t.objective, ${HomeBoard.homeSql('t')} AS home,
              w.principal_id || ' holds it, quiet for '
                || floor(extract(epoch FROM ($2::timestamptz - last.at)) / 3600)::int || 'h (last word '
                || to_char(last.at, ${STAMP}) || ')' AS detail,
              to_char(last.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS at
         FROM cell.work_claim w
         JOIN cell.task t USING (org_id, task_id)
         LEFT JOIN LATERAL (${latestProgressSql({ task: 't', claim: 'w' })}) p ON true
         CROSS JOIN LATERAL (SELECT coalesce(p.asserted_at, w.claimed_at) AS at) last
        WHERE w.org_id = $1 AND w.state = 'active' AND w.settled_at IS NULL
          AND last.at < $2::timestamptz - make_interval(hours => $3)
        ORDER BY last.at, t.task_id`,
      [this.orgId, asOf, this.quietHours]);
    return rows;
  }
}
