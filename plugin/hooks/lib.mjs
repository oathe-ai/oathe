// oathe plugin hooks — the shared spine. The plugin ships INSIDE the package, so hooks import
// the package's own modules relatively; ${CLAUDE_PLUGIN_ROOT} only locates the script itself.
//
// A hook must NEVER break a session: every entry point runs through failSoft, which turns any
// substrate absence into a quiet note (SessionStart) or silence (Stop/PreCompact) and exit 0.
// Payloads arrive in each harness's own dialect (Claude/Codex: `cwd`; Cursor:
// `workspace_roots[]`) — the catalog's dialect sniff normalizes them, and the reply speaks the
// same dialect back. A session with no resolvable workspace exits silently: there is no board
// to speak about, and hooks are the one sanctioned fail-soft surface.

import fs from 'node:fs';
import path from 'node:path';

import { Substrate } from '../../src/substrate.mjs';
import { buildPaths, homeOf } from '../../src/paths.mjs';
import { OatheConfig } from '../../src/config.mjs';

import { dialectFor, ownerOfTracePath } from '../../src/harnesses/catalog.mjs';
import { cwdDialect } from '../../src/harnesses/dialects.mjs';
import { WorkspaceResolver } from '../../src/workspace-resolver.mjs';

/** The hook's JSON input on stdin, whichever dialect the harness speaks. */
export async function readHookInput() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
  // Drift monitors: with OATHE_HOOK_CAPTURE_DIR set, the RAW payload is written before any
  // normalization — the live lane compares what the harness actually sends against the pinned
  // fixtures. Off by default; a capture failure never costs the session (fail-soft surface).
  const captureDir = process.env.OATHE_HOOK_CAPTURE_DIR;
  if (captureDir) {
    try {
      fs.mkdirSync(captureDir, { recursive: true });
      fs.writeFileSync(path.join(captureDir, `${input.hook_event_name ?? 'unknown'}-${Date.now()}.json`), raw);
    } catch (e) {
      process.stderr.write(`oathe hook: capture ${String(e?.message || e)}\n`);
    }
  }
  return input;
}

export async function buildHookContext(input, env = process.env) {
  const paths = buildPaths(env);
  const dialect = dialectFor(input) ?? cwdDialect;
  const normalized = dialect.normalizePayload(input ?? {});
  // A payload naming a directory is described outright; one without falls to the resolution
  // ladder (env vars, guarded cwd). Either way the facts (ref, synthetic) come from the one
  // describer. An unresolvable session throws OATHE_WORKSPACE_UNRESOLVED — failSoft exits silently.
  const home = homeOf(env);
  const place = normalized.cwd
    ? WorkspaceResolver.describe({ dir: normalized.cwd, home })
    : await new WorkspaceResolver({ env, home }).resolve();
  const cwd = place.dir;
  const config = new OatheConfig({ env, cwd });
  // The session identity the harness hands every hook — the trace linkage rides on it.
  const session = normalized.sessionId
    ? {
      sessionId: normalized.sessionId,
      transcriptPath: normalized.transcriptPath,
      harness: ownerOfTracePath(normalized.transcriptPath ?? ''),
    }
    : null;
  return {
    session,
    substrate: new Substrate({ database: config.get('db'), paths, env, config }),
    workspace: place.ref,
    synthetic: place.synthetic, // R-BOARD-SCOPE: a staging dir serves the full board
    identity: {
      orgId: config.get('org'),
      principalId: config.get('principal') || env.USER || 'operator',
      department: config.get('department'),
    },
    config,
    cwd,
    dialect,
    paths,
    env,
  };
}

/**
 * The SessionStart reply in the session's own dialect: `context` reaches the MODEL, `message`
 * is the user-visible line (dialects without a message channel carry context only).
 */
export function emitSessionStart({ context, message, dialect = cwdDialect }) {
  process.stdout.write(dialect.formatSessionStart({ context, message }));
}

/**
 * The session's liveness signal — SessionStart and the heartbeat both speak it, so a living
 * session is never invisible (a pre-feature or resumed session converges at its next turn).
 * The ps walk rides the facts thunk: paid only when the registry actually (re)registers.
 * Fail-soft on its own: a broken registry costs the facts, never the session.
 */
export async function ensureSessionRegistered({ session, paths, workspace = undefined }) {
  try {
    if (!session?.sessionId) return;
    const { SessionRegistry, processAncestry, nearestAppBundle } = await import('../../src/sessions.mjs');
    const { ownedAncestorIndex } = await import('../../src/harnesses/catalog.mjs');
    // The row describes THE HARNESS PROCESS, not whatever interposer spawned the hook
    // (cursor-agent runs hooks through a short-lived /bin/zsh — registering the shell's pid
    // would sweep the session the moment the shell exits). Walk up to the nearest
    // adapter-owned ancestor; a chain with none (fixtures, bare runners) keeps the ppid.
    const walk = processAncestry({ pid: process.ppid });
    const owned = ownedAncestorIndex(walk);
    const ancestry = owned <= 0 ? walk : walk.slice(owned);
    await new SessionRegistry({ sessionsPath: paths.sessionsPath }).ensure({
      sessionId: session.sessionId,
      pid: ancestry[0]?.pid ?? process.ppid,
      facts: () => ({
        ancestry,
        app: nearestAppBundle(ancestry),
        transcriptPath: session.transcriptPath ?? undefined,
        workspace,
      }),
    });
  } catch (e) {
    process.stderr.write(`oathe hook: sessions ${String(e?.message || e)}\n`);
  }
}

/**
 * Run `fn`; on failure print `quietNote` (when given) as a visible session-load line and exit 0
 * regardless. The board being unavailable is information for the session, never an error that
 * blocks it — and a session with no resolvable workspace has no board to mention at all.
 */
export async function failSoft(fn, { quietNote = null } = {}) {
  let substrate = null;
  let dialect = cwdDialect;
  try {
    const input = await readHookInput();
    dialect = dialectFor(input) ?? cwdDialect;
    const ctx = await buildHookContext(input);
    substrate = ctx.substrate;
    await fn(ctx, input);
  } catch (e) {
    if (e?.code !== 'OATHE_WORKSPACE_UNRESOLVED') {
      const detail = String(e?.message || e);
      if (quietNote) emitSessionStart({ context: quietNote, message: `${quietNote} (${detail.slice(0, 120)})`, dialect });
      process.stderr.write(`oathe hook: ${detail}\n`);
    }
  } finally {
    if (substrate) await substrate.close().catch(() => {});
  }
  process.exit(0);
}
