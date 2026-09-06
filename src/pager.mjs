// oathe — the breach pager (R-PAGER): the session-start digest of promises BREACHED anywhere
// on this machine. Condition-based and stateless — four org-wide reads over facts the
// substrate already holds, no cursor, no read-state, no auto-yield; a breach repeats every
// session until its condition clears, because the condition is the fact.
//
//   reopened  a rejection nobody reclaimed: origin `reopened`, and the task's latest claim
//             predates its latest rejected verification (016's next claimant never came)
//   stalled   a verification that died before a verdict (engine or evidence) and released
//             its claim — the promise waits on a retry
//   overdue   a completion asserted and still unverified past its verify_by
//             (cell.unverified_past_verify_by — the R2 clock leg, at the injected instant)
//   quiet     an active claim whose holder has said nothing (no non-trace progress statement)
//             for longer than pagerQuietHours — the claim itself counts as the first word
//
// A lapsed lease is lifecycle, not a breach. A task appears once, under its sharpest breach;
// the kinds, their sharpness order (BREACH_KINDS) and the ONE comparator (breachOrder) live
// with the digest (src/breach-digest.mjs) and are re-exported here beside the facts. Where a
// breach lives renders as its residence: a folder through the registry (raw ref when
// unregistered), an app by its display word; the raw place rides beside the label. The data is whole — a verdict or
// an engine's words are never clipped here; clipping is the renderer's business. This
// module owns the facts, not the voice; `digest()` hands them to the one budget.

import { HomeBoard, HomeError, Place, PlaceEvidence } from './home.mjs';
import { SYSTEM_TASKS, isSystemTaskSql } from './plans.mjs';
import { IN_FLIGHT } from './breach-digest.mjs';
import {
  holdSql, isUpdateFailureSql, isVerifyStallSql, latestVerdictSql, parseEngineFailure, latestProgressSql, rejectedIntervalSql,
  spawnParentSql,
} from './statements.mjs';
import { displayFor, verifierCapable } from './harnesses/catalog.mjs';
import { BreachDigest, breachOrder } from './breach-digest.mjs';

export { BREACH_KINDS, breachOrder } from './breach-digest.mjs';
const STAMP = "'YYYY-MM-DD HH24:MI'";

/**
 * A stall's detail: the verify child's own failure words, whole, behind the retry gesture.
 * Config wins at every verify (ruling 2026-09-04), so the gesture is decided by ONE question:
 * would a plain retry hit the same dead engine? Only when the engine that died IS the
 * configured verifier — then the act is the config change, naming a concrete other engine
 * from the catalog, and the retry after it. Any other stall (a record that would fail every
 * engine alike, or a death on an override engine the config no longer points at) is a plain
 * retry. The failed engine is read from the stall statement's fixed opening
 * (`engine <name> failed…`, src/verifier.mjs) — the one place that wording is minted. The
 * kind word ("verify failed") rides beside every rendering of this detail, so the detail does
 * not repeat it; the gesture leads, so a renderer's clip only ever shortens the engine's words.
 */
function stallDetail({ task_id, proposition, engine, cause, update_failure, verifier }) {
  // The cause (ruling 2026-09-05) names the honest gesture: an out-of-date engine is UPDATED (the
  // glass's update ↗ runs it; the last failed update rides beside, so a click that did not help
  // says why); an unreachable one is re-addressed by oathe init. Neither is "another verifier".
  if (cause === 'outdated') {
    const name = displayFor(engine) ?? engine;
    return `${name} is out of date — update it and the judgment re-runs: oathe engine update ${engine}`
      + `${update_failure ? ` — last update failed: ${update_failure}` : ''} — ${proposition}`;
  }
  if (cause === 'missing') {
    return `${displayFor(engine) ?? engine} is not reachable from this process — run oathe init to record its address, `
      + `then /oathe:verify ${task_id} — ${proposition}`;
  }
  if (engine !== null && engine === verifier) {
    const other = verifierCapable().find((e) => e !== engine);
    return `set another verifier: oathe config verifier ${other}, then /oathe:verify ${task_id} — ${proposition}`;
  }
  return `retry: /oathe:verify ${task_id} — ${proposition}`;
}

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
    this.verifier = config.get('verifier'); // the engine a plain retry would run — the stall gesture's one question
    this.registry = registry;
    this.clock = clock;
  }

  /**
   * @returns {Promise<Array<{kind: 'reopened'|'stalled'|'overdue'|'quiet', task_id: string,
   *                          objective: string, home: string, home_ref: string|null, detail: string,
   *                          at: string, busy: boolean}>>} in breachOrder; `at` is the breach's own
   *          clock (UTC) — ages render from it, never from the sentence; `busy` says a system
   *          claim is held for this row right now — the judge's `verify:`, or the machine's
   *          `update:<engine>` on a stall that names that engine out of date — with `busy_word`/
   *          `busy_detail` from IN_FLIGHT (then `at` is that hold's start); `engine`/`cause` ride
   *          a stall; `home_ref` is the raw ref a digest scopes on, `home` the folder a person reads
   */
  async breaches() {
    const asOf = this.clock().toISOString();
    const overdue = await this.#overdue(asOf);
    const reopened = await this.#reopened();
    const stalled = await this.#stalled();
    const quiet = await this.#quiet(asOf);
    const flight = await this.inFlight(asOf);
    // A rejected-and-unreclaimed or stalled task is also "asserted past verify_by" — but the
    // verdict (or the attempt at one) landed; what is breached is the reclaim or the retry.
    // One row per task, the sharper fact wins; the order is breachOrder's, nowhere else's.
    const judged = new Set([...reopened, ...stalled].map((r) => r.task_id));
    return [...reopened, ...stalled, ...overdue.filter((r) => !judged.has(r.task_id)), ...quiet]
      .map(({ kind, task_id, objective, place, place_evidence, places, detail, at, parent, parent_objective, engine = null, cause = null }) => {
        // Busy is a state ON the breach, never a fifth kind (rulings 2026-09-04/05): a system
        // claim is held for this row — a judge on verify:<task>, or the machine on update:<engine>
        // when the stall names that engine out of date — so the row keeps its kind (the overdue
        // leg stays suppressed, no "never verified" twin), wears IN_FLIGHT's word, and its clock
        // becomes the hold's start. The stale failure it wore is the digest's to drop.
        const judge = flight.verify.get(task_id);
        const updating = kind === 'stalled' && cause === 'outdated' ? flight.update.get(engine) : undefined;
        const name = displayFor(engine) ?? engine;
        const hold = judge !== undefined ? { at: judge, word: IN_FLIGHT.verify.word, detail: IN_FLIGHT.verify.detail }
          : updating !== undefined ? { at: updating, word: IN_FLIGHT.update.word(name), detail: IN_FLIGHT.update.detail(name) }
            : null;
        // Where it lives (ruling 2026-09-05): the residence (last pickup) wears the word; every
        // place that ever picked it up scopes it (BreachDigest.scoped).
        const residence = Place.parseOrNull(place ?? null);
        return {
          kind, task_id, objective, detail,
          home: this.#homeLabel(residence), home_ref: residence?.isFolder ? residence.ref : null,
          place: residence ? String(residence) : null, places: places ?? [], ...PlaceEvidence.parse(place_evidence).row(),
          at: hold?.at ?? at, busy: hold !== null, busy_word: hold?.word ?? null, busy_detail: hold?.detail ?? null,
          engine, cause,
          parent: parent ?? null, parent_objective: parent_objective ?? null,
        };
      })
      .sort(breachOrder);
  }

  /** The residence and every place, as the four legs select them — one spelling of the columns. */
  static #placeColumns(taskAlias) {
    return `res.place, res.place_evidence, ${HomeBoard.placesSql(taskAlias)} AS places`;
  }

  static #placeJoin(taskAlias) {
    return `LEFT JOIN LATERAL (${HomeBoard.residenceSql(taskAlias)}) res ON true`;
  }

  /**
   * The system claims IN FLIGHT at `asOf` — the ONE map (UX rule 22): `verify` — a judge holding
   * `verify:<task>` inside its lease (task → start), so the task's breach is busy and the board's
   * `verifying` judgment is the same fact through the same SQL (holdSql); `update` — the machine
   * holding `update:<engine>` (engine → start), so every stall naming that engine out of date is
   * busy "updating". An active claim past its lease is a holder that died without releasing —
   * not a running one; the underlying breach shows again, with its own clock.
   * @returns {Promise<{verify: Map<string, string>, update: Map<string, string>}>} starts in UTC
   */
  async inFlight(asOf) {
    const held = async (kind, subjectSql, where) => new Map((await this.client.query(
      `SELECT ${subjectSql} AS subject, to_char(j.claimed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS at
         FROM cell.task t
         JOIN LATERAL (${holdSql({ kind, orgId: 't.org_id', subject: subjectSql, asOf: '$2::timestamptz' })}) j ON true
        WHERE t.org_id = $1 AND ${where}`,
      [this.orgId, asOf])).rows.map((r) => [r.subject, r.at]));
    return {
      verify: await held('verify', 't.task_id', `NOT ${isSystemTaskSql('t.task_id')}`),
      update: await held('update', `substr(t.task_id, ${SYSTEM_TASKS.update.length + 1})`, `t.task_id LIKE '${SYSTEM_TASKS.update}%'`),
    };
  }


  /** The one budget over the facts — every surface that shows a breach renders this. */
  async digest() {
    return new BreachDigest({ breaches: await this.breaches() });
  }

  /** The word a place wears: a folder through the registry (else its raw ref), an app by the
   *  adapter's display word (else the surface). A breach is a claim's, and every claim has a
   *  place — a residence-less breach is a broken record, said loudly, never a third word. */
  #homeLabel(residence) {
    if (residence === null) {
      throw new HomeError('OATHE_PLACE_UNKNOWN', 'a breached claim has no recorded place — the record is broken (every pickup records one)');
    }
    if (residence.isFolder) return this.registry?.rootOf(residence.ref) ?? residence.ref;
    return displayFor(residence.ref) ?? residence.ref;
  }

  // Verification tasks never page on their own: their overdue IS the parent's overdue line.
  async #overdue(asOf) {
    // "Overdue" means exactly: an assertion NOBODY HAS JUDGED. A task whose latest claim
    // already received a verdict is a closed question — re-paging it as overdue invited
    // re-judgment of the same rejected assertion forever (the founder's live loop,
    // 2026-08-31). The substrate function stays the raw clock; this leg owns the meaning.
    const { rows } = await this.client.query(
      `SELECT 'overdue' AS kind, o.task_id, t.objective, ${Pager.#placeColumns('t')},
              'verification overdue since ' || to_char(o.verify_by, ${STAMP}) AS detail,
              to_char(o.verify_by AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS at,
              sp.parent_task_id AS parent, sp.parent_objective
         FROM cell.unverified_past_verify_by($2::timestamptz) o
         JOIN cell.task t ON t.org_id = o.org_id AND t.task_id = o.task_id
         LEFT JOIN LATERAL (${spawnParentSql({ task: 't' })}) sp ON true
         ${Pager.#placeJoin('t')}
        WHERE o.org_id = $1 AND NOT ${isSystemTaskSql('t.task_id')}
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
    // Pages while nobody is REDOING the work: no active claim, and no unjudged assertion
    // standing (an asserted interval the rejection was NOT over — rejectedIntervalSql, the
    // interval-exact fact, never a clock). A reclaim silences it only while it stays active —
    // a reclaim-then-yield returns here, never to "overdue" (the rejected assertion is not
    // owed a second judgment). The verdict rides WHOLE: the reason is one
    // sentence by the verdict contract; clipping is the renderer's business, not the data's.
    const { rows } = await this.client.query(
      `SELECT 'reopened' AS kind, t.task_id, t.objective, ${Pager.#placeColumns('t')},
              coalesce(v.verdict || ' — ', '') || 'nobody has reclaimed it (last held by ' || w.principal_id || ')' AS detail,
              to_char(r.last_rejected AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS at,
              sp.parent_task_id AS parent, sp.parent_objective
         FROM cell.task t
         LEFT JOIN LATERAL (${spawnParentSql({ task: 't' })}) sp ON true
         ${Pager.#placeJoin('t')}
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
                      OR (c2.state = 'completion_asserted' AND NOT ${rejectedIntervalSql({ claim: 'c2' })})))
        ORDER BY w.claimed_at, t.task_id`,
      [this.orgId]);
    return rows;
  }

  // A verification that died before a verdict (the run recorded the failure and RELEASED its
  // claim — ruling 2026-08-30): the promise is stalled, and the page names the retry gesture.
  // Only an ENGINE-stage death advises another engine — a CONCRETE one, asked of the catalog
  // — because an unreadable record (evidence stage) fails every engine alike, so its retry is
  // the same command after the cause is fixed. The engine's own words ride whole.
  async #stalled() {
    const { rows } = await this.client.query(
      `SELECT 'stalled' AS kind, substring(t.task_id from 8) AS task_id, p.objective,
              ${Pager.#placeColumns('p')}, s.proposition, s.failure_ref, uf.update_failure,
              to_char(s.asserted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS at,
              sp.parent_task_id AS parent, sp.parent_objective
         FROM cell.task t
         JOIN cell.task p ON p.org_id = t.org_id AND p.task_id = substring(t.task_id from 8)
         LEFT JOIN LATERAL (${spawnParentSql({ task: 'p' })}) sp ON true
         ${Pager.#placeJoin('p')}
         JOIN LATERAL (
              SELECT st.proposition, st.asserted_at,
                     (SELECT er FROM jsonb_array_elements_text(st.evidence_refs) er WHERE er LIKE 'engine-failure:%' LIMIT 1) AS failure_ref
                FROM cell.agent_statement st
               WHERE st.org_id = t.org_id AND st.task_id = t.task_id
                 AND ${isVerifyStallSql('st.evidence_refs')}
               ORDER BY st.asserted_at DESC LIMIT 1
         ) s ON true
         -- The last FAILED update of the engine the stall names (its update:<engine> task's
         -- statement) — a person who clicked update ↗ sees why it did not help.
         LEFT JOIN LATERAL (
              SELECT u.proposition AS update_failure
                FROM cell.agent_statement u
               WHERE u.org_id = t.org_id AND u.task_id = '${SYSTEM_TASKS.update}' || split_part(s.failure_ref, ':', 2)
                 AND ${isUpdateFailureSql('u.evidence_refs')}
               ORDER BY u.asserted_at DESC LIMIT 1
         ) uf ON true
        WHERE t.org_id = $1 AND t.task_id LIKE 'verify:%'
          -- A settled verify claim closes the stall. An ACTIVE one does not hide it: that is a
          -- retry in flight, rendered busy (breaches()) — hiding it here let the overdue leg
          -- re-surface the task as "never verified" mid-retry (live 2026-09-04).
          AND NOT EXISTS (SELECT 1 FROM cell.work_claim c
                           WHERE c.org_id = t.org_id AND c.task_id = t.task_id
                             AND c.settled_at IS NOT NULL)
          AND s.asserted_at > coalesce((SELECT max(c2.claimed_at) FROM cell.work_claim c2
                                         WHERE c2.org_id = t.org_id AND c2.task_id = t.task_id
                                           AND c2.settled_at IS NOT NULL), 'epoch')
        ORDER BY s.asserted_at`,
      [this.orgId]);
    return rows.map(({ proposition, failure_ref, update_failure, ...row }) => {
      const { engine, cause } = parseEngineFailure(failure_ref) ?? { engine: null, cause: null };
      return { ...row, engine, cause, update_failure: update_failure ?? null, detail: stallDetail({ ...row, proposition, engine, cause, update_failure, verifier: this.verifier }) };
    });
  }

  async #quiet(asOf) {
    const { rows } = await this.client.query(
      `SELECT 'quiet' AS kind, t.task_id, t.objective, ${Pager.#placeColumns('t')},
              w.principal_id || ' holds it, quiet for '
                || floor(extract(epoch FROM ($2::timestamptz - last.at)) / 3600)::int || 'h (last word '
                || to_char(last.at, ${STAMP}) || ')' AS detail,
              to_char(last.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS at,
              sp.parent_task_id AS parent, sp.parent_objective
         FROM cell.work_claim w
         JOIN cell.task t USING (org_id, task_id)
         LEFT JOIN LATERAL (${spawnParentSql({ task: 't' })}) sp ON true
         ${Pager.#placeJoin('t')}
         LEFT JOIN LATERAL (${latestProgressSql({ task: 't', claim: 'w' })}) p ON true
         CROSS JOIN LATERAL (SELECT coalesce(p.asserted_at, w.claimed_at) AS at) last
        WHERE w.org_id = $1 AND w.state = 'active' AND w.settled_at IS NULL
          AND last.at < $2::timestamptz - make_interval(hours => $3)
        ORDER BY last.at, t.task_id`,
      [this.orgId, asOf, this.quietHours]);
    return rows;
  }
}
