// oathe — the verification dispatcher. `oathe_verify` over MCP never runs the engine in the
// server: it launches the existing `oathe verify` bin verb as a DETACHED process (its own
// group, unref'd — it survives the session; a deliberate, documented exception to the cage's
// containment) and answers immediately with the durable addresses. Concurrency stays the
// substrate's: the child claims `verify:<task>` before its engine runs, so a concurrent loser
// exits on FC003 pre-engine. The only pre-spawn read exists so a live in-flight review is a
// TYPED refusal naming the holder — never a lying {started: true}. No auto-heal: an expired
// lease names the manual fix (`oathe yield`) and stops.

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

import { isVerificationTask, verificationTaskId } from './plans.mjs';
import { isEngineFailureSql } from './statements.mjs';
import { pidAlive } from './sessions.mjs';

export class VerifyDispatchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VerifyDispatchError';
    this.code = code;
    this.details = details;
  }
}

/** The env the child gets: the caller's, minus the judged session's provenance stamps —
 *  otherwise the verifier's own statements carry the attempt id of the very execution under
 *  judgment. */
function scrubbedEnv(env) {
  const child = { ...env };
  delete child.OATHE_EXECUTION_ATTEMPT_ID;
  delete child.OATHE_LAUNCHED_HARNESS;
  return child;
}

/**
 * @param {{taskId: string, engine?: string, orgId: string,
 *          query: (sql: string, params: unknown[]) => Promise<{rows: object[]}>,
 *          paths: {packageRoot: string, logsDir: string}, cwd: string, env: object,
 *          spawn?: typeof nodeSpawn, clock?: () => Date}} o
 * @returns {Promise<{started: true, task_id: string, verification_task: string, engine: string|null,
 *                    pid: number, log: string, note: string}>}
 */
export async function dispatchVerification({
  taskId, engine = null, orgId, query, paths, cwd, env, spawn = nodeSpawn, clock = () => new Date(),
}) {
  const verificationTask = isVerificationTask(taskId) ? taskId : verificationTaskId(taskId);
  const originalTask = verificationTask.slice('verify:'.length);

  const { rows } = await query(
    `SELECT principal_id, state, ownership_valid_until
       FROM cell.work_claim WHERE org_id = $1 AND task_id = $2
      ORDER BY claimed_at DESC LIMIT 1`, [orgId, verificationTask]);
  const latest = rows[0];
  if (latest?.state === 'active') {
    const until = latest.ownership_valid_until ? new Date(latest.ownership_valid_until) : null;
    const expired = until !== null && until < clock();
    throw new VerifyDispatchError('OATHE_VERIFY_IN_FLIGHT',
      expired
        ? `a verification of '${originalTask}' is still claimed by ${latest.principal_id} but its `
          + `lease expired ${until.toISOString()} — likely a dead run; \`oathe yield ${verificationTask}\` `
          + 'releases it, then dispatch again'
        : `a verification of '${originalTask}' is already running — claimed by ${latest.principal_id}`
          + `${until ? ` until ${until.toISOString()}` : ''}; its verdict lands on the board`,
      { verification_task: verificationTask, holder: latest.principal_id, expired });
  }

  fs.mkdirSync(paths.logsDir, { recursive: true });
  const log = path.join(paths.logsDir, `verify-${originalTask.replace(/[^A-Za-z0-9._-]+/g, '-')}.log`);
  const logFd = fs.openSync(log, 'w'); // one log per task, overwritten per run — no retention machinery
  let child;
  try {
    child = spawn(process.execPath,
      [path.join(paths.packageRoot, 'bin/oathe.mjs'), 'verify', originalTask, ...(engine ? ['--engine', engine] : [])],
      { detached: true, cwd, env: scrubbedEnv(env), stdio: ['ignore', logFd, logFd] });
  } finally {
    fs.closeSync(logFd); // the child holds its own copy; the long-lived server must not leak one per dispatch
  }
  child.unref();

  return {
    started: true,
    task_id: originalTask,
    verification_task: verificationTask,
    engine,
    pid: child.pid,
    log,
    note: `verification of '${originalTask}' started in the background as ${verificationTask} — `
      + 'when it leaves the board the claim settled; a rejection reopens the task with the reason '
      + `recorded on ${verificationTask}'s completion statement. Engine log: ${log}`,
  };
}

/**
 * AWAIT a dispatched judgment's outcome from the substrate — the blocking half of the
 * local rule. The engine still runs in its own detached process; this only reads. The
 * wait is bounded by the CHILD'S OWN LIFE, never an arbitrary budget: verdict recorded →
 * the answer; failure statement recorded → the failure; child dead with neither (one
 * last read closes the exit race) → a typed failed outcome naming the retry.
 * @returns {Promise<{verdict: 'accepted'|'rejected', reason: string}
 *                  |{failed: true, reason: string}>}
 */
export async function awaitVerdict({
  taskId, pid, orgId, query, since,
  pollMs = 1000, isAlive = pidAlive, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const verificationTask = isVerificationTask(taskId) ? taskId : verificationTaskId(taskId);
  const originalTask = verificationTask.slice('verify:'.length);
  let lastChance = false;
  for (;;) {
    const { rows } = await query(
      `SELECT v.result, s.proposition
         FROM cell.verification v
         LEFT JOIN LATERAL (
              SELECT st.proposition FROM cell.agent_statement st
               WHERE st.org_id = v.org_id AND st.task_id = $3 AND st.statement_type = 'completion'
               ORDER BY st.asserted_at DESC LIMIT 1) s ON true
        WHERE v.org_id = $1 AND v.task_id = $2 AND v.recorded_at > $4
        ORDER BY v.recorded_at DESC LIMIT 1`,
      [orgId, originalTask, verificationTask, since]);
    if (rows[0]) {
      return {
        verdict: rows[0].result === 'rejected' ? 'rejected' : 'accepted',
        // The verdict statement reads "accepted: <reason>" / "rejected: <reason>" — hand back the reason.
        reason: String(rows[0].proposition ?? '').replace(/^(accepted|rejected):\s*/, '') || rows[0].result,
      };
    }
    // The failure is only REPORTABLE once the dead run has RELEASED its claim — returning
    // on the statement alone raced the child's yield and handed the caller a twin still
    // holding the lock (a retry dispatched in that beat read IN_FLIGHT — caught live).
    const { rows: twin } = await query(
      `SELECT state FROM cell.work_claim WHERE org_id = $1 AND task_id = $2
        ORDER BY claimed_at DESC LIMIT 1`, [orgId, verificationTask]);
    if (twin[0] && twin[0].state !== 'active') {
      const { rows: fail } = await query(
        `SELECT proposition FROM cell.agent_statement
          WHERE org_id = $1 AND task_id = $2 AND asserted_at > $3
            AND ${isEngineFailureSql('evidence_refs')}
          ORDER BY asserted_at DESC LIMIT 1`,
        [orgId, verificationTask, since]);
      if (fail[0]) return { failed: true, reason: fail[0].proposition };
    }
    if (lastChance) {
      return {
        failed: true,
        reason: `the verifier (pid ${pid}) died without recording a verdict — retry: oathe verify ${originalTask}`,
      };
    }
    if (!isAlive(pid)) { lastChance = true; continue; } // one final read closes the wrote-then-exited race
    await sleep(pollMs);
  }
}

/**
 * THE verifier seam — how a serving tool surface runs a verification, and WHERE topology
 * decides the blocking rule (founder ruling 2026-08-31: the trust boundary is the blocking
 * boundary). A LOCAL substrate owes the answer in-call — dispatch the detached child, then
 * await its verdict; when the substrate is REMOTE (the cloud), this seam is the one place
 * that flips to dispatch-and-return. Never an engine inside the server either way.
 */
export function verifierSeam({ orgId, query, paths, cwd, env = process.env }) {
  return async ({ taskId, engine = null }) => {
    const since = new Date().toISOString();
    const out = await dispatchVerification({ taskId, engine, orgId, query, paths, cwd, env });
    const outcome = await awaitVerdict({ taskId, pid: out.pid, orgId, query, since });
    return { ...outcome, log: out.log };
  };
}
