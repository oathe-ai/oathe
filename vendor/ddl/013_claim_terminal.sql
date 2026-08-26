-- 013_claim_terminal.sql — THE COMPLETION TERMINAL: the sanctioned verb that
-- ends an interval of responsibility, and the call-stack guard that makes it the
-- only way in.
--
-- Contract: docs/a1-cell-work-spine-contract.md §1.2 (claim terminals; terminals
-- are identified by event MEANING, never by producing code path), §1.3 (a
-- completion statement is an ASSERTION and not completion), §1.6 (completion and
-- settlement are separate facts), FOUNDER RULING R1 (a claim is responsibility,
-- an attempt is runtime) and R2 (the uniform assertion terminal).
-- Requires 001_core.sql, 002_claim.sql (cell.written_by, the producer registry)
-- and 003_verification.sql (cell.agent_statement).
--
-- Re-apply: idempotent (CREATE OR REPLACE, ON CONFLICT registry seed).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- WHY THIS FILE EXISTS, MEASURED
--
-- 002_claim.sql registered ONE producer — `work_claim.claimed` — and named the
-- rest of contract §1.2's terminal verbs as an L8 dated bridge that had not
-- landed. The bake-off measured what that bridge's absence costs. `C3-K6` is the
-- `lifecycle_silent_complete` analog (78 of 120 measured orphans on the Mac were
-- work that had finished and never said so), and its check asks for exactly one
-- row: the claim, at its completion terminal, with `completed_at` stamped. Both
-- candidates were red on it in every repetition, and neither red was theirs: THE
-- CELL HAD NO VERB THAT WRITES ONE. The only road to that row was a direct
-- `UPDATE cell.work_claim` from executor code — a settlement-class write by the
-- one-writer census's own list (A2.4-F0), forbidden absolutely to every
-- candidate. So the leg sat between a missing domain verb and a boundary, and no
-- executor closed it by trying harder.
--
-- This file lands the bridge's first span. It is deliberately NOT "the executor
-- may now write claim terminals": the census is unchanged and `cell.work_claim`
-- remains a table no candidate's source may write. What a candidate may do is
-- CAUSE the write it may not PERFORM — the same shape as `cell.claim_effect_
-- receipt` and `cell.confirm_effect_receipt`, and the shape the evaluator seat's
-- three verbs already have.
--
-- WHY THIS IS A COMPLETION TERMINAL AND NOT A SETTLEMENT
--
-- Said plainly because the two are one word apart in English and two facts apart
-- in the contract. §1.6: settlement is a SEPARATE fact from completion, and
-- `settled_at` is a different column with a different owner — the shared
-- evaluator seat, which transcribes verdicts that already exist. This verb
-- writes `state`, `completed_at` and `ownership_ended_at` and never touches
-- `settled_at`. An author asserting completion is L10's `agent_statement`: it
-- ends the author's RESPONSIBILITY and settles nothing at all. The
-- `work_claim_settlement_follows_a_claim_terminal` constraint in 001 is what
-- keeps the two orders honest afterwards.
--
-- WHY IT IS A TRANSCRIPTION AND TAKES NO INSTANT
--
-- The verb's two arguments are identifiers. Everything it writes is READ off the
-- `cell.agent_statement` row the caller names: the org, the task, the claim and
-- the instant. There is nowhere in the statement below to put a value the caller
-- invented, which is the same discipline `cell.record_confirm_verdict` is built
-- to and the reason a lane writing a settlement-adjacent fact is lawful at all.
-- In particular there is no `p_completed_at`: a runtime that could choose the
-- instant its principal's responsibility ended could end it before the assertion
-- that is supposed to be its basis.
--
-- Declared failure vocabulary (SQLSTATE class FC; this lane reserves
-- FC100-FC109):
--   FC100 CLAIM_TERMINAL_WRITTEN_OUTSIDE_THE_SANCTIONED_VERB  a completion
--                                          terminal moved onto a claim row by
--                                          something that is not this verb
--   FC101 CLAIM_TERMINAL_STATEMENT_UNKNOWN  a terminal transcribed from a
--                                          statement the cell has no record of
--   FC102 CLAIM_TERMINAL_STATEMENT_IS_NOT_A_COMPLETION  a terminal transcribed
--                                          from a progress/result/observation
--   FC103 CLAIM_TERMINAL_STATEMENT_SUPERSEDED  a terminal transcribed from an
--                                          assertion its own author withdrew
--   FC104 CLAIM_TERMINAL_CLAIM_ALREADY_ENDED  a completion terminal onto a claim
--                                          that yielded, aborted, was taken over
--                                          or expired

-- ------------------------------------------------------------- the writer guard
--
-- The 009/012 lesson, restated for the claim row: a rule that lives only in
-- whoever happens to be writing is a rule with a bypass, and the Mac's 23
-- direct-publish `verified` settles are what that bypass cost. The signal is
-- `cell.written_by` — the PL/pgSQL CALL STACK, which a caller cannot put a frame
-- on that is not there — rather than a column it could type or a setting it
-- could set for itself.
--
-- ONLY THE TRANSITION IS GUARDED, and only on UPDATE. Two deliberate scopes:
--
--   * a row that is ALREADY `completion_asserted` may be updated for reasons
--     that have nothing to do with the terminal (the evaluator seat's later
--     `settled_at`, a correction to `ownership_valid_until`), and re-checking the
--     terminal there would make an unrelated write fail for a reason that is not
--     about it — the same scoping `cell.enforce_task_edge_release_is_the_
--     evaluator_lanes` uses;
--   * an INSERT of a row already at a terminal is a SCENE declaring history, not
--     a writer performing one. `cell.claim_work` is the only path that mints a
--     claim and it always mints `active`, so every terminal a live cell reaches
--     is reached by UPDATE. 012's reopen guard is `BEFORE UPDATE` for exactly
--     this reason.
CREATE OR REPLACE FUNCTION cell.enforce_completion_terminal_is_the_sanctioned_verbs()
RETURNS trigger
LANGUAGE plpgsql
AS $completion_writer$
BEGIN
    IF NEW.state IS DISTINCT FROM 'completion_asserted'
       OR OLD.state = 'completion_asserted' THEN
        RETURN NEW;
    END IF;

    IF NOT cell.written_by('cell.assert_claim_completion') THEN
        RAISE EXCEPTION
            'CLAIM_TERMINAL_WRITTEN_OUTSIDE_THE_SANCTIONED_VERB:% — a claim '
            'reaches its completion terminal through cell.assert_claim_completion '
            'and through nothing else. Contract §1.2: claim terminals are '
            'identified by MEANING and the cell has exactly one producer per '
            'meaning; §1.3 and L10 make the author''s completion statement an '
            'assertion, so the terminal is a TRANSCRIPTION of a recorded '
            'statement rather than a runtime''s opinion about itself. The writer '
            'signal is the PL/pgSQL call stack, which a direct writer cannot '
            'fabricate, rather than a column it could type: 23 historical '
            '`verified` settles reached the bus by direct publish naming exactly '
            'the right evaluator.',
            NEW.work_claim_id
            USING ERRCODE = 'FC100';
    END IF;

    RETURN NEW;
END;
$completion_writer$;

CREATE OR REPLACE TRIGGER work_claim_completion_terminal_is_the_sanctioned_verbs
    BEFORE UPDATE ON cell.work_claim
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_completion_terminal_is_the_sanctioned_verbs();

-- ------------------------------------------------------ the producer registry
--
-- The other half of "one producer per meaning", and the half 002 could not seed
-- until this verb existed. With this row present, `cell.enforce_one_producer_
-- per_meaning` refuses a hand-written `work_claim.completion_asserted` event
-- from any session — the same refusal `work_claim.claimed` has had since 002.
--
-- L8 (dated bridge), narrowed by one span: the registry is complete when the
-- remaining terminal verbs (yield, abort, takeover, expiry) ship. Retirement
-- condition unchanged — all of contract §1.2's claim-terminal verbs present in
-- this table; deletion owner: the A1 work-spine lane.
INSERT INTO cell.claim_event_producer (topic, producer)
VALUES ('work_claim.completion_asserted', 'cell.assert_claim_completion')
ON CONFLICT (topic) DO UPDATE SET producer = EXCLUDED.producer;

-- --------------------------------------------------------------------- the verb
--
-- Both arguments are required and both are identifiers. There is no default here
-- and there will not be one: a server-generated event id would make the caller
-- unable to address the event it caused, and a defaulted instant would be the
-- substrate choosing when a principal stopped being responsible.
--
-- It ANSWERS WHETHER THIS CALL MOVED ANYTHING, like every verb in 012: "the
-- terminal was recorded" and "the terminal was already recorded" are different
-- facts to an executor that has to write down what it did, and a recovery that
-- transcribed nothing must be distinguishable in evidence from one that never
-- looked.
CREATE OR REPLACE FUNCTION cell.assert_claim_completion(
    p_statement_id uuid,
    p_event_id     uuid
)
RETURNS boolean
LANGUAGE plpgsql
AS $assert_completion$
DECLARE
    v_org           text;
    v_task          text;
    v_claim         uuid;
    v_type          text;
    v_asserted_at   timestamptz;
    v_superseded_by uuid;
    v_state         text;
    v_moved         integer;
BEGIN
    SELECT s.org_id, s.task_id, s.work_claim_id, s.statement_type, s.asserted_at,
           (SELECT later.statement_id FROM cell.agent_statement later
             WHERE later.supersedes_ref = s.statement_id LIMIT 1)
      INTO v_org, v_task, v_claim, v_type, v_asserted_at, v_superseded_by
      FROM cell.agent_statement s
     WHERE s.statement_id = p_statement_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'CLAIM_TERMINAL_STATEMENT_UNKNOWN:% — a completion terminal is a '
            'TRANSCRIPTION of a recorded assertion (§1.3), and there is no such '
            'statement. Writing anyway would end a principal''s responsibility on '
            'the strength of something nobody said.',
            p_statement_id
            USING ERRCODE = 'FC101';
    END IF;

    IF v_type IS DISTINCT FROM 'completion' THEN
        RAISE EXCEPTION
            'CLAIM_TERMINAL_STATEMENT_IS_NOT_A_COMPLETION:%:% — only a '
            '`completion` statement asserts that the work described by the '
            'objective is done. A progress, result or observation statement is an '
            'author saying something ELSE about work still in hand, and a terminal '
            'transcribed from one would end responsibility nobody offered to end.',
            p_statement_id, coalesce(v_type, '<null>')
            USING ERRCODE = 'FC102';
    END IF;

    IF v_superseded_by IS NOT NULL THEN
        RAISE EXCEPTION
            'CLAIM_TERMINAL_STATEMENT_SUPERSEDED:%:% — this assertion was '
            'withdrawn by a later one, and a superseded completion assertion '
            'stops counting in v_task_completion for exactly that reason. The '
            'terminal follows the LIVE assertion or it follows nothing.',
            p_statement_id, v_superseded_by
            USING ERRCODE = 'FC103';
    END IF;

    -- Lock the claim before reading its state: two transcriptions of the same
    -- assertion on the same tick serialize here, and the loser re-reads AFTER
    -- the winner has committed rather than both seeing `active`.
    SELECT state INTO v_state
      FROM cell.work_claim
     WHERE work_claim_id = v_claim
       FOR UPDATE;

    -- Idempotency is the PREDICATE, not a set this verb remembers: a restart
    -- takes a remembered set with it, which is the whole reason L2 puts durable
    -- state below the agent. A recovery that finds the terminal already recorded
    -- has nothing to do and says so.
    IF v_state = 'completion_asserted' THEN
        RETURN false;
    END IF;

    IF v_state IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION
            'CLAIM_TERMINAL_CLAIM_ALREADY_ENDED:%:% — responsibility for this work '
            'already ended by another terminal, and claim terminals are not '
            'reversible by a second one arriving. Contract §1.2: responsibility '
            'passes by yield, abort, takeover, reassignment or organizational '
            'expiry, and a completion terminal written over one of those would '
            'record that the principal who was relieved of the work finished it.',
            v_claim, coalesce(v_state, '<no such claim>')
            USING ERRCODE = 'FC104';
    END IF;

    -- The terminal. Every value is the statement's own: `completed_at` is R2's
    -- assertion stamp and `ownership_ended_at` is the same instant, because the
    -- assertion IS the end of the author's responsibility (§1.2 as amended by
    -- R2). `settled_at` is untouched and belongs to the evaluator seat (§1.6).
    --
    -- Nothing is set to authorize this write: THIS frame, on the call stack, is
    -- what the guard above reads, and it stops existing when the function
    -- returns — so nothing later in the transaction inherits the authority to
    -- end a claim, without anybody having to remember to clear a setting.
    UPDATE cell.work_claim
       SET state              = 'completion_asserted',
           completed_at       = v_asserted_at,
           ownership_ended_at = v_asserted_at
     WHERE work_claim_id = v_claim
       AND state = 'active';

    GET DIAGNOSTICS v_moved = ROW_COUNT;

    -- The meaning event, in the SAME transaction as the row. A terminal visible
    -- as a row but not as an event (or the reverse) is the split-brain 002's
    -- claim transaction exists to make impossible, and this verb inherits the
    -- rule rather than restating it: the producer trigger reads the same call
    -- stack, so this INSERT is lawful here and nowhere else.
    INSERT INTO cell.work_claim_event (event_id, org_id, work_claim_id, topic, ts,
                                       producer)
    VALUES (p_event_id, v_org, v_claim, 'work_claim.completion_asserted',
            v_asserted_at, 'cell.assert_claim_completion');

    RETURN v_moved = 1;
END;
$assert_completion$;

COMMENT ON FUNCTION cell.assert_claim_completion IS
    'Contract §1.2/R2: the one writer of a claim''s completion terminal. A '
    'TRANSCRIPTION of a recorded completion statement — org, task, claim and '
    'instant are all read off it — and never a settlement: `settled_at` is the '
    'evaluator seat''s (§1.6).';
