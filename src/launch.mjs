// oathe claude — pre-flight the project surfaces, then launch the interactive harness INSIDE
// the cage (spawnCaged: replaced environment, stamped fence, proven-empty teardown) with the
// session host observing cage liveness (never touching claim horizons — R1).
//
// The cage is reached through the runtime seam (resolveRuntimeProvider), not by a path import
// here — the runtime's cage lives outside oathe-runtime's exports map (pre-extraction) and is
// resolved by PATH from paths.cagePath inside OatheRuntimeProvider itself.

import fs from 'node:fs';
import path from 'node:path';

import { buildContext } from './context.mjs';
import { byName } from './harnesses/catalog.mjs';
import { SessionHost } from './session-host.mjs';
import { launchSessionEnv } from './launch-env.mjs';

export class LaunchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LaunchError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Ensure the cwd's context files carry the managed Oathe section (through the ONE activation
 * writer — src/activation.mjs), and that the global install exists.
 */
export async function preflight({ env = process.env, cwd = process.cwd(), exec, harness } = {}) {
  byName(harness); // the harness to launch is named by the caller — unknown or missing is the catalog's typed refusal
  const ctx = buildContext({ env, exec });
  const { manifest, version, substrate, paths, config } = ctx;
  await substrate.close(); // preflight itself never talks to the database
  if (!manifest.rows.some((r) => r.harness === harness)) {
    throw new LaunchError('OATHE_NOT_INSTALLED',
      `the ${harness} install is missing (no ${harness} rows in the install manifest) — `
      + 'run `oathe init` with that harness present first');
  }
  const { activateWorkspace } = await import('./activation.mjs');
  const { WorkspaceRegistry } = await import('./registry.mjs');
  const registry = new WorkspaceRegistry({ registryPath: paths.registryPath });
  const { workspace, synthetic, actions } = await activateWorkspace({
    cwd, env, manifest, registry, config, version, source: 'launcher:preflight', harness,
  });
  return { workspace, synthetic, actions };
}

/** POSIX-name keys only — what the cage can declare; the rest cannot ride an `env -i` word. */
function declarable(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && v !== undefined && v !== null && !String(v).includes('\0')) {
      out[k] = String(v);
    }
  }
  return out;
}

/**
 * Resolve `name` against the LAUNCH env's PATH (not the supervisor's — the cage's own resolver
 * reads process.env.PATH, which is not the environment the user asked us to launch from).
 */
function resolveOnPath(envPath, name) {
  for (const dir of String(envPath ?? '').split(':').filter(Boolean)) {
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  throw new LaunchError('OATHE_HARNESS_NOT_FOUND',
    `no executable '${name}' on PATH — is the harness installed?`, { name });
}

/** The hermetic whitelist: terminal plumbing + oathe wiring, nothing else. */
const HERMETIC_KEYS = ['PATH', 'HOME', 'TERM', 'USER', 'LANG', 'LC_ALL', 'SHELL', 'TMPDIR', 'COLORTERM'];

function curatedEnv(env, { hermetic, extra }) {
  if (!hermetic) return { ...declarable(env), ...extra };
  const out = {};
  for (const key of HERMETIC_KEYS) if (env[key] !== undefined) out[key] = String(env[key]);
  return { ...out, ...extra };
}

/**
 * ONE launcher, every launchable harness (Claude Code, Codex) — same cage, same session host,
 * same pre-flight; only the binary differs.
 *
 * @param {{harness: 'claude'|'codex', env?: object, cwd?: string, args?: string[],
 *          hermetic?: boolean, exec?: object, observeIntervalMs?: number}} o
 * @returns {Promise<{exitCode: number, teardown: object, workspace: string}>}
 */
export async function runHarness({
  harness, env = process.env, cwd = process.cwd(), args = [], hermetic = false, exec,
  observeIntervalMs = 60_000, out = process.stdout, stdin = process.stdin, pauseMs = 3000,
} = {}) {
  const { workspace, synthetic } = await preflight({ env, cwd, exec, harness });
  const ctx = buildContext({ env, exec, cwd });
  const { paths, substrate, identity, config } = ctx;

  // First launch in a folder: the verifier is CHOSEN, on the record, before any claim binds it.
  await ensureVerifierChoice({ config, harness, stdin, out });

  // The splash is the adapter's own quirk (codex buries hook output in its ctrl+T transcript
  // overlay, unrendered; Claude Code shows the systemMessage banner inside its own TUI).
  if (byName(harness).launch?.splash) {
    let openWork = false;
    try {
      const [{ renderBoard, renderSplash }, { Pager }, { WorkspaceRegistry }] = await Promise.all([
        import('./board-render.mjs'), import('./pager.mjs'), import('./registry.mjs'),
      ]);
      const registry = new WorkspaceRegistry({ registryPath: paths.registryPath });
      const digest = await new Pager({ client: substrate, identity, config, registry }).digest();
      const seen = await renderBoard({ client: substrate, identity, workspace, config, synthetic, digest });
      out.write(renderSplash({ digest, sections: seen.sections, workspace: seen.lens }));
      openWork = Object.values(seen.sections).some((rows) => rows.length > 0);
    } catch (e) {
      out.write(`Oathe board unavailable (${String(e?.message || e).slice(0, 120)})\n`);
    }
    if (openWork) await waitForLaunch({ harness, pauseMs, stdin, out });
  }

  const { resolveRuntimeProvider } = await import('./runtime/provider.mjs');
  const { spawnCaged } = await resolveRuntimeProvider({ config, paths }).cage();

  const unit = `oathe-${Date.now().toString(36)}-${process.pid}`;
  const extra = launchSessionEnv({ config, identity, cwd, harness });
  const cage = spawnCaged({
    unit,
    env: curatedEnv(env, { hermetic, extra }),
    cmd: resolveOnPath(env.PATH, byName(harness).launch?.bin ?? harness), // the adapter names its own binary
    args,
    cwd,
    stdio: 'inherit', // an interactive daily driver owns the terminal
  });

  const host = new SessionHost({
    client: substrate,
    identity,
    liveness: () => (cage.alive ? cage.alive() : cage.enumerate().length > 0),
    observeIntervalMs,
  });
  host.start();

  const exitCode = await new Promise((resolve) => {
    cage.child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  try {
    if (exitCode === 0) await host.stop({ exitCode });
    else await host.stopSilently(); // a non-zero exit was not a clean goodbye — leave the absence
  } finally {
    await substrate.close();
  }
  const teardown = await cage.teardownProvenEmpty();
  return { exitCode, teardown, workspace };
}

/**
 * The verifier is chosen ONCE, at `oathe init` (machine-wide, per-folder override via
 * `oathe config verifier <engine>`). Launch never prompts: an explicit choice passes
 * silently; a still-default value is ANNOUNCED on stderr — never silently assumed.
 * @returns {Promise<{chosen: string, prompted: boolean}>}
 */
export function ensureVerifierChoice({ config, err = process.stderr } = {}) {
  const chosen = config.get('verifier');
  if (config.source('verifier') === 'default') {
    err?.write?.(`verifier: ${chosen} (default — \`oathe init\` records the machine choice; `
      + 'override per folder with `oathe config verifier <engine>`)\n');
  }
  return Promise.resolve({ chosen, prompted: false });
}

/**
 * The readable-moment gate: give the splash `pauseMs` on screen, let Enter cut it short.
 * TTY-only on BOTH ends — scripts, pipes, and tests never wait. The stdin listener is removed
 * and the stream paused before the harness inherits it.
 */
export function waitForLaunch({ harness, pauseMs, stdin, out }) {
  if (stdin?.isTTY !== true || out?.isTTY !== true) return Promise.resolve();
  out.write(`  \x1b[2mstarting ${harness} in ${Math.round(pauseMs / 1000)}s — Enter to go now\x1b[0m\n`);
  return new Promise((resolve) => {
    let timer = null;
    const finish = () => {
      stdin.removeListener('data', finish);
      if (timer) clearTimeout(timer);
      stdin.pause();
      resolve();
    };
    // The timer stays ref'd on purpose: this promise is awaited before the harness spawns,
    // so the countdown must hold the event loop open even when stdin contributes no handle
    // (an unref'd timer here let the loop drain mid-wait and cancel the gate).
    timer = setTimeout(finish, pauseMs);
    stdin.on('data', finish);
    stdin.resume?.();
  });
}
