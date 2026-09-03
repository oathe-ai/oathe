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
//   → one headless engine run (any verifier-capable adapter, assigned at claim time) → strict JSON verdict
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

import { isTraceSubjectSql, TRACE_SUBJECT_PREFIX } from './statements.mjs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { amendSubjectRef, engineFailureRef, evidenceFailureRef } from './statements.mjs';
import { emit as wireEmit } from './wire.mjs';
import { WorkspaceRegistry } from './registry.mjs';
import { homeOf } from './paths.mjs';
import { HomeBoard } from './home.mjs';

import { createOatheTools } from './mcp/oathe-tools.mjs';
import { renderEvidenceView, sliceForTask } from './atif.mjs';
import { transcriptFor } from './harnesses/catalog.mjs';
import { projectAnnotated } from './oathe-annotator.mjs';
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
  constructor({ substrate, paths, workspace, config, operatorPrincipal, engineRunner, provider = null, homePathFor = null, env = process.env }) {
    this.env = env; // the store home follows the RUN's env — a rebound HOME (cage, sandbox) must read the store the hooks wrote
    this.substrate = substrate;
    this.paths = paths;
    this.workspace = workspace;
    this.config = config;
    this.operatorPrincipal = operatorPrincipal;
    this.verifierPrincipal = config.get('verifierPrincipal');
    this.engineRunner = engineRunner ?? defaultEngineRunner;
    // The ONE home resolver (registry rootOf), injectable for tests. The engine judges
    // FROM the task's own folder — its tools are the evidence reader (ruling 2026-08-31);
    // a homeless task judges from the operator's home, never the caller's accidental cwd.
    this.homePathFor = homePathFor
      ?? ((homeRef) => new WorkspaceRegistry({ registryPath: paths.registryPath }).rootOf(homeRef));
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
        WHERE org_id = $1 AND work_claim_id = $2 AND ${isTraceSubjectSql('subject_ref')}`,
      [this.orgId, workClaimId]);
    const traces = [];
    for (const row of rows) {
      // The file the session's rows LIVE in: a link spoken from a resumed session names the
      // transcript the harness reported and never wrote — the store resolves it from the rows
      // that carry the session id (transcriptFor); a file nothing carries stays as recorded
      // and refuses below, loudly.
      const sessionId = row.subject_ref.slice(TRACE_SUBJECT_PREFIX.length);
      for (const ref of row.evidence_refs) {
        const file = transcriptFor({ sessionId, reportedPath: ref, home: homeOf(this.env) });
        traces.push({ path: file, trajectory: await projectAnnotated(file, { home: homeOf(this.env) }) });
      }
    }
    return traces;
  }

  #prompt({ taskRow, completion, traces, taskId, amendments = [] }) {
    const budget = this.config.get('verifierEvidenceBudget');
    const perTrace = Math.max(1, Math.floor(budget / Math.max(1, traces.length)));
    return [
      'You are a verification agent. Judge ONE question: do the recorded ACTIONS and OUTCOMES',
      'support the completion assertion? In the trace views below, SAID lines are the agent\'s',
      'own claims; CLAIM lines are its on-the-record speech acts; DID lines are the actions it',
      'actually took; GOT lines are what actually came back; FROM lines are messages other agents sent',
      'this one (a delegated brief, a subagent\'s answer) — never this agent\'s own claims. Judge',
      'claims against actions and outcomes — be strict: absence of evidence is absence.',
      'You are running in the task\'s workspace — check asserted artifacts against the files on disk.',
      '',
      `TASK: ${taskId}`,
      `OBJECTIVE: ${taskRow.objective}`,
      `VERIFICATION PLAN: ${JSON.stringify(taskRow.verification_plan)}`,
      `COMPLETION ASSERTION: ${completion.proposition}`,
      `ASSERTED EVIDENCE: ${JSON.stringify(completion.evidence_refs)}`,
      ...(amendments.length === 0 ? [] : [
        '',
        `AMENDMENT TRAIL (${amendments.length} — the definition of done MOVED, with sign-off;`,
        'judge the CURRENT objective above; a late or convenient move is itself evidence to weigh):',
        ...amendments.map((a) => `- [${new Date(a.asserted_at).toISOString()}] ${a.proposition}`),
      ]),
      '',
      `SESSION TRACES (${traces.length}, sliced to this task's claim intervals where recorded):`,
      ...traces.map(({ trajectory }) => renderEvidenceView(sliceForTask(trajectory, taskId), { budget: perTrace })),
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

    // 2-3. EVERYTHING between the claim and a durable verdict runs under the release
    // guard (ruling 2026-08-31: ANY exit before a verdict fails loud and frees the claim —
    // an exit outside the guard, an unreadable trace say, would leave the twin wedged
    // behind its lease). Evidence-gathering and the engine fail the same way: durable
    // statement, yield, verify_failed on the wire.
    let raw;
    let completion;
    let taskRows;
    let traces;
    let engineLaunched = false;
    try {
      completion = await this.#completionStatement(originalTask);
      ({ rows: taskRows } = await this.substrate.query(
        `SELECT objective, verification_plan, ${HomeBoard.homeSql('t')} AS home
           FROM cell.task t WHERE org_id = $1 AND task_id = $2`,
        [this.orgId, originalTask]));
      // The engine judges FROM the task's workspace — its own tools read the evidence on
      // disk. One resolver (registry rootOf); a homeless task judges from the operator's home.
      const taskHome = this.homePathFor(taskRows[0]?.home) ?? homeOf();
      traces = await this.#traceEvidence(completion.work_claim_id);
      // R-AMEND: the amendment trail is part of the record — the engine judges the CURRENT
      // objective and SEES every move of the bar (a late amendment is visible evidence).
      const { rows: amendments } = await this.substrate.query(
        `SELECT proposition, asserted_at FROM cell.agent_statement
          WHERE org_id = $1 AND task_id = $2 AND subject_ref = $3
          ORDER BY asserted_at`,
        [this.orgId, originalTask, amendSubjectRef(originalTask)]);
      engineLaunched = true;
      raw = await this.engineRunner({
        engine,
        cwd: taskHome,
        prompt: this.#prompt({ taskRow: taskRows[0], completion, traces, taskId: originalTask, amendments }),
      });
      if (!raw || !VERDICTS.includes(raw.verdict) || typeof raw.reason !== 'string' || raw.reason.trim() === '') {
        throw new VerifierError('OATHE_VERDICT_MALFORMED',
          `the ${engine} engine returned ${JSON.stringify(raw)} — a verdict is exactly `
          + `{verdict: ${VERDICTS.join('|')}, reason} and the lane never guesses`, { raw, engine });
      }
    } catch (e) {
      // One guard, two honest stalls (the 2026-08-31 pileup): an unreadable record fails
      // every engine alike, so only an engine-stage death may advise trying another one.
      const msg = String(e?.message ?? e).slice(0, 400);
      const stall = engineLaunched
        ? { proposition: `engine ${engine} failed before a verdict: ${msg}`,
            ref: engineFailureRef(engine),
            note: `engine ${engine} died — released for retry: oathe verify ${originalTask} --engine <another>` }
        : { proposition: `gathering evidence failed before the ${engine} engine launched: ${msg}`,
            ref: evidenceFailureRef(e?.code),
            note: `the record could not be read — fix the cause and retry: oathe verify ${originalTask}` };
      try {
        await this.tools.oathe_statement({
          task_id: verificationTask,
          proposition: stall.proposition,
          evidence_ref: stall.ref,
        });
        await this.tools.oathe_yield({ task_id: verificationTask, note: stall.note });
      } catch { /* best-effort release — the primary failure must surface either way */ }
      // The glass hears the failure too (fail-soft inside emit): named by the ORIGINAL
      // task — the row a person is looking at — so retry is one act, not archaeology.
      await wireEmit(this.substrate, { kind: 'verify_failed', task_id: originalTask, via: engine });
      throw e;
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

    let settledNow = outcome.settled === true;
    if (!settledNow) {
      // `settle_work_claim` answers false for an ALREADY-settled claim (idempotency) exactly as it
      // does for a refused one. A prior run killed after its settle must read as recovery — the
      // claim row knows (a re-run otherwise wedged forever, burning an engine run per retry).
      const { rows: settledRows } = await this.substrate.query(
        'SELECT settled_at FROM cell.work_claim WHERE work_claim_id = $1', [completion.work_claim_id]);
      settledNow = settledRows[0]?.settled_at != null;
      if (!settledNow && (outcome.verification?.verdict === 'blocked' || raw.verdict === 'accepted')) {
        throw new VerifierError('OATHE_SETTLEMENT_BLOCKED',
          `the acceptance lane did not settle an ACCEPTED verdict: ${JSON.stringify(outcome.verification)}`,
          { outcome });
      }
    }

    // 6. R8: a rejection reopens the work, through the evaluator lane's own verb.
    if (raw.verdict === 'rejected') {
      await this.substrate.query('SELECT cell.reopen_rejected_task($1, $2)', [this.orgId, originalTask]);
    }
    // The wire hears the verdict the moment it lands (fail-soft inside emit — the settlement
    // stands whatever the wire does; the notch otherwise catches up on its heartbeat).
    await wireEmit(this.substrate, { kind: raw.verdict === 'rejected' ? 'rejected' : 'settled', task_id: originalTask });

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
      settled: settledNow,
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
export async function defaultEngineRunner({ engine, prompt, env = process.env, model = null, cwd = undefined }) {
  // The command line and output shape are each engine adapter's own facts (src/harnesses/).
  const { byName, verifierCapable } = await import('./harnesses/catalog.mjs');
  const known = verifierCapable();
  if (!known.includes(engine)) {
    throw new VerifierError('OATHE_ENGINE_UNKNOWN',
      `no engine '${engine}' — known engines: ${known.join(', ')}`, { engine });
  }
  const adapter = byName(engine);
  const command = adapter.headless.command(prompt, model);
  // async spawn — a minutes-long engine run must never halt the event loop (spawnSync froze the
  // whole MCP server, ping included, before the dispatcher existed; the sync bin path gains the
  // same hygiene for free).
  const run = await new Promise((resolve) => {
    // stdin 'ignore': the engine gets immediate EOF (codex exec drains stdin before answering;
    // spawnSync closed it implicitly — an open default pipe hung two live runs, 2026-08-30).
    const child = spawn(command[0], command[1], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    // Resolve on EXIT (with a short drain grace), not only on 'close': an engine's backgrounded
    // helper can inherit the stdio pipes, and then 'close' never fires — a detached verify sat
    // at 0% CPU for 20 minutes after codex finished (live, 2026-08-30). Destroying the streams
    // releases the inherited-pipe fds so the loop is never pinned either.
    const finish = (result) => {
      if (settled) return;
      settled = true;
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
    };
    child.stdout.on('data', (d) => { if (stdout.length < 32 * 1024 * 1024) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 1024 * 1024) stderr += d; });
    child.on('error', (error) => finish({ error, status: null, stdout, stderr }));
    child.on('close', (status) => finish({ status, stdout, stderr }));
    child.on('exit', (status) => { setTimeout(() => finish({ status, stdout, stderr }), 500).unref(); });
  });
  if (run.error) {
    throw new VerifierError('OATHE_ENGINE_MISSING',
      `the '${engine}' CLI is not installed or not on PATH — verification needs a real engine `
      + `(${String(run.error.message).slice(0, 120)})`, { engine });
  }
  if (run.status !== 0) {
    throw new VerifierError('OATHE_ENGINE_FAILED',
      `${engine} exited ${run.status}; stderr tail: ${String(run.stderr ?? '').trim().slice(-300)}`, { engine, status: run.status });
  }
  let text;
  try {
    text = adapter.headless.extract(run.stdout);
  } catch (e) {
    throw new VerifierError('OATHE_ENGINE_OUTPUT_MALFORMED', e.message, { engine });
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
