-- 014_claim_settlement.sql — THE SETTLEMENT STAMP: the shared evaluator seat's
-- verb for the claim row, and the call-stack guard that makes it the only way in.
--
-- Contract: docs/a1-cell-work-spine-contract.md §1.6 (completion and settlement
-- are SEPARATE facts, with different owners), §1.3 and L10 (a completion
-- statement is an assertion, never truth), §1.4 (a verification is a non-author
-- verdict about a recorded statement), FOUNDER RULING R4 (release is performed
-- by the evaluator lane) and R8 (a rejection reopens work; it never settles it).
-- Requires 001_core.sql, 002_claim.sql (cell.written_by), 003_verification.sql
-- and 013_claim_terminal.sql (the terminal this settlement follows).
--
-- Re-apply: idempotent (CREATE OR REPLACE).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- WHY THIS FILE EXISTS, MEASURED
--
-- 013 landed the COMPLETION half of §1.6 and said in its own comment that the
-- other half was somebody else's: "`settled_at` is untouched and belongs to the
-- evaluator seat (§1.6)". The seat did not have it. `firia_cell_domain.
-- evaluator`'s fifth standing property was "No settlement fact on the claim —
-- nothing here touches `cell.work_claim`", and what that cost was measured
-- across a whole bake-off family: `SETTLE_LOST`, case 3's standing assertion
-- that a settled claim carries a `verified` verification recorded at or before
-- its `settled_at`, was red on ALL EIGHT legs against BOTH entrants and was
-- UNREACHABLE rather than unmet. `cell.work_claim` is on the one-writer census's
-- settlement list absolutely (A2.4-F0), so no candidate could write it; and no
-- verb existed for the seat, so waking the seat could not cause it either. The
-- red was the CELL's.
--
-- This file closes it in the shape 013 and 012 already established: a sanctioned
-- verb under a call-stack guard. A candidate may CAUSE this write by waking the
-- seat and may never PERFORM it, and `cell.settle_work_claim` joins the census's
-- SANCTIONED_SETTLEMENT_VERBS — the list of names no candidate's source may even
-- reach for.
--
-- WHY THIS IS NOT A CLAIM TERMINAL
--
-- Responsibility has already ended when this runs; §1.2's terminals are the
-- author's or the organization's acts and this is neither. So the verb writes
-- `settled_at` and NOTHING else — not `state`, not `completed_at`, not
-- `ownership_ended_at` — and it writes no `cell.work_claim_event`: 001_core.sql
-- declares six claim MEANINGS and settlement is not among them. A settlement
-- event would make settlement look like a seventh terminal to every reader of
-- that table.
--
-- WHY THERE IS NO SIGNER ARGUMENT
--
-- Because there is no signer column, and adding one would be the drift `cell.
-- v_dep_edge_release` exists to prevent: `cell.verification.verifier_principal`
-- already holds the name of whoever signed, and a copy of it on the claim row
-- would be a second place for "who settled this" to be answered differently. The
-- verdict this settlement rests on is addressable from the claim's own org and
-- task, which is what the refusals below read.
--
-- WHY THE INSTANT IS AN ARGUMENT AND THE VERDICT IS NOT
--
-- `p_settled_at` is the SEAT's, exactly as `cell.settle_task_edge`'s is: a lane
-- that transcribes says when it did so, and a server-chosen `now()` would be the
-- substrate deciding an instant that belongs in the caller's evidence. Every
-- other precondition is READ: the claim's terminal, and a standing `verified`
-- verification over the claim's own task. There is nowhere in the UPDATE below
-- to put a value a caller invented except that instant, and both orderings it
-- could get wrong are refused by name rather than by a bare CHECK violation.
--
-- Declared failure vocabulary (SQLSTATE class FC; this lane reserves
-- FC110-FC119):
--   FC110 CLAIM_SETTLEMENT_WRITTEN_OUTSIDE_THE_SANCTIONED_VERB  a settlement
--                                          stamp moved onto a claim row by
--                                          something that is not this verb
--   FC111 CLAIM_SETTLEMENT_CLAIM_UNKNOWN   a settlement of a claim the company
--                                          has no record of
--   FC112 CLAIM_SETTLEMENT_WITHOUT_A_CLAIM_TERMINAL  a settlement of work whose
--                                          principal still holds it
--   FC113 CLAIM_SETTLEMENT_UNVERIFIED      a settlement with no `verified`
--                                          verification standing over the
--                                          claim's own task at or before it
--   FC114 CLAIM_SETTLEMENT_PRECEDES_ITS_OWN_TERMINAL  a settlement instant
--                                          earlier than the end of the
--                                          responsibility it settles
--   FC115 CLAIM_SETTLEMENT_SUPERSEDED_BY_A_SUCCESSOR  a settlement of an interval
--                                          that handed the work on to a later one
--   FC116 CLAIM_SETTLEMENT_VERIFICATION_NOT_BOUND_TO_THIS_INTERVAL  a successor
--                                          settled on a verdict about an earlier
--                                          interval's statement
--
-- The two codes above were ADDED 2026-08-25 — F3, the ownership-return §5.6,
-- FOUNDER CHECKPOINT **FC-C ruled S2** (R-A35-25 §5): settlement is stamped on
-- the interval that carried the work to DONE, and a predecessor's `settled_at`
-- stays NULL forever. They amend this file IN PLACE and take codes from its own
-- FC110-FC119 block rather than arriving from 027, because re-creating
-- cell.settle_work_claim out of another migration would split one verb's
-- definition across two files (§5.6.1's stated reason; 027's FC187 is released).
--
-- WHY A RETURN NEEDS TWO NEW REFUSALS AND NOT ONE
--
-- After R-A35-23's ownership return, ONE TASK CAN CARRY TWO INTERVALS: the
-- predecessor that handed the work back and the successor that resumed it. Both
-- of the checks below were correct while a task had one interval and are holes
-- the moment it has two.
--
--   FC115 — FC113's message says settlement exists to prevent "work marked done
--   by the thing that did it". A predecessor settling off a SUCCESSOR's
--   verification is the adjacent defect: work marked done FOR an interval that
--   did not do it and did not verify it, whose own recorded terminal says it
--   handed the work away. Nothing breaks under S2 — a claim with NULL
--   `settled_at` is exactly what an `aborted` or `taken_over` interval looks
--   like, and work_claim_settlement_follows_a_claim_terminal
--   (001_core.sql:182-184) permits the absence unconditionally.
--
--   FC116 — FC113 reads its verdict over the claim's own ORG AND TASK, which is
--   the right grain for a task with one interval and too WIDE for a task with
--   two: the predecessor's historical `verified` verification satisfies a
--   task-grain lookup and would settle a successor that has not yet said
--   anything. The narrowed predicate follows the verdict back to its author —
--   `verification.statement_id` → `agent_statement.work_claim_id` — which 003
--   makes NOT NULL precisely so a verdict always has a recorded statement to be
--   about. It applies to claims that HAVE a predecessor and to no others: an
--   ordinary claim's settlement rule is unchanged, because for it the two grains
--   select the same rows.

-- ------------------------------------------------------------- the writer guard
--
-- ONLY THE TRANSITION into a settled claim is guarded, and only on UPDATE — the
-- same two scopes 013's terminal guard carries, for the same two reasons. A row
-- that is ALREADY settled may be written for reasons that are not about
-- settlement, and an INSERT of a settled row is a SCENE declaring history rather
-- than a writer performing one (`cell.claim_work` always mints `active`, so
-- every settlement a live cell reaches is reached by UPDATE).
CREATE OR REPLACE FUNCTION cell.enforce_claim_settlement_is_the_evaluator_seats()
RETURNS trigger
LANGUAGE plpgsql
AS $settlement_writer$
BEGIN
    IF NEW.settled_at IS NULL OR OLD.settled_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    IF NOT cell.written_by('cell.settle_work_claim') THEN
        RAISE EXCEPTION
            'CLAIM_SETTLEMENT_WRITTEN_OUTSIDE_THE_SANCTIONED_VERB:% — a claim is '
            'settled through cell.settle_work_claim and through nothing else. '
            'FOUNDER RULING R4 with contract §1.2: settlement is performed by the '
            'evaluator lane, never by the completing author''s runtime; §1.6 keeps '
            'it a separate fact from the completion terminal beside it. The writer '
            'signal is the PL/pgSQL call stack, which a direct writer cannot '
            'fabricate, rather than a column it could type: 23 historical '
            '`verified` settles reached the bus by direct publish naming exactly '
            'the right evaluator.',
            NEW.work_claim_id
            USING ERRCODE = 'FC110';
    END IF;

    RETURN NEW;
END;
$settlement_writer$;

CREATE OR REPLACE TRIGGER work_claim_settlement_is_the_evaluator_seats
    BEFORE UPDATE ON cell.work_claim
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_claim_settlement_is_the_evaluator_seats();

-- --------------------------------------------------------------------- the verb
--
-- Both arguments are required and neither has a default. It ANSWERS WHETHER THIS
-- CALL MOVED ANYTHING, like every verb in 012 and 013: "settled" and "already
-- settled" are different facts to a lane that has to write down what its wake
-- did, and a wake that settled nothing must be distinguishable in evidence from
-- one that never looked.
CREATE OR REPLACE FUNCTION cell.settle_work_claim(
    p_work_claim_id uuid,
    p_settled_at    timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
AS $settle_claim$
DECLARE
    v_org       text;
    v_task      text;
    v_state     text;
    v_ended_at  timestamptz;
    v_settled   timestamptz;
    v_verified  timestamptz;
    v_predecessor uuid;
    v_moved     integer;
BEGIN
    -- Lock the claim before reading it: two wakes on the same tick serialize
    -- here, and the loser re-reads AFTER the winner has committed rather than
    -- both seeing an unsettled row.
    SELECT org_id, task_id, state, ownership_ended_at, settled_at,
           predecessor_work_claim_id
      INTO v_org, v_task, v_state, v_ended_at, v_settled, v_predecessor
      FROM cell.work_claim
     WHERE work_claim_id = p_work_claim_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'CLAIM_SETTLEMENT_CLAIM_UNKNOWN:% — a settlement is an act on work the '
            'company has a record of. An UPDATE that matched nothing fires no '
            'trigger at all, which is how a settlement path comes to report '
            'success for a row it never touched.',
            p_work_claim_id
            USING ERRCODE = 'FC111';
    END IF;

    -- Idempotency is the PREDICATE, not a set this lane remembers: a restart
    -- takes a remembered set with it, which is the whole of what L2 puts below
    -- the agent.
    IF v_settled IS NOT NULL THEN
        RETURN false;
    END IF;

    -- F3, first half. Read BEFORE the terminal check, because "this interval
    -- handed the work on" is a stronger and more specific fact than "this
    -- interval is live", and an operator reading the log should be told which of
    -- the two is true of the row they asked about.
    IF EXISTS (SELECT 1 FROM cell.work_claim succ
                WHERE succ.org_id = v_org
                  AND succ.predecessor_work_claim_id = p_work_claim_id) THEN
        RAISE EXCEPTION
            'CLAIM_SETTLEMENT_SUPERSEDED_BY_A_SUCCESSOR:%/%:% — this interval was '
            'RESUMED: a later interval on the same work carries it, and the '
            'settlement stamp belongs to whichever interval carried the work to '
            'done (§5.6, FC-C ruled S2). Stamping it here would assert that this '
            'interval''s work was accepted, about an interval whose own recorded '
            'terminal says it handed the work away — the adjacent defect to the '
            'one FC113 exists to refuse.',
            v_org, v_task, p_work_claim_id
            USING ERRCODE = 'FC115';
    END IF;

    IF v_state = 'active' THEN
        RAISE EXCEPTION
            'CLAIM_SETTLEMENT_WITHOUT_A_CLAIM_TERMINAL:% — settlement follows the '
            'end of responsibility (§1.6, and 001_core.sql''s '
            'work_claim_settlement_follows_a_claim_terminal). A live claim settled '
            'would record work as finished while its principal still holds it, and '
            'the refusal is named here rather than left to a CHECK whose message '
            'says nothing about who was asking.',
            p_work_claim_id
            USING ERRCODE = 'FC112';
    END IF;

    -- THE VERDICT, read over the claim's OWN org and task, at or before the
    -- instant being stamped. `result = 'verified'` and not merely "a verification
    -- exists": R8 makes a rejection reopen work rather than settle it, and a
    -- lane that settled on any verdict would settle rejected work.
    SELECT min(v.recorded_at) INTO v_verified
      FROM cell.verification v
     WHERE v.org_id = v_org
       AND v.task_id = v_task
       AND v.result = 'verified'
       AND v.recorded_at <= p_settled_at;

    IF v_verified IS NULL THEN
        RAISE EXCEPTION
            'CLAIM_SETTLEMENT_UNVERIFIED:%/%:% — a settled claim carries a '
            '`verified` verification recorded at or before its settled_at. §1.3 '
            'and L10 make the author''s completion statement an ASSERTION, so a '
            'claim settled on the strength of it alone is the Mac''s '
            'queue_task_state.closed — work marked done by the thing that did it — '
            'which is the single defect cell.verification exists to make '
            'impossible.',
            v_org, v_task, p_settled_at
            USING ERRCODE = 'FC113';
    END IF;

    -- F3, second half: a SUCCESSOR settles only on a verdict about ITS OWN
    -- completion statement. Read after FC113 so a successor with no verdict at
    -- all still gets the unverified refusal — "nobody verified this work" and
    -- "the verdict is about an earlier interval" are different facts and a
    -- caller keying on the code must be able to tell them apart.
    IF v_predecessor IS NOT NULL
       AND NOT EXISTS (SELECT 1
                         FROM cell.verification v
                         JOIN cell.agent_statement s
                           ON s.statement_id = v.statement_id
                        WHERE v.org_id = v_org
                          AND v.task_id = v_task
                          AND v.result = 'verified'
                          AND v.recorded_at <= p_settled_at
                          AND s.work_claim_id = p_work_claim_id) THEN
        RAISE EXCEPTION
            'CLAIM_SETTLEMENT_VERIFICATION_NOT_BOUND_TO_THIS_INTERVAL:%/%:% — '
            'this interval RESUMED % and the only `verified` verdicts standing '
            'over this task are about an earlier interval''s statement. After a '
            'return one task carries two intervals, so a task-grain lookup can no '
            'longer tell whose work was accepted: the verdict that settles an '
            'interval is the one recorded against a statement that interval made.',
            v_org, v_task, p_work_claim_id, v_predecessor
            USING ERRCODE = 'FC116';
    END IF;

    IF p_settled_at < v_ended_at THEN
        RAISE EXCEPTION
            'CLAIM_SETTLEMENT_PRECEDES_ITS_OWN_TERMINAL:%:% — the instant a claim '
            'is settled is at or after the instant responsibility for it ended '
            '(§1.6). Stamping earlier would settle work somebody still held, and '
            'the constraint that would otherwise catch it says nothing about which '
            'of the two orderings was wrong.',
            p_work_claim_id, p_settled_at
            USING ERRCODE = 'FC114';
    END IF;

    -- Nothing is set to authorize this write: THIS frame, on the call stack, is
    -- what the guard above reads, and it stops existing when the function
    -- returns — so nothing later in the transaction inherits the authority to
    -- settle a claim, without anybody having to remember to clear a setting.
    UPDATE cell.work_claim
       SET settled_at = p_settled_at
     WHERE work_claim_id = p_work_claim_id
       AND settled_at IS NULL;

    GET DIAGNOSTICS v_moved = ROW_COUNT;
    RETURN v_moved = 1;
END;
$settle_claim$;

COMMENT ON FUNCTION cell.settle_work_claim IS
    'Contract §1.6 / FOUNDER RULING R4: the one writer of a claim''s settlement '
    'stamp, held by the shared evaluator seat. Never a claim terminal — `state`, '
    '`completed_at` and `ownership_ended_at` are 013''s and are untouched here — '
    'and never written without a `verified` verification standing over the '
    'claim''s own task at or before the instant stamped. After R-A35-23''s '
    'ownership return a task may carry two intervals, so it also refuses to '
    'settle an interval that was RESUMED (FC115, FC-C ruled S2) and refuses to '
    'settle a SUCCESSOR on a verdict about an earlier interval''s statement '
    '(FC116).';
