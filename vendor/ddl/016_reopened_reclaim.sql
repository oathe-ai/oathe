-- 016_reopened_reclaim.sql — R8's SECOND HALF: the fresh interval of
-- responsibility a reopened task gets, and the call-stack guard that makes the
-- evaluator seat the only way to it.
--
-- Contract: docs/a1-cell-work-spine-contract.md §1.2 (a claim is an interval of
-- RESPONSIBILITY; responsibility passes by a terminal, never by a second
-- claimant arriving), §2.1 shape (a) (the delegated child claim), FOUNDER
-- RULING R8 ("a rejection reopens the work — the reopened task's next claimant
-- resumes on the SAME work"), and R1 (a claim is responsibility, an attempt is
-- runtime). Requires 001_core.sql, 002_claim.sql (cell.claim_work,
-- cell.written_by), 003_verification.sql and 012_evaluator_lane.sql
-- (cell.reopen_rejected_task, whose act this one follows and never performs).
--
-- Re-apply: idempotent (CREATE OR REPLACE throughout).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- WHY THIS FILE EXISTS, MEASURED
--
-- `C1-CHILD-REJECTED` asks for one row: the rejected delegated child carrying an
-- ACTIVE claim again, while the parent goes on waiting and nothing anywhere is
-- settled. Both bake-off entrants were red on it in every repetition of the
-- 20260818T2100Z pair and NEITHER RED WAS THEIRS. 012 landed half of R8 —
-- `cell.reopen_rejected_task` moves the task's origin to `reopened`, which says
-- the work is not done — and the other half of the same sentence, the next
-- claimant resuming, had no verb in the cell at all. The only road to the row
-- was a `cell.claim_work` issued from executor code on behalf of a principal
-- that executor does not represent: in the leg's own scene, an engineering-scope
-- runtime claiming as the RESEARCH lead. The one-writer census (A2.4-F0) forbids
-- exactly that, so the leg sat between a missing domain verb and a boundary and
-- no executor closed it by trying harder.
--
-- WHY A SEAT MAY MINT A CLAIM AT ALL
--
-- Because it invents nothing, which is the same reason 013's completion terminal
-- and 012's confirm transcription are lawful. Every value in the fresh claim is
-- READ: the principal, the department, the mode, the contract ref and the parent
-- claim come off the interval being resumed, and the ownership window is the
-- TASK's own `verify_by` — the one recorded answer to "by when is this work
-- due". There is nowhere in the signature below to put a principal a caller
-- picked. A verb that took one would be a runtime deciding who answers for work
-- next, which is the authority L11 says a capability may never widen for itself.
--
-- WHY THE REOPEN IS NOT PERFORMED HERE
--
-- Two facts, two verbs. `cell.reopen_rejected_task` says the work is not done;
-- this one says who resumes it. A single verb doing both would let a resumption
-- reopen work nobody rejected — the seat handing live work to a second interval
-- on its own say-so — and the refusal below (FC132) is what keeps the order
-- honest: this verb acts only on a task the reopen has already reached.
--
-- WHY THE GUARD READS THE ORIGIN AND NOT THE COUNT
--
-- A first claim on reopened work is an ORDINARY claim and stays one: a task
-- reopened before anybody ever held it must be claimable by whoever claims it,
-- or the reopen would be a state no principal can take responsibility for. A
-- second claim on work nobody reopened is a takeover, a reassignment or a fresh
-- interval after a yield, and none of those is this file's business either. What
-- is guarded is the intersection — a SECOND interval on a task the seat
-- reopened — because that is precisely the write an executor would have to
-- perform to close its own leg. The signal is `cell.written_by`, the PL/pgSQL
-- call stack, rather than a column a writer could type or a setting it could set
-- for itself: MEASURED, 23 historical `verified` settles reached the bus by
-- direct publish naming exactly the right evaluator.
--
-- Declared failure vocabulary (SQLSTATE class FC; this lane reserves
-- FC130-FC139):
--   FC130 REOPENED_WORK_RESUMED_OUTSIDE_THE_EVALUATOR_LANE  a second interval on
--                                          a reopened task, claimed by something
--                                          that is not this seat's verb
--   FC131 REOPENED_RECLAIM_TASK_UNKNOWN    a resumption of work the company has
--                                          no record of
--   FC132 REOPENED_RECLAIM_TASK_NOT_REOPENED  a resumption of work nobody
--                                          reopened
--   FC133 REOPENED_RECLAIM_NO_PRIOR_CLAIM  a resumption of work nobody ever held,
--                                          so there is no claimant to read
--   FC134 REOPENED_RECLAIM_RESUMES_BEFORE_THE_INTERVAL_IT_FOLLOWS  a resumption
--                                          stamped inside the previous holder's
--                                          own window

-- ------------------------------------------------------------- the writer guard
--
-- BEFORE INSERT, because a resumption is a NEW claim row and never an update of
-- the interval it follows (§1.2: responsibility passes by a terminal; the ended
-- interval stays in the record exactly as it ended, L12). The two narrowing
-- clauses are the whole subject of the header above: the task's origin, and
-- whether this row is the first interval or a later one.
CREATE OR REPLACE FUNCTION cell.enforce_reopened_resumption_is_the_evaluator_lanes()
RETURNS trigger
LANGUAGE plpgsql
AS $resumption_writer$
DECLARE
    v_origin text;
BEGIN
    SELECT origin INTO v_origin
      FROM cell.task
     WHERE org_id = NEW.org_id AND task_id = NEW.task_id;

    -- Not a resumption: an ordinary claim on work nobody reopened. The claim
    -- path's own refusals (FC001/FC002/FC003) are the ones that apply.
    IF v_origin IS DISTINCT FROM 'reopened' THEN
        RETURN NEW;
    END IF;

    -- Not a resumption either: the FIRST interval on a task that happens to
    -- carry the reopened origin. R8 is about the next claimant, and where there
    -- was no previous one there is nothing to be next to.
    IF NOT EXISTS (SELECT 1 FROM cell.work_claim prior
                    WHERE prior.org_id = NEW.org_id
                      AND prior.task_id = NEW.task_id
                      AND prior.work_claim_id <> NEW.work_claim_id) THEN
        RETURN NEW;
    END IF;

    IF NOT cell.written_by('cell.reclaim_reopened_task') THEN
        RAISE EXCEPTION
            'REOPENED_WORK_RESUMED_OUTSIDE_THE_EVALUATOR_LANE:%/% — the next '
            'claimant of reopened work is seated by cell.reclaim_reopened_task '
            'and by nothing else. FOUNDER RULING R8 makes the resumption the '
            'other half of the reopen, and the reopen is already the evaluator '
            'seat''s (012_evaluator_lane.sql): an executor that seated this '
            'claim would be naming the principal who answers for work next, on '
            'the strength of a verdict about work it ran itself. The writer '
            'signal is the PL/pgSQL call stack, which a direct writer cannot '
            'fabricate, rather than a column it could type: 23 historical '
            '`verified` settles reached the bus by direct publish naming '
            'exactly the right evaluator.',
            NEW.org_id, NEW.task_id
            USING ERRCODE = 'FC130';
    END IF;

    RETURN NEW;
END;
$resumption_writer$;

CREATE OR REPLACE TRIGGER work_claim_resumption_is_the_evaluator_lanes
    BEFORE INSERT ON cell.work_claim
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_reopened_resumption_is_the_evaluator_lanes();

-- --------------------------------------------------------------------- the verb
--
-- Every argument is required and none may grow a default. The three the caller
-- supplies are an IDENTITY, an INSTANT and an EVENT ID — the same three 013 and
-- 015 take — and everything the row MEANS is read off the substrate. A defaulted
-- identifier would make the caller unable to address the claim it caused; a
-- defaulted instant would be the substrate deciding when a second interval of
-- responsibility began.
--
-- It ANSWERS WHETHER THIS CALL MOVED ANYTHING, like every verb in 012, 013 and
-- 015: "the work was resumed" and "the work already has a holder" are different
-- facts to a seat that has to write down what its wake did, and a wake that
-- resumed nothing must be distinguishable in evidence from one that never
-- looked.
CREATE OR REPLACE FUNCTION cell.reclaim_reopened_task(
    p_org_id        text,
    p_task_id       text,
    p_work_claim_id uuid,
    p_claimed_at    timestamptz,
    p_event_id      uuid
)
RETURNS boolean
LANGUAGE plpgsql
AS $reclaim_reopened$
DECLARE
    v_origin    text;
    v_verify_by timestamptz;
    v_prior     cell.work_claim%ROWTYPE;
    v_live      uuid;
BEGIN
    -- The task's policy row, locked before anything is read off it: two wakes
    -- resuming the same work on the same tick serialize here, exactly as two
    -- claimants of one task serialize inside `cell.claim_work`.
    SELECT origin, verify_by INTO v_origin, v_verify_by
      FROM cell.task
     WHERE org_id = p_org_id AND task_id = p_task_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'REOPENED_RECLAIM_TASK_UNKNOWN:%/% — resuming is an act on work the '
            'company has a record of. A resumption that matched nothing would '
            'report a claimant for a task nobody can later account for.',
            p_org_id, p_task_id
            USING ERRCODE = 'FC131';
    END IF;

    IF v_origin IS DISTINCT FROM 'reopened' THEN
        RAISE EXCEPTION
            'REOPENED_RECLAIM_TASK_NOT_REOPENED:%/%:% — R8''s two halves are two '
            'verbs. `cell.reopen_rejected_task` says the work is not done; this '
            'one says who resumes it, and it acts only on a task the reopen has '
            'already reached. A verb that did both would let a resumption reopen '
            'work nobody rejected — a seat handing live work to a second '
            'interval on its own say-so.',
            p_org_id, p_task_id, coalesce(v_origin, '<null>')
            USING ERRCODE = 'FC132';
    END IF;

    -- A LIVE OWNER ends this call, and it is the idempotency predicate rather
    -- than a set this verb remembers: a restart takes a remembered set with it,
    -- which is the whole reason L2 puts durable state below the agent. It is
    -- also the answer for a task reopened while its holder is still working —
    -- reopening does not evict anybody, and a seat that took the work off a live
    -- principal would be performing the takeover terminal nobody asked it for.
    SELECT work_claim_id INTO v_live
      FROM cell.work_claim
     WHERE org_id = p_org_id AND task_id = p_task_id AND state = 'active';

    IF FOUND THEN
        RETURN false;
    END IF;

    -- The interval being resumed: the LAST one to end, which is the one whose
    -- holder was answerable for this work most recently. Everything the fresh
    -- claim says about WHO is read from this row.
    SELECT * INTO v_prior
      FROM cell.work_claim
     WHERE org_id = p_org_id AND task_id = p_task_id
       AND ownership_ended_at IS NOT NULL
     ORDER BY ownership_ended_at DESC, claimed_at DESC, work_claim_id
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'REOPENED_RECLAIM_NO_PRIOR_CLAIM:%/% — there is no ended interval of '
            'responsibility to read the claimant off, and this verb does not '
            'choose one. R8 is about the NEXT claimant; a task reopened without '
            'ever having been claimed is a mis-declared task, and seating a '
            'principal on it would be the substrate deciding who answers for '
            'work nobody has answered for yet (L11).',
            p_org_id, p_task_id
            USING ERRCODE = 'FC133';
    END IF;

    IF p_claimed_at < v_prior.ownership_ended_at THEN
        RAISE EXCEPTION
            'REOPENED_RECLAIM_RESUMES_BEFORE_THE_INTERVAL_IT_FOLLOWS:%:% — the '
            'interval this resumption follows ended at %, and this claim is '
            'stamped %. Two intervals of responsibility over one task may not '
            'overlap in the record: a history saying two principals were '
            'answerable at once is the exact state unique active ownership '
            'exists to make impossible, and a runtime that could pick the '
            'instant could write one by choosing an earlier clock.',
            p_task_id, p_work_claim_id, v_prior.ownership_ended_at, p_claimed_at
            USING ERRCODE = 'FC134';
    END IF;

    -- THE ONE CLAIM PATH, called rather than re-spelled. The lock, the mode
    -- check (R7), the unique-active-ownership refusal and the claim-meaning
    -- event are the same ones every other claimant meets — a second INSERT here
    -- would be a second claim path, which is the thing 002 exists to not have.
    --
    -- Nothing is set to authorize the write: THIS frame, on the call stack, is
    -- what the guard above reads, and it stops existing when the function
    -- returns.
    PERFORM cell.claim_work(
        p_org_id                    => p_org_id,
        p_task_id                   => p_task_id,
        p_work_claim_id             => p_work_claim_id,
        p_parent_work_claim_id      => v_prior.parent_work_claim_id,
        -- NULL, and it is a statement rather than an omission (027 gave
        -- cell.claim_work this argument and no default). A reopen is not a
        -- succession: R8's next claimant resumes work a REJECTION reopened, and
        -- the prior interval it reads from may be any terminal at all. Naming it
        -- as a predecessor here would put a reopen inside
        -- work_claim_one_successor_per_predecessor's uniqueness and make a task
        -- reopenable exactly once.
        p_predecessor_work_claim_id => NULL,
        p_principal_id              => v_prior.principal_id,
        p_department                => v_prior.department,
        p_claim_mode                => v_prior.claim_mode,
        p_ownership_valid_until     => v_verify_by,
        p_contract_ref              => v_prior.contract_ref,
        p_claimed_at                => p_claimed_at,
        p_event_id                  => p_event_id);

    RETURN true;
END;
$reclaim_reopened$;

COMMENT ON FUNCTION cell.reclaim_reopened_task IS
    'FOUNDER RULING R8, second half: the reopened task''s next claimant resumes '
    'on the SAME work. A TRANSCRIPTION — the principal, department, mode, '
    'contract ref and parent claim are read off the interval being resumed and '
    'the ownership window off the task''s own verify_by — and it goes through '
    'cell.claim_work rather than around it.';
