// oathe — the allocated-on-demand verifier (the ruled form: an agent evaluator is allocated
// per obligation, never a standing grader; D0:48 "the runtime never being an agent grading
// agents" stays intact because the AGENT only produces EVIDENCE — every settlement is signed
// by a deterministic acceptance lane under a non-author seat, through the substrate's own
// verbs, refusals and all).
//
// The flow, per obligation:
//   claim the verification task (as the verifier principal — visible on the board)
//   → gather the record: objective, frozen plan, completion statement, linked traces (fan-out
//     derived at read time; a trace that fails the contract REFUSES — never less evidence
//     than the claim recorded)
//   → one headless engine run (claude|codex, assigned at claim time) → strict JSON verdict
//   → the verdict lands as the verification task's completion statement (durable, addressable)
//   → the acceptance lane settles the ORIGINAL claim: seat = verifier principal (FC010: not
//     the author), checker = 'oathe-verdict' (deterministic: the standard conditions PLUS the
//     recorded verdict); accepted → verification row + settle_work_claim in ONE txn;
//     rejected → rejected verification row + cell.reopen_rejected_task (R8)
//   → the verification task itself settles under the OPERATOR seat (the review's acceptance
//     is itself non-author — a2a's shape, all the way down).
//
// Shallowness, stated on purpose: the deterministic bar checks the verdict's PRESENCE and
// PROVENANCE; the judgment quality is the engine's, and the linked traces exist precisely so
// that judgment stays auditable.

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

import { createOatheTools } from './mcp/oathe-tools.mjs';
import { projectorFor, renderEvidenceView } from './atif.mjs';
import { verificationTaskId, isVerificationTask, ACCEPTANCE_CLAUSE_KEY } from './plans.mjs';
import { RECORDED_VERDICT_CHECKER } from './runtime/discharge.mjs';

const require = createRequire(import.meta.url);

const VERDICTS = ['accepted', 'rejected'];

export class VerifierError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VerifierError';
    this.code = code;
    this.details = details;
  }
}

export class Verifier {
  /**
   * @param {{substrate: import('./substrate.mjs').Substrate, paths: object, workspace: string,
   *          config: import('./config.mjs').OatheConfig, operatorPrincipal: string,
   *          engineRunner?: ({engine, prompt}) => Promise<{verdict: string, reason: string}>}} o
   */
  constructor({ substrate, paths, workspace, config, operatorPrincipal, engineRunner, provider = null }) {
    this.substrate = substrate;
    this.paths = paths;
    this.workspace = workspace;
    this.config = config;
    this.operatorPrincipal = operatorPrincipal;
    this.verifierPrincipal = config.get('verifierPrincipal');
    this.engineRunner = engineRunner ?? defaultEngineRunner;
    this.orgId = config.get('org');
    this.provider = provider;
    this.tools = createOatheTools({
      client: substrate,
      identity: {
        orgId: this.orgId,
        principalId: this.verifierPrincipal,
        department: 'verification',
      },
      workspace,
      config,
    });
    this.pool = null;
    this.runtime = null;
  }

  async #runtime() {
    if (this.runtime) return this.runtime;
    const provider = this.provider
      ?? (await import('./runtime/provider.mjs')).resolveRuntimeProvider({
        config: this.config, paths: this.paths });
    const pg = require('pg');
    this.pool = new pg.Pool(this.substrate.connectionConfig());
    this.runtime = await provider.acceptanceRuntime({ pool: this.pool, orgId: this.orgId });
    return this.runtime;
  }

  /** The latest completion statement for a task — the assertion under judgment. */
  async #completionStatement(taskId) {
    const { rows } = await this.substrate.query(
      `SELECT statement_id, work_claim_id, claim_principal, execution_actor, evidence_refs, proposition
         FROM cell.agent_statement
        WHERE org_id = $1 AND task_id = $2 AND statement_type = 'completion'
        ORDER BY asserted_at DESC LIMIT 1`,
      [this.orgId, taskId]);
    if (rows.length === 0) {
      throw new VerifierError('OATHE_NO_COMPLETION',
        `'${taskId}' has no completion statement — nothing was asserted, nothing to verify`, { taskId });
    }
    return rows[0];
  }

  /**
   * Linked traces (C1 statements), projected to ATIF at read time — fan-out embedded,
   * validated. Contract/projection failures REFUSE loudly (TraceContractError/AtifError):
   * never less evidence than the claim recorded.
   */
  async #traceEvidence(workClaimId) {
    const { rows } = await this.substrate.query(
      `SELECT subject_ref, evidence_refs FROM cell.agent_statement
        WHERE org_id = $1 AND work_claim_id = $2 AND subject_ref LIKE 'trace:%'`,
      [this.orgId, workClaimId]);
    const traces = [];
    for (const row of rows) {
      for (const file of row.evidence_refs) {
        traces.push({ path: file, trajectory: projectorFor(file).project(file) });
      }
    }
    return traces;
  }

  #prompt({ taskRow, completion, traces, taskId }) {
    const budget = this.config.get('verifierEvidenceBudget');
    const perTrace = Math.max(1, Math.floor(budget / Math.max(1, traces.length)));
    return [
      'You are a verification agent. Judge ONE question: do the recorded ACTIONS and OUTCOMES',
      'support the completion assertion? In the trace views below, SAID lines are the agent\'s',
      'own claims; CLAIM lines are its on-the-record speech acts; DID lines are the actions it',
      'actually took; GOT lines are what actually came back. Judge claims against actions and',
      'outcomes — be strict: absence of evidence is absence.',
      '',
      `TASK: ${taskId}`,
      `OBJECTIVE: ${taskRow.objective}`,
      `VERIFICATION PLAN: ${JSON.stringify(taskRow.verification_plan)}`,
      `COMPLETION ASSERTION: ${completion.proposition}`,
      `ASSERTED EVIDENCE: ${JSON.stringify(completion.evidence_refs)}`,
      '',
      `SESSION TRACES (${traces.length}):`,
      ...traces.map(({ trajectory }) => renderEvidenceView(trajectory, { budget: perTrace })),
      '',
      'Reply with ONLY a JSON object, no other text:',
      '{"verdict": "accepted" | "rejected", "reason": "<one sentence naming the evidence>"}',
    ].join('\n');
  }

  /**
   * The whole lane for one obligation.
   * @param {{taskId: string, engine?: string}} o taskId = the ORIGINAL task (or its verify: task)
   */
  async verify({ taskId, engine: engineOverride }) {
    const verificationTask = isVerificationTask(taskId) ? taskId : verificationTaskId(taskId);
    const originalTask = verificationTask.slice('verify:'.length);

    const { rows: vtaskRows } = await this.substrate.query(
      'SELECT objective, verification_plan FROM cell.task WHERE org_id = $1 AND task_id = $2',
      [this.orgId, verificationTask]);
    if (vtaskRows.length === 0) {
      throw new VerifierError('OATHE_NOTHING_TO_VERIFY',
        `no verification task '${verificationTask}' on the board — has '${originalTask}' been `
        + 'asserted done (oathe done) at all?', { taskId });
    }
    const engine = engineOverride ?? vtaskRows[0].verification_plan?.verifier_engine
      ?? this.config.get('verifier');

    // 1. Claim the review — the verifier principal takes visible responsibility for it.
    const vclaim = await this.tools.oathe_claim({ task_id: verificationTask });

    // 2. The record under judgment.
    const completion = await this.#completionStatement(originalTask);
    const { rows: taskRows } = await this.substrate.query(
      'SELECT objective, verification_plan FROM cell.task WHERE org_id = $1 AND task_id = $2',
      [this.orgId, originalTask]);
    const traces = await this.#traceEvidence(completion.work_claim_id);

    // 3. One engine run — fresh context, different eyes. The verdict must be exact.
    const raw = await this.engineRunner({
      engine,
      prompt: this.#prompt({ taskRow: taskRows[0], completion, traces, taskId: originalTask }),
    });
    if (!raw || !VERDICTS.includes(raw.verdict) || typeof raw.reason !== 'string' || raw.reason.trim() === '') {
      throw new VerifierError('OATHE_VERDICT_MALFORMED',
        `the ${engine} engine returned ${JSON.stringify(raw)} — a verdict is exactly `
        + `{verdict: ${VERDICTS.join('|')}, reason} and the lane never guesses`, { raw, engine });
    }

    // 4. The verdict becomes durable: the verification task's completion statement.
    const verdictRef = `verdict:${raw.verdict}:${originalTask}`;
    const done = await this.tools.oathe_done({
      task_id: verificationTask,
      proposition: `${raw.verdict}: ${raw.reason}`,
      evidence_ref: verdictRef,
    });

    // 5. Settle the ORIGINAL claim — deterministic lane, verifier seat, FC010-clean.
    const { SETTLE, laneFor } = await this.#runtime();
    const tracePath = traces[0]?.path ?? `statement:${done.statement_id}`;
    const lane = laneFor(this.verifierPrincipal);
    const statementFor = (stmt) => ({
      statement_ref: stmt.statement_id,
      work_claim_id: stmt.work_claim_id,
      evidence_refs: stmt.evidence_refs,
      trace_ref: tracePath,
      kind: 'completion',
      statement_type: 'completion',
    });
    const clauseFor = (task, plan, stmt, extra = {}) => ({
      org_id: this.orgId,
      task_id: task,
      clause_key: ACCEPTANCE_CLAUSE_KEY,
      verification_plan: plan,
      author_principal: stmt.claim_principal,
      executor_principal: stmt.execution_actor,
      seat_principal: null,
      evidence_refs: [verdictRef],
      trace_ref: tracePath,
      privacy_class: 'org_internal',
      transfer_scope: 'org_internal',
      ...extra,
    });
    const outcome = await lane.verify({
      agent_statement: statementFor(completion),
      task_id: originalTask,
      clause: clauseFor(originalTask, taskRows[0].verification_plan, completion,
        { checker: RECORDED_VERDICT_CHECKER, oathe_recorded_verdict: raw.verdict }),
    }, { settle: SETTLE.CLAIM });

    if (outcome.verification?.verdict === 'blocked' || (!outcome.settled && raw.verdict === 'accepted')) {
      throw new VerifierError('OATHE_SETTLEMENT_BLOCKED',
        `the acceptance lane did not settle an ACCEPTED verdict: ${JSON.stringify(outcome.verification)}`,
        { outcome });
    }

    // 6. R8: a rejection reopens the work, through the evaluator lane's own verb.
    if (raw.verdict === 'rejected') {
      await this.substrate.query('SELECT cell.reopen_rejected_task($1, $2)', [this.orgId, originalTask]);
    }

    // 7. The review itself settles under the OPERATOR seat (non-author of the verdict statement).
    const verdictStatement = await this.#completionStatement(verificationTask);
    const operatorLane = laneFor(this.operatorPrincipal);
    const reviewOutcome = await operatorLane.verify({
      agent_statement: statementFor(verdictStatement),
      task_id: verificationTask,
      clause: clauseFor(verificationTask, vtaskRows[0].verification_plan, verdictStatement,
        { checker: 'verification-clause' }),
    }, { settle: SETTLE.CLAIM });
    if (!reviewOutcome.settled) {
      throw new VerifierError('OATHE_REVIEW_UNSETTLED',
        `the verification task's own settlement failed: ${JSON.stringify(reviewOutcome.verification)}`,
        { reviewOutcome });
    }

    return {
      task_id: originalTask,
      verification_task: verificationTask,
      engine,
      verdict: raw.verdict,
      reason: raw.reason,
      settled: outcome.settled === true,
      reopened: raw.verdict === 'rejected',
      verdict_ref: verdictRef,
      verification_claim: vclaim.work_claim_id,
      traces: traces.map((t) => t.path),
    };
  }

  /** Every open verification task in this workspace's view — `oathe verify --all` sweeps them. */
  async pending() {
    const { sections } = await this.tools.oathe_board({});
    return [...sections.open, ...sections.mine]
      .filter((r) => isVerificationTask(r.task_id))
      .map((r) => r.task_id);
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}

/** The real engine runner: one headless run, strict JSON out. Refusals are typed and loud. */
export async function defaultEngineRunner({ engine, prompt, env = process.env, model = null }) {
  const commands = {
    claude: ['claude', ['-p', prompt, '--output-format', 'json', ...(model ? ['--model', model] : [])]],
    codex: ['codex', ['exec', '--skip-git-repo-check', ...(model ? ['-m', model] : []), prompt]],
  };
  const command = commands[engine];
  if (!command) {
    throw new VerifierError('OATHE_ENGINE_UNKNOWN',
      `no engine '${engine}' — known engines: ${Object.keys(commands).join(', ')}`, { engine });
  }
  const run = spawnSync(command[0], command[1], { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 });
  if (run.status !== 0) {
    throw new VerifierError('OATHE_ENGINE_FAILED',
      `${engine} exited ${run.status}: ${String(run.stderr).slice(0, 300)}`, { engine, status: run.status });
  }
  let text = run.stdout;
  if (engine === 'claude') {
    try {
      text = JSON.parse(run.stdout).result ?? '';
    } catch {
      throw new VerifierError('OATHE_ENGINE_OUTPUT_MALFORMED',
        'claude --output-format json did not return JSON', { engine });
    }
  }
  const match = String(text).match(/\{[^{}]*"verdict"[^{}]*\}/g);
  if (!match) {
    throw new VerifierError('OATHE_VERDICT_MALFORMED',
      `no JSON verdict found in ${engine} output: ${String(text).slice(-300)}`, { engine });
  }
  try {
    return JSON.parse(match.at(-1));
  } catch (e) {
    throw new VerifierError('OATHE_VERDICT_MALFORMED',
      `the ${engine} verdict JSON does not parse: ${e.message}`, { engine });
  }
}
