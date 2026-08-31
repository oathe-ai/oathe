// oathe — the home board (ruling R-HOME-BOARD, PLAN.md 2026-08-28). A task's board is the
// workspace of the EARLIEST claim that named a real folder; every later claim inherits it and
// never restamps it, so cross-surface pickup cannot drag a task off its repo's board. Tasks
// minted from a synthetic workspace (a ChatGPT-desktop staging dir) are HOMELESS until a real
// folder claims — adopts — them; a verification task lives wherever its parent lives.
//
// Home is DERIVED from the claim ledger, never stored: the DDL is frozen, and a stored copy
// would drift from the ledger it summarizes. This module is the ONE owner of the contract_ref
// grammar (`workspace:<ws-ref|none>;contract:<org>/<task>@v1`) in both JavaScript and SQL —
// nothing else in the tree builds, parses, or pattern-matches a contract_ref.

import { VERIFICATION_PREFIX, verifiedTaskId } from './plans.mjs';

/** The workspace token of a homeless claim — a real ref is always `ws-<12hex>`, never this. */
export const HOMELESS = 'none';

const CONTRACT_VERSION = 'v1';
const GRAMMAR = /^workspace:([^;]+);contract:([^/]+)\/(.+)@v1$/;

export class HomeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HomeError';
    this.code = code;
    this.details = details;
  }
}

/** A claim's contract reference: the workspace it is homed on (null = homeless) + the contract. */
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
        `contract_ref '${text}' does not follow workspace:<ws|${HOMELESS}>;contract:<org>/<task>@${CONTRACT_VERSION}`,
        { text });
    }
    const [, workspace, orgId, taskId] = match;
    return new ContractRef({ workspace: workspace === HOMELESS ? null : workspace, orgId, taskId });
  }

  get isHomeless() {
    return this.workspace === null;
  }

  toString() {
    return `workspace:${this.workspace ?? HOMELESS};contract:${this.orgId}/${this.taskId}@${CONTRACT_VERSION}`;
  }
}

/**
 * The home derivation over the claim ledger. `of(taskId)` answers from the database; `homeSql`
 * projects the same rule into a query so the board never re-implements it.
 */
export class HomeBoard {
  /** @param {{client: {query: Function}, orgId: string}} o */
  constructor({ client, orgId }) {
    this.client = client;
    this.orgId = orgId;
  }

  /** The task whose ledger decides `taskId`'s home: itself, or its parent for a verification task. */
  static anchorTaskId(taskId) {
    return verifiedTaskId(taskId) ?? taskId;
  }

  /** The LIKE pattern every homeless claim matches — the sentinel, spelled once. */
  static get homelessPattern() {
    return `workspace:${HOMELESS};%`;
  }

  /**
   * SQL scalar subquery: the home workspace ref (or NULL) of the task row aliased `taskAlias`.
   * The verification-prefix anchor and the sentinel exclusion derive from the JS constants —
   * one owner, two languages.
   */
  static homeSql(taskAlias) {
    const t = taskAlias;
    return `(SELECT split_part(split_part(c.contract_ref, ';', 1), ':', 2)
               FROM cell.work_claim c
              WHERE c.org_id = ${t}.org_id
                AND c.task_id = CASE WHEN ${t}.task_id LIKE '${VERIFICATION_PREFIX}%'
                                     THEN substr(${t}.task_id, ${VERIFICATION_PREFIX.length + 1})
                                     ELSE ${t}.task_id END
                AND c.contract_ref NOT LIKE '${HomeBoard.homelessPattern}'
              ORDER BY c.claimed_at ASC LIMIT 1)`;
  }

  /** @returns {Promise<string|null>} the home workspace ref, or null when homeless/unclaimed */
  async of(taskId) {
    const { rows } = await this.client.query(
      `SELECT split_part(split_part(contract_ref, ';', 1), ':', 2) AS workspace
         FROM cell.work_claim
        WHERE org_id = $1 AND task_id = $2 AND contract_ref NOT LIKE $3
        ORDER BY claimed_at ASC LIMIT 1`,
      [this.orgId, HomeBoard.anchorTaskId(taskId), HomeBoard.homelessPattern]);
    return rows[0]?.workspace ?? null;
  }
}
