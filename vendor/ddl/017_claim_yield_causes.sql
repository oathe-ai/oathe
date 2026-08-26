-- 017_claim_yield_causes.sql — THE ONE PRODUCER OF THE YIELD MEANING, the
-- registry of the causes that may reach it, and the SECOND cause: a parent
-- handing responsibility back with delegated work outstanding.
--
-- Contract: docs/a1-cell-work-spine-contract.md §1.2 (claim terminals;
-- responsibility passes by yield; a terminal is identified by event MEANING
-- rather than by producing code path), §1.6 (completion and settlement are
-- separate facts), §2.1 shape (a) (the delegated child claim), FOUNDER RULING
-- R1 and R8. Requires 001_core.sql, 002_claim.sql (cell.written_by, the producer
-- registry) and 015_claim_yield.sql (the first cause, whose terminal write moves
-- here in this same change).
--
-- Re-apply: idempotent (CREATE OR REPLACE, ON CONFLICT registry seeds).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- WHY THIS FILE EXISTS, MEASURED
--
-- `C1-CHILD-LEASE-ON-PARENT-YIELD` asks for one row: the parent's claim at a
-- yield terminal carrying a typed basis, while the child claim stays ACTIVE and
-- no `child_retraction` is written — a yield is not a withdrawal. Both bake-off
-- entrants were red on it in every repetition of the 20260818T2100Z pair and
-- NEITHER RED WAS THEIRS. 015's own header named this cause in as many words
-- ("a yield has several lawful causes — a holder handing back unfinished work, a
-- parent yielding with delegated work outstanding, a reassignment") and shipped
-- a verb for exactly one of them. That verb takes a `token_id` and reads
-- everything off the ask, so a parent with no ask had nothing to hand it, and
-- the only road to the row was a direct `UPDATE cell.work_claim` from executor
-- code — forbidden absolutely to every candidate by the one-writer census
-- (A2.4-F0). The leg sat between a missing domain verb and a boundary.
--
-- WHY ONE PRODUCER AND SEVERAL CAUSES IS NOT A CONTRADICTION
--
-- §1.2 identifies a terminal by its MEANING, and 002's registry holds exactly
-- one producer per meaning. So the MEANING gets one writer — `cell.record_claim_
-- yield`, which owns the lock, the idempotency predicate, the not-reversible
-- rule, the row and the event — and the CAUSES are separate verbs that each
-- answer a different question: which recorded fact ends this claim, at which
-- instants that fact is already true, and what basis it derives. Splitting it
-- the other way (a verb per cause, each writing its own row and its own event)
-- is what would put two producers behind one meaning, which is the state 002's
-- guard exists to refuse.
--
-- `cell.claim_yield_cause` is the review surface for that split: it names which
-- verb may transcribe which basis, and the writer refuses a caller on neither
-- list. A cause cannot write another cause's basis, and nothing outside the
-- declared causes can write the meaning at all. Adding a cause is a row here and
-- a verb; it is never a second writer.
--
-- WHY THE HANDBACK'S FACT IS THE OUTSTANDING WORK AND NOT THE ESCALATION
--
-- Case 1's parent raises an escalation on its way out — `YIELD_SCRIPT` declares
-- one, addressed to the CEO — and this verb deliberately never reads it.
-- 005_escalation.sql: nothing keys a row to an escalation and no trigger turns
-- one into a consequence, precisely so the request-for-help lane cannot become a
-- second authority over the work lifecycle (L1). What ends this claim is the
-- DELEGATED WORK ITSELF — active child claims hanging off it, a fact the claim
-- transaction recorded — and a parent with nothing outstanding is REFUSED. So "I
-- would like to stop" is not something a runtime can say to this verb; the only
-- claims it can end are ones the substrate already says somebody else is
-- carrying work for.
--
-- WHY THERE IS STILL NO ROW TRIGGER ON THIS TRANSITION
--
-- 015 deferred it under a dated L8 bridge, and this file narrows that bridge by
-- one span rather than closing it: a guard naming `cell.record_claim_yield`
-- would now be TRUE of every yield the cell can perform, and false of every
-- yield the two causes that still have no verb perform — the holder's plain
-- handback and the reassignment — including the ones the matrix's own scenes
-- declare as history. A guard that has to be true of a meaning cannot be
-- installed while that meaning still has causes with no verb.
--
-- L8, dated, narrowed by one span: the row-level guard lands in the same change
-- as the remaining yield causes' verbs (plain handback, reassignment).
-- Retirement condition unchanged — all of contract §1.2's yield causes reachable
-- through a verb in this schema. Deletion owner: the A1 work-spine lane.
--
-- Declared failure vocabulary (SQLSTATE class FC; this lane reserves
-- FC140-FC149):
--   FC140 CLAIM_YIELD_WRITTEN_OUTSIDE_A_DECLARED_CAUSE  the yield meaning
--                                          written by something that is not one
--                                          of the registered causes
--   FC141 CLAIM_YIELD_BASIS_IS_NOT_THE_CAUSES  a declared cause writing a basis
--                                          registered to a different cause
--   FC142 CLAIM_YIELD_CLAIM_ALREADY_ENDED  a yield onto a claim whose
--                                          responsibility ended by another
--                                          terminal
--   FC143 CLAIM_YIELD_HANDBACK_CLAIM_UNKNOWN  a handback by a claim the company
--                                          has no record of
--   FC144 CLAIM_YIELD_HANDBACK_NOTHING_OUTSTANDING  a handback by a parent with
--                                          no delegated work anybody is carrying
--   FC145 CLAIM_YIELD_HANDBACK_PRECEDES_THE_DELEGATION  a handback stamped
--                                          before the work being handed back was
--                                          delegated
--   FC146 CLAIM_YIELD_CLAIM_UNKNOWN        the yield meaning written against a
--                                          claim that is not there

-- ------------------------------------------------------------ the cause registry
--
-- Shaped like `cell.claim_event_producer` on purpose: substrate VOCABULARY
-- installed by a migration, read by a guard, and checkable rather than asserted.
-- The basis prefix is UNIQUE as well as the cause, because the pair is what
-- makes "why did responsibility pass" resolvable — a reader holding a terminal
-- basis can name the cause that wrote it, and exactly one.
CREATE TABLE IF NOT EXISTS cell.claim_yield_cause (
    cause        text NOT NULL,
    basis_prefix text NOT NULL,

    CONSTRAINT claim_yield_cause_pkey PRIMARY KEY (cause),
    CONSTRAINT claim_yield_cause_prefix_names_one_cause UNIQUE (basis_prefix),

    -- A prefix with a colon in it could not be split back out of the basis, and
    -- a blank one would match every basis there is.
    CONSTRAINT claim_yield_cause_prefix_is_a_single_token
        CHECK (basis_prefix <> '' AND strpos(basis_prefix, ':') = 0)
);

COMMENT ON TABLE cell.claim_yield_cause IS
    'Contract §1.2. The declared causes of a work_claim.yielded MEANING, and the '
    'basis each may derive. One producer writes the meaning; these are the facts '
    'that may reach it.';

INSERT INTO cell.claim_yield_cause (cause, basis_prefix) VALUES
    ('cell.yield_claim_on_expired_ask', 'confirm_ask_expired'),
    ('cell.yield_claim_with_delegated_work_outstanding',
     'delegated_work_outstanding')
ON CONFLICT (cause) DO UPDATE SET basis_prefix = EXCLUDED.basis_prefix;

-- ------------------------------------------------------ the producer registry
--
-- 002 named the terminal verbs as an L8 dated bridge and registered the meanings
-- whose verb had landed. 015 seeded this row with its own name, because it was
-- then the only cause there was; the producer of the MEANING is now the shared
-- writer below, and 015's registration is deleted in the same change (L5) rather
-- than left beside this one for a reader to reconcile.
INSERT INTO cell.claim_event_producer (topic, producer)
VALUES ('work_claim.yielded', 'cell.record_claim_yield')
ON CONFLICT (topic) DO UPDATE SET producer = EXCLUDED.producer;

-- --------------------------------------------------------- the one producer
--
-- Everything that is true of a yield REGARDLESS of what caused it, in one place:
-- the claim lock, the idempotency predicate, the terminals-are-not-reversible
-- rule, the row, and the meaning event in the same transaction. A rule that
-- lives in one cause is a rule the next cause has to remember, and 015 was
-- written when there was no next cause.
--
-- It takes a BASIS rather than deriving one, and that is not a hole: the basis
-- is checked against the registry row of the cause on the call stack, so a
-- caller may only pass a basis its own cause declares. What each cause derives
-- the rest of that basis FROM is the cause's business, and it is a recorded fact
-- in every case — an ask's canonical key, the task ids of the work still
-- outstanding.
CREATE OR REPLACE FUNCTION cell.record_claim_yield(
    p_work_claim_id uuid,
    p_basis         text,
    p_at            timestamptz,
    p_event_id      uuid
)
RETURNS boolean
LANGUAGE plpgsql
AS $record_yield$
DECLARE
    v_cause  text;
    v_prefix text;
    v_org    text;
    v_state  text;
    v_moved  integer;
BEGIN
    -- WHICH DECLARED CAUSE IS ON THE STACK. Not a column, not a setting: a
    -- caller cannot put a frame on the PL/pgSQL call stack that is not there,
    -- and MEASURED, three transaction-local settings that any session could set
    -- were exactly what the cell's guards used to read.
    SELECT c.cause, c.basis_prefix INTO v_cause, v_prefix
      FROM cell.claim_yield_cause c
     WHERE cell.written_by(c.cause)
     ORDER BY c.cause
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'CLAIM_YIELD_WRITTEN_OUTSIDE_A_DECLARED_CAUSE:% — a work_claim.'
            'yielded meaning is written by this verb and reached by a DECLARED '
            'CAUSE (cell.claim_yield_cause), and nothing on this call stack is '
            'one. Contract §1.2: responsibility passes by a terminal, and a '
            'terminal nobody can resolve to a recorded fact is a principal '
            'relieved of work for a reason the company does not hold.',
            p_work_claim_id
            USING ERRCODE = 'FC140';
    END IF;

    IF split_part(p_basis, ':', 1) IS DISTINCT FROM v_prefix THEN
        RAISE EXCEPTION
            'CLAIM_YIELD_BASIS_IS_NOT_THE_CAUSES:%:%:% — this cause derives a '
            'basis under ''%'', and the basis offered is not one. A cause that '
            'could write another''s basis would make the terminal''s reason '
            'unresolvable: a reader holding the row could not tell which '
            'recorded fact it stands on.',
            p_work_claim_id, v_cause, p_basis, v_prefix
            USING ERRCODE = 'FC141';
    END IF;

    -- The claim, locked before its state is read: two causes reaching the same
    -- claim on the same tick serialize here, and the loser re-reads AFTER the
    -- winner has committed rather than both seeing `active`.
    SELECT org_id, state INTO v_org, v_state
      FROM cell.work_claim
     WHERE work_claim_id = p_work_claim_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'CLAIM_YIELD_CLAIM_UNKNOWN:% — there is no such claim, so nothing '
            'ended and there is no responsibility this call could be evidence '
            'of. An UPDATE that matched nothing fires no trigger at all, which '
            'is how a terminal path comes to report success for a row it never '
            'touched.',
            p_work_claim_id
            USING ERRCODE = 'FC146';
    END IF;

    -- Idempotency is the PREDICATE, not a set this verb remembers: a restart
    -- takes a remembered set with it, which is the whole reason L2 puts durable
    -- state below the agent. A recovery that finds the terminal already recorded
    -- has nothing to do and says so.
    IF v_state = 'yielded' THEN
        RETURN false;
    END IF;

    IF v_state IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION
            'CLAIM_YIELD_CLAIM_ALREADY_ENDED:%:% — responsibility for this work '
            'already ended by another terminal, and claim terminals are not '
            'reversible by a second one arriving. Contract §1.2: a yield written '
            'over a completion, an abort or a takeover would record that the '
            'principal who was relieved of the work handed it back.',
            p_work_claim_id, v_state
            USING ERRCODE = 'FC142';
    END IF;

    -- The terminal. `settled_at` is untouched and belongs to the evaluator seat
    -- (§1.6): handing work back settles nothing, whatever handed it back.
    UPDATE cell.work_claim
       SET state              = 'yielded',
           terminal_basis     = p_basis,
           yielded_at         = p_at,
           ownership_ended_at = p_at
     WHERE work_claim_id = p_work_claim_id
       AND state = 'active';

    GET DIAGNOSTICS v_moved = ROW_COUNT;

    -- The meaning event, in the SAME transaction as the row. A terminal visible
    -- as a row but not as an event (or the reverse) is the split-brain 002's
    -- claim transaction exists to make impossible. The producer trigger reads
    -- THIS frame off the call stack, so this INSERT is lawful here and nowhere
    -- else.
    INSERT INTO cell.work_claim_event (event_id, org_id, work_claim_id, topic, ts,
                                       producer)
    VALUES (p_event_id, v_org, p_work_claim_id, 'work_claim.yielded', p_at,
            'cell.record_claim_yield');

    RETURN v_moved = 1;
END;
$record_yield$;

COMMENT ON FUNCTION cell.record_claim_yield IS
    'Contract §1.2: the ONE producer of a work_claim.yielded meaning. Owns the '
    'lock, the idempotency predicate, the not-reversible rule, the row and the '
    'event; reached only by a verb registered in cell.claim_yield_cause, and only '
    'with the basis that cause declares.';

-- ------------------------------------------------------------- the second cause
--
-- Every argument is required and none may grow a default. The caller supplies an
-- IDENTITY, an INSTANT and an EVENT ID — the same three 015 takes — and
-- everything the terminal MEANS is read off the substrate.
--
-- The INSTANT is the caller's because this cause has no stored moment of its
-- own: the fact it rests on is a state (work delegated out and still carried),
-- not an event with a timestamp. It cannot be used to end responsibility before
-- that fact was true, because the verb REFUSES any instant earlier than the
-- delegation it names.
CREATE OR REPLACE FUNCTION cell.yield_claim_with_delegated_work_outstanding(
    p_work_claim_id uuid,
    p_at            timestamptz,
    p_event_id      uuid
)
RETURNS boolean
LANGUAGE plpgsql
AS $yield_handback$
DECLARE
    v_outstanding text;
    v_delegated   timestamptz;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM cell.work_claim
                    WHERE work_claim_id = p_work_claim_id) THEN
        RAISE EXCEPTION
            'CLAIM_YIELD_HANDBACK_CLAIM_UNKNOWN:% — a handback is an act by a '
            'principal holding an interval of responsibility, and there is no '
            'such interval. Writing anyway would end responsibility nobody took.',
            p_work_claim_id
            USING ERRCODE = 'FC143';
    END IF;

    -- THE RECORDED FACT, and the whole of what this cause stands on: work
    -- delegated out of this claim (§2.1 shape (a)) that a DIFFERENT principal is
    -- still carrying. `active` and nothing else — a child that reached its own
    -- terminal is work nobody is holding, so it is not something to hand back
    -- with.
    SELECT string_agg(child.task_id, ',' ORDER BY child.task_id),
           max(child.claimed_at)
      INTO v_outstanding, v_delegated
      FROM cell.work_claim child
     WHERE child.parent_work_claim_id = p_work_claim_id
       AND child.state = 'active';

    IF v_outstanding IS NULL THEN
        RAISE EXCEPTION
            'CLAIM_YIELD_HANDBACK_NOTHING_OUTSTANDING:% — this claim has no '
            'delegated work anybody is carrying, so there is nothing to hand '
            'back with. A holder that simply wants to stop is a DIFFERENT yield '
            'cause with a different recorded fact behind it, and it has no verb '
            'yet: a runtime that could reach this one would be ending its '
            'principal''s responsibility on its own say-so, which is the whole '
            'thing the cause registry exists to prevent.',
            p_work_claim_id
            USING ERRCODE = 'FC144';
    END IF;

    IF p_at < v_delegated THEN
        RAISE EXCEPTION
            'CLAIM_YIELD_HANDBACK_PRECEDES_THE_DELEGATION:%:% — the work being '
            'handed back was delegated at %, and this yield is stamped %. A '
            'parent cannot hand back work it had not yet delegated, and a '
            'runtime that could pick the instant could write one by choosing an '
            'earlier clock.',
            p_work_claim_id, v_outstanding, v_delegated, p_at
            USING ERRCODE = 'FC145';
    END IF;

    -- The basis is DERIVED from the work still outstanding — the task ids
    -- themselves, not a count — so "why did responsibility pass" resolves to
    -- rows an operator can go and read, rather than to a sentence a runtime
    -- composed about itself. There is nowhere in this call to put one.
    RETURN cell.record_claim_yield(
        p_work_claim_id => p_work_claim_id,
        p_basis         => 'delegated_work_outstanding:' || v_outstanding,
        p_at            => p_at,
        p_event_id      => p_event_id);
END;
$yield_handback$;

COMMENT ON FUNCTION cell.yield_claim_with_delegated_work_outstanding IS
    'Contract §1.2 / §2.1: the second declared cause of a claim yield — a parent '
    'handing responsibility back while a different principal is still carrying '
    'work delegated out of it. The basis is derived from that work; the '
    'escalation such a parent also raises is deliberately never read (005).';
