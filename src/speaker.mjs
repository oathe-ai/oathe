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

import { processAncestry, nearestAppBundle, SessionRegistry } from './sessions.mjs';
import { surfaceForSession, harnessForClient, ownerOfTracePath, ownedAncestorIndex, HARNESS_CLASSES } from './harnesses/catalog.mjs';

/**
 * @param {{pid?: number, sessionsPath: string, clientName?: string|null,
 *          exec?: object, platform?: string}} o — exec/platform are test seams for the walk
 * @returns {{surface: string|null, app: {bundle: string, pid: number}|null,
 *            session: {sessionId: string, transcriptPath: string|null, harness: string}|null}}
 */
export function resolveSpeaker({ pid = process.pid, sessionsPath, clientName = null, exec, platform } = {}) {
  const walk = processAncestry({
    pid,
    ...(exec !== undefined && { exec }),
    ...(platform !== undefined && { platform }),
  });
  const hit = sessionsPath ? new SessionRegistry({ sessionsPath }).byAncestry(walk) : null;
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
        transcriptPath: row.transcript_path ?? null,
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
}
