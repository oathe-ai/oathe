// oathe — where work lives (founder ruling 2026-09-05, superseding R-HOME-BOARD's fixed home).
// A PLACE is where a claim was picked up — a folder (a workspace ref) or an app (a surface with
// no folder, the ChatGPT desktop) — and every pickup records its place as a statement
// (statements.mjs linkPlace). A task is VISIBLE on the board of every place that ever picked it
// up (the history keeps the visibility R-HOME-BOARD's fixed home once protected), and it
// RESIDES where it was picked up last: that is where continue goes, where the verifier runs,
// and the word a row wears. A claim is picked up at a place or it is refused; a task no claim
// has picked up is UNCLAIMED. There is no third word. No rank, no adoption — the last pickup.
//
// Residence and places are DERIVED, never stored: the DDL is frozen, and a stored copy would
// drift from the record it summarizes. This module is the ONE owner of two grammars, in
// JavaScript and in SQL: the ledger's contract_ref (`workspace:<ws-ref|none>;contract:<org>/
// <task>@v1` — the substrate's own field, transcribed by 016/027; `none` says "this claim had
// no folder", which is an app pickup) and the place (`workspace:<ws-ref>` | `app:<surface>`).
// Nothing else in the tree builds, parses, or pattern-matches either.

import { VERIFICATION_PREFIX, verifiedTaskId } from './plans.mjs';
import { PLACE_SUBJECT_PREFIX } from './statements.mjs';

/** The ledger's token for a claim made from no folder (an app pickup) — a real ref is always `ws-<12hex>`, never this. */
export const NO_FOLDER = 'none';

const CONTRACT_VERSION = 'v1';
const GRAMMAR = /^workspace:([^;]+);contract:([^/]+)\/(.+)@v1$/;
const PLACE_GRAMMAR = /^(workspace|app):(.+)$/;

export class HomeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HomeError';
    this.code = code;
    this.details = details;
  }
}

/** A claim's contract reference: the folder it was made from (null = none) + the contract. */
export class ContractRef {
  /** @param {{workspace: string|null, orgId: string, taskId: string}} o */
  constructor({ workspace, orgId, taskId }) {
    this.workspace = workspace ?? null;
    this.orgId = orgId;
    this.taskId = taskId;
  }

  /** @param {string} text @returns {ContractRef} @throws {HomeError} OATHE_CONTRACT_REF_MALFORMED */
  static parse(text) {
    const match = GRAMMAR.exec(String(text));
    if (!match) {
      throw new HomeError('OATHE_CONTRACT_REF_MALFORMED',
        `contract_ref '${text}' does not follow workspace:<ws|${NO_FOLDER}>;contract:<org>/<task>@${CONTRACT_VERSION}`,
        { text });
    }
    const [, workspace, orgId, taskId] = match;
    return new ContractRef({ workspace: workspace === NO_FOLDER ? null : workspace, orgId, taskId });
  }

  /** A folder claim; false for an app pickup (the ledger's `none`). */
  get hasFolder() {
    return this.workspace !== null;
  }

  toString() {
    return `workspace:${this.workspace ?? NO_FOLDER};contract:${this.orgId}/${this.taskId}@${CONTRACT_VERSION}`;
  }
}

/**
 * Where a claim was picked up: a folder (`workspace:<ws-ref>`) or an app (`app:<surface>` —
 * the surface name the adapter gives it, e.g. `chatgpt`). A value object; the statement's
 * subject is `place:` + this string (statements.mjs owns the subject prefix).
 */
export class Place {
  /** @param {{kind: 'workspace'|'app', ref: string}} o */
  constructor({ kind, ref }) {
    this.kind = kind;
    this.ref = ref;
  }

  static workspace(ref) {
    return new Place({ kind: 'workspace', ref });
  }

  static app(surface) {
    return new Place({ kind: 'app', ref: surface });
  }

  /** @throws {HomeError} OATHE_PLACE_MALFORMED — a place is a folder ref or an app surface, never the ledger's token */
  static parse(text) {
    const match = PLACE_GRAMMAR.exec(String(text));
    if (!match || (match[1] === 'workspace' && match[2] === NO_FOLDER)) {
      throw new HomeError('OATHE_PLACE_MALFORMED',
        `place '${text}' does not follow workspace:<ws-ref> | app:<surface>`, { text });
    }
    return new Place({ kind: match[1], ref: match[2] });
  }

  /** A row that has no place is null — never a throw. */
  static parseOrNull(text) {
    return text === null || text === undefined ? null : Place.parse(text);
  }

  get isFolder() {
    return this.kind === 'workspace';
  }

  toString() {
    return `${this.kind}:${this.ref}`;
  }
}

/**
 * What a pickup KNOWS beside its place, each only when known: the app bundle it was spoken from,
 * the device, and — for an app pickup — the project folder the app ran in (the ChatGPT project's
 * staging dir, where its files are; never a place to resume into). One grammar (`app:`,
 * `device:`, `dir:`), one writer, one parser; a row reads it back as place_app/place_device/place_dir.
 */
const EVIDENCE_PREFIX = Object.freeze({ app: 'app:', device: 'device:', dir: 'dir:' });

export class PlaceEvidence {
  /** @param {{app?: string|null, device?: string|null, dir?: string|null}} o */
  constructor({ app = null, device = null, dir = null } = {}) {
    this.app = app;
    this.device = device;
    this.dir = dir;
  }

  /** The evidence refs a place statement carries — the known facts only, never a null string. */
  get refs() {
    return Object.entries(EVIDENCE_PREFIX).flatMap(([key, prefix]) => (this[key] ? [`${prefix}${this[key]}`] : []));
  }

  /** The refs of a place statement back to facts; refs of another grammar are ignored. */
  static parse(refs) {
    const list = Array.isArray(refs) ? refs : [];
    const pick = (prefix) => list.find((r) => typeof r === 'string' && r.startsWith(prefix))?.slice(prefix.length) ?? null;
    return new PlaceEvidence({ app: pick(EVIDENCE_PREFIX.app), device: pick(EVIDENCE_PREFIX.device), dir: pick(EVIDENCE_PREFIX.dir) });
  }

  /** The row shape every surface reads (the pager, the board, the glass). */
  row() {
    return { place_app: this.app, place_device: this.device, place_dir: this.dir };
  }
}

/**
 * The PICKUP: where a surface picks work up and what it knows — computed once per surface, recorded
 * on every claim and re-seat (ruling 2026-09-05). A folder session picks up at its workspace (the
 * folder is the registry's fact, not evidence); an app session (a synthetic dir, or no folder at
 * all) picks up at `app:<surface>` and records the project dir it ran in; a surface with neither
 * has no place, and `require()` refuses a claim from it. A system task (a judgment, an update)
 * never records a place: it lives where its work does.
 */
export class Pickup {
  /** @param {{place: Place|null, evidence: PlaceEvidence}} o */
  constructor({ place, evidence }) {
    this.place = place;
    this.evidence = evidence;
  }

  static of({ workspace = null, synthetic = false, dir = null, speaker = null } = {}) {
    const folder = !synthetic && workspace ? Place.workspace(workspace) : null;
    const app = folder === null && speaker?.surface ? Place.app(speaker.surface) : null;
    return new Pickup({
      place: folder ?? app,
      evidence: new PlaceEvidence({ app: speaker?.app?.bundle ?? null, device: speaker?.device ?? null, dir: app !== null ? dir : null }),
    });
  }

  /** @throws {HomeError} OATHE_PLACE_UNKNOWN — a claim is picked up somewhere, or it is refused before anything is written */
  require(taskId) {
    if (this.place === null) {
      throw new HomeError('OATHE_PLACE_UNKNOWN',
        `a claim is picked up somewhere — a folder session or an app — and this surface named neither; `
        + `speak it from a harness session on a project folder or from the desktop app (task '${taskId}')`, { task_id: taskId });
    }
    return this.place;
  }
}

/**
 * The place rule projected into SQL so the board, the pager, and the verifier never
 * re-implement it: `residenceSql` is the LAST pickup (a LATERAL body yielding `place` and
 * `place_evidence`), `placesSql` every pickup (a scalar text[] of place strings). Both anchor
 * a verification task on its parent — the judgment lives where the work does.
 *
 * A pickup is read from ONE record: the place statement every claim records at the pickup
 * (statements.mjs linkPlace). The ledger's `contract_ref` slot still carries the claim's folder
 * (or `none`) because the substrate's verbs transcribe it, but nothing derives a place from it —
 * a claim with no place statement does not exist (zero legacy, founder 2026-09-05: records from
 * before the statement were removed from the machine, never inferred).
 */
export class HomeBoard {
  /** The task whose record decides `taskId`'s place: itself, or its parent for a verification task. */
  static anchorTaskId(taskId) {
    return verifiedTaskId(taskId) ?? taskId;
  }

  static #anchorSql(t) {
    return `CASE WHEN ${t}.task_id LIKE '${VERIFICATION_PREFIX}%'
                 THEN substr(${t}.task_id, ${VERIFICATION_PREFIX.length + 1})
                 ELSE ${t}.task_id END`;
  }

  /**
   * Every pickup of the anchored task — the place statements, and nothing else (place,
   * place_evidence, at). The ledger's `contract_ref` slot is NOT read as a pickup: every claim
   * records its place as a statement at the pickup, and a claim without one does not exist
   * (zero legacy, founder 2026-09-05 — records from before the statement were removed, never inferred).
   */
  static #pickupsSql(t) {
    return `SELECT substr(s.subject_ref, ${PLACE_SUBJECT_PREFIX.length + 1}) AS place, s.evidence_refs AS place_evidence, s.asserted_at AS at
              FROM cell.agent_statement s
             WHERE s.org_id = ${t}.org_id AND s.task_id = ${HomeBoard.#anchorSql(t)}
               AND s.subject_ref LIKE '${PLACE_SUBJECT_PREFIX}%'`;
  }

  /** LATERAL body: the residence — the latest pickup's place text and its evidence (app, device). */
  static residenceSql(taskAlias) {
    return `SELECT pickup.place, pickup.place_evidence
              FROM (${HomeBoard.#pickupsSql(taskAlias)}) pickup
             ORDER BY pickup.at DESC LIMIT 1`;
  }

  /** Scalar subquery: every place that ever picked the task up, as place strings (text[], never NULL). */
  static placesSql(taskAlias) {
    return `(SELECT coalesce(array_agg(DISTINCT pickup.place), '{}'::text[])
               FROM (${HomeBoard.#pickupsSql(taskAlias)}) pickup)`;
  }
}
