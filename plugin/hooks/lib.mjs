// oathe plugin hooks — the shared spine. The plugin ships INSIDE the package, so hooks import
// the package's own modules relatively; ${CLAUDE_PLUGIN_ROOT} only locates the script itself.
//
// A hook must NEVER break a session: every entry point runs through failSoft, which turns any
// substrate absence into a quiet note (SessionStart) or silence (Stop/PreCompact) and exit 0.

import { Substrate } from '../../src/substrate.mjs';
import { buildPaths } from '../../src/paths.mjs';
import { workspaceRef } from '../../src/workspace.mjs';

/** The hook's JSON input on stdin (Claude and Codex both deliver {cwd, hook_event_name, …}). */
export async function readHookInput() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try { return JSON.parse(raw); } catch { return {}; }
}

export function buildHookContext(input, env = process.env) {
  const paths = buildPaths(env);
  const cwd = input.cwd || process.cwd();
  return {
    substrate: new Substrate({ database: env.OATHE_DB || 'oathe_local', paths, env }),
    workspace: workspaceRef(cwd),
    identity: {
      orgId: env.OATHE_ORG || 'oathe',
      principalId: env.OATHE_PRINCIPAL || env.USER || 'operator',
      department: env.OATHE_DEPARTMENT || 'founder',
    },
    cwd,
  };
}

/**
 * Run `fn`; on any failure print `quietNote` (when given) and exit 0 regardless. The board being
 * unavailable is information for the session, never an error that blocks it.
 */
export async function failSoft(fn, { quietNote = null } = {}) {
  let substrate = null;
  try {
    const input = await readHookInput();
    const ctx = buildHookContext(input);
    substrate = ctx.substrate;
    await fn(ctx, input);
  } catch (e) {
    if (quietNote) process.stdout.write(`${quietNote} (${String(e?.message || e).slice(0, 120)})\n`);
    process.stderr.write(`oathe hook: ${String(e?.message || e)}\n`);
  } finally {
    if (substrate) await substrate.close().catch(() => {});
  }
  process.exit(0);
}
