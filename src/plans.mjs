// oathe — the policy-standard verification plan (the G2-b "policy supplies a standard plan
// for routine work types" binder, the one ruled way a solo user's claim ever settles without
// ceremony). Named ONCE here; bound by oathe_done before the completion terminal (FC161
// permits amendment only under an ACTIVE claim), and stamped `bound_by` so the ledger shows
// WHO set the bar (G2-b: "stamped — visibly, in the ledger").
//
// The clause conditions are DETERMINISTIC (the acceptance lane's own vocabulary — no model,
// no network): a completion-typed statement, at least one addressable evidence ref, and a
// non-blank trace ref. The judgment about the WORK is the verifier agent's, recorded as
// evidence; this bar checks presence and provenance — checker shallowness is a published
// bound of the design, stated here on purpose.

export const ACCEPTANCE_CLAUSE_KEY = 'acceptance_package';
export const PLAN_POLICY_VERSION = 1;

export const STANDARD_CLAUSE_CONDITIONS = Object.freeze([
  { kind: 'statement_kind', expected: 'completion' },
  { kind: 'evidence_present', min: 1 },
  { kind: 'trace_ref_present' },
]);

/**
 * @param {{verifierEngine?: string|null}} o engine stamped on VERIFICATION tasks so any
 *        session (or `oathe verify`) knows which harness the founder assigned.
 */
export function standardPlan({ verifierEngine = null } = {}) {
  return {
    plan_status: 'declared',
    clauses: [ACCEPTANCE_CLAUSE_KEY],
    clause_spec: {
      [ACCEPTANCE_CLAUSE_KEY]: { conditions: STANDARD_CLAUSE_CONDITIONS.map((c) => ({ ...c })) },
    },
    bound_by: `policy:oathe-standard@${PLAN_POLICY_VERSION}`,
    ...(verifierEngine ? { verifier_engine: verifierEngine } : {}),
  };
}

/**
 * The machine's OWN tasks (ruling 2026-09-05): one grammar, `<kind>:<subject>` — the judgment
 * of a task (`verify:<task>`) and the update of an engine (`update:<harness>`). A system task is
 * a claim like any other (that is how every surface reads "verifying"/"updating" off one fact)
 * but never a WORK row: boards and pagers ask `systemTaskOf`, and no prefix literal lives
 * outside this table.
 */
export const SYSTEM_TASKS = Object.freeze({ verify: 'verify:', update: 'update:' });

export function systemTaskId(kind, subject) {
  const prefix = SYSTEM_TASKS[kind];
  if (!prefix) throw new Error(`no system task kind '${kind}' — kinds: ${Object.keys(SYSTEM_TASKS).join(', ')}`);
  return `${prefix}${subject}`;
}

/** @returns {{kind: string, subject: string}|null} */
export function systemTaskOf(taskId) {
  for (const [kind, prefix] of Object.entries(SYSTEM_TASKS)) {
    if (taskId.startsWith(prefix)) return { kind, subject: taskId.slice(prefix.length) };
  }
  return null;
}

/** SQL: is `column` a system task of any kind — the one exclusion every work-row query applies. */
export function isSystemTaskSql(column) {
  return `(${Object.values(SYSTEM_TASKS).map((p) => `${column} LIKE '${p}%'`).join(' OR ')})`;
}

/** The verification kind's helpers — thin calls on the grammar. */
export const VERIFICATION_PREFIX = SYSTEM_TASKS.verify;

export function verificationTaskId(taskId) {
  return systemTaskId('verify', taskId);
}

export function isVerificationTask(taskId) {
  return systemTaskOf(taskId)?.kind === 'verify';
}

/** The task a verification task judges, or null for a non-verification id. */
export function verifiedTaskId(taskId) {
  const system = systemTaskOf(taskId);
  return system?.kind === 'verify' ? system.subject : null;
}

/** The update kind's helpers. */
export function updateTaskId(harness) {
  return systemTaskId('update', harness);
}

export function updateObjective(harness, address) {
  return `Update the '${harness}' CLI in place at ${address} — the engine a judgment named as out of date; `
    + 'the machine claims this, runs the CLI\'s own updater, records the version before and after, and re-verifies.';
}

export function verificationObjective(taskId) {
  return `Render a verdict on '${taskId}': does the recorded evidence — the completion `
    + 'statement and the linked session traces — support that the objective was met? '
    + 'A non-author principal claims this, analyzes the traces, and records the verdict.';
}
