// oathe — the SPEAKER primitive (founder ruling 2026-08-30): every speech act is spoken by
// someone, and the writer resolves WHO from its own process ancestry — never from the
// model's word, never from a client's self-declared name when the process tree says more
// (ChatGPT-embedded codex is 'chatgpt', not 'codex'). One resolution, one shape:
//
//   { surface:  string|null   — which glass is speaking, named by the adapters
//     app:      {bundle,pid}|null — the focusable app above the speaker (the switch target)
//     session:  {sessionId, transcriptPath|null, harness}|null — the registered harness
//               session this process speaks FOR, found by the parent chain in the device's
//               session registry (~/.oathe/sessions.json) }
//
// Each field is observed truth or null: a bare terminal has no session; a desktop surface
// with no hooks has surface + app but no session. Observation gaps (ps failing, no registry
// file) resolve to nulls; a MALFORMED registry refuses typed through load() — a broken
// invariant is never smoothed over (no fail-soft outside hooks).
//
// The two homes this primitive spans (cloud posture, founder ruling): the substrate keeps
// the PORTABLE fact (which session spoke — written by linkTrace at the act); this device's
// sessions.json keeps the DEVICE fact (which process embodies it now).

import fs from 'node:fs';

import { processAncestry, nearestAppBundle, SessionRegistry } from './sessions.mjs';
import { surfaceForSession, harnessForClient, ownerOfTracePath, ownedAncestorIndex, transcriptFor, HARNESS_CLASSES } from './harnesses/catalog.mjs';

/**
 * @param {{pid?: number, sessionsPath: string, clientName?: string|null,
 *          exec?: object, platform?: string}} o — exec/platform are test seams for the walk
 * @returns {{surface: string|null, app: {bundle: string, pid: number}|null,
 *            session: {sessionId: string, transcriptPath: string|null, harness: string}|null}}
 */
export function resolveSpeaker({ pid = process.pid, sessionsPath, clientName = null, exec, platform } = {}) {
  // The ancestry is a fact of the PROCESS: walked once (one ps call), never per act.
  const walk = processAncestry({
    pid,
    ...(exec !== undefined && { exec }),
    ...(platform !== undefined && { platform }),
  });
  const registry = sessionsPath ? new SessionRegistry({ sessionsPath }) : null;

  const shape = () => {
    const hit = registry ? registry.byAncestry(walk) : null;
    if (hit) {
      const { row } = hit;
      const ownedRow = ownedAncestorIndex(row.ancestry ?? []);
      const harnessExec = (ownedRow === -1 ? row.ancestry?.[0]?.exec : row.ancestry[ownedRow].exec) ?? '';
      return {
        surface: surfaceForSession({ ancestry: row.ancestry ?? [], app: row.app ?? null, transcriptPath: row.transcript_path ?? null })
          ?? harnessForClient(clientName),
        app: row.app ?? nearestAppBundle(walk),
        session: {
          sessionId: hit.sessionId,
          // The file the session's rows live in — the registry holds what the hook was told,
          // which a resume or compaction rotates away from (the store resolves; see traces.mjs).
          transcriptPath: transcriptFor({ sessionId: hit.sessionId, reportedPath: row.transcript_path ?? null }),
          // The adapter that owns the session: its trace store first, else its own process.
          harness: ownerOfTracePath(row.transcript_path ?? '')
            ?? HARNESS_CLASSES.find((C) => C.surfaces?.ownsExec(harnessExec))?.harnessName
            ?? harnessForClient(clientName),
        },
      };
    }
    // No registered session — name what the chain itself shows, sliced at the nearest
    // adapter-owned ancestor (the harness above us); the client's word is the last fallback.
    const owned = ownedAncestorIndex(walk);
    const ancestry = owned === -1 ? walk : walk.slice(owned);
    const app = nearestAppBundle(ancestry);
    return {
      surface: (owned === -1 ? null : surfaceForSession({ ancestry, app })) ?? harnessForClient(clientName),
      app,
      session: null,
    };
  };

  // The session is a fact of the ACT (ruling 2026-09-03): a /clear or a resume registers a new
  // id under the same process, and the next act must speak as it. A long-lived writer — the
  // MCP server, whose context lives until a config change — used to keep the session it
  // resolved at its first tool call and stamp it on every later act. So every read looks the
  // registry up afresh, re-shaped only when the registry file changed (one stat per read).
  let cached = null;
  let stamp = null;
  const current = () => {
    let now = null;
    try { now = sessionsPath ? fs.statSync(sessionsPath, { bigint: true }).mtimeNs : null; } catch { now = null; }
    if (cached === null || now !== stamp) { cached = shape(); stamp = now; }
    return cached;
  };
  return {
    get surface() { return current().surface; },
    get app() { return current().app; },
    get session() { return current().session; },
  };
}
