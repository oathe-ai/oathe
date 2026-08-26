-- 002_claim.sql — the claim transaction, and the two halves of one-producer-per-
-- meaning: the guard on the claim-meaning EVENT, and the guard on the terminal
-- ROW whose meaning no verb produces.
--
-- Contract: docs/a1-cell-work-spine-contract.md §1.2, FOUNDER RULING R7
-- ("enforced inside the claim transaction: lock task policy -> insert claim row
-- -> emit claim event, atomically; any other value is a validation error
-- NO_SUCH_MODE"). Requires 001_core.sql.
--
-- Re-apply: idempotent (CREATE OR REPLACE FUNCTION / TRIGGER, ON CONFLICT seed).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- WHY THIS IS A DATABASE FUNCTION AND NOT APPLICATION CODE
--
-- Unique active ownership must hold for every writer, not only for writers that
-- remembered to call the library. MEASURED on the Mac: `realClaimTask` had three
-- bypasses, and 23 `verified` settles reached the bus by direct publish past a
-- CLI-only gate. A claim path expressed as a Postgres function plus a partial
-- unique index has no "past" — the lock, the check, the row and the event are
-- one transaction on the server, and a caller that skips the function still
-- meets the index (001_core.sql).
--
-- WHY THE LOCK IS ON THE TASK ROW
--
-- Read-committed visibility is not enough on its own: two claimants can each
-- observe "no active claim" in their own snapshot. SELECT ... FOR UPDATE on the
-- task's policy row serializes the claimants against each other, so the second
-- one re-reads AFTER the first has committed and refuses with a typed error
-- rather than colliding on the index with an untyped 23505. The index remains as
-- the guarantee; the lock is what makes the refusal legible.

-- ---------------------------------------------------------------------------
-- Declared failure vocabulary (SQLSTATE class FC — outside every class Postgres
-- assigns). The message prefix and the SQLSTATE carry the SAME invariant name,
-- so a caller can key on either and an operator reading the log sees the rule.
--   FC001 CLAIM_UNKNOWN_TASK           claim against work the company has no record of
--   FC002 NO_SUCH_MODE                 any claim_mode but 'exclusive' (R7)
--   FC003 WORK_ALREADY_CLAIMED         a live owner already holds this task
--   FC004 CLAIM_EVENT_FOREIGN_PRODUCER a claim-meaning event from a foreign writer
--   FC005 CLAIM_EVENT_UNREGISTERED_MEANING  a claim-meaning event on a topic no
--                                      verb has been registered to produce
--   FC006 CLAIM_TERMINAL_HAS_NO_DECLARED_WRITER  a claim moved into a terminal
--                                      state that no verb in the cell writes
-- ---------------------------------------------------------------------------
--
-- The two codes above ARE ONE RULE IN TWO HALVES, and they share this file's block
-- for that reason rather than opening one of their own. Checkpoint annex eff9796
-- §E.2, absorbed at design §8 addition 2, measured the hole as a single
-- sentence: for `work_claim.aborted`, `.taken_over` and `.expired` a session
-- could forge BOTH the meaning event AND the terminal row, so 015's argument
-- that a forged terminal "can still reach the ROW but can never reach the
-- MEANING" was true of two terminals out of five. Closing one half would have
-- left the sentence false and the other half open.
--
-- The alternative considered and rejected: a fresh file with its own block, the
-- way 028 takes one for the attempt-bind guard. 028's subject is a DIFFERENT
-- table with DIFFERENT writers; this one's subject is the same claim vocabulary
-- this file already owns, and splitting it would put the two halves of one rule
-- in two migrations for a reviewer to reassemble.
--
-- RETIREMENT CONDITION for both: a verb that writes any of the three terminals,
-- registered in cell.claim_event_producer as that meaning's producer. DELETION
-- OWNER: whoever lands it, in the same change. PHASE: W4's FC-D/FC-E grid, which
-- is where FOUNDER CHECKPOINT FC-E sits.

-- --------------------------------------------------------- producer registry
--
-- contract §1.2: terminals are identified by event MEANING (topic), never by
-- producing code path — MEASURED, the Mac's orphan events had three distinct
-- producers. The cell has exactly one producer per meaning, and this table is
-- where that sentence is checkable rather than asserted.
--
-- L8 (dated bridge), RETIRED 2026-08-25 — see the guard below. Only the meanings
-- whose verb has landed are registered: `work_claim.claimed` here,
-- `work_claim.completion_asserted` by 013 and `work_claim.yielded` by 017. The
-- bridge used to be the GUARD's, which answered a registry miss with `RETURN NEW`
-- while the remaining terminal verbs were pending. That is closed: an
-- unregistered meaning is now refused (FC005), so the three verbless terminals
-- are unwritable as MEANINGS by anybody until W4's FC-E grid says what writes
-- them. Retirement condition for the registry itself is unchanged: the
-- claim-terminal verbs of contract §1.2 all present in this table.
CREATE TABLE IF NOT EXISTS cell.claim_event_producer (
    topic     text NOT NULL,
    producer  text NOT NULL,

    CONSTRAINT claim_event_producer_pkey PRIMARY KEY (topic),

    CONSTRAINT claim_event_producer_topic_is_a_declared_meaning
        CHECK (topic IN ('work_claim.claimed', 'work_claim.completion_asserted',
                         'work_claim.yielded', 'work_claim.aborted',
                         'work_claim.taken_over', 'work_claim.expired'))
);

INSERT INTO cell.claim_event_producer (topic, producer)
VALUES ('work_claim.claimed', 'cell.claim_work')
ON CONFLICT (topic) DO UPDATE SET producer = EXCLUDED.producer;

-- ------------------------------------------------------ the writer signal
--
-- "Which verb is writing this row" — the signal every governed-writer guard in
-- the cell reads, here once because two answers to that question is two answers
-- to the question the whole guard family exists to have one answer to.
--
-- It is the PL/pgSQL CALL STACK, and it used to be a transaction-local setting
-- (`cell.event_producer`, `cell.registrar`, `cell.settling_evaluator`). That was
-- forgeable: a setting is transaction-local, not privileged, so ANY session could
-- type `set_config('cell.settling_evaluator', '<the registered evaluator>', true)`
-- before a direct UPDATE and satisfy the guard that exists to refuse exactly that
-- write. MEASURED in review: the verified edge settled and a second
-- `work_claim.claimed` event landed, both past guards whose comments claimed the
-- writer was checked. The three settings are DELETED in the same change (L5).
--
-- The stack is not forgeable by typing: a caller cannot put a frame on it that is
-- not there. Fabricating one would mean CREATEing a function of that
-- schema-qualified name, which needs CREATE on schema `cell` — owner authority,
-- and an owner already has every authority these guards are about.
--
-- `strpos` rather than LIKE deliberately: every verb name in the cell contains
-- underscores, and `_` is a LIKE wildcard — a LIKE-based check would accept
-- `cell.settleXverified_edge`.
CREATE OR REPLACE FUNCTION cell.written_by(p_verb text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $written_by$
DECLARE
    v_stack text;
BEGIN
    GET DIAGNOSTICS v_stack = PG_CONTEXT;
    RETURN strpos(v_stack, 'PL/pgSQL function ' || p_verb || '(') > 0;
END;
$written_by$;

COMMENT ON FUNCTION cell.written_by IS
    'The cell''s one writer signal: is the named governed verb on this trigger''s '
    'PL/pgSQL call stack. Replaces three transaction-local settings that any '
    'session could set, and therefore forge.';

-- The guard. A direct INSERT — from psql, from a script, from any service that
-- learned the table name — cannot present itself as the registered producer,
-- because the registered producer's frame is either on the call stack or it is
-- not. Matching the `producer` column alone would be forgeable by typing the
-- right string; so, as it turned out, was matching a settable GUC.
CREATE OR REPLACE FUNCTION cell.enforce_one_producer_per_meaning()
RETURNS trigger
LANGUAGE plpgsql
AS $enforce$
DECLARE
    v_registered text;
    v_running    text;
BEGIN
    SELECT producer INTO v_registered
      FROM cell.claim_event_producer
     WHERE topic = NEW.topic;

    IF NOT FOUND THEN
        -- REGISTER-OR-REFUSE (F4, 2026-08-25). This used to `RETURN NEW`: a
        -- meaning whose verb had not landed was bounded by 001's topic
        -- vocabulary and nothing else. MEASURED consequence (design §8, addition
        -- 2): `work_claim.aborted`, `.taken_over` and `.expired` have NO
        -- registered producer, so a session could forge BOTH the terminal row
        -- and its meaning event, and 015's argument that a forged terminal "can
        -- reach the ROW but can never reach the MEANING" was true of two
        -- terminals out of five.
        --
        -- The guard must DECIDE rather than defer: an unregistered topic is
        -- exactly the case where nobody can say what the event means, and a
        -- trigger that waved it through was the widest hole in the terminal
        -- vocabulary. The three verbless terminals get their meanings back the
        -- day a verb registers as their producer — which is FC-E's question and
        -- W4's grid, not this file's.
        --
        -- ENUMERATED EXEMPTIONS AT LANDING: none. No declared meaning in
        -- 001_core.sql's vocabulary legitimately has no producer, so the
        -- exemption list is empty and says so; an unenumerated miss is a refusal.
        --
        -- The refusal names the REGISTRY as what is missing, which is true of
        -- every topic 001's vocabulary declares. A topic outside that vocabulary
        -- meets this refusal first — a BEFORE trigger runs ahead of a CHECK — and
        -- work_claim_event_claim_event_topic_is_a_declared_meaning is still the
        -- layer beneath it, unchanged and still the guarantee for any writer that
        -- could reach the table around this trigger. The same rule is asserted at
        -- its own home in tests/test_core_schema.py: a producer cannot be
        -- registered for a meaning the vocabulary does not declare.
        RAISE EXCEPTION
            'CLAIM_EVENT_UNREGISTERED_MEANING:% — no verb is registered to '
            'produce the meaning ''%''. Terminals are identified by MEANING and '
            'the cell has exactly one producer per meaning (contract §1.2); an '
            'event nobody is registered to write is an event no reader can '
            'attribute, and accepting it is how a forged terminal reaches the '
            'ledger. Register the producing verb in cell.claim_event_producer in '
            'the migration that introduces it.',
            NEW.topic, NEW.topic
            USING ERRCODE = 'FC005';
    END IF;

    IF cell.written_by(v_registered) THEN
        v_running := v_registered;
    ELSE
        v_running := NULL;
    END IF;

    IF v_running IS DISTINCT FROM v_registered
       OR NEW.producer IS DISTINCT FROM v_registered THEN
        RAISE EXCEPTION
            'CLAIM_EVENT_FOREIGN_PRODUCER:%:% — the meaning ''%'' has exactly one '
            'registered producer (%), and this row was not written by it. '
            'Terminals are identified by meaning, never by code path: a second '
            'writer of this topic makes the event unreadable without knowing who '
            'wrote it.',
            NEW.topic, coalesce(v_running, '<no producer in this transaction>'),
            NEW.topic, v_registered
            USING ERRCODE = 'FC004';
    END IF;

    RETURN NEW;
END;
$enforce$;

CREATE OR REPLACE TRIGGER work_claim_event_one_producer_per_meaning
    BEFORE INSERT ON cell.work_claim_event
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_one_producer_per_meaning();

-- --------------------------------------------- the ROW half of the same rule
--
-- Contract §1.2 declares six claim states. Three of them — `aborted`,
-- `taken_over`, `expired` — are written by NO VERB (FOUNDER CHECKPOINT FC-E),
-- and until one exists there is no lawful road into them. This guard is that
-- sentence made true: the transition is refused for EVERY writer, with no
-- `cell.written_by` exemption, because naming a verb here would be naming one
-- that does not exist.
--
-- BEFORE UPDATE, and only the TRANSITION, which is the same two scopes 013's
-- completion guard (:83-88) and 014's settlement guard (:83-88) carry and for
-- the same stated reason: `cell.claim_work` always mints `active`, so every
-- terminal a LIVE cell reaches is reached by UPDATE, while an INSERT of an
-- already-terminal row is a SCENE declaring history rather than a writer
-- performing one. A row that ALREADY holds one of the three may still be written
-- for reasons that are not about its terminal.
--
-- MEASURED consequence, recorded rather than discovered later: this makes
-- 010_parent_child_verification.sql's child-retraction lane unenterable, because
-- its precondition (`010:259-272`) is a parent at `aborted`. That lane was
-- ALREADY dead — annex §E.2 measured every insert raising FC051 today, for the
-- same reason one level down — so this does not close a road; it makes the
-- closed road say so at the first step instead of the second.
CREATE OR REPLACE FUNCTION cell.enforce_verbless_terminal_has_no_writer()
RETURNS trigger
LANGUAGE plpgsql
AS $verbless_terminal$
BEGIN
    IF NEW.state IS NOT DISTINCT FROM OLD.state
       OR NEW.state NOT IN ('aborted', 'taken_over', 'expired') THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'CLAIM_TERMINAL_HAS_NO_DECLARED_WRITER:%:% — no verb in the cell writes '
        'the ''%'' terminal, so there is no lawful road into it and this write '
        'has no author to be accountable to. Contract §1.2 declares six claim '
        'states and the cell has one producer per meaning; three of the six have '
        'no producer at all, which is FOUNDER CHECKPOINT FC-E and W4''s to rule '
        'on. Until a verb lands and registers as that meaning''s producer, a '
        'session that could write this row would be relieving a principal of '
        'work for a reason the company does not hold — and, because the meaning '
        'event is refused too (FC005), would leave a terminal no reader can '
        'attribute.',
        NEW.work_claim_id, NEW.state, NEW.state
        USING ERRCODE = 'FC006';
END;
$verbless_terminal$;

CREATE OR REPLACE TRIGGER work_claim_verbless_terminal_has_no_writer
    BEFORE UPDATE ON cell.work_claim
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_verbless_terminal_has_no_writer();

-- ------------------------------------------------------- the claim transaction
--
-- Every argument is required. There is no default in this signature and there
-- will not be one: a default claim_mode, a default ownership window or a
-- server-generated identifier would each be a policy decision made in the
-- substrate, invisible at the call site, and unreachable by the config object
-- that is supposed to hold every such decision.
--
-- `p_predecessor_work_claim_id` (R-A35-23, added by 027_ownership_return.sql) is
-- SUCCESSION lineage — the interval this claim RESUMES — and it has no default
-- for the same reason nothing else here does. The eleven-argument form is
-- DROPped by 027 in the same change (L5) rather than left beside this one: an
-- overload would be two claim paths, and a caller that kept the old shape would
-- write successor claims carrying no provenance at all.
--
-- Nothing in this signature carries a comment BETWEEN its parameters, and that
-- is load-bearing rather than tidy: the runtime's ONE-CLOCK standing leg derives
-- each verb's instant POSITIONS by parsing this list, and a comment inside it
-- shifts every position after it (MEASURED, this change).
CREATE OR REPLACE FUNCTION cell.claim_work(
    p_org_id                    text,
    p_task_id                   text,
    p_work_claim_id             uuid,
    p_parent_work_claim_id      uuid,
    p_predecessor_work_claim_id uuid,
    p_principal_id              text,
    p_department                text,
    p_claim_mode                text,
    p_ownership_valid_until     timestamptz,
    p_contract_ref              text,
    p_claimed_at                timestamptz,
    p_event_id                  uuid
)
RETURNS uuid
LANGUAGE plpgsql
AS $claim_work$
DECLARE
    v_task_claim_mode text;
    v_holder          text;
    v_holder_claim    uuid;
    v_constraint      text;
BEGIN
    -- 1. lock the task's policy row. Claimants of the same task serialize here.
    SELECT claim_mode INTO v_task_claim_mode
      FROM cell.task
     WHERE org_id = p_org_id AND task_id = p_task_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'CLAIM_UNKNOWN_TASK:%/% — no task by that identity exists in this org, '
            'so there is nothing to take responsibility for. A claim never mints '
            'the work it claims.',
            p_org_id, p_task_id
            USING ERRCODE = 'FC001';
    END IF;

    -- 2. mode. FOUNDER RULING R7: exclusive is the only mode there is. Both the
    --    caller's declared mode and the task's recorded policy are checked, so a
    --    task carrying some other policy cannot be claimed by asking politely.
    IF p_claim_mode IS DISTINCT FROM 'exclusive'
       OR v_task_claim_mode IS DISTINCT FROM 'exclusive' THEN
        RAISE EXCEPTION
            'NO_SUCH_MODE:% — claim_mode ''exclusive'' is the only mode the cell '
            'has (task policy is ''%''). max_active_claims was deferred for want '
            'of any measured workload demanding it; a second mode is a founder '
            'ruling, not a parameter.',
            coalesce(p_claim_mode, '<null>'), coalesce(v_task_claim_mode, '<null>')
            USING ERRCODE = 'FC002';
    END IF;

    -- 3. unique active ownership. Re-read under the lock: the winner of a race
    --    has committed by the time a loser reaches this statement.
    SELECT principal_id, work_claim_id INTO v_holder, v_holder_claim
      FROM cell.work_claim
     WHERE org_id = p_org_id AND task_id = p_task_id AND state = 'active';

    IF FOUND THEN
        RAISE EXCEPTION
            'WORK_ALREADY_CLAIMED:%/% — principal % holds an active claim (%) on '
            'this work. Responsibility passes by a claim terminal — yield, abort, '
            'takeover, reassignment or organizational expiry — never by a second '
            'claimant arriving.',
            p_org_id, p_task_id, v_holder, v_holder_claim
            USING ERRCODE = 'FC003';
    END IF;

    -- 4. the claim row: an interval of RESPONSIBILITY. No session, no runtime,
    --    no heartbeat — those belong to the execution attempts beneath it (R1).
    --
    --    The handler is not a fallback, it is the SAME refusal reached by the
    --    other road. Step 3's re-read uses the TRANSACTION's snapshot, so at
    --    REPEATABLE READ or SERIALIZABLE — where the snapshot predates the
    --    winner's commit — the task row is locked but unmodified, no
    --    serialization failure fires, and the loser sees no active claim. It
    --    then collides with the partial unique index instead: uniqueness still
    --    holds, but the caller gets an untyped 23505 rather than the declared
    --    FC003, and a caller keying on the rule sees a broken substrate. An
    --    executor's own transaction machinery may run this claim at an elevated
    --    isolation level, so the typed refusal is made to hold there too rather
    --    than at READ COMMITTED alone. (At SERIALIZABLE the conflict arrives as
    --    a 40001 serialization failure instead, which is retryable and is NOT a
    --    refusal — the Python face gives it its own type.)
    --
    --    ONLY the unique-active-ownership index is translated. Any other
    --    unique_violation — a reused work_claim_id, say — is a different fact
    --    and is re-raised untouched.
    BEGIN
        INSERT INTO cell.work_claim (
            work_claim_id, org_id, task_id, parent_work_claim_id,
            predecessor_work_claim_id, principal_id,
            department, state, claim_mode, ownership_valid_until, contract_ref,
            terminal_basis, claimed_at, ownership_ended_at, yielded_at, completed_at,
            settled_at
        ) VALUES (
            p_work_claim_id, p_org_id, p_task_id, p_parent_work_claim_id,
            p_predecessor_work_claim_id, p_principal_id,
            p_department, 'active', p_claim_mode, p_ownership_valid_until, p_contract_ref,
            NULL, p_claimed_at, NULL, NULL, NULL,
            NULL
        );
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint IS DISTINCT FROM 'work_claim_unique_active_ownership' THEN
            RAISE;
        END IF;

        SELECT principal_id, work_claim_id INTO v_holder, v_holder_claim
          FROM cell.work_claim
         WHERE org_id = p_org_id AND task_id = p_task_id AND state = 'active';

        RAISE EXCEPTION
            'WORK_ALREADY_CLAIMED:%/% — principal % holds an active claim (%) on '
            'this work. Responsibility passes by a claim terminal — yield, abort, '
            'takeover, reassignment or organizational expiry — never by a second '
            'claimant arriving. (Reached through the unique-ownership index rather '
            'than the re-read: this transaction''s snapshot predates the winner''s '
            'commit, which is what an isolation level above READ COMMITTED means.)',
            p_org_id, p_task_id, coalesce(v_holder, '<committed after this snapshot>'),
            coalesce(v_holder_claim::text, '<committed after this snapshot>')
            USING ERRCODE = 'FC003';
    END;

    -- 5. the claim event, in the SAME transaction. A claim visible as an event
    --    but not as a row (or the reverse) is the split-brain this shape exists
    --    to make impossible. Nothing is set to authorize this write: THIS frame,
    --    on the call stack, is the authorization, and it stops existing when the
    --    function returns — so nothing later in the transaction inherits the
    --    authority to write the meaning, without anybody having to remember to
    --    clear a setting.
    INSERT INTO cell.work_claim_event (event_id, org_id, work_claim_id, topic, ts, producer)
    VALUES (p_event_id, p_org_id, p_work_claim_id, 'work_claim.claimed', p_claimed_at,
            'cell.claim_work');

    RETURN p_work_claim_id;
END;
$claim_work$;

COMMENT ON FUNCTION cell.claim_work IS
    'The one path by which a principal takes responsibility for work. Locks the '
    'task policy row, refuses any mode but exclusive (R7) and any second live '
    'owner, then writes the claim row and its claim-meaning event atomically.';
