-- 028_attempt_bind_ownership.sql — an execution attempt may not be bound beneath
-- an ownership interval that is no longer valid.
--
-- Contract: docs/a1-cell-work-spine-contract.md §1.2 (a claim is an interval of
-- RESPONSIBILITY; an attempt is the disposable runtime binding beneath it),
-- PRD 3.0 §5.2 R1/R2 and `:401`/`:414` (the organizational ownership horizon).
-- FOUNDER RULING R-A35-26 ruling 3, verbatim: *"Add a database-level refusal for
-- binding an execution attempt to a claim whose ownership interval is no longer
-- valid. Derive the exact allowed predicate from the authoritative PRD/DDL
-- ownership-terminal law; do not assume `state='active'` without resolving
-- `completion_asserted` and `ownership_ended_at`. This guard must cover Lane A,
-- ScopeAllocator, and direct writers."* Design of record:
-- docs/firia-runtime-a3/a3-ownership-return-design.md §6/C1 as corrected
-- 2026-08-25; predicate derivation in a3-r0-reconciliation.md §2.
--
-- Requires 001_core.sql (cell.execution_attempt and cell.work_claim, and the
-- biconditional this guard's two spellings rest on). It installs nothing outside
-- schema `cell` and alters no existing table, verb or trigger.
--
-- Re-apply: idempotent (CREATE OR REPLACE FUNCTION / TRIGGER).
-- Revert:   DROP TRIGGER execution_attempt_binds_under_valid_ownership
--               ON cell.execution_attempt;
--           DROP FUNCTION cell.enforce_attempt_bind_ownership_is_valid();
--           (a reverted cell can bind a runtime beneath an interval whose
--            principal already handed the work away — the state this file exists
--            to end, not a safe resting place)
--
-- WHY THE ENFORCEMENT POINT IS THE SUBSTRATE AND NOT THE ALLOCATOR
--
-- The refusal was first designed into `ScopeAllocator.allocate`. MEASURED:
-- Lane A's bind path never touches ScopeAllocator — the durable executor's
-- `bindAttempt` INSERTs directly (`src/substrate.mjs:278-285`) and that package
-- has no `firia-runtime` dependency at all. An allocator-side guard would have
-- been a guard one of the three writers walks past, which is the shape 002's
-- header already names as the reason the claim path is a database function:
-- "unique active ownership must hold for every writer, not only for writers that
-- remembered to call the library".
--
-- MEASURED at f45e9e64, and it is why this is a trigger rather than three
-- guards: `cell.execution_attempt` carried ZERO triggers (21 triggers across 12
-- other tables, none on this one); its only FK is existence/org; 025's partial
-- unique index was the sole bind-time exclusion; and no test in this package
-- bound an attempt to a non-`active` claim. There was no checker here to repair,
-- which is why this file's legs are BORN red rather than fixed.
--
-- THE PREDICATE, DERIVED
--
-- An attempt may bind IFF the claim's ownership interval is valid AT THE
-- ATTEMPT'S OWN INSTANT:
--
--   (a) `wc.state = 'active'`, which is the SAME TEST as
--       `wc.ownership_ended_at IS NULL` — 001_core.sql:183-184 is a
--       BICONDITIONAL, so the two select identical row sets and a
--       `completion_asserted` row with a NULL ownership_ended_at is unstorable.
--       Both spellings are cited in the refusal below so that a future
--       relaxation of that CHECK cannot silently widen this guard.
--
--       `completion_asserted` is refused with the rest: ownership ended at the
--       assertion — "the assertion IS the end of the author's responsibility"
--       (013_claim_terminal.sql:243-246) — and the replacement road is 012/016's
--       rejection → reopened task → NEW CLAIM (012:326-330, 016:82-85), never a
--       new attempt on the ended one. `yielded`, `aborted`, `taken_over` and
--       `expired` are refused for the same reason: all four carry
--       ownership_ended_at. The three verbless ones stay FC-E/W4 material — this
--       guard refuses a bind beneath them TODAY without claiming their designs.
--
--   (b) `NEW.started_at < wc.ownership_valid_until`, tested at the ROW's own
--       instant and never a `now()` inside this function. Lane A writes `now()`
--       in its INSERT and the allocator passes its own clock; either way the
--       instant the guard reads is the one the row states, because a runtime
--       must not be able to move a guard by choosing a clock (011:263-287,
--       015:162-171). This clause is present because the ruling's own words are
--       "ownership interval is no longer valid" and `ownership_valid_until` IS
--       that validity (PRD `:401`, `:414`); the DDL cannot express expiry
--       (`expired` has no writer, FC-E), so this clause is what stops F2 leg
--       (a)'s RED state — a claim past its horizon with no terminal — from also
--       being an EXECUTING state.
--
-- WHAT THIS GUARD DOES NOT COVER, STATED RATHER THAN LEFT IMPLICIT
--
-- It tests the BIND. A claim that terminalizes MID-FLIGHT leaves a live attempt
-- beneath an ended interval and there is no substrate refusal for that: an
-- INSERT-time guard covers 0% of the update path by construction. The reader
-- that sees it is C3's sweep, which is a reader and not an invariant. Recorded
-- as the `ATTEMPT-BIND-OWNERSHIP` coverage row's first enumerated exemption
-- (zero_class: definitional), in falsifiers/rollup/manifest.mjs.
--
-- Declared failure vocabulary (FC190-FC199 reserved; 2 codes used). This file
-- opens a FRESH BLOCK rather than spending 027's two spare codes: the vocabulary
-- registry is keyed by FILE (tests/test_failure_vocabulary.py:47-94), a file
-- shares a neighbour's block only when its raises are genuinely the same lane's
-- rule, and this is not the ownership-return lane — its subject is
-- cell.execution_attempt, its writers are the executor role and the allocator,
-- and it fires for claims that never yielded. The nearest precedent is 025,
-- which took its own file for one rule about binding an execution_attempt.
--   FC190 ATTEMPT_BIND_OWNERSHIP_ENDED     a runtime bound beneath an interval of
--                                          responsibility that has already ended
--   FC191 ATTEMPT_BIND_OWNERSHIP_HORIZON_PASSED  a runtime bound at an instant at
--                                          or after the claim's own ownership
--                                          horizon

CREATE OR REPLACE FUNCTION cell.enforce_attempt_bind_ownership_is_valid()
RETURNS trigger
LANGUAGE plpgsql
AS $attempt_bind$
DECLARE
    v_state      text;
    v_ended_at   timestamptz;
    v_valid_until timestamptz;
BEGIN
    SELECT wc.state, wc.ownership_ended_at, wc.ownership_valid_until
      INTO v_state, v_ended_at, v_valid_until
      FROM cell.work_claim wc
     WHERE wc.org_id = NEW.org_id AND wc.work_claim_id = NEW.work_claim_id;

    IF NOT FOUND THEN
        -- execution_attempt_claim_fkey is the authority on whether the named
        -- claim exists, and it refuses this row at the end of the statement with
        -- the FK's own message. A second, competing refusal here would report an
        -- OWNERSHIP problem for what is a dangling reference — the same reasoning
        -- 003_verification.sql:158-163 gives for standing aside in exactly this
        -- position. This is not a guard declining to decide: the decision is
        -- another constraint's and it is unconditional.
        RETURN NEW;
    END IF;

    IF v_state IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION
            'ATTEMPT_BIND_OWNERSHIP_ENDED:%/%:% — responsibility for this work '
            'ended at % (state ''%''), and a runtime bound beneath an ended '
            'interval would execute work whose principal no longer answers for it '
            '(contract §1.2, PRD §5.2). `state = ''active''` and '
            '`ownership_ended_at IS NULL` are the same test here — '
            'work_claim_active_claim_has_no_ownership_end makes them a '
            'biconditional — and both are named so a later relaxation of that '
            'CHECK cannot widen this refusal without a reader noticing. A '
            'completion assertion IS the end of the author''s responsibility '
            '(013): the road back to execution is a rejection, a reopened task '
            'and a NEW CLAIM, never a new attempt on the ended one.',
            NEW.org_id, NEW.work_claim_id, NEW.attempt_id,
            coalesce(v_ended_at::text, '<no stamp, which is unstorable here>'),
            v_state
            USING ERRCODE = 'FC190';
    END IF;

    IF NEW.started_at >= v_valid_until THEN
        RAISE EXCEPTION
            'ATTEMPT_BIND_OWNERSHIP_HORIZON_PASSED:%/%:% — this attempt starts at '
            '% and the claim''s ownership horizon was %. The organizational '
            'window in which this principal answers for this work has passed and '
            'no terminal names it, which is F2 leg (a)''s RED state; binding here '
            'would make that state an EXECUTING one as well. The instant read is '
            'the ROW''s own started_at and never this trigger''s clock, so a '
            'runtime cannot move the guard by choosing when it says it began.',
            NEW.org_id, NEW.work_claim_id, NEW.attempt_id,
            NEW.started_at, v_valid_until
            USING ERRCODE = 'FC191';
    END IF;

    RETURN NEW;
END;
$attempt_bind$;

COMMENT ON FUNCTION cell.enforce_attempt_bind_ownership_is_valid IS
    'FOUNDER RULING R-A35-26 ruling 3: an execution attempt binds only beneath a '
    'claim whose ownership interval is valid at the attempt''s own instant. A '
    'BEFORE INSERT trigger and not three call-site guards, because Lane A''s '
    'bindAttempt, ScopeAllocator.allocate and any direct writer under the '
    'executor role each issue their own INSERT and only the table sees all three.';

CREATE OR REPLACE TRIGGER execution_attempt_binds_under_valid_ownership
    BEFORE INSERT ON cell.execution_attempt
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_attempt_bind_ownership_is_valid();
