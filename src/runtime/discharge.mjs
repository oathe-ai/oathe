// oathe — deterministic clause discharge, owned by the package (the Stage 1 plan: "we already
// own STANDARD_CLAUSE_CONDITIONS; the discharge logic is ~50 lines against the DDL's
// contract"). Shared by BOTH providers: the standalone lane calls dischargeClause directly;
// the firia provider composes applyRecordedVerdict over the upstream base checker. Three
// verdicts only — accepted, rejected, blocked — and everything unknown fails TOWARD blocked.

export const RECORDED_VERDICT_CHECKER = 'oathe-verdict';

/** The recorded-verdict rule (bound at claim, discharged here) — only for its own checker. */
export function applyRecordedVerdict(conditions, clause) {
  if (clause.checker !== RECORDED_VERDICT_CHECKER) return conditions;
  if (conditions.verdict !== 'accepted') return conditions;
  const recorded = clause.oathe_recorded_verdict;
  if (recorded === 'accepted') return conditions;
  if (recorded === 'rejected') {
    return { verdict: 'rejected',
      reason: 'the assigned verifier engine rejected the completion against its traces',
      checks: conditions.checks, evidence: conditions.evidence };
  }
  return { verdict: 'blocked',
    reason: `recorded verdict '${recorded}' is not a verdict`,
    checks: conditions.checks, evidence: conditions.evidence };
}

const CONDITION_CHECKS = {
  statement_kind: (statement, cond) =>
    (statement.kind ?? statement.statement_type) === cond.expected,
  evidence_present: (statement, cond) =>
    Array.isArray(statement.evidence_refs) && statement.evidence_refs.length >= cond.min,
  trace_ref_present: (statement) =>
    typeof statement.trace_ref === 'string' && statement.trace_ref.trim() !== '',
};

/** @returns {{verdict: 'accepted'|'rejected'|'blocked', reason?: string, checks: object[], evidence: string[]}} */
export function dischargeClause({ statement, clause, spec }) {
  const evidence = Array.isArray(statement.evidence_refs) ? statement.evidence_refs : [];
  if (!spec) {
    return { verdict: 'blocked',
      reason: `no clause_spec for '${clause.clause_key}' — a lane with no bar blocks rather than accepting`,
      checks: [], evidence };
  }
  const checks = [];
  for (const cond of spec.conditions) {
    const check = CONDITION_CHECKS[cond.kind];
    if (!check) {
      return { verdict: 'blocked',
        reason: `unknown condition kind '${cond.kind}' — the discharge never guesses`,
        checks, evidence };
    }
    checks.push({ kind: cond.kind, pass: check(statement, cond) === true });
  }
  const failed = checks.filter((c) => !c.pass).map((c) => c.kind);
  const conditions = failed.length === 0
    ? { verdict: 'accepted', checks, evidence }
    : { verdict: 'rejected', reason: `conditions failed: ${failed.join(', ')}`, checks, evidence };
  return applyRecordedVerdict(conditions, clause);
}
