// oathe — SqlAcceptanceLane: the standalone provider's settlement path. The documented
// SQL-equivalent of the estate lane: our own deterministic clause discharge, then
// INSERT cell.verification + cell.settle_work_claim in ONE transaction (now() =
// transaction_timestamp keeps FC113/FC114 by equality). The substrate's triggers remain the
// enforcement — this lane is a caller, not an authority: it never writes settled_at itself
// (FC110), never edits a frozen plan (FC160), and blocks whenever the law is not plainly met.
// cell.verification_clause (the optional clause object) is deliberately not written.

import crypto from 'node:crypto';

import { dischargeClause } from './discharge.mjs';
import { RuntimeError } from './provider.mjs';

export const SETTLE = Object.freeze({ CLAIM: 'claim' });

export class SqlAcceptanceLane {
  constructor({ pool, orgId, seatPrincipal, specs }) {
    this.pool = pool;
    this.orgId = orgId;
    this.seatPrincipal = seatPrincipal;
    this.specs = specs;
  }

  /** The seat law (026): registered roster, and never the author or executor (pre-FC010). */
  async #seatBlocked(clause) {
    const { rows } = await this.pool.query(
      'SELECT seats FROM cell.acceptance_authority WHERE org_id = $1', [this.orgId]);
    if (rows.length === 0) {
      return `no acceptance authority is registered for org '${this.orgId}' — an absent row is not lawful`;
    }
    if (!rows[0].seats.includes(this.seatPrincipal)) {
      return `'${this.seatPrincipal}' is not in the registered seats roster [${rows[0].seats.join(', ')}]`;
    }
    if (this.seatPrincipal === clause.author_principal
      || this.seatPrincipal === clause.executor_principal) {
      return `'${this.seatPrincipal}' authored or executed the statement under evaluation — `
        + 'verification is non-author only (FC010)';
    }
    return null;
  }

  async verify({ agent_statement, task_id, clause }, { settle }) {
    const blockedBySeat = await this.#seatBlocked(clause);
    if (blockedBySeat) {
      return { settled: false, verification: { verdict: 'blocked', reason: blockedBySeat } };
    }
    const outcome = dischargeClause({
      statement: agent_statement, clause, spec: this.specs[clause.clause_key] });
    if (outcome.verdict === 'blocked') {
      return { settled: false, verification: { verdict: 'blocked', reason: outcome.reason } };
    }

    const client = await this.pool.connect();
    const verificationId = crypto.randomUUID();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO cell.verification
           (verification_id, org_id, task_id, statement_id, source, result,
            verifier_principal, verifier_type, verification_plan_ref, checks,
            evidence_refs, trace_ref, privacy_class, transfer_scope, state_version, recorded_at)
         VALUES ($1, $2, $3, $4, 'acceptance_package', $5, $6, 'seat', $7,
                 $8::jsonb, $9::jsonb, $10, $11, $12, NULL, now())`,
        [verificationId, this.orgId, task_id, agent_statement.statement_ref,
          outcome.verdict === 'accepted' ? 'verified' : 'rejected',
          this.seatPrincipal, clause.clause_key,
          JSON.stringify(outcome.checks), JSON.stringify(clause.evidence_refs),
          clause.trace_ref, clause.privacy_class, clause.transfer_scope]);
      let settled = false;
      if (outcome.verdict === 'accepted' && settle === SETTLE.CLAIM) {
        const { rows } = await client.query(
          'SELECT cell.settle_work_claim($1, now()) AS settled',
          [agent_statement.work_claim_id]);
        settled = rows[0].settled === true;
      }
      await client.query('COMMIT');
      return { settled,
        verification: { verdict: outcome.verdict, reason: outcome.reason ?? null,
          verification_id: verificationId } };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw new RuntimeError('OATHE_SETTLEMENT_REFUSED',
        `the substrate refused the settlement: ${String(e?.message || e)}`,
        { sqlstate: e?.code ?? null, task_id });
    } finally {
      client.release();
    }
  }
}
