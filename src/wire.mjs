// oathe — the wire: one pg_notify per successful speech act, so an ambient surface (the
// notch feed, `oathe notch --serve`) hears a write the moment it lands instead of polling.
// The substrate stays the one source of truth — an event is a NUDGE, never a record: the
// feed recomputes its frame from durable facts on every wake, and a lost notification costs
// at most one heartbeat of staleness. Reads never emit (a feed that echoed its own reads
// would ring forever).
//
// Emission is fail-soft BY RULING exception: the speech act must stand even when the wire
// is down — but the failure is reported visibly on stderr, never swallowed.

export const WIRE_CHANNEL = 'oathe_wire';

/** WRITE tools only — the kind is the speech act's own name in the past tense. */
export const WIRE_KINDS = Object.freeze({
  oathe_claim: 'claimed',
  oathe_statement: 'progress',
  oathe_amend: 'amended',
  oathe_yield: 'yielded',
  oathe_done: 'asserted',
  oathe_verify: 'verify_dispatched',
  oathe_pickup: 'restored',
});

/**
 * The acts whose speaker session is EVIDENCE on the claim — linkTrace rides these and
 * only these. oathe_verify is excluded on purpose: dispatching judgment is not working
 * the task, and a bystander's transcript must never enter the evidence under judgment.
 */
export const LINKABLE = Object.freeze(new Set(
  Object.keys(WIRE_KINDS).filter((name) => name !== 'oathe_verify')));

/** ONE wording for the restored-state receipt — the pickup result and the feed both speak it. */
export function restoredReceipt(taskId) {
  return `🎉 Oathe restored your session state — '${taskId}' picked back up.`;
}

/**
 * The wire kinds that surface as an ephemeral NOTICE on the glass — one wording each, one
 * tone each: sage is a receipt riding the act, amber is a deviation that changes what you
 * do next (the verifier rejecting a completion — founder ruling 2026-08-30). The reopened
 * task also stands in the breach list, so the notice can fade without losing the fact.
 * @returns {{text: string, tone: 'sage'|'amber'}|null}
 */
export function noticeFor(kind, taskId, via = null) {
  if (kind === 'restored') return { text: restoredReceipt(taskId), tone: 'sage' };
  if (kind === 'rejected') return { text: `✗ '${taskId}' reopened — verification rejected.`, tone: 'amber' };
  if (kind === 'settled') return { text: `✓ '${taskId}' verified — settled.`, tone: 'sage' };
  if (kind === 'verify_failed') return { text: `✗ verification of '${taskId}' failed${via ? ` (${via})` : ''} — retry from the glass.`, tone: 'amber' };
  return null;
}

export async function emit(client, { kind, task_id, via, app }) {
  try {
    await client.query('SELECT pg_notify($1, $2)',
      [WIRE_CHANNEL, JSON.stringify({
        kind, task_id: task_id ?? null, via: via ?? null,
        app: app ?? null, // the act's living app {bundle, pid} — a homeless task still knows where it is spoken from
        at: new Date().toISOString(),
      })]);
  } catch (e) {
    process.stderr.write(`oathe wire: emit failed (${String(e?.message || e).slice(0, 120)}) `
      + '— the write stands; the glass catches up on its heartbeat\n');
  }
}
