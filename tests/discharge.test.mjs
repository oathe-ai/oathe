import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dischargeClause, applyRecordedVerdict, RECORDED_VERDICT_CHECKER } from '../src/runtime/discharge.mjs';
import { standardPlan, ACCEPTANCE_CLAUSE_KEY } from '../src/plans.mjs';

const SPEC = standardPlan().clause_spec[ACCEPTANCE_CLAUSE_KEY];
const GOOD = Object.freeze({
  kind: 'completion', statement_type: 'completion',
  evidence_refs: ['evidence://one'], trace_ref: '/traces/session.jsonl',
});
const CLAUSE = Object.freeze({ clause_key: ACCEPTANCE_CLAUSE_KEY, checker: RECORDED_VERDICT_CHECKER });

test('a complete completion statement discharges the standard conditions as accepted', () => {
  const out = dischargeClause({ statement: GOOD,
    clause: { ...CLAUSE, oathe_recorded_verdict: 'accepted' }, spec: SPEC });
  assert.equal(out.verdict, 'accepted');
  assert.equal(out.checks.length, SPEC.conditions.length);
  assert.ok(out.checks.every((c) => c.pass === true));
});

test('each standard condition rejects on its own: kind, evidence, trace', () => {
  for (const broken of [
    { ...GOOD, kind: 'progress', statement_type: 'progress' },
    { ...GOOD, evidence_refs: [] },
    { ...GOOD, trace_ref: '   ' },
  ]) {
    const out = dischargeClause({ statement: broken,
      clause: { ...CLAUSE, oathe_recorded_verdict: 'accepted' }, spec: SPEC });
    assert.equal(out.verdict, 'rejected');
    assert.ok(out.reason, 'a rejection says why');
  }
});

test('the recorded-verdict rule: engine rejection overrides clean conditions', () => {
  const out = dischargeClause({ statement: GOOD,
    clause: { ...CLAUSE, oathe_recorded_verdict: 'rejected' }, spec: SPEC });
  assert.equal(out.verdict, 'rejected');
  assert.match(out.reason, /verifier engine rejected/);
});

test('a non-verdict recorded value BLOCKS — the lane never guesses', () => {
  const out = dischargeClause({ statement: GOOD,
    clause: { ...CLAUSE, oathe_recorded_verdict: 'maybe' }, spec: SPEC });
  assert.equal(out.verdict, 'blocked');
});

test('the rule only binds its own checker name — the review clause passes through', () => {
  const conditions = { verdict: 'accepted', checks: [], evidence: [] };
  const out = applyRecordedVerdict(conditions,
    { clause_key: ACCEPTANCE_CLAUSE_KEY, checker: 'verification-clause' });
  assert.equal(out, conditions);
});

test('no spec means BLOCKED — a lane with no bar refuses to accept', () => {
  const out = dischargeClause({ statement: GOOD, clause: CLAUSE, spec: undefined });
  assert.equal(out.verdict, 'blocked');
  assert.match(out.reason, /no clause_spec/);
});

test('an unknown condition kind is BLOCKED, never skipped', () => {
  const out = dischargeClause({ statement: GOOD, clause: CLAUSE,
    spec: { conditions: [{ kind: 'phase-of-moon' }] } });
  assert.equal(out.verdict, 'blocked');
});
