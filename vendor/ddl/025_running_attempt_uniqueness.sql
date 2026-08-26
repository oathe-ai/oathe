-- 025_running_attempt_uniqueness.sql — one work claim, at most one RUNNING
-- execution attempt, as a property of what the substrate can STORE.
--
-- Contract: contract §1.2 (the attempt is the disposable runtime binding beneath
-- a claim; the claim is the interval of responsibility) + FOUNDER RULING R1 (the
-- runtime binding is the executor's, the judgment is not) + a3-verification-
-- strategy.md §3.2 row RT-CLOSURE's premise, which is that an attempt row
-- identifies ONE execution. Requires 001_core.sql (declares cell.execution_attempt
-- and its state vocabulary) and 021_execution_attempt_closure.sql (the columns a
-- runtime-written attempt carries). Nothing else in the substrate is touched.
--
-- Re-apply: idempotent (CREATE UNIQUE INDEX IF NOT EXISTS).
-- Revert:   DROP INDEX cell.execution_attempt_one_running_per_claim;
--           (FC085 in 024_executor_role_hardening.sql keeps refusing the receipt,
--            so a reverted cell is back to the read-time fence alone, not to no
--            enforcement at all)
--
-- Declared failure vocabulary: NONE. This file raises no FC code. Its refusal is
-- PostgreSQL's own 23505 unique_violation naming the index, deliberately: the
-- rule is "this row may not exist", which is the exact thing a unique index says
-- and a consumer already knows how to read. Inventing an FC code for it would put
-- a domain-vocabulary spelling on a refusal the substrate raises without any
-- plpgsql of ours running, and a caller keying on FC codes would then have two
-- ways to learn one fact.
--
--
-- WHAT THIS CHANGES, AND WHAT WAS ALREADY THERE
--
-- The read-time fence remains: FC085 (RECEIPT_MULTIPLE_RUNNING_ATTEMPTS) in
-- 024_executor_role_hardening.sql:315-322. The name is parenthesised on every
-- mention below, per the convention 015 established: this file declares no
-- vocabulary of its own, and a bare `FCnnn NAME` line reads as a declaration.
-- The fence sits inside cell.claim_effect_receipt: when the
-- claim beneath a receipt holds more than one running attempt, currency is
-- unanswerable and the verb fails closed rather than attributing an irreversible
-- effect to a guessed binding. This index does not replace it and does not weaken
-- it — it removes its cause. FC085 is checked at the worst moment there is (a
-- runtime that has already done the work, at the instant it records the effect)
-- and only for callers that come through that one verb; the index refuses the
-- SECOND running row at the moment somebody tries to write it, for every writer,
-- including one that bypasses the verbs entirely. Two enforcement points, one
-- invariant, in the order that costs least: unstorable at write time, and still
-- named at read time for a substrate that carries the state already.
--
-- THAT FENCE IS NOT NOW DEAD CODE, and this is the reason it is not deleted in the
-- same change (L5 asks for the obsolete mechanism, not for a still-reachable one):
--   * a cell UPGRADED with two running attempts already in place keeps them —
--     CREATE UNIQUE INDEX fails loudly on such a cell rather than deleting
--     evidence (L12), and the operator resolving it needs the fence standing
--     while they do;
--   * an index can be dropped, by an operator or a migration, and a fence that
--     only exists as an index is a fence whose absence is silent;
--   * FC085's own suite (tests/test_executor_role.py) seeds the state with the
--     index dropped and asserts the verb still refuses — so the fence keeps its
--     falsifier and cannot rot behind the index.
--
-- WHY (org_id, work_claim_id) AND NOT THE ATTEMPT'S OTHER COLUMNS. The question
-- the invariant answers is "which attempt is this claim's current binding", and
-- that question is asked per claim. org_id leads so the index shares the
-- (org_id, ...) prefix shape every other execution_attempt index uses and answers
-- an org-scoped lookup as well as the exclusion.
--
-- WHY PARTIAL. Attempt rows are durable execution evidence and only accumulate
-- (L12): a claim retried three times holds three attempt rows, and a total unique
-- index on (org_id, work_claim_id) would make the second retry unstorable — it
-- would forbid history rather than ambiguity. Only 'running' is exclusive, and
-- only while it is running: 001_core's execution_attempt_running_attempt_has_no_end
-- ties that state to a NULL ended_at, so leaving the predicate is the same event
-- as the attempt ending.
--
-- THE OTHER INDEX ON THIS PREDICATE, AND WHY IT IS NOT DELETED HERE. The A2
-- dispatcher candidate declares `execution_attempt_running` on
-- (org_id, work_claim_id, started_at) WHERE state = 'running' from its own schema
-- file (firia-executor-dispatcher/sql/001_dispatcher.sql), to bound its 4-Hz hot
-- loop. Its L8 retirement condition is specific — "deleted the moment the same
-- index is adopted beside execution_attempt_by_claim in ddl/001_core.sql", with
-- the name identical so adoption is a no-op for a live cell — and this file is
-- not that: different name, different file, and a stricter shape that enforces
-- rather than only accelerates. The bridge and its deletion owner are unchanged.
--
-- WHAT IT DOES NOT DO. It does not decide WHICH attempt wins a race — the loser's
-- INSERT is refused with 23505 and the caller sees that its binding was not
-- established, which is the answer it needed. It grants nothing, revokes nothing
-- and changes no query's result; a reader that saw one running attempt before sees
-- one now.
--
-- BUILT NON-CONCURRENTLY, DELIBERATELY. This file is applied as part of the
-- declared order, in one transaction per file, on a cell being built or upgraded —
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block and would leave
-- an INVALID index behind on failure, which is the one outcome worse than a lock:
-- an invalid unique index enforces nothing while looking installed.

CREATE UNIQUE INDEX IF NOT EXISTS execution_attempt_one_running_per_claim
    ON cell.execution_attempt (org_id, work_claim_id)
    WHERE state = 'running';

COMMENT ON INDEX cell.execution_attempt_one_running_per_claim IS
    'contract §1.2: a work claim has at most one RUNNING execution attempt. The '
    'write-time half of the invariant FC085 (024_executor_role_hardening.sql) '
    'fences at receipt-claim time; this index makes the double-running state '
    'unstorable for every writer. PARTIAL because attempt history accumulates '
    '(L12) — only the running binding is exclusive.';
