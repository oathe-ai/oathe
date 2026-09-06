// oathe — the engine update as a CLAIM (ruling 2026-09-05, launch/2026-09-05-engines-places-plan.md
// Leg D). A judgment named an engine out of date; the fix is the engine's OWN updater, run by
// the machine and recorded like every other act: the update child claims `update:<harness>`
// (so the glass, `oathe ls` and attention read "updating <Name>" off one fact and a feed
// restart forgets nothing), states what it runs, runs it into a log, asserts done with the
// version measured after, settles under the operator seat at the deterministic bar, and
// re-verifies what the old version failed. A failure is a statement (ref update-failure:<h>),
// a yield, an amber notice and a typed refusal — never a silent success.

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

import { byName, displayFor } from './harnesses/catalog.mjs';
import { updateTaskId, updateObjective } from './plans.mjs';
import { updateFailureRef } from './statements.mjs';
import { emit as wireEmit } from './wire.mjs';
import { Verifier, completionStatementOf, settleReview } from './verifier.mjs';
import { Pager } from './pager.mjs';

export class EngineUpdateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** One process, its output tee'd to a log; resolves on exit with the stderr tail for the record. */
function runToLog({ spawn, bin, args, env, log }) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(log, { flags: 'a' });
    out.write(`$ ${[bin, ...args].join(' ')}\n`);
    let tail = '';
    let stdout = '';
    let child;
    try {
      child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      out.end(); resolve({ status: null, error, tail: error.message, stdout }); return;
    }
    child.stdout.on('data', (d) => { out.write(d); stdout += d; });
    child.stderr.on('data', (d) => { out.write(d); tail = (tail + d).slice(-2000); });
    child.on('error', (error) => { out.end(); resolve({ status: null, error, tail: tail || error.message, stdout }); });
    child.on('close', (status) => { out.end(); resolve({ status, tail: tail.trim().slice(-300), stdout }); });
  });
}

export class EngineUpdate {
  /**
   * @param {{substrate: object, paths: object, workspace: string, config: object, operatorPrincipal: string,
   *          manifest: {cliAddressFor: Function}, provider?: object|null, env?: object, spawn?: Function,
   *          onStart?: Function}} o onStart({harness, address, before, command, log}) — a caller's line before the run
   */
  constructor({ substrate, paths, workspace, config, operatorPrincipal, manifest, provider = null, env = process.env, spawn = nodeSpawn, onStart = () => {} }) {
    this.substrate = substrate;
    this.paths = paths;
    this.config = config;
    this.manifest = manifest;
    this.env = env;
    this.spawn = spawn;
    this.onStart = onStart;
    this.orgId = config.get('org');
    this.operatorPrincipal = operatorPrincipal;
    // The verification lane's own actor: its tools speak as the system seat, its runtime
    // settles, and it re-verifies — one object, one close().
    this.verifier = new Verifier({
      substrate, paths, workspace, config, operatorPrincipal, provider, env,
      addressFor: (engine) => manifest.cliAddressFor(engine),
    });
  }

  /**
   * @param {{harness: string, thenVerify?: boolean, task?: string|null}} o
   * @returns {Promise<{harness: string, address: string, before: string, after: string, update_task: string,
   *                    log: string, reverified: Array<{task_id: string, verdict?: string, error?: string}>}>}
   */
  async run({ harness, thenVerify = false, task = null }) {
    const adapter = this.#adapter(harness);
    const address = this.manifest.cliAddressFor(harness); // the recorded address or a refusal — never a PATH guess
    if (address === null) {
      throw new EngineUpdateError('OATHE_ENGINE_MISSING',
        `the '${harness}' CLI: no address was recorded for it — run oathe init to record where it is`, { harness });
    }
    const name = displayFor(harness) ?? harness;
    const updateTask = updateTaskId(harness);
    fs.mkdirSync(this.paths.logsDir, { recursive: true });
    const log = path.join(this.paths.logsDir, `update-${harness}.log`);
    fs.writeFileSync(log, '');
    const before = await this.#version(address, adapter);
    const [bin, args] = adapter.install.update(address);
    const command = [bin, ...args].join(' ');

    const tools = this.verifier.tools;
    await tools.oathe_claim({ task_id: updateTask, objective: updateObjective(harness, address) });
    await wireEmit(this.substrate, { kind: 'engine_update_started', task_id: updateTask, via: name });
    await tools.oathe_statement({ task_id: updateTask, proposition: `updating ${name} (${before}) via ${command}`, evidence_ref: `log:${log}` });
    this.onStart({ harness, address, before, command, log });

    const run = await runToLog({ spawn: this.spawn, bin, args, env: this.env, log });
    if (run.status !== 0) {
      const tail = run.tail || `exit ${run.status}`;
      const proposition = `update of ${harness} failed: ${tail}`;
      try {
        await tools.oathe_statement({ task_id: updateTask, proposition, evidence_ref: updateFailureRef(harness) });
        await tools.oathe_yield({ task_id: updateTask, note: `${name}'s updater refused — read ${log}, fix the cause, and update again` });
      } catch { /* best-effort release — the primary failure must surface either way */ }
      await wireEmit(this.substrate, { kind: 'engine_update_failed', task_id: updateTask, via: `${name}: ${tail}` });
      throw new EngineUpdateError('OATHE_ENGINE_UPDATE_FAILED',
        `${command} exited ${run.status ?? 'without running'}: ${tail} — log: ${log}`, { harness, address, status: run.status, log });
    }

    const after = await this.#version(address, adapter);
    const evidenceRef = `version:${after}`;
    const done = await tools.oathe_done({ task_id: updateTask, proposition: `updated ${name}: ${before} → ${after}`, evidence_ref: evidenceRef });
    // The update's own review settles under the OPERATOR seat at the deterministic bar — the
    // same close a judgment's verify: task gets (src/verifier.mjs settleReview).
    await settleReview({
      runtime: await this.verifier.runtime(), seat: this.operatorPrincipal, orgId: this.orgId, taskId: updateTask,
      plan: await this.verifier.planOf(updateTask),
      stmt: await completionStatementOf({ substrate: this.substrate, orgId: this.orgId, taskId: updateTask }),
      evidenceRefs: [evidenceRef], tracePath: `statement:${done.statement_id}`,
    });
    await wireEmit(this.substrate, { kind: 'engine_updated', task_id: updateTask, via: name });

    const reverified = thenVerify ? await this.#reverify({ harness, task }) : [];
    return { harness, address, before, after, update_task: updateTask, log, reverified };
  }

  /** Every stall this engine's old version caused (the pager's own reading), or the one task named — judged again by the updated engine. */
  async #reverify({ harness, task }) {
    const targets = task ? [task]
      : (await new Pager({ client: this.substrate, identity: { orgId: this.orgId }, config: this.config }).breaches())
        .filter((b) => b.kind === 'stalled' && b.engine === harness && b.cause === 'outdated' && !b.busy)
        .map((b) => b.task_id);
    const out = [];
    for (const taskId of targets) {
      try {
        const v = await this.verifier.verify({ taskId, engine: harness });
        out.push({ task_id: taskId, verdict: v.verdict });
      } catch (e) {
        out.push({ task_id: taskId, error: `[${e?.code ?? 'error'}] ${String(e?.message ?? e).slice(0, 200)}` });
      }
    }
    return out;
  }

  #adapter(harness) {
    let adapter;
    try { adapter = byName(harness); } catch (e) { throw new EngineUpdateError('OATHE_ENGINE_UNKNOWN', e.message, { harness }); }
    if (typeof adapter.install?.update !== 'function') {
      throw new EngineUpdateError('OATHE_ENGINE_UPDATE_UNSUPPORTED',
        `'${harness}' declares no in-place updater (src/harnesses/${harness}.mjs install.update) — update it the way you installed it`, { harness });
    }
    return adapter;
  }

  /** The CLI's version, measured (`<address> <versionArgs>`); 'unknown' when it will not say. */
  async #version(address, adapter) {
    const scratch = path.join(this.paths.logsDir, `.version-${path.basename(address)}.log`);
    const run = await runToLog({ spawn: this.spawn, bin: address, args: adapter.install.versionArgs, env: this.env, log: scratch });
    try { fs.rmSync(scratch, { force: true }); } catch { /* a scratch file */ }
    const line = String(run.stdout ?? '').trim().split('\n')[0];
    return run.status === 0 && line ? line : 'unknown';
  }

  async close() {
    await this.verifier.close();
  }
}
