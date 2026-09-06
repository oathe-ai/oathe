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

import { isVerificationTask, verificationTaskId, verifiedTaskId, updateTaskId } from './plans.mjs';
import { isVerifyStallSql } from './statements.mjs';
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
/**
 * A system task already HELD refuses a second dispatch — the row already says what is running.
 * @param {{what: string}} o what — the act in words ("a verification of 'x'", "an update of 'codex'")
 */
async function refuseIfHeld({ query, orgId, taskId, clock, code, what }) {
  const { rows } = await query(
    `SELECT principal_id, state, ownership_valid_until
       FROM cell.work_claim WHERE org_id = $1 AND task_id = $2
      ORDER BY claimed_at DESC LIMIT 1`, [orgId, taskId]);
  const latest = rows[0];
  if (latest?.state !== 'active') return;
  const until = latest.ownership_valid_until ? new Date(latest.ownership_valid_until) : null;
  const expired = until !== null && until < clock();
  throw new VerifyDispatchError(code,
    expired
      ? `${what} is still claimed by ${latest.principal_id} but its `
        + `lease expired ${until.toISOString()} — likely a dead run; \`oathe yield ${taskId}\` `
        + 'releases it, then dispatch again'
      : `${what} is already running — claimed by ${latest.principal_id}`
        + `${until ? ` until ${until.toISOString()}` : ''}; its outcome lands on the board`,
    { system_task: taskId, verification_task: taskId, holder: latest.principal_id, expired });
}

/**
 * The ONE detached spawn of a bin verb: own process group (it outlives the session, the feed,
 * the daemon), a log under logsDir overwritten per run (no retention machinery), a scrubbed env.
 * @returns {{pid: number, log: string}}
 */
function spawnDetachedVerb({ paths, args, cwd, env, logName, spawn }) {
  fs.mkdirSync(paths.logsDir, { recursive: true });
  const log = path.join(paths.logsDir, `${logName.replace(/[^A-Za-z0-9._-]+/g, '-')}.log`);
  const logFd = fs.openSync(log, 'w');
  let child;
  try {
    child = spawn(process.execPath, [path.join(paths.packageRoot, 'bin/oathe.mjs'), ...args],
      { detached: true, cwd, env: scrubbedEnv(env), stdio: ['ignore', logFd, logFd] });
  } finally {
    fs.closeSync(logFd); // the child holds its own copy; the long-lived server must not leak one per dispatch
  }
  child.unref();
  return { pid: child.pid, log };
}

export async function dispatchVerification({
  taskId, engine = null, orgId, query, paths, cwd, env, spawn = nodeSpawn, clock = () => new Date(),
}) {
  const verificationTask = isVerificationTask(taskId) ? taskId : verificationTaskId(taskId);
  const originalTask = verifiedTaskId(verificationTask);
  await refuseIfHeld({ query, orgId, taskId: verificationTask, clock, code: 'OATHE_VERIFY_IN_FLIGHT', what: `a verification of '${originalTask}'` });
  const { pid, log } = spawnDetachedVerb({
    paths, cwd, env, spawn, logName: `verify-${originalTask}`,
    args: ['verify', originalTask, ...(engine ? ['--engine', engine] : [])],
  });
  return {
    started: true,
    task_id: originalTask,
    verification_task: verificationTask,
    engine,
    pid,
    log,
    note: `verification of '${originalTask}' started in the background as ${verificationTask} — `
      + 'when it leaves the board the claim settled; a rejection reopens the task with the reason '
      + `recorded on ${verificationTask}'s completion statement. Engine log: ${log}`,
  };
}

/**
 * The glass's `update ↗` (ruling 2026-09-05): `oathe engine update <harness> --then-verify`
 * detached through the same spawn as a judgment. The child CLAIMS `update:<harness>`, so the
 * next frame reads "updating <Harness>" off the substrate — this process remembers nothing.
 * @returns {Promise<{started: true, harness: string, update_task: string, pid: number, log: string, note: string}>}
 */
export async function dispatchEngineUpdate({ harness, orgId, query, paths, cwd, env, spawn = nodeSpawn, clock = () => new Date() }) {
  const updateTask = updateTaskId(harness);
  await refuseIfHeld({ query, orgId, taskId: updateTask, clock, code: 'OATHE_UPDATE_IN_FLIGHT', what: `an update of '${harness}'` });
  const { pid, log } = spawnDetachedVerb({
    paths, cwd, env, spawn, logName: `update-${harness}`, args: ['engine', 'update', harness, '--then-verify'],
  });
  return {
    started: true, harness, update_task: updateTask, pid, log,
    note: `updating ${harness} in the background as ${updateTask} — when it leaves the board the CLI updated `
      + `and every judgment its old version failed re-runs; a failure lands on ${updateTask}'s record. Log: ${log}`,
  };
}

/**
 * AWAIT a dispatched judgment's outcome from the substrate — the blocking half of the
 * local rule. The engine still runs in its own detached process; this only reads. The
 * wait is bounded by the CHILD'S OWN LIFE, never an arbitrary budget: verdict recorded →
 * the answer; failure statement recorded → the failure; child dead with neither (one
 * last read closes the exit race) → a typed failed outcome naming the retry.
 * While it waits it TICKS (ruling 2026-09-05): `onTick({elapsedMs})` every `tickMs` — the one
 * signal a transport forwards as MCP progress so a client's per-tool clock knows the judgment
 * is still running. No `onTick`, no ticking.
 * @returns {Promise<{verdict: 'accepted'|'rejected', reason: string}
 *                  |{failed: true, reason: string}>}
 */
export async function awaitVerdict({
  taskId, pid, orgId, query, since,
  pollMs = 1000, isAlive = pidAlive, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onTick = null, tickMs = null, now = Date.now,
}) {
  const verificationTask = isVerificationTask(taskId) ? taskId : verificationTaskId(taskId);
  const originalTask = verifiedTaskId(verificationTask);
  const started = now();
  let nextTick = onTick && tickMs ? started + tickMs : null;
  let lastChance = false;
  for (;;) {
    if (nextTick !== null && now() >= nextTick) {
      onTick({ elapsedMs: now() - started });
      nextTick += tickMs;
    }
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
            AND ${isVerifyStallSql('evidence_refs')}
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
export function verifierSeam({
  orgId, query, paths, cwd, env = process.env, progressIntervalMs = null,
  spawn = undefined, pollMs = undefined, sleep = undefined, now = undefined, isAlive = undefined,
}) {
  const waitOptions = Object.fromEntries(Object.entries({ pollMs, sleep, now, isAlive }).filter(([, v]) => v !== undefined));
  return async ({ taskId, engine = null, progress = null }) => {
    const since = new Date().toISOString();
    const out = await dispatchVerification({ taskId, engine, orgId, query, paths, cwd, env, ...(spawn && { spawn }) });
    // The caller's progress emitter (a transport's MCP notification, the CLI's stderr) hears one
    // line per interval — Node's words, the transport only forwards them.
    const onTick = progress && progressIntervalMs
      ? ({ elapsedMs }) => progress(`verifying ${taskId} — ${Math.round(elapsedMs / 1000)}s`)
      : null;
    const outcome = await awaitVerdict({ taskId, pid: out.pid, orgId, query, since, onTick, tickMs: progressIntervalMs, ...waitOptions });
    return { ...outcome, log: out.log };
  };
}
