// oathe — the claim/board/statement/yield/pickup MCP server. The SHAPE is copied from
// oathe-runtime's governed-effect-mcp-server (unpinned): newline-delimited JSON-RPC 2.0 over
// stdio, NO SDK, a pure dispatch() that unit-tests with a fake tools map, and a run-as-main
// guard so importing never reads stdin or opens a connection.
//
// FAIL-LOUD: every substrate refusal (a second claimant, a yield with no claim, a statement
// against nothing) comes back isError:true with a typed code. The substrate's refusals are the
// product — they must reach the model as refusals, never as bland empties.
//
// Protocol: legacy initialize handshake advertising 2025-06-18 — the maximally compatible target
// (2026-07-28 "modern" clients probe server/discover, read our -32601, and fall back).

import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

import { standardPlan, verificationTaskId, verificationObjective, isVerificationTask } from '../plans.mjs';
import { verifierCapable } from '../harnesses/catalog.mjs';
import { ContractRef, HomeBoard } from '../home.mjs';
import {
  amendSubjectRef, isTraceSubjectSql, latestVerdictSql, latestProgressSql, latestTracePathSql, linkTrace,
  spawnParentSql, spawnParentFor, linkSpawn,
} from '../statements.mjs';
import { Pager } from '../pager.mjs';
import { KINDS, clipDetail, pullPointer } from '../breach-digest.mjs';
import { WIRE_KINDS, LINKABLE, emit, restoredReceipt } from '../wire.mjs';

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_NAME = 'oathe-tools';

/** The only two honest moves after a rejection (ruling 2026-08-31) — ONE wording, spoken
 *  by the blocked done's result and the reclaim bundle alike. */
export const REJECTION_FORK = 'prove it (do the missing work, assert done again) or descope it '
  + '(oathe_amend — the objective shrinks on the record); verification re-runs either way';

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
        + 'do the work. A second claimant is refused by the substrate. Args: {task_id, objective, parent?}.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'the task to claim' },
          objective: { type: 'string', description: 'what done means, in one line (required to mint a new task)' },
          parent: {
            type: ['string', 'null'],
            description: 'omit: recorded as spawned under the claim this session already holds (its root); '
              + 'an id: that claim, which you must hold; null: standalone work',
          },
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
      name: 'oathe_amend',
      description:
        "Change what done means, on the record: amends the ACTIVE claim's objective — this "
        + 'changes the expected outcome; the original definition stays on record in the '
        + 'amendment trail, and verification judges the version in force at assertion WITH '
        + 'the trail visible. Open-claim only, acceptance-seat only, never the verifier. '
        + 'Args: {task_id, objective, why}.',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string' }, objective: { type: 'string' }, why: { type: 'string' } },
        required: ['task_id', 'objective', 'why'],
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
        'Verify an asserted task and RETURN THE VERDICT — a fresh headless engine (assigned '
        + 'at claim time) judges the completion against its recorded traces and the files in '
        + 'the task workspace, in a detached process this call waits on (local substrate: '
        + 'blocking is the contract; the verdict lands durably either way). Accepted settles '
        + 'the claim; rejected reopens the task with the reason. A review already running is '
        + 'a typed OATHE_VERIFY_IN_FLIGHT refusal. Args: {task_id, engine?}.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          engine: { type: 'string', description: `override the assigned engine (${verifierCapable().join('|')})` },
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
 *          successor?: (o: {task_id: string, work_claim_id: string}) => Promise<object>,
 *          activation?: {register: (source: string) => Promise<object>,
 *                        activate: (source: string) => Promise<object>}}} o
 *   activation — the central-registry seam (src/activation.mjs ActivationSeam): every
 *     successful call registers the workspace; oathe_claim activates through the ONE writer.
 *   oathe_claim (write intent) activates it, and the claim result discloses what happened.
 *   synthetic — the session sits on a synthetic workspace (R-BOARD-SCOPE): its mints are
 *   HOMELESS and its claims never adopt (R-HOME-BOARD).
 */
export function createOatheTools({
  client, identity, workspace, executionActor, successor, config, verifier, activation, synthetic = false,
  // The SPEAKER primitive (founder ruling 2026-08-30): who is speaking — {surface, app,
  // session} resolved from the writer's own ancestry (src/speaker.mjs). REQUIRED wherever
  // it is consumed: a serving surface (one with the activation seam, whose writes ride the
  // wire and stamp attribution) refuses construction without it. Internal read-only
  // compositions (board render, the verifier's own seat) build no wrapper and carry none.
  speaker = null,
  // ATTENTION (UX rule 19) is served on every tool response; a read-only composition (the
  // board renderer, which carries its own digest) passes attention:false and reads no breach.
  attention = true,
}) {
  const { orgId, principalId, department } = identity;
  const homeBoard = new HomeBoard({ client, orgId });
  // The breaches are the pager's conditions read per call — stateless: a line repeats while
  // its condition holds and vanishes when it clears — under the ONE digest (src/breach-
  // digest.mjs): scoped to this board (a synthetic surface sees the machine), grouped,
  // ordered, budgeted. Attention words the fix bucket for the model's response channel —
  // rejected and verify-failed work, the one thing a session can act on now — so a background
  // rejection reaches it at its next act; the SessionStart hook covers new sessions.
  if (attention && !config) {
    throw new OatheToolError('OATHE_ATTENTION_NEEDS_CONFIG',
      'attention reads the pager, whose thresholds come from config — pass config, or attention:false for a read-only composition');
  }
  const pager = attention ? new Pager({ client, identity, config }) : null;
  const breachesFor = async (machine) => (await pager.digest()).scoped(machine ? null : workspace);
  const attentionLines = async () => {
    const fix = (await breachesFor(synthetic)).filter((row) => KINDS[row.kind].bucket === 'fix');
    const lines = fix.rows.map((row) => (row.group
      ? `spawned under '${row.task_id}': ${row.kind_word} — the children and their verdicts are in `
        + 'oathe_board.breaches; reclaim each (oathe_claim <child>), retry a failed verify with /oathe:verify <child>'
      : `${row.kind_word}: '${row.task_id}' — ${clipDetail(row.detail)}`
        + (row.kind === 'reopened' ? ' — reclaim it (oathe_claim) for the bundle' : '')));
    const more = pullPointer('attention', fix.more);
    return more ? [...lines, more] : lines;
  };
  const leaseHours = config?.get('leaseHours') ?? 4;
  const verifyByHours = config?.get('verifyByHours') ?? 24;
  const actor = executionActor
    ?? (process.env.OATHE_EXECUTION_ATTEMPT_ID
      ? `attempt:${process.env.OATHE_EXECUTION_ATTEMPT_ID}`
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

  let toolMap = {
    async oathe_claim({ task_id, objective }) {
      const { rows: existing } = await client.query(
        'SELECT origin FROM cell.task WHERE org_id = $1 AND task_id = $2', [orgId, task_id]);
      // R-HOME-BOARD: an existing task keeps the home its ledger already decided; a homeless
      // task is ADOPTED by the first real folder that claims it; a synthetic surface neither
      // stamps nor adopts — its mints and re-claims stay homeless.
      const priorHome = existing.length > 0 ? await homeBoard.of(task_id) : null;
      const home = priorHome ?? (synthetic ? null : workspace);
      const adopted = existing.length > 0 && priorHome === null && home !== null;
      let contractRef = String(new ContractRef({ workspace: home, orgId, taskId: task_id }));
      let rejection = null; // the recovery bundle, set on a reclaim of rejected work
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
        // The reclaim verb TRANSCRIBES the prior interval's ref (016) — report that, not ours.
        const { rows: seated } = await client.query(
          'SELECT contract_ref FROM cell.work_claim WHERE work_claim_id = $1', [workClaimId]);
        contractRef = seated[0].contract_ref;
        // The recovery bundle: what was missed and where the work stood when verification began.
        const { rows: verdictRows } = await client.query(
          `SELECT v.verdict, v.verdict_at FROM cell.task t
             LEFT JOIN LATERAL (${latestVerdictSql({ task: 't' })}) v ON true
            WHERE t.org_id = $1 AND t.task_id = $2`, [orgId, task_id]);
        const { rows: vtask } = await client.query(
          "SELECT created_at FROM cell.task WHERE org_id = $1 AND task_id = 'verify:' || $2", [orgId, task_id]);
        const { rows: priorWords } = await client.query(
          `SELECT proposition FROM cell.agent_statement s
            WHERE s.org_id = $1 AND s.task_id = $2 AND NOT ${isTraceSubjectSql('s.subject_ref')}
            ORDER BY s.asserted_at DESC LIMIT 3`, [orgId, task_id]);
        const { rows: traceRows } = await client.query(
          `SELECT DISTINCT evidence_refs FROM cell.agent_statement s
            WHERE s.org_id = $1 AND s.task_id = $2 AND ${isTraceSubjectSql('s.subject_ref')}
            ORDER BY evidence_refs LIMIT 2`, [orgId, task_id]);
        rejection = {
          reason: verdictRows[0]?.verdict ?? null,
          verification_started_at: vtask[0]?.created_at ?? null,
          last_statements: priorWords.map((r) => r.proposition),
          trace_refs: traceRows.flatMap((r) => (Array.isArray(r.evidence_refs) ? r.evidence_refs : [])),
          your_options: REJECTION_FORK,
        };
      } else {
        await client.query(
          `SELECT cell.claim_work($1, $2, $3, NULL, NULL, $4, $5, 'exclusive',
                  now() + make_interval(hours => $6), $7, now(), $8)`,
          [orgId, task_id, workClaimId, principalId, department, leaseHours, contractRef, crypto.randomUUID()]);
      }
      // Verifier assignment happens AT CLAIM (founder direction 2026-08-25): the engine that
      // will judge this work is named before the work starts, from config, on the record.
      // No fallback literal: config names the verifier or the claim refuses — never a judge
      // nobody chose.
      const verifier = config.get('verifier');
      await client.query(
        `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
                execution_actor, claim_principal, statement_type, subject_ref, proposition,
                evidence_refs, epistemic_status, asserted_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'observation', $7, $8, $9::jsonb, 'observed', now())`,
        [crypto.randomUUID(), orgId, task_id, workClaimId, actor, principalId,
          `verifier:${verifier}`,
          `verification of this claim is assigned to the ${verifier} engine (bound at claim time)`,
          JSON.stringify([`config:verifier=${verifier}`])]);
      const effective = ContractRef.parse(contractRef);
      const note = existing.length === 0
        ? (effective.isHomeless
          ? "task minted HOMELESS from a synthetic workspace — the first real folder to claim it adopts it; plan_status is honestly 'unknown'"
          : "task minted at claim — plan_status is honestly 'unknown'; a real cell pages you at verify_by")
        : adopted
          ? `existing homeless task claimed and ADOPTED onto this folder's board (${effective.workspace})`
          : effective.isHomeless
            ? 'existing homeless task claimed — still homeless (a synthetic surface never adopts)'
            : 'existing task claimed';
      return {
        claimed: true,
        task_id,
        ...(rejection !== null && { rejection }),
        work_claim_id: workClaimId,
        contract_ref: contractRef,
        home: effective.workspace,
        lease: `${leaseHours} hours`,
        verifier,
        note,
      };
    },

    async oathe_board({ all = false } = {}) {
      // R-BOARD-SCOPE: scope is a per-surface fact. A synthetic workspace has no folder to
      // lens through, so it serves the full board whatever the caller asked.
      const full = all || synthetic;
      // R-HOME-BOARD: a task's board is its HOME (the home rule, src/home.mjs, projected into
      // SQL once). The scoped board = tasks homed here + homeless tasks (unclaimed or minted
      // from a synthetic surface — visible everywhere so a real folder can adopt them).
      const filter = full ? '' : 'AND (latest.home = $2 OR latest.home IS NULL)';
      const params = full ? [orgId] : [orgId, workspace];
      // ONE row per task: the latest claim in view wins (a task reclaimed after a yield is one
      // task, not a history lesson — statements carry the history).
      const { rows } = await client.query(
        `SELECT task_id, objective, origin, state, principal_id, contract_ref, home, settled_at,
                lease_until, last_progress, last_progress_at, last_word_at, trace_path, trace_session_id, rejected_after,
                parent, parent_objective FROM (
           SELECT DISTINCT ON (t.task_id)
                  t.task_id, t.objective, t.created_at, t.origin, w.state, w.principal_id, w.contract_ref,
                  sp.parent_task_id AS parent, sp.parent_objective,
                  EXISTS (SELECT 1 FROM cell.verification v
                           WHERE v.org_id = t.org_id AND v.task_id = t.task_id
                             AND v.result = 'rejected' AND v.recorded_at > w.claimed_at) AS rejected_after,
                  ${HomeBoard.homeSql('t')} AS home,
                  w.settled_at,
                  to_char(w.ownership_valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI\"Z\"') AS lease_until,
                  p.proposition AS last_progress,
                  to_char(p.asserted_at, 'YYYY-MM-DD HH24:MI') AS last_progress_at,
                  to_char(coalesce(p.asserted_at, w.claimed_at) AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI"Z"') AS last_word_at,
                  tr.trace_path, tr.trace_session_id
             FROM cell.task t LEFT JOIN cell.work_claim w USING (org_id, task_id)
             LEFT JOIN LATERAL (${latestProgressSql({ task: 't', claim: 'w' })}) p ON true
             LEFT JOIN LATERAL (${latestTracePathSql({ task: 't' })}) tr ON true
             LEFT JOIN LATERAL (${spawnParentSql({ task: 't' })}) sp ON true
            WHERE t.org_id = $1
            ORDER BY t.task_id, w.claimed_at DESC NULLS LAST
         ) latest WHERE true ${filter} ORDER BY created_at DESC`,
        params);
      // Lineage (UX rule 21): a child never surfaces top-level while its parent is in view —
      // it is counted on the parent's row. A child whose parent is off the board (settled,
      // or homed elsewhere) stands on its own.
      const inView = new Set(rows.filter((r) => !r.settled_at).map((r) => r.task_id));
      const childrenOf = new Map();
      for (const row of rows) {
        if (row.parent && inView.has(row.parent)) childrenOf.set(row.parent, [...(childrenOf.get(row.parent) ?? []), row]);
      }
      // ONE classification, consumed by every render: active-yours / active-theirs /
      // asserted-awaiting-verdict / open. Asserted is NOT open — it awaits verification.
      const sections = { mine: [], open: [], asserted: [], held: [] };
      for (const row of rows) {
        if (row.settled_at) continue; // settled: the obligation is CLOSED — off the board
        if (row.parent && inView.has(row.parent)) continue;
        const [bucket, entry] = classify(row, principalId);
        const kids = childrenOf.get(row.task_id);
        sections[bucket].push(kids ? { ...entry, children: childrenSummary(kids, principalId) } : entry);
      }
      // The pull (UX rule 19): every breach on this board — every kind, grouped, ordered,
      // uncapped — where a `+N more` sends the model.
      return {
        workspace: full ? null : workspace, board: rows, sections,
        ...(pager ? { breaches: (await breachesFor(full)).groups } : {}),
      };
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
      // The schema requires `note`, but the server enforces no schema (tools/call hands the
      // arguments straight here): a client that ignores `required` must still hear WHY in the
      // tool's own words — not FC141's sentence about yield bases from plpgsql (2026-09-03).
      if (typeof note !== 'string' || note.trim() === '') {
        throw new OatheToolError('OATHE_YIELD_NOTE_REQUIRED',
          `yield refused — '${task_id}' cannot go back on the board without its cause: pass note `
          + '(why you are stopping, for whoever picks it up)', { task_id });
      }
      const workClaimId = await activeClaim(task_id);
      await client.query(
        'SELECT cell.oathe_yield_operator($1::uuid, $2, now(), $3::uuid)',
        [workClaimId, note, crypto.randomUUID()]);
      return {
        yielded: true, task_id, work_claim_id: workClaimId,
        note: 'the obligation is back on the board, unowned',
      };
    },

    async oathe_amend({ task_id, objective, why }) {
      // R-AMEND: "Oathe does not prevent people from changing their minds. It prevents them
      // from pretending the old obligation was completed." Open-claim only, seat-signed,
      // never the judge; the trail is the record and the version derives from it. The claim
      // row is locked FIRST — the amend-vs-done race is decided by the lock, not by luck.
      if (!objective || !String(objective).trim()) {
        throw new OatheToolError('OATHE_OBJECTIVE_REQUIRED', 'an amendment states the NEW definition of done', { task_id });
      }
      if (!why || !String(why).trim()) {
        throw new OatheToolError('OATHE_AMEND_WHY_REQUIRED', 'an amendment records WHY the definition moved', { task_id });
      }
      if (isVerificationTask(task_id)) {
        throw new OatheToolError('OATHE_AMEND_VERIFY_TASK',
          `'${task_id}' is a verification task — its objective is generated (src/plans.mjs), never amended`, { task_id });
      }
      const { rows: authority } = await client.query(
        'SELECT seats FROM cell.acceptance_authority WHERE org_id = $1', [orgId]);
      if (authority.length === 0) {
        throw new OatheToolError('OATHE_AMEND_UNAUTHORIZED',
          `no acceptance authority is registered for org '${orgId}' — an absent row is not lawful; run oathe init`, { task_id });
      }
      if (!authority[0].seats.includes(principalId)) {
        throw new OatheToolError('OATHE_AMEND_UNAUTHORIZED',
          `'${principalId}' is not in the seats roster [${authority[0].seats.join(', ')}] — an amendment is signed by the acceptance seat`, { task_id });
      }
      if (principalId === (config?.get('verifierPrincipal') ?? 'oathe-verifier')) {
        throw new OatheToolError('OATHE_AMEND_UNAUTHORIZED',
          `'${principalId}' is the verifier — the judge must not move the bar it judges`, { task_id });
      }
      return inTransaction(client, async (tx) => {
        const { rows: locked } = await tx.query(
          `SELECT work_claim_id FROM cell.work_claim
            WHERE org_id = $1 AND task_id = $2 AND state = 'active' AND settled_at IS NULL
            ORDER BY claimed_at DESC LIMIT 1 FOR UPDATE`, [orgId, task_id]);
        if (locked.length === 0) {
          throw new OatheToolError('OATHE_AMEND_AFTER_DONE',
            `'${task_id}' has no ACTIVE claim — the definition of done is amendable only while the work is held `
            + '(after done it is frozen at assertion; unclaimed work has nobody to renegotiate with — claim it first)', { task_id });
        }
        const { rows: taskRows } = await tx.query(
          'SELECT objective FROM cell.task WHERE org_id = $1 AND task_id = $2', [orgId, task_id]);
        const { rows: countRows } = await tx.query(
          `SELECT count(*)::int AS n FROM cell.agent_statement
            WHERE org_id = $1 AND task_id = $2 AND subject_ref = $3`, [orgId, task_id, amendSubjectRef(task_id)]);
        const version = countRows[0].n + 2; // v1 is the mint; v2 = the first amendment — derived, never stamped
        await tx.query(
          `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
                  execution_actor, claim_principal, statement_type, subject_ref, proposition,
                  evidence_refs, epistemic_status, asserted_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'observation', $7, $8, '[]'::jsonb, 'observed', now())`,
          [crypto.randomUUID(), orgId, task_id, locked[0].work_claim_id, actor, principalId,
            amendSubjectRef(task_id),
            `objective amended to v${version} by ${principalId} — ${why}\nOLD: ${taskRows[0].objective}\nNEW: ${objective}`]);
        await tx.query(
          'UPDATE cell.task SET objective = $3 WHERE org_id = $1 AND task_id = $2', [orgId, task_id, objective]);
        return {
          amended: true,
          task_id,
          version,
          note: `the definition of done moved to v${version}; the original definition stays on record in the amendment trail — verification judges the version in force at assertion and SEES the trail`,
        };
      });
    },

    async oathe_done({ task_id, proposition, evidence_ref }) {
      // ONE transaction, claim row locked FIRST (the same discipline as oathe_amend): the
      // amend-vs-done race is decided by the lock, "the version in force at assertion" is
      // exact, and a completion statement never lands without its terminal.
      const workClaimId = await activeClaim(task_id);
      const statementId = crypto.randomUUID();
      await inTransaction(client, async (tx) => {
        const { rows: lockRows } = await tx.query(
          "SELECT work_claim_id FROM cell.work_claim WHERE work_claim_id = $1 AND state = 'active' FOR UPDATE",
          [workClaimId]);
        if (lockRows.length === 0) {
          throw new OatheToolError('OATHE_NO_ACTIVE_CLAIM',
            `the claim on '${task_id}' left the active state while this done was in flight — read the board`, { task_id });
        }

        // 1. G2-b: work may not finish until a plan exists. If the plan is still honestly
        //    unknown, the POLICY binder supplies the standard plan — via the substrate's own
        //    amend verb (an explicit CONTRACT_CHANGED event), which FC161 permits only while
        //    the claim is ACTIVE, i.e. exactly now, before the completion terminal.
        const { rows: taskRows } = await tx.query(
          'SELECT verification_plan AS plan FROM cell.task WHERE org_id = $1 AND task_id = $2',
          [orgId, task_id]);
        if (taskRows[0].plan?.plan_status !== 'declared') {
          await tx.query(
            'SELECT cell.amend_verification_contract($1, $2, $3::jsonb, now(), $4::uuid, $5)',
            [orgId, task_id, JSON.stringify(standardPlan()), crypto.randomUUID(),
              'oathe policy-standard plan bound at completion (G2-b policy binder)']);
        }

        // 2. The completion statement + the substrate's terminal (as before).
        await tx.query(
          `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
                  execution_actor, claim_principal, statement_type, subject_ref, proposition,
                  evidence_refs, epistemic_status, asserted_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'completion', $7, $8, $9::jsonb, 'observed', now())`,
          [statementId, orgId, task_id, workClaimId, actor, principalId,
            `task:${task_id}`, proposition, JSON.stringify([evidence_ref ?? 'note:session'])]);
        await tx.query(
          'SELECT cell.assert_claim_completion($1::uuid, $2::uuid)',
          [statementId, crypto.randomUUID()]);
      });

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
          ?? config.get('verifier');
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
          'pickup is not wired into this tools server — the successor sequence is unavailable in '
          + 'this session (a preview limitation of sessions without the runtime seam). Claim the '
          + 'task instead (oathe_claim): a reclaim of rejected work returns the recovery bundle — '
          + 'the rejection reason, the prior interval\'s statements, and its trace refs — and the '
          + 'board (oathe_board) carries the objective and progress; pickup cannot pretend',
          { task_id });
      }
      const frame = await successor({ task_id, work_claim_id: latest.work_claim_id });
      // R-QUIET: the restored-state banner rides the pickup — the one moment it is news.
      return { ...frame, receipt: restoredReceipt(task_id) };
    },
  };

  // Attention rides EVERY response, activation or not: the act succeeded — a failing
  // attention read is reported beside it (attention_error), never converted into a tool error.
  if (pager) {
    toolMap = Object.fromEntries(Object.entries(toolMap).map(([name, fn]) => [name, async (args) => {
      const out = await fn(args);
      try {
        const lines = await attentionLines();
        if (lines.length > 0) out.attention = lines;
      } catch (e) {
        out.attention_error = `the attention read failed: ${String(e?.message ?? e).slice(0, 160)}`;
      }
      return out;
    }]));
  }

  if (!activation) return toolMap;
  if (!speaker) {
    throw new OatheToolError('OATHE_SPEAKER_REQUIRED',
      'a serving tool surface must know who is speaking — pass speaker: resolveSpeaker(...) '
      + '(src/speaker.mjs); the SPEAKER primitive is required, never assumed');
  }
  // Registration rides every SUCCESSFUL call; claim, the write-intent act, activates and
  // discloses. The seam receives the bare tool name — each surface (mcp:, cli:) labels its
  // own source. A failing registry is a typed error, not a silent skip — fail loud.
  // Every successful WRITE carries its speaker: the durable trace-link lands WITH the act
  // (linkTrace — a failure throws typed; retries are idempotent), the wire nudges the glass,
  // and the result discloses who spoke. Reads stamp and emit nothing.
  return Object.fromEntries(Object.entries(toolMap).map(([name, fn]) => [name, async (args) => {
    // Lineage is decided BEFORE a claim lands (a refused parent leaves nothing behind) and
    // recorded right after it, on the parent's claim — the `spawn:<child>` observation.
    const spawn = name === 'oathe_claim'
      ? await spawnParentFor({ client, identity, session: speaker.session, taskId: args.task_id, parent: args.parent })
      : null;
    const out = await fn(args);
    if (WIRE_KINDS[name]) {
      if (speaker.session && args?.task_id && LINKABLE.has(name)) {
        const link = await linkTrace({ client, identity, taskId: args.task_id, session: speaker.session });
        if (link.why) out.trace_link = link; // a link that waits is disclosed, never assumed
      }
      if (name === 'oathe_claim') {
        if (spawn) {
          await linkSpawn({
            client, identity, parent: spawn.parent, childTaskId: args.task_id,
            actor: speaker.session ? `session:${speaker.session.sessionId}` : actor,
          });
        }
        out.lineage = spawn;
      }
      // The trust boundary is the blocking boundary (ruling 2026-08-31): on your own
      // machine, done OWES its verdict and waits for it — the seam dispatches the detached
      // engine and awaits the substrate's answer (a remote substrate flips the seam to
      // dispatch-and-return when the cloud lands; never a knob here). The assertion STANDS
      // whatever happens — a seam failure is disclosed, and the pager pages the miss.
      if (name === 'oathe_done' && verifier) {
        try {
          const outcome = await verifier({ taskId: args.task_id });
          out.verification = outcome?.verdict === 'rejected'
            ? { ...outcome, your_options: REJECTION_FORK }
            : outcome;
        } catch (e) {
          out.verification = { failed: true, reason: `${e?.code ? `[${e.code}] ` : ''}${String(e?.message ?? e).slice(0, 200)}` };
        }
      }
      out.spoken_from = {
        surface: speaker.surface,
        app: speaker.app?.bundle ?? null,
        session: speaker.session?.sessionId ?? null,
      };
      await emit(client, { kind: WIRE_KINDS[name], task_id: args?.task_id, via: speaker.surface, app: speaker.app });
    }
    if (name === 'oathe_claim') out.activation = await activation.activate(name);
    else await activation.register(name);
    return out;
  }]));
}

/**
 * The board's ONE classification of an unsettled row: [bucket, row]. The discriminator is a
 * REJECTION AFTER the latest claim: with one, the task is back on the board (R8); without
 * one, origin='reopened' is stale history and the truth is asserted-awaiting-verification (a
 * no-verdict engine failure must not read as reopened — live, 2026-08-30).
 */
function classify(row, principalId) {
  if (row.state === 'active') return [row.principal_id === principalId ? 'mine' : 'held', row];
  if (row.state === 'completion_asserted' && !row.rejected_after) return ['asserted', row];
  if (row.origin === 'reopened') return ['open', { ...row, state: 'reopened' }]; // R8: back on the board
  if (row.state === 'completion_asserted') return ['asserted', row];
  return ['open', row];
}

/** A spawned child's one word on its parent's row, in the order the line speaks them. */
const CHILD_WORDS = ['active', 'asserted', 'reopened', 'open', 'settled'];
function childWord(row, principalId) {
  if (row.settled_at) return 'settled';
  const [bucket, entry] = classify(row, principalId);
  if (bucket === 'mine' || bucket === 'held') return 'active';
  if (bucket === 'asserted') return 'asserted';
  return entry.state === 'reopened' ? 'reopened' : 'open';
}

/** `spawned 3 — 2 active · 1 settled`: the parent's counts line, zero counts omitted. */
function childrenSummary(kids, principalId) {
  const by = {};
  for (const kid of kids) {
    const word = childWord(kid, principalId);
    by[word] = (by[word] ?? 0) + 1;
  }
  const parts = CHILD_WORDS.filter((word) => by[word]).map((word) => `${by[word]} ${word}`);
  return { n: kids.length, by, line: `spawned ${kids.length} — ${parts.join(' · ')}` };
}

/**
 * ONE transaction idiom for the write verbs: the real substrate's withTransaction holds
 * the interleave gate for the whole span; a bare {query} client (test fakes, spies) gets
 * the inline BEGIN..COMMIT with identical semantics on its single connection.
 */
async function inTransaction(client, fn) {
  if (typeof client.withTransaction === 'function') return client.withTransaction(fn);
  await client.query('BEGIN');
  try {
    const out = await fn({ query: (sql, params) => client.query(sql, params) });
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
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

/**
 * Lazily-served tools: the same tool NAMES, each call routed through `loader` so the real
 * context (workspace resolution, config, substrate) is built on FIRST USE, once, never at
 * process startup. A loader refusal (e.g. OATHE_WORKSPACE_UNRESOLVED) surfaces per call as
 * that call's typed error — the server itself never dies for it. Resolution is the gate; the
 * launched-harness env var is custody-only.
 */
export function lazyTools(loader, { names = makeToolDefs().map((t) => t.name) } = {}) {
  // No memo here: deduplication (and invalidation) is the LOADER's job — one cache, one owner.
  return Object.fromEntries(names.map((name) => [name, async (args) => {
    const context = await loader();
    return context.tools[name](args);
  }]));
}

/** The pure JSON-RPC dispatcher — a response object, or null for a notification. `version`
 *  is the package version the server names at initialize (the connection reads it once). */
export async function dispatch(msg, { tools, version }) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  const result = await (async () => {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version },
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

/**
 * Start the server over stdio. The transport, server-initiated requests (roots/list), and the
 * LAZY per-connection tool context live in McpConnection (./connection.mjs) — nothing beyond
 * the transport is built at startup, so a poisoned environment surfaces per call, typed,
 * never as a startup crash.
 */
export async function main(env = process.env) {
  const { McpConnection } = await import('./connection.mjs');
  new McpConnection({ env }).start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
