// oathe plugin hooks — the shared spine. The plugin ships INSIDE the package, so hooks import
// the package's own modules relatively; ${CLAUDE_PLUGIN_ROOT} only locates the script itself.
//
// A hook must NEVER break a session: every entry point runs through failSoft, which turns any
// substrate absence into a quiet note (SessionStart) or silence (Stop/PreCompact) and exit 0.

import { Substrate } from '../../src/substrate.mjs';
import { buildPaths } from '../../src/paths.mjs';
import { workspaceRef } from '../../src/workspace.mjs';
import path from 'node:path';
import { OatheConfig } from '../../src/config.mjs';

/** The hook's JSON input on stdin (Claude and Codex both deliver {cwd, hook_event_name, …}). */
export async function readHookInput() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try { return JSON.parse(raw); } catch { return {}; }
}

export function buildHookContext(input, env = process.env) {
  const paths = buildPaths(env);
  const cwd = input.cwd || process.cwd();
  const config = new OatheConfig({ env, cwd });
  // The session identity both harnesses hand every hook — the trace linkage rides on it.
  const session = input.session_id
    ? {
      sessionId: input.session_id,
      transcriptPath: input.transcript_path ?? null,
      harness: String(input.transcript_path ?? '').includes(`${path.sep}.codex${path.sep}`) ? 'codex' : 'claude',
    }
    : null;
  return {
    session,
    substrate: new Substrate({ database: config.get('db'), paths, env, config }),
    workspace: workspaceRef(cwd),
    identity: {
      orgId: config.get('org'),
      principalId: config.get('principal') || env.USER || 'operator',
      department: config.get('department'),
    },
    config,
    cwd,
  };
}

/**
 * The SessionStart hook's JSON frame: `context` reaches the MODEL as additional context,
 * `message` is the line the USER sees when the session loads — the visible confirmation that
 * oathe is watching this folder.
 */
export function emitSessionStart({ context, message }) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    systemMessage: message,
  })}\n`);
}

/**
 * Run `fn`; on any failure print `quietNote` (when given) as a visible session-load line and
 * exit 0 regardless. The board being unavailable is information for the session, never an
 * error that blocks it.
 */
export async function failSoft(fn, { quietNote = null } = {}) {
  let substrate = null;
  try {
    const input = await readHookInput();
    const ctx = buildHookContext(input);
    substrate = ctx.substrate;
    await fn(ctx, input);
  } catch (e) {
    const detail = String(e?.message || e);
    if (quietNote) emitSessionStart({ context: quietNote, message: `${quietNote} (${detail.slice(0, 120)})` });
    process.stderr.write(`oathe hook: ${detail}\n`);
  } finally {
    if (substrate) await substrate.close().catch(() => {});
  }
  process.exit(0);
}
