#!/usr/bin/env node
// oathe — the live-behaviour lane (drift monitors P3). Hook payload shapes, transcript formats
// and headless output shapes can only be checked by running a REAL session: one headless
// prompt in a sandboxed, oathe-wired project, then four assertions against what came back —
// the model's text extracted from stdout; our SessionStart hook captured the harness's raw
// payload (OATHE_HOOK_CAPTURE_DIR); that payload normalizes through the adapter's declared
// dialect (a field diff against the pinned fixture on failure); the project registered — the
// board reached the session through our own hook; and, for engines, the session's transcript
// projects through the doctor (RUNTIME told apart from DRIFT). Auth is the harness's
// documented non-interactive env (the CI path); `--in-place` runs in the developer's own HOME
// with their login instead of a sandbox.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { HARNESS_CLASSES, dialectFor } from '../src/harnesses/catalog.mjs';
import { WorkspaceRegistry } from '../src/registry.mjs';
import { workspaceRef } from '../src/workspace.mjs';
import { buildPaths } from '../src/paths.mjs';
import { LaneReport, EXIT_REFUSED } from './lane-report.mjs';
import { sandboxEnv, installedBin } from './harness-install-contract.mjs';

export { EXIT_FAILED, EXIT_REFUSED } from './lane-report.mjs';
export const LIVE_MARKER = 'OATHE-LIVE-OK';
const PROMPT = `Reply with exactly this token and nothing else: ${LIVE_MARKER}`;

export class LiveContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LiveContractError';
    this.code = code;
  }
}

function defaultSpawn({ cmd, args, env, cwd }) {
  const r = spawnSync(cmd, args, { env, cwd, encoding: 'utf8', timeout: 240_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : (r.stderr ?? '') };
}

async function defaultTraceStatus(harness, env) {
  const { runDoctor } = await import('../src/doctor.mjs');
  return (await runDoctor({ env })).traces[harness]?.status ?? 'store-absent';
}

const packageRoot = () => path.dirname(path.dirname(fs.realpathSync(new URL(import.meta.url).pathname)));

/** The newest pinned payload for a harness — the shape the field diff is reported against. */
function pinnedPayload(harness) {
  const dir = path.join(packageRoot(), 'tests/fixtures/hooks', harness);
  const newest = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().at(-1);
  return JSON.parse(fs.readFileSync(path.join(dir, newest), 'utf8')).payload;
}

const isSessionStart = (payload) => String(payload?.hook_event_name ?? '').toLowerCase() === 'sessionstart';

/**
 * @param {{harness: string, env: NodeJS.ProcessEnv, projectDir: string, spawn?: Function,
 *          requireAuthEnv?: boolean, traceStatus?: Function, captureDir?: string}} o
 *   env — sandboxed (CI) or the developer's own (--in-place); spawn({cmd,args,env,cwd}) runs the
 *   harness; traceStatus(harness, env) answers the doctor's trace status.
 * @returns {Promise<LaneReport>}
 */
export async function runLiveContract({
  harness, env, projectDir, spawn = defaultSpawn, requireAuthEnv = true, traceStatus = defaultTraceStatus,
  captureDir = fs.mkdtempSync(path.join(os.tmpdir(), `oathe-live-capture-${harness}-`)),
}) {
  const Adapter = HARNESS_CLASSES.find((C) => C.harnessName === harness);
  if (!Adapter || Adapter.headless === null) {
    throw new LiveContractError('OATHE_LIVE_CONTRACT_UNKNOWN_HARNESS',
      `no live-testable harness '${harness}' — known: ${HARNESS_CLASSES.filter((C) => C.headless !== null).map((C) => C.harnessName).join(', ')}`);
  }
  const { auth, command, extract } = Adapter.headless;
  if (requireAuthEnv) {
    const missing = auth.filter((name) => !env[name]);
    if (missing.length > 0) {
      throw new LiveContractError('OATHE_LIVE_CONTRACT_AUTH_MISSING',
        `${harness}'s non-interactive mode authenticates with ${missing.join(', ')} — not set (a CI secret; or run --in-place with your own login)`);
    }
  }
  const report = new LaneReport({ lane: 'live-contract', harness });

  const [cmd, args] = command(PROMPT);
  const run = spawn({ cmd, args, env: { ...env, OATHE_HOOK_CAPTURE_DIR: captureDir }, cwd: projectDir });

  // 1. the model answered, in the documented output shape
  let text = '';
  try { text = run.status === 0 ? extract(run.stdout) : ''; } catch (e) { text = ''; run.stderr = `${e.message}; ${run.stderr}`; }
  report.add('headless-output', run.status === 0 && text.trim() !== '',
    run.status !== 0 ? `exit ${run.status}: ${run.stderr.trim().split('\n').at(-1) ?? ''}`
      : text.trim() === '' ? `no text extracted from stdout (${run.stdout.slice(0, 80)}…)`
        : `marker ${text.includes(LIVE_MARKER) ? 'echoed' : 'paraphrased'}`);

  // 2. our SessionStart hook fired and captured the harness's raw payload
  const captures = fs.existsSync(captureDir)
    ? fs.readdirSync(captureDir).sort().map((f) => { try { return JSON.parse(fs.readFileSync(path.join(captureDir, f), 'utf8')); } catch { return null; } }).filter(Boolean)
    : [];
  const start = captures.find(isSessionStart) ?? null;
  report.add('hook-captured', start !== null,
    start ? `events: ${captures.map((c) => c.hook_event_name).join(', ')}`
      : captures.length ? `captured ${captures.map((c) => c.hook_event_name).join(', ')} but no SessionStart` : 'no hook fired — nothing captured');

  // 3. the payload normalizes through the declared dialect; a field diff against the pin on failure
  if (start) {
    const dialect = dialectFor(start);
    const normalized = dialect?.normalizePayload(start) ?? {};
    // cwd and a session id are every dialect's promise; a transcript path only where the trace
    // layer reads one (engines) — Cursor's CLI sends transcript_path: null (recorded live 2026-08-29).
    const ok = dialect === Adapter.hooks.dialect && typeof normalized.cwd === 'string'
      && typeof normalized.sessionId === 'string' && normalized.sessionId !== ''
      && (Adapter.traces === null || (typeof normalized.transcriptPath === 'string' && normalized.transcriptPath !== ''));
    const pin = pinnedPayload(harness);
    const missing = Object.keys(pin).filter((k) => !(k in start));
    const added = Object.keys(start).filter((k) => !(k in pin));
    report.add('hook-normalizes', ok, ok ? (added.length ? `new fields since the pin: ${added.join(', ')}` : 'fields as pinned')
      : `dialect ${dialect === Adapter.hooks.dialect ? 'matched' : 'did NOT match'}; normalized ${JSON.stringify(normalized)}; `
        + `vs pin — missing: [${missing.join(', ')}] new: [${added.join(', ')}]`);
  } else {
    report.add('hook-normalizes', false, 'no SessionStart payload to normalize');
  }

  // 4. the board reached the session: our hook registered the project
  const paths = buildPaths(env);
  let registered = false;
  try { registered = new WorkspaceRegistry({ registryPath: paths.registryPath }).get(workspaceRef(projectDir)) !== null; } catch { registered = false; }
  report.add('board-reached-session', registered, registered ? '' : `${projectDir} never registered — the SessionStart hook did not run our activation`);

  // 5. the session's LIVING process registered — the notch can meet it and name it. The
  //    failure detail prints the observed exec chain against the pinned process-identity
  //    fixtures: THEIR app moved something if this drifts.
  {
    const { SessionRegistry, pidAlive } = await import('../src/sessions.mjs');
    const { surfaceForSession } = await import('../src/harnesses/catalog.mjs');
    const sessionId = start ? (dialectFor(start)?.normalizePayload(start)?.sessionId ?? null) : null;
    let row = null;
    try { row = sessionId ? new SessionRegistry({ sessionsPath: paths.sessionsPath }).get(sessionId) : null; } catch { row = null; }
    const surface = row ? surfaceForSession({ ancestry: row.ancestry, app: row.app, transcriptPath: row.transcript_path }) : null;
    // Aliveness is the NOTCH's read-time concern — a headless session has exited by now,
    // for real CLIs too. The lane pins registration + naming; liveness rides the detail.
    // Naming rides process ancestry, a darwin fact (src/sessions.mjs processAncestry gives
    // [] elsewhere, by design) — off darwin an unnamed-but-registered session is the
    // RUNTIME's bound, not harness drift, exactly as check 6 treats an old Node.
    const namingBound = process.platform !== 'darwin' && row !== null && row.ancestry.length === 0;
    const ok = row !== null && (surface !== null || namingBound);
    report.add('session-registered', ok,
      !ok ? (row === null ? 'no sessions.json row — the SessionStart hook did not register the living process'
        : `nobody owns this process — observed exec chain: ${row.ancestry.map((a) => a.exec).join(' ← ') || '(empty)'};`
          + ` compare tests/fixtures/process-identity/${harness}/`)
        : namingBound ? `registered (pid ${row.pid}); naming degrades off darwin — ancestry is a darwin fact`
          : `${surface} (pid ${row.pid} ${pidAlive(row.pid) ? 'alive' : 'exited'}${row.app ? `, ${path.basename(row.app.bundle)}` : ', no app'})`);
  }

  // 6. engines: the session's transcript projects AND the store censuses clean — the
  // doctor's trace status is census-backed (roster + fidelity over the recent window), so
  // the freshest CLI's own rollout is swept the night it lands (RUNTIME stays the
  // environment, never drift).
  if (Adapter.traces !== null) {
    const status = await traceStatus(harness, env);
    report.add('transcript-projects', status === 'ok',
      status === 'ok' ? '' : status === 'RUNTIME' ? 'RUNTIME — this runtime cannot read the store (node:sqlite needs Node >= 22.13); not harness drift'
        : status === 'store-absent' ? 'no transcript found under HOME — the session left no record' : `${status}`);
  }
  return report;
}

/**
 * The DESKTOP drift monitor — `harness-live-contract.mjs surfaces`. No session is spawned:
 * desktop apps (ChatGPT's embedded codex, Cursor's helper) can't run headless, so their
 * drift is checked against THIS machine's own disk and process table, per pinned
 * process-identity fixture whose harness exec lives INSIDE the expected app bundle:
 *   - the pinned exec must still exist on disk — their update MOVED it if this fails;
 *   - when the process is live, its REAL ancestry must still classify to the expected
 *     surface — their update RESHAPED the tree if this fails (chain printed for re-pinning);
 *   - the app merely not running is a note, never a pass stolen or a failure invented.
 * Terminal-hosted chains stay the headless lane's business.
 */
export async function surfacesReport({ fixturesDir, psTable } = {}) {
  const report = new LaneReport({ lane: 'live-contract', harness: 'surfaces' });
  const { processAncestry, nearestAppBundle } = await import('../src/sessions.mjs');
  const { surfaceForSession } = await import('../src/harnesses/catalog.mjs');
  const root = fixturesDir ?? path.join(path.dirname(new URL(import.meta.url).pathname), '../tests/fixtures/process-identity');
  const table = psTable ?? spawnSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).stdout ?? '';
  const live = table.split('\n')
    .map((l) => l.match(/^\s*(\d+)\s+\d+\s+(.+)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), exec: m[2] }));
  for (const harness of fs.readdirSync(root).sort()) {
    for (const file of fs.readdirSync(path.join(root, harness)).sort()) {
      const fx = JSON.parse(fs.readFileSync(path.join(root, harness, file), 'utf8'));
      const bundle = fx.expected?.app?.bundle;
      const signature = fx.payload?.ancestry?.[0]?.exec ?? '';
      if (!bundle || !signature.startsWith(`${bundle}/`)) continue; // not a desktop-embedded chain
      const name = `${harness}/${file.replace(/\.json$/, '')}`;
      if (!fs.existsSync(signature)) {
        report.add(name, false, `pinned exec is GONE from disk: ${signature} — their update moved it; re-trace and re-pin`);
        continue;
      }
      const proc = live.find((p) => p.exec === signature);
      if (!proc) {
        report.add(name, true, `binary as pinned; process not live (open ${path.basename(bundle)} to exercise the walk)`);
        continue;
      }
      const ancestry = processAncestry({ pid: proc.pid });
      const surface = surfaceForSession({ ancestry, app: nearestAppBundle(ancestry) });
      report.add(name, surface === fx.expected.surface,
        surface === fx.expected.surface
          ? `${surface} (live pid ${proc.pid})`
          : `classified '${surface}', fixture expects '${fx.expected.surface}' — observed chain: `
            + `${ancestry.map((a) => a.exec).join(' ← ') || '(empty)'}`);
    }
  }
  return report;
}

async function main(argv) {
  const harness = argv.find((a) => !a.startsWith('--'));
  const inPlace = argv.includes('--in-place');
  const known = HARNESS_CLASSES.filter((C) => C.headless !== null).map((C) => C.harnessName);
  if (harness === 'surfaces') {
    const report = await surfacesReport();
    process.stdout.write(`live-contract: desktop surface identity on this machine\n${report.render()}`);
    return report.exitCode;
  }
  if (!harness) {
    process.stderr.write(`live-contract: refused — usage: harness-live-contract.mjs <${known.join('|')}|surfaces> [--in-place]\n`);
    return EXIT_REFUSED;
  }
  let sandbox = null;
  try {
    let env = process.env;
    if (!inPlace) {
      sandbox = sandboxEnv({ harness, fromTarball: true });
      env = sandbox.env;
      const init = spawnSync(installedBin({ home: sandbox.home }), ['init', '--harness', harness, '--yes'], { env, encoding: 'utf8' });
      if (init.status !== 0) throw new LiveContractError('OATHE_LIVE_CONTRACT_INIT_FAILED', `oathe init failed in the sandbox: ${(init.stderr || init.stdout).trim().split('\n').at(-1)}`);
    }
    const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `oathe-live-project-${harness}-`)));
    const report = await runLiveContract({ harness, env, projectDir, requireAuthEnv: !inPlace });
    process.stdout.write(`live-contract: ${harness} ${inPlace ? 'in place (your login)' : `in ${sandbox.home}`}, project ${projectDir}\n${report.render()}`);
    if (report.ok) { fs.rmSync(projectDir, { recursive: true, force: true }); if (sandbox) fs.rmSync(sandbox.home, { recursive: true, force: true }); }
    else process.stderr.write(`live-contract: kept for inspection — project ${projectDir}${sandbox ? `, sandbox ${sandbox.home}` : ''}\n`);
    return report.exitCode;
  } catch (e) {
    process.stderr.write(`live-contract: refused — ${e?.code ? `[${e.code}] ` : ''}${e.message}\n`);
    return EXIT_REFUSED;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
