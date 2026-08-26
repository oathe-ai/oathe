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

export function verificationTaskId(taskId) {
  return `verify:${taskId}`;
}

export function isVerificationTask(taskId) {
  return taskId.startsWith('verify:');
}

export function verificationObjective(taskId) {
  return `Render a verdict on '${taskId}': does the recorded evidence — the completion `
    + 'statement and the linked session traces — support that the objective was met? '
    + 'A non-author principal claims this, analyzes the traces, and records the verdict.';
}
