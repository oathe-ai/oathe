// Stop — the turn-end heartbeat. ONE duty: LINK the session's trace to this workspace's
// claims (one statement per claim x session, keyed by subject_ref 'trace:<session_id>') so a
// verifier can later read exactly the transcripts behind the work. It does NOT touch
// ownership_valid_until: session liveness is not an organizational act (R1, correction
// packet 2026-08-26); the horizon is set at claim time by the substrate's claim verb.

import { linkTrace } from '../../src/statements.mjs';
import { failSoft, ensureSessionRegistered } from './lib.mjs';
import { claimIntervals } from '../../src/atif.mjs';
import { projectorFor } from '../../src/harnesses/catalog.mjs';

await failSoft(async ({ substrate, identity, session, paths, workspace }) => {
  // The session's liveness signal — independent of trace linkage (a planning-only session
  // still converges) and fail-soft on its own.
  await ensureSessionRegistered({ session, paths, workspace });
  if (!session?.transcriptPath) return; // no identity handed to this hook — nothing to link
  // R3 (§5): evidence is claim-specific and interval-specific. The session's own structured
  // trace names the tasks it ACTED on (the projector's claim_events); only those claims get
  // this trace linked. No readable trace, or no oathe acts in it → nothing to attribute —
  // a planning-only session leaves no claim evidence.
  let touched;
  try {
    const trajectory = (await projectorFor(session.transcriptPath)).project(session.transcriptPath);
    touched = new Set(claimIntervals(trajectory).map((i) => i.task_id));
  } catch {
    return; // fail-soft: an unreadable or unprojectable trace attributes nothing
  }
  if (touched.size === 0) return;
  // Linkage covers ASSERTED claims too: a claim taken and completed inside a single turn has
  // never seen a heartbeat while active — the turn-end hook is its only chance to leave the
  // trace evidence the verifier will demand. (Settled claims are closed; nothing to link.)
  // Custody is the PRINCIPAL's, not the folder's (R-HOME-BOARD): a claim homed on another
  // board is still this principal's, and the trace's own touched-set is what scopes linkage.
  // The write wrapper already linked every claim SPOKEN through the tools (linkTrace at
  // the act — the SPEAKER primitive); this turn-end sweep covers claims the transcript
  // proves were WORKED without a substrate write this turn. Same writer, idempotent.
  for (const taskId of touched) {
    await linkTrace({
      client: substrate,
      identity,
      taskId,
      session: { sessionId: session.sessionId, transcriptPath: session.transcriptPath, harness: session.harness },
    });
  }
});
