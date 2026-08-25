// oathe claude — pre-flight the project surfaces, then launch the interactive harness INSIDE
// the cage (spawnCaged: replaced environment, stamped fence, proven-empty teardown) with the
// session host renewing leases exactly as long as the cage shows life.
//
// The cage lives outside firia-runtime's exports map (pre-extraction), so it is imported by
// PATH from paths.cagePath — the one sanctioned path import, named in the plan.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildContext } from './context.mjs';
import { census } from './harness.mjs';
import { FencedBlock, FENCE_STYLES } from './blocks.mjs';
import { sha256Hex } from './manifest.mjs';
import { workspaceRef } from './workspace.mjs';
import { SessionHost } from './session-host.mjs';

export class LaunchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LaunchError';
    this.code = code;
    this.details = details;
  }
}

/** The managed section: an H2 inside HTML-comment fences — the estate-convention hybrid. */
function fenceBody(workspace) {
  return [
    '## Oathe',
    '',
    `This folder has an Oathe board (workspace \`${workspace}\`). Claims are speech acts: claim`,
    'before you build, record progress as statements, yield what you cannot finish — via the',
    '`oathe_*` MCP tools. The board renders at SessionStart; `continue <task>` picks work up.',
  ].join('\n');
}

/**
 * Ensure the cwd's CLAUDE.md (and AGENTS.md when Codex is installed) carries the managed Oathe
 * section, and that the global install exists. Creates a minimal file holding only the fence
 * when absent — recorded as a project-scope manifest row either way.
 */
export async function preflight({ env = process.env, cwd = process.cwd(), exec } = {}) {
  const ctx = buildContext({ env, exec });
  const { manifest, harnesses, version, substrate } = ctx;
  await substrate.close(); // preflight itself never talks to the database
  if (!manifest.rows.some((r) => r.harness === 'claude')) {
    throw new LaunchError('OATHE_NOT_INSTALLED',
      'the global install is missing (no claude rows in the install manifest) — run `oathe init` first');
  }
  const seen = census(harnesses);
  const workspace = workspaceRef(cwd);
  const block = new FencedBlock({ style: FENCE_STYLES.html });
  const targets = [{ file: 'CLAUDE.md', action: 'claude-md-fence' }];
  if (seen.find((s) => s.name === 'codex')?.installed) {
    targets.push({ file: 'AGENTS.md', action: 'agents-md-fence' });
  }
  const actions = [];
  for (const target of targets) {
    const file = path.join(cwd, target.file);
    manifest.backupOnce(file);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const { content, changed } = block.apply(before, { version, body: fenceBody(workspace) });
    if (changed) fs.writeFileSync(file, content);
    manifest.upsert({
      harness: 'project',
      file,
      kind: 'fence',
      scope: 'project',
      detail: { style: 'html' },
      blockVersion: version,
      sha256: sha256Hex(block.read(content).blockText),
    });
    actions.push({ action: target.action, file, changed });
  }
  manifest.save();
  return { workspace, actions };
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
 * @param {{env?: object, cwd?: string, args?: string[], hermetic?: boolean,
 *          exec?: object, renewIntervalMs?: number}} o
 * @returns {Promise<{exitCode: number, teardown: object, workspace: string}>}
 */
export async function runClaude({
  env = process.env, cwd = process.cwd(), args = [], hermetic = false, exec, renewIntervalMs = 60_000,
} = {}) {
  const { workspace } = await preflight({ env, cwd, exec });
  const ctx = buildContext({ env, exec });
  const { paths, substrate, identity } = ctx;
  const { spawnCaged } = await import(pathToFileURL(paths.cagePath).href);

  const unit = `oathe-${Date.now().toString(36)}-${process.pid}`;
  const extra = {
    OATHE_DB: env.OATHE_DB || 'oathe_local',
    OATHE_ORG: identity.orgId,
    OATHE_PRINCIPAL: identity.principalId,
    OATHE_DEPARTMENT: identity.department,
    OATHE_WORKSPACE_DIR: cwd,
  };
  const cage = spawnCaged({
    unit,
    env: curatedEnv(env, { hermetic, extra }),
    cmd: resolveOnPath(env.PATH, 'claude'),
    args,
    cwd,
    stdio: 'inherit', // an interactive daily driver owns the terminal
  });

  const host = new SessionHost({
    client: substrate,
    identity,
    workspace,
    liveness: () => cage.enumerate().length > 0,
    renewIntervalMs,
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
