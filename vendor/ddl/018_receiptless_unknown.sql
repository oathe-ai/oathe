-- 018_receiptless_unknown.sql — THE RESOLVER'S VERB: the one `unknown` no
-- reconciler can ever read a remote about, and the judgment that closes it.
--
-- Contract: docs/a1-cell-work-spine-contract.md §1.2 (R3's interrupted attempts,
-- their deadline and their named resolver), §8/F2 leg (c) ("unknown past its
-- reconcile_by is RED"), FOUNDER RULING R3 ("bundled inseparably: effect
-- receipts — an irreversible external effect claims a durable receipt
-- in-substrate before firing; WITHOUT RECEIPTS, UNKNOWN IS PERMANENT BY
-- CONSTRUCTION").
-- Requires 001_core.sql (cell.execution_attempt), 008_effect_receipt.sql.
--
-- Re-apply: idempotent (CREATE OR REPLACE throughout).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- WHY THIS FILE EXISTS, AND WHY THE SENTENCE IT IS BUILT ON IS A DERIVATION
--
-- "Without receipts, unknown is permanent by construction" is quoted everywhere
-- in this substrate as a WARNING — build the receipt lane or lose the ability to
-- reconcile. It is also a DERIVATION, and nothing in the cell had drawn it:
--
--   R3 makes the receipt the PRECONDITION of firing an irreversible effect.
--   An attempt that holds no receipt at all therefore fired none.
--   An attempt that fired no irreversible effect left nothing outside the cell
--   carrying a consequence of it.
--   So its outcome is not unknowable. It is `known_failure` — the work did not
--   land, and there is nobody to ask because there is nothing to ask about.
--
-- What keeps that from being a way to launder every unknown into a resolution is
-- the DEADLINE. Before `reconcile_by`, "somebody may yet find out" is the honest
-- state and R3 put a name on the row saying who. Past it, R3 says unknown is
-- never a tolerated state — and F2 leg (c) is the falsifier that says so out
-- loud. So this verb resolves exactly the intersection: no receipt, past the
-- deadline, with a named resolver on the row.
--
-- WHY IT IS THE RESOLVER'S AND NOT THE EXECUTOR'S
--
-- MEASURED, in both bake-off candidates: each of them reconciles an `unknown` by
-- reading the REMOTE's own append-only ledger for a receipt key it can name, and
-- each of them refuses this case explicitly. The dispatcher's own comment names
-- the owner — "an attempt with NO receipts is deliberately left alone: there is
-- no remote to ask about it, so its outcome stays unknown until its deadline and
-- the named resolver in the evaluator lane answers. Manufacturing 'known_failure'
-- for it here would be this process minting an unobserved fact."
--
-- That refusal is right, and this file is its other half. The name on the row is
-- a PRINCIPAL (`resolver_principal`), and an executor is not one; a runtime that
-- signed a principal's answer would be exactly the L1 crossing the evaluator seat
-- was extracted to close. The seat reads the name off the row, refuses a caller
-- that supplies a different one, and refuses a resolution taken early.
--
-- WHAT IS DELIBERATELY NOT HERE: A CALL-STACK WRITER GUARD
--
-- Every settlement lane in this substrate guards its table with
-- `cell.written_by` (002_claim.sql), and this one does not. That is a decision,
-- argued rather than skipped. `cell.execution_attempt` is the DISPOSABLE runtime
-- binding beneath the claim (R1): writing one is an executor's whole job, it is
-- the one-writer census's anti-vacuity probe, and both candidates legitimately
-- write `outcome_status` on it every time they reconcile a receipt against a
-- remote. A guard over that column would refuse the write that is properly
-- theirs, and a guard narrowed to "receiptless transitions only" would refuse
-- the frozen falsifier envelopes' own satisfied-controls, which state a resolved
-- world directly and must keep being able to.
--
-- So what the seat owns here is the JUDGMENT, not the column, and the judgment's
-- preconditions live in the verb where a caller meets them. An executor that
-- wrote this row itself would not be refused by the substrate; it would be
-- refused by the one-writer census reading its source, and by the fact that it
-- has no principal to sign as.
--
-- Declared failure vocabulary added by this file (SQLSTATE class FC; this lane
-- reserves FC150-FC159):
--   FC150 RECEIPTLESS_UNKNOWN_NOT_RESOLVABLE   the attempt is not this verb's to
--                                          answer for: it is not there, or it
--                                          holds an effect receipt and is the
--                                          reconciler's
--   FC151 RECEIPTLESS_UNKNOWN_RESOLVER_MISMATCH  a caller signing an answer the
--                                          row names somebody else for
--   FC152 RECEIPTLESS_UNKNOWN_NOT_YET_DUE  a resolution taken before the deadline
--                                          the unknown was given
--   FC153 RECEIPTLESS_UNKNOWN_OUTCOME_CONTRADICTED  a receiptless attempt already
--                                          carrying a known outcome that is NOT
--                                          the one R3 derives — two answers about
--                                          one runtime, which is a fact to
--                                          investigate rather than a value to
--                                          overwrite

-- ---------------------------------------------------------------------------
-- cell.v_receiptless_unknown_attempt — what the resolver may answer for
--
-- The seat's read surface, and a VIEW rather than a predicate spelled at the
-- call site for the reason every other lane in this substrate has one: the half
-- that FINDS the work and the verb that DOES it must agree on which rows
-- qualify, and two spellings of that eventually disagree in the direction nobody
-- sees — a seat that quietly stops resolving reads exactly like a cell with
-- nothing to resolve.
--
-- The deadline is deliberately NOT in this view. "Which attempts can only ever be
-- resolved by judgment" and "which of them are due" are different questions: the
-- first is a property of the world, the second is a property of the instant a
-- caller is reasoning at, and this substrate takes every instant as an explicit
-- argument rather than reading now() inside a definition. The verb applies the
-- clock; the seat's reader passes its own.
--
-- Nor does it re-check that the deadline and the resolver are PRESENT.
-- 001_core.sql already carries both as CHECK constraints — `unknown` holds
-- exactly when `reconcile_by` does and exactly when `resolver_principal` does —
-- so an `unknown` row without them cannot be inserted at all. Restating them
-- here would read as a predicate that selects a subset while selecting nothing
-- out, which is how a reader learns to distrust the ones that do.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW cell.v_receiptless_unknown_attempt AS
SELECT
    a.attempt_id,
    a.org_id,
    a.work_claim_id,
    a.state,
    a.reconcile_by,
    a.resolver_principal
FROM cell.execution_attempt a
WHERE a.outcome_status = 'unknown'
  AND NOT EXISTS (SELECT 1 FROM cell.effect_receipt r
                   WHERE r.attempt_id = a.attempt_id);

COMMENT ON VIEW cell.v_receiptless_unknown_attempt IS
    'R3: the unknowns no reconciler can read a remote about, because the attempt '
    'claimed no receipt and therefore fired no irreversible effect. Carries the '
    'deadline and the named resolver; applying the clock is the caller''s.';

-- ------------------------------------------------------ the resolver's verb
--
-- RETURNS the outcome that STANDS on the row when this call is done, and returns
-- it whether this call wrote it or found it. That is a correction, and it was
-- MEASURED rather than reasoned: the first version refused an already-resolved
-- attempt by name, and a full dispatcher matrix run took a 500 out of the
-- candidate on `C2-KILL-DURING-RECOVERY` because a claim gets woken more than
-- once — at each bind, at each scope end, and on the tick — so two wakes over one
-- claim both survey the same overdue unknown and the second arrives after the
-- first has closed it. A benign re-resolution is not a caller reasoning about a
-- world that moved; it is the ordinary shape of a seat that may be woken by
-- anybody, and `cell.claim_effect_receipt` already carries the argument one lane
-- over: an idempotent restatement answers, a CONTRADICTION raises.
--
-- THE READ IS `FOR UPDATE` ON THE ATTEMPT ITSELF, not on the view, and that is
-- what makes the check and the write one decision. Two concurrent calls then
-- serialise on the row: the first resolves, the second reads `known_failure` and
-- answers it. A verb that re-read the view after somebody else's commit would
-- have the same race one layer down.
CREATE OR REPLACE FUNCTION cell.resolve_receiptless_unknown(
    p_attempt_id          uuid,
    p_resolver_principal  text,
    p_resolved_at         timestamptz
)
RETURNS text
LANGUAGE plpgsql
AS $resolve_receiptless$
DECLARE
    v_outcome  text;
    v_named    text;
    v_due      timestamptz;
    v_receipts integer;
BEGIN
    SELECT outcome_status, resolver_principal, reconcile_by
      INTO v_outcome, v_named, v_due
      FROM cell.execution_attempt
     WHERE attempt_id = p_attempt_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'RECEIPTLESS_UNKNOWN_NOT_RESOLVABLE:% — no runtime binding under this '
            'id, so there is no outcome for a resolver to answer for.',
            p_attempt_id
            USING ERRCODE = 'FC150';
    END IF;

    SELECT count(*) INTO v_receipts
      FROM cell.effect_receipt r
     WHERE r.attempt_id = p_attempt_id;

    IF v_receipts > 0 THEN
        RAISE EXCEPTION
            'RECEIPTLESS_UNKNOWN_NOT_RESOLVABLE:%:% — this attempt holds effect '
            'receipts, so its outcome is the RECONCILER''s to read off the '
            'remote''s own ledger. Answering it from the absence of a receipt that '
            'is not absent would overwrite an answer somebody can check with a '
            'guess.',
            p_attempt_id, v_receipts
            USING ERRCODE = 'FC150';
    END IF;

    -- THE IDEMPOTENT ARM, and the contradiction beside it. A receiptless attempt
    -- already carrying the outcome R3 derives is this verb's own work, seen a
    -- second time — the ordinary result of one claim being woken more than once.
    -- Any OTHER known outcome is two answers about one runtime with no ledger
    -- behind either, and that is a fact to investigate.
    IF v_outcome IS DISTINCT FROM 'unknown' THEN
        IF v_outcome = 'known_failure' THEN
            RETURN v_outcome;
        END IF;
        RAISE EXCEPTION
            'RECEIPTLESS_UNKNOWN_OUTCOME_CONTRADICTED:%:% — this attempt claimed '
            'no receipt, so R3 derives `known_failure` for it, and the row already '
            'says ''%''. Two answers about one runtime with no remote behind either '
            'is not a value to overwrite; it is a fact to investigate.',
            p_attempt_id, coalesce(v_outcome, '<none>'), coalesce(v_outcome, '<none>')
            USING ERRCODE = 'FC153';
    END IF;

    IF v_named IS DISTINCT FROM p_resolver_principal THEN
        RAISE EXCEPTION
            'RECEIPTLESS_UNKNOWN_RESOLVER_MISMATCH:%:% — R3 names the resolver ON '
            'THE ROW (%), and this call signs as somebody else. The name is read '
            'here and checked against the caller''s rather than taken from it: a '
            'verb that accepted whatever principal it was handed would let any '
            'waker sign any resolver''s answer.',
            p_attempt_id, p_resolver_principal, v_named
            USING ERRCODE = 'FC151';
    END IF;

    IF p_resolved_at < v_due THEN
        RAISE EXCEPTION
            'RECEIPTLESS_UNKNOWN_NOT_YET_DUE:%:% — the unknown''s deadline is % '
            'and this resolution is earlier. Before the deadline, "somebody may '
            'yet find out" is the honest state and the row says who; resolving '
            'early closes the window R3 opened. Past it, unknown is never a '
            'tolerated state, which is what makes this a judgment rather than a '
            'read.',
            p_attempt_id, p_resolved_at, v_due
            USING ERRCODE = 'FC152';
    END IF;

    -- The deadline and the name go WITH the unknown they were there to bound: a
    -- resolved outcome has nothing left to reconcile, and a deadline left behind
    -- on it would sit in F2 leg (c)'s path forever, reporting a resolved attempt
    -- as an overdue one.
    UPDATE cell.execution_attempt
       SET outcome_status     = 'known_failure',
           reconcile_by       = NULL,
           resolver_principal = NULL
     WHERE attempt_id = p_attempt_id;

    RETURN 'known_failure';
END;
$resolve_receiptless$;

COMMENT ON FUNCTION cell.resolve_receiptless_unknown IS
    'FOUNDER RULING R3, derived: an attempt holding no receipt fired no '
    'irreversible effect, so past its deadline its outcome is known_failure and '
    'the named resolver on the row is who may say so.';
