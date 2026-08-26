// oathe — the session host: the ONE new runtime semantic this package adds. An interactive
// session holds its leases exactly as long as its cage demonstrably holds a live process.
//
// The rule, stated once: renewal follows LIVENESS, not hope. Each tick asks the injected
// liveness probe (the cage's enumerate(), kernel-read); a live cage renews every active lease
// this principal holds in this workspace; a dead one stops the loop and touches NOTHING —
// R10: an absence is an absence. No statement is fabricated for a death nobody witnessed;
// the lease simply stops being renewed and `oathe ls` shows it running out. Only a CLEAN exit
// speaks: stop({exitCode}) records the exit statement, because the exit was actually observed.

import crypto from 'node:crypto';



export class SessionHost {
  /**
   * @param {{client: {query: Function}, identity: {orgId: string, principalId: string},
   *          workspace: string, liveness: () => boolean, renewIntervalMs?: number}} o
   */
  constructor({ client, identity, workspace, liveness, renewIntervalMs = 60_000, leaseHours = 4 }) {
    this.leaseHours = leaseHours;
    this.client = client;
    this.identity = identity;
    this.workspace = workspace;
    this.liveness = liveness;
    this.renewIntervalMs = renewIntervalMs;
    this.running = false;
    this.timer = null;
    this.tickInFlight = Promise.resolve();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => { this.tickInFlight = this.#tick(); }, this.renewIntervalMs);
    this.timer.unref?.();
  }

  async #tick() {
    let alive;
    try {
      alive = this.liveness() === true;
    } catch {
      alive = false; // "I cannot tell" is not "it is alive"
    }
    if (!alive) {
      this.#halt();
      return;
    }
    try {
      await this.client.query(
        `UPDATE cell.work_claim
            SET ownership_valid_until = now() + make_interval(hours => $4)
          WHERE org_id = $1 AND principal_id = $2 AND state = 'active'
            AND contract_ref LIKE $3`,
        [this.identity.orgId, this.identity.principalId, `workspace:${this.workspace};%`, this.leaseHours]);
    } catch {
      // A failed renewal is not a death: the next tick tries again; expiry stays the substrate's
      // honest answer if the failures persist.
    }
  }

  #halt() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  /** Stop without a word — the killed-cage path and test teardown. */
  async stopSilently() {
    this.#halt();
    await this.tickInFlight;
  }

  /** The observed clean exit: stop renewing AND say so on every claim this session held. */
  async stop({ exitCode }) {
    this.#halt();
    await this.tickInFlight;
    const { rows } = await this.client.query(
      `SELECT work_claim_id, task_id FROM cell.work_claim
        WHERE org_id = $1 AND principal_id = $2 AND state = 'active' AND contract_ref LIKE $3`,
      [this.identity.orgId, this.identity.principalId, `workspace:${this.workspace};%`]);
    for (const claim of rows) {
      await this.client.query(
        `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
                execution_actor, claim_principal, statement_type, subject_ref, proposition,
                evidence_refs, epistemic_status, asserted_at)
         VALUES ($1, $2, $3, $4, 'oathe-session-host', $5, 'progress', $6,
                 $7, '["session:exit"]'::jsonb, 'observed', now())`,
        [crypto.randomUUID(), this.identity.orgId, claim.task_id, claim.work_claim_id,
          this.identity.principalId, `task:${claim.task_id}`,
          `session ended (exit ${exitCode}) with this claim still held — the lease will expire `
          + 'unless the work is picked up or yielded']);
    }
  }
}
