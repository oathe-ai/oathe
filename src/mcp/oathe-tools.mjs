// oathe — the claim/board/statement/yield/pickup MCP server. The SHAPE is copied from
// firia-runtime's governed-effect-mcp-server (unpinned): newline-delimited JSON-RPC 2.0 over
// stdio, NO SDK, a pure dispatch() that unit-tests with a fake tools map, and a run-as-main
// guard so importing never reads stdin or opens a connection.
//
// FAIL-LOUD: every substrate refusal (a second claimant, a yield with no claim, a statement
// against nothing) comes back isError:true with a typed code. The substrate's refusals are the
// product — they must reach the model as refusals, never as bland empties.
//
// Protocol: legacy initialize handshake advertising 2025-06-18 — the maximally compatible target
// (2026-07-28 "modern" clients probe server/discover, read our -32601, and fall back).

import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

import { standardPlan, verificationTaskId, verificationObjective, isVerificationTask } from '../plans.mjs';

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_NAME = 'oathe-tools';

// Durations flow from OatheConfig (founder ruling: never hardcode); SQL uses make_interval
// with a parameter, so the value is data, not a spliced literal.

export class OatheToolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OatheToolError';
    this.code = code;
    this.details = details;
  }
}

export function makeToolDefs() {
  return [
    {
      name: 'oathe_claim',
      description:
        'Claim a task on the cell board (minting it if new — with plan_status honestly "unknown", '
        + 'never a fabricated plan). A claim is a speech act: it takes responsibility, it does not '
        + 'do the work. A second claimant is refused by the substrate. Args: {task_id, objective}.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'the task to claim' },
          objective: { type: 'string', description: 'what done means, in one line (required to mint a new task)' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'oathe_board',
      description:
        "The Oathe board: this folder's open tasks — yours, open, or held by someone else. "
        + 'Args: {all?: true} to see every workspace.',
      inputSchema: { type: 'object', properties: { all: { type: 'boolean' } } },
    },
    {
      name: 'oathe_statement',
      description:
        'Record a progress statement against your active claim — a statement, not truth; nothing '
        + 'settles. Args: {task_id, proposition, evidence_ref?}.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          proposition: { type: 'string' },
          evidence_ref: { type: 'string' },
        },
        required: ['task_id', 'proposition'],
      },
    },
    {
      name: 'oathe_yield',
      description:
        'Yield your active claim with the declared operator cause: the obligation goes back on the '
        + 'board, unowned. Args: {task_id, note}.',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string' }, note: { type: 'string' } },
        required: ['task_id', 'note'],
      },
    },
    {
      name: 'oathe_done',
      description:
        'Assert completion of your active claim: records a completion statement and moves the '
        + 'claim terminal through the substrate\'s own verb. Asserted, NOT settled — verification '
        + 'is still owed at verify_by. Args: {task_id, proposition, evidence_ref?}.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          proposition: { type: 'string', description: 'what was done, as the completion assertion' },
          evidence_ref: { type: 'string' },
        },
        required: ['task_id', 'proposition'],
      },
    },
    {
      name: 'oathe_verify',
      description:
        'Run the verification lane for an asserted task: a fresh headless engine (assigned at '
        + 'claim time) judges the completion against its recorded traces, the verdict lands as '
        + 'durable evidence, and the deterministic acceptance lane settles (accepted) or '
        + 'reopens (rejected) under a NON-AUTHOR seat. Args: {task_id, engine?}.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          engine: { type: 'string', description: 'override the assigned engine (claude|codex)' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'oathe_pickup',
      description:
        'Pick up prior work on a claim: runs the successor sequence (read prior attempt → '
        + 'reallocate → recompiled frame) and returns the compiled context. The obligation, not '
        + 'the conversation, is what comes back. Args: {task_id}.',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    },
  ];
}

/**
 * The tool implementations over a substrate client ({query}). Identity comes from the
 * environment the launcher stamped, never from the model.
 *
 * @param {{client: {query: Function}, identity: {orgId: string, principalId: string, department: string},
 *          workspace: string, executionActor?: string,
 *          successor?: (o: {task_id: string, work_claim_id: string}) => Promise<object>}} o
 */
export function createOatheTools({ client, identity, workspace, executionActor, successor, config, verifier }) {
  const { orgId, principalId, department } = identity;
  const leaseHours = config?.get('leaseHours') ?? 4;
  const verifyByHours = config?.get('verifyByHours') ?? 24;
  const actor = executionActor
    ?? (process.env.FIRIA_EXECUTION_ATTEMPT_ID
      ? `attempt:${process.env.FIRIA_EXECUTION_ATTEMPT_ID}`
      : 'oathe-operator');

  async function activeClaim(taskId) {
    const { rows } = await client.query(
      `SELECT work_claim_id FROM cell.work_claim
        WHERE org_id = $1 AND task_id = $2 AND state = 'active' LIMIT 1`,
      [orgId, taskId]);
    if (rows.length === 0) {
      throw new OatheToolError('OATHE_NO_ACTIVE_CLAIM',
        `no active claim on '${taskId}' — nothing to speak against`, { task_id: taskId });
    }
    return rows[0].work_claim_id;
  }

  return {
    async oathe_claim({ task_id, objective }) {
      const contractRef = `workspace:${workspace};contract:${orgId}/${task_id}@v1`;
      const { rows: existing } = await client.query(
        'SELECT origin FROM cell.task WHERE org_id = $1 AND task_id = $2', [orgId, task_id]);
      if (existing.length === 0) {
        if (!objective) {
          throw new OatheToolError('OATHE_OBJECTIVE_REQUIRED',
            `task '${task_id}' does not exist yet; minting it needs an objective — what does done mean?`,
            { task_id });
        }
        await client.query(
          `INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                                  verify_by, claim_mode, created_at)
           VALUES ($1, $2, $3, $4, 'minted_at_claim', '{"plan_status":"unknown"}'::jsonb,
                   now() + make_interval(hours => $5), 'exclusive', now())
           ON CONFLICT DO NOTHING`,
          [orgId, task_id, department, objective, verifyByHours]);
      }
      const workClaimId = crypto.randomUUID();
      if (existing[0]?.origin === 'reopened') {
        // R8's second half: reopened work is RESUMED, not re-claimed — the evaluator lane's
        // verb seats the prior interval's principal (the one who answers for this work next).
        const { rows: reclaimed } = await client.query(
          'SELECT cell.reclaim_reopened_task($1, $2, $3, now(), $4) AS seated',
          [orgId, task_id, workClaimId, crypto.randomUUID()]);
        if (reclaimed[0].seated !== true) {
          throw new OatheToolError('OATHE_RECLAIM_REFUSED',
            `'${task_id}' is reopened but could not be resumed (a live owner already holds it)`,
            { task_id });
        }
      } else {
        await client.query(
          `SELECT cell.claim_work($1, $2, $3, NULL, $4, $5, 'exclusive',
                  now() + make_interval(hours => $6), $7, now(), $8)`,
          [orgId, task_id, workClaimId, principalId, department, leaseHours, contractRef, crypto.randomUUID()]);
      }
      // Verifier assignment happens AT CLAIM (founder direction 2026-08-25): the engine that
      // will judge this work is named before the work starts, from config, on the record.
      const verifier = config?.get('verifier') ?? 'claude';
      await client.query(
        `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
                execution_actor, claim_principal, statement_type, subject_ref, proposition,
                evidence_refs, epistemic_status, asserted_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'observation', $7, $8, $9::jsonb, 'observed', now())`,
        [crypto.randomUUID(), orgId, task_id, workClaimId, actor, principalId,
          `verifier:${verifier}`,
          `verification of this claim is assigned to the ${verifier} engine (bound at claim time)`,
          JSON.stringify([`config:verifier=${verifier}`])]);
      return {
        claimed: true,
        task_id,
        work_claim_id: workClaimId,
        contract_ref: contractRef,
        lease: `${leaseHours} hours`,
        verifier,
        note: existing.length === 0
          ? "task minted at claim — plan_status is honestly 'unknown'; a real cell pages you at verify_by"
          : 'existing task claimed',
      };
    },

    async oathe_board({ all = false } = {}) {
      // Workspace scope rides the claim's contract_ref (W1 convention). Unclaimed tasks carry no
      // workspace yet, so the scoped board still shows them: they are the offered, claimable ones.
      const filter = all ? '' : 'AND (w.contract_ref LIKE $2 OR w.contract_ref IS NULL)';
      const params = all ? [orgId] : [orgId, `workspace:${workspace};%`];
      // ONE row per task: the latest claim in view wins (a task reclaimed after a yield is one
      // task, not a history lesson — statements carry the history).
      const { rows } = await client.query(
        `SELECT task_id, objective, origin, state, principal_id, contract_ref, settled_at, lease_until FROM (
           SELECT DISTINCT ON (t.task_id)
                  t.task_id, t.objective, t.created_at, t.origin, w.state, w.principal_id, w.contract_ref,
                  w.settled_at,
                  to_char(w.ownership_valid_until, 'YYYY-MM-DD HH24:MI') AS lease_until
             FROM cell.task t LEFT JOIN cell.work_claim w USING (org_id, task_id)
            WHERE t.org_id = $1 ${filter}
            ORDER BY t.task_id, w.claimed_at DESC NULLS LAST
         ) latest ORDER BY created_at DESC`,
        params);
      // ONE classification, consumed by every render: active-yours / active-theirs /
      // asserted-awaiting-verdict / open. Asserted is NOT open — it awaits verification.
      const sections = { mine: [], open: [], asserted: [], held: [] };
      for (const row of rows) {
        if (row.settled_at) continue; // settled: the obligation is CLOSED — off the board
        if (row.state === 'active') sections[row.principal_id === principalId ? 'mine' : 'held'].push(row);
        else if (row.origin === 'reopened') sections.open.push({ ...row, state: 'reopened' }); // R8: back on the board
        else if (row.state === 'completion_asserted') sections.asserted.push(row);
        else sections.open.push(row);
      }
      return { workspace: all ? null : workspace, board: rows, sections };
    },

    async oathe_statement({ task_id, proposition, evidence_ref }) {
      const workClaimId = await activeClaim(task_id);
      const statementId = crypto.randomUUID();
      await client.query(
        `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
                execution_actor, claim_principal, statement_type, subject_ref, proposition,
                evidence_refs, epistemic_status, asserted_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'progress', $7, $8, $9::jsonb, 'observed', now())`,
        [statementId, orgId, task_id, workClaimId, actor, principalId,
          `task:${task_id}`, proposition, JSON.stringify([evidence_ref ?? 'note:session'])]);
      return {
        recorded: true, statement_id: statementId,
        note: 'a statement, not truth — nothing settled',
      };
    },

    async oathe_yield({ task_id, note }) {
      const workClaimId = await activeClaim(task_id);
      await client.query(
        'SELECT cell.oathe_yield_operator($1::uuid, $2, now(), $3::uuid)',
        [workClaimId, note, crypto.randomUUID()]);
      return {
        yielded: true, task_id, work_claim_id: workClaimId,
        note: 'the obligation is back on the board, unowned',
      };
    },

    async oathe_done({ task_id, proposition, evidence_ref }) {
      const workClaimId = await activeClaim(task_id);

      // 1. G2-b: work may not finish until a plan exists. If the plan is still honestly
      //    unknown, the POLICY binder supplies the standard plan — via the substrate's own
      //    amend verb (an explicit CONTRACT_CHANGED event), which FC161 permits only while
      //    the claim is ACTIVE, i.e. exactly now, before the completion terminal.
      const { rows: taskRows } = await client.query(
        'SELECT verification_plan AS plan FROM cell.task WHERE org_id = $1 AND task_id = $2',
        [orgId, task_id]);
      if (taskRows[0].plan?.plan_status !== 'declared') {
        await client.query(
          'SELECT cell.amend_verification_contract($1, $2, $3::jsonb, now(), $4::uuid, $5)',
          [orgId, task_id, JSON.stringify(standardPlan()), crypto.randomUUID(),
            'oathe policy-standard plan bound at completion (G2-b policy binder)']);
      }

      // 2. The completion statement + the substrate's terminal (as before).
      const statementId = crypto.randomUUID();
      await client.query(
        `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
                execution_actor, claim_principal, statement_type, subject_ref, proposition,
                evidence_refs, epistemic_status, asserted_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'completion', $7, $8, $9::jsonb, 'observed', now())`,
        [statementId, orgId, task_id, workClaimId, actor, principalId,
          `task:${task_id}`, proposition, JSON.stringify([evidence_ref ?? 'note:session'])]);
      await client.query(
        'SELECT cell.assert_claim_completion($1::uuid, $2::uuid)',
        [statementId, crypto.randomUUID()]);

      // 3. Verification is ordinary work: mint the verification task, open on the board,
      //    carrying the engine assigned at claim time. A verification task does not mint a
      //    verifier for ITSELF — that regress ends at the deterministic bar.
      let verificationTask = null;
      if (!isVerificationTask(task_id)) {
        const { rows: engineRows } = await client.query(
          `SELECT subject_ref FROM cell.agent_statement
            WHERE org_id = $1 AND work_claim_id = $2 AND subject_ref LIKE 'verifier:%'
            ORDER BY asserted_at DESC LIMIT 1`,
          [orgId, workClaimId]);
        const engine = engineRows[0]?.subject_ref.slice('verifier:'.length)
          ?? config?.get('verifier') ?? 'claude';
        verificationTask = verificationTaskId(task_id);
        await client.query(
          `INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                                  verify_by, claim_mode, created_at)
           VALUES ($1, $2, $3, $4, 'minted_at_claim', $5::jsonb,
                   now() + make_interval(hours => $6), 'exclusive', now())
           ON CONFLICT DO NOTHING`,
          [orgId, verificationTask, department, verificationObjective(task_id),
            JSON.stringify(standardPlan({ verifierEngine: engine })), verifyByHours]);
      }

      return {
        done: true, task_id, work_claim_id: workClaimId, statement_id: statementId,
        verification_task: verificationTask,
        note: verificationTask
          ? `completion ASSERTED, not settled. Verification task '${verificationTask}' is on the `
            + 'board. A DIFFERENT principal must verify (FC010 — you cannot verify your own work, '
            + 'including via your own sub-agents): run `oathe verify` from any terminal, or leave '
            + 'it for another session to claim.'
          : 'completion ASSERTED, not settled — the deterministic acceptance bar settles verification tasks',
      };
    },

    async oathe_verify({ task_id, engine }) {
      if (!verifier) {
        throw new OatheToolError('OATHE_VERIFY_UNAVAILABLE',
          'the verification lane is not wired into this server — run `oathe verify` from a '
          + 'terminal instead; verification cannot pretend', { task_id });
      }
      return verifier({ taskId: task_id, engine });
    },

    async oathe_pickup({ task_id }) {
      const { rows } = await client.query(
        `SELECT work_claim_id, state FROM cell.work_claim
          WHERE org_id = $1 AND task_id = $2 ORDER BY claimed_at DESC LIMIT 1`,
        [orgId, task_id]);
      const latest = rows[0];
      if (!latest || latest.state !== 'active') {
        // The refusal coaches the recovery a session actually needs mid-conversation.
        const hint = latest
          ? `the latest claim on '${task_id}' is ${latest.state} — claim it again (oathe_claim), `
            + 'then oathe_pickup follows the task\'s history'
          : `no claim exists on '${task_id}' — nothing to pick up`;
        throw new OatheToolError('OATHE_NO_ACTIVE_CLAIM', hint, { task_id, state: latest?.state ?? null });
      }
      if (!successor) {
        throw new OatheToolError('OATHE_PICKUP_UNAVAILABLE',
          'the successor sequence is not wired into this server (no runtime config in this '
          + 'session) — pickup cannot pretend; launch via `oathe claude` to get it', { task_id });
      }
      return successor({ task_id, work_claim_id: latest.work_claim_id });
    },
  };
}

const okText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], isError: false });
const errText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], isError: true });

/** One tools/call: a throwing tool becomes a TYPED tool error — never a bland success. */
export async function handleToolCall(params, tools) {
  const name = params?.name;
  const fn = tools[name];
  if (typeof fn !== 'function') {
    return errText({ status: 'ERROR', error_type: 'unknown_tool', reason: `no such oathe tool '${name}'` });
  }
  try {
    return okText(await fn(params?.arguments || {}));
  } catch (e) {
    return errText({
      status: 'ERROR',
      error_type: e?.name || 'Error',
      error_code: e?.code ?? null,
      reason: String(e?.message || e).slice(0, 400),
      fail_loud: true,
    });
  }
}

/** The pure JSON-RPC dispatcher — a response object, or null for a notification. */
export async function dispatch(msg, { tools }) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  const result = await (async () => {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: '0.1.0' },
        };
      case 'tools/list':
        return { tools: makeToolDefs() };
      case 'tools/call':
        return handleToolCall(params, tools);
      case 'ping':
        return {};
      default:
        return undefined;
    }
  })();
  if (isNotification) return null;
  if (result === undefined) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  }
  return { jsonrpc: '2.0', id, result };
}

/** Start the ndjson JSON-RPC loop over stdio. Only runs when launched as the entrypoint. */
export async function main(env = process.env) {
  const { Substrate } = await import('../substrate.mjs');
  const { buildPaths } = await import('../paths.mjs');
  const { workspaceRef } = await import('../workspace.mjs');
  const paths = buildPaths(env);
  const { OatheConfig } = await import('../config.mjs');
  const config = new OatheConfig({ env, cwd: env.OATHE_WORKSPACE_DIR || process.cwd() });
  const substrate = new Substrate({ database: config.get('db'), paths, env, config });
  const identity = {
    orgId: config.get('org'),
    principalId: config.get('principal') || env.USER || 'operator',
    department: config.get('department'),
  };
  // The successor is built LAZILY on the first pickup: a session that never picks up never pays
  // for the runtime wiring, and a wiring failure surfaces as that call's typed error.
  let successorPromise = null;
  let verifierInstance = null;
  const tools = createOatheTools({
    client: substrate,
    identity,
    config,
    workspace: workspaceRef(env.OATHE_WORKSPACE_DIR || process.cwd()),
    verifier: async (o) => {
      if (!verifierInstance) {
        const { Verifier } = await import('../verifier.mjs');
        verifierInstance = new Verifier({
          substrate, paths, config,
          workspace: workspaceRef(env.OATHE_WORKSPACE_DIR || process.cwd()),
          operatorPrincipal: identity.principalId,
        });
      }
      return verifierInstance.verify(o);
    },
    successor: async (o) => {
      if (!successorPromise) {
        successorPromise = import('../successor.mjs')
          .then(({ buildSuccessor }) => buildSuccessor({ substrate, identity, paths, env }));
        successorPromise.catch(() => { successorPromise = null; }); // a failed build must not poison retries
      }
      return (await successorPromise).pickup(o);
    },
  });
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch { return; }
    const out = await dispatch(msg, { tools });
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
