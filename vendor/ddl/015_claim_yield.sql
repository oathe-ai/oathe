-- 015_claim_yield.sql — THE YIELD TERMINAL FOR AN ASK NOBODY ANSWERED: the
-- sanctioned verb that hands responsibility back when the decision a claim was
-- waiting on can never arrive.
--
-- Contract: docs/a1-cell-work-spine-contract.md §1.2 (claim terminals;
-- responsibility passes by yield, and a terminal is identified by event MEANING
-- rather than by producing code path), §5 case 4 (the confirm wait), FOUNDER
-- RULING R1 (a claim is responsibility, an attempt is runtime — a runtime dying
-- costs a binding and never an ownership, and so does a question dying).
-- Requires 001_core.sql, 002_claim.sql (cell.claim_event_producer) and
-- 011_confirm.sql (the ask this terminal is transcribed from).
--
-- Re-apply: idempotent (CREATE OR REPLACE, ON CONFLICT registry seed).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- WHY THIS FILE EXISTS, MEASURED
--
-- `C4-TOKEN-EXPIRES` asks for one row: the claim whose operator ask died
-- unanswered, at a yield terminal, carrying a typed basis. Both bake-off
-- entrants were red on it in every repetition of the 20260818T1200Z pair and
-- NEITHER RED WAS THEIRS. `cell.consume_confirm_token`'s own FC062 message names
-- the outcome — "the honest outcome is a typed yield and an escalation to the
-- assigner" — and the cell had no verb that writes one: 002_claim.sql registered
-- `work_claim.claimed`, 013_claim_terminal.sql added `work_claim.
-- completion_asserted`, and the remaining four terminals were an L8 dated bridge
-- that had not landed. The only road to the row was a direct
-- `UPDATE cell.work_claim` from executor code, which the one-writer census
-- (A2.4-F0) forbids to every candidate absolutely. So the leg sat between a
-- missing domain verb and a boundary, and no executor closed it by trying harder.
--
-- This file lands the bridge's second span, for the ONE yield cause case 4
-- measures. The census is unchanged and `cell.work_claim` remains a table no
-- candidate's source may write; what a candidate may do is CAUSE the write it
-- may not PERFORM, exactly as with `cell.claim_effect_receipt`,
-- `cell.confirm_effect_receipt` and `cell.assert_claim_completion`.
--
-- WHY THE VERB NAMES THE ASK RATHER THAN THE CLAIM
--
-- Because it is a TRANSCRIPTION and not a decision, which is the only shape in
-- which a lane may write a claim terminal at all (013's argument, restated for
-- this cause). Everything written below is read off the ask: the org and task are
-- the token's, the claim is the one holding that task, and the basis is DERIVED
-- from the ask's own canonical key — there is nowhere in the statement to put a
-- basis a caller invented, so no runtime can end its principal's responsibility
-- and describe why in words of its own.
--
-- The INSTANT is the caller's and is required, and that is 011's lesson 3 rather
-- than an exception to 013's no-instant rule: expiry is derived at an explicit
-- instant, never stored, so a caller that could not state the instant it read the
-- world at could not be tested at a stated one. It cannot be used to end
-- responsibility early: the verb REFUSES any instant at which the ask was still
-- answerable, so the earliest yield this verb can write is the ask's own death.
--
-- WHAT THIS FILE OWNS, AND WHAT MOVED OUT OF IT
--
-- It owns the CAUSE and nothing else: which recorded fact ends this claim (an
-- ask that died unanswered), at which instants that fact is already true, and
-- what basis it derives. The TERMINAL itself — the claim lock, the idempotency
-- predicate, the terminals-are-not-reversible rule, the row and the meaning
-- event — moved to `cell.record_claim_yield` in 017_claim_yield_causes.sql, and
-- the inline copy that used to be here is deleted in that same change (L5).
--
-- It moved because a SECOND CAUSE arrived. §1.2 identifies a terminal by its
-- MEANING and 002's registry holds one producer per meaning, so a verb per cause
-- each writing its own row and its own event would be two producers behind one
-- meaning — the state that guard exists to refuse. One writer, several declared
-- causes, and the causes are a registry (`cell.claim_yield_cause`) rather than a
-- comment: this verb is registered there against the `confirm_ask_expired`
-- basis, and may write no other.
--
-- The apply order is a table-and-constraint order, not a call-graph one. PL/pgSQL
-- resolves the call below when it RUNS, so this file may hand its terminal to a
-- verb the next file installs; `tests/test_apply.py` applies the whole declared
-- order and `tests/test_claim_yield.py` drives this verb against it, so a 017
-- that stopped installing the writer fails there rather than in a cell.
--
-- FC123 (CLAIM_YIELD_CLAIM_ALREADY_ENDED) was raised here and is not any more: the
-- rule is every cause's, so it belongs to the shared writer (017, FC142).
--
-- WHY THERE IS STILL NO ROW TRIGGER ON THIS TRANSITION, SAID PLAINLY
--
-- 013 guards the transition into `completion_asserted` with `cell.written_by`,
-- and the symmetric guard here would be wrong TODAY rather than merely
-- unfinished. A yield has several lawful causes — a holder handing back
-- unfinished work, a parent yielding with delegated work outstanding, a
-- reassignment — and a guard naming ONE verb refuses every yield the other causes
-- perform, including the ones the matrix's own scenes declare as history. A
-- guard that has to be true of a meaning cannot be installed while only one of
-- that meaning's causes has a verb.
--
-- What IS installed is the half that can be true now: the EVENT registry, seeded
-- in 017 against the shared writer. `cell.enforce_one_producer_per_meaning`
-- refuses a hand-written `work_claim.yielded` event from any session — so a
-- forged terminal can still reach the ROW but can never reach the MEANING, and a
-- terminal with no event beside it is visible to anybody who looks for one.
-- Contract §1.2 makes the event the identity of a terminal, so that is the half
-- that decides.
--
-- L8, dated, narrowed by one span in 017: the row-level guard lands in the same
-- change as the remaining yield causes' verbs (the plain handback, the
-- reassignment). Retirement condition unchanged — all of contract §1.2's yield
-- causes reachable through a verb in this schema. Deletion owner: the A1
-- work-spine lane.
--
-- Declared failure vocabulary (SQLSTATE class FC; this lane reserves
-- FC120-FC129):
--   FC120 CLAIM_YIELD_ASK_UNKNOWN          a yield transcribed from an ask the
--                                          cell has no record of
--   FC121 CLAIM_YIELD_ASK_WAS_ANSWERED     a yield transcribed from an ask an
--                                          operator answered
--   FC122 CLAIM_YIELD_ASK_STILL_ANSWERABLE a yield at an instant the ask was
--                                          still alive at

-- --------------------------------------------------------------------- the verb
--
-- Every argument is required and none may grow a default. It ANSWERS WHETHER
-- THIS CALL MOVED ANYTHING, like every verb in 012 and 013: "the claim yielded"
-- and "the claim had already ended" are different facts to an executor that has
-- to write down what it did, and a wake that transcribed nothing must be
-- distinguishable in evidence from one that never looked.
CREATE OR REPLACE FUNCTION cell.yield_claim_on_expired_ask(
    p_token_id uuid,
    p_at       timestamptz,
    p_event_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
AS $yield_on_expiry$
DECLARE
    v_org        text;
    v_task       text;
    v_ask_key    text;
    v_state      text;
    v_expires_at timestamptz;
    v_claim      uuid;
BEGIN
    SELECT t.org_id, t.task_id, t.ask_key, t.state, t.expires_at
      INTO v_org, v_task, v_ask_key, v_state, v_expires_at
      FROM cell.confirm_token t
     WHERE t.token_id = p_token_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'CLAIM_YIELD_ASK_UNKNOWN:% — a yield on an expiry is a TRANSCRIPTION '
            'of an ask that died, and there is no such ask. Writing anyway would '
            'end a principal''s responsibility on the strength of a question '
            'nobody ever put.',
            p_token_id
            USING ERRCODE = 'FC120';
    END IF;

    IF v_state <> 'issued' THEN
        RAISE EXCEPTION
            'CLAIM_YIELD_ASK_WAS_ANSWERED:%:% — an operator answered this ask, so '
            'the decision the claim was waiting on EXISTS. The verdict it becomes '
            'is the evaluator seat''s to transcribe (011_confirm.sql); yielding '
            'here would hand back work whose answer had already arrived.',
            p_token_id, v_state
            USING ERRCODE = 'FC121';
    END IF;

    IF p_at < v_expires_at THEN
        RAISE EXCEPTION
            'CLAIM_YIELD_ASK_STILL_ANSWERABLE:% — the ask lives until % and this '
            'yield is stamped %. 011_confirm.sql lesson 2: a waiter that gives up '
            'while its ask is still answerable has not timed out, it has dropped a '
            'live decision — and a runtime that could pick the instant would be '
            'able to drop one by choosing a later clock.',
            p_token_id, v_expires_at, p_at
            USING ERRCODE = 'FC122';
    END IF;

    -- The claim that HOLDS this work. The lock, the state read and the
    -- not-reversible rule are `cell.record_claim_yield`'s (017): they are true of
    -- every yield whatever caused it, and a rule that lives in one cause is a
    -- rule the next cause has to remember. What is read HERE is the identity —
    -- which claim this ask's work belongs to — because that is the cause's own
    -- question and nobody else's.
    SELECT wc.work_claim_id INTO v_claim
      FROM cell.work_claim wc
     WHERE wc.org_id = v_org AND wc.task_id = v_task
     ORDER BY wc.claimed_at DESC, wc.work_claim_id
     LIMIT 1;

    -- An ask over work nobody ever claimed transcribes nothing and says so. It
    -- is not a refusal: a token can outlive the claim it was minted under, and a
    -- verb that raised here would take down a recovery sweep over the ordinary
    -- shape of the world.
    IF v_claim IS NULL THEN
        RETURN false;
    END IF;

    -- The terminal, through the one producer of the yield MEANING. The basis is
    -- DERIVED from the ask's own canonical key, so "why did responsibility pass"
    -- resolves to the question that died rather than to a sentence a runtime
    -- composed about itself — and the registry binds this verb to the
    -- `confirm_ask_expired` prefix, so it is the only basis this cause can write.
    -- `settled_at` is untouched and belongs to the evaluator seat (§1.6): a
    -- question nobody answered settles nothing.
    RETURN cell.record_claim_yield(
        p_work_claim_id => v_claim,
        p_basis         => 'confirm_ask_expired:' || v_ask_key,
        p_at            => p_at,
        p_event_id      => p_event_id);
END;
$yield_on_expiry$;

COMMENT ON FUNCTION cell.yield_claim_on_expired_ask IS
    'Contract §1.2 / R1 and 011_confirm.sql FC062: the FIRST declared cause of '
    'a work_claim.yielded meaning — the operator ask that died unanswered. A '
    'TRANSCRIPTION: org, task, claim and basis are all read off the ask, and the '
    'instant is refused unless the ask was already dead at it. The terminal '
    'itself is written by cell.record_claim_yield (017).';
