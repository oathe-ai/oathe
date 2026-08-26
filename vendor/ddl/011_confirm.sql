-- 011_confirm.sql — the confirm token: the operator verification case 4 waits on.
--
-- Contract: docs/a1-cell-work-spine-contract.md §1.4 source 3 (the consume is a
-- verification, state_version-bound; a REJECT consume is a verification with
-- result='rejected'; a NULL-verdict consume projects `indeterminate`, never
-- approve) and §5 case 4 (restart neither re-mints the ask nor double-consumes;
-- the claim resumes against the already-recorded verification).
-- Requires 001_core.sql (the task this ask hangs off).
--
-- Re-apply: idempotent (CREATE ... IF NOT EXISTS / OR REPLACE).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- WHAT THIS FILE IS AND IS NOT
--
-- It is the minimal confirm-token-shaped substrate the `C4-*` bake-off legs
-- assert over: one canonical ask, one state-version-bound consume, one derived
-- projection. It is deliberately NOT the operator surface — nothing here renders
-- a prompt, routes a page, or decides who may answer. Those live above it, and
-- the point of putting the token here is that a restart, a redeploy or a killed
-- executor changes none of it.
--
-- The verification record itself is 003_verification.sql's
-- `source='confirm_token_consume'` row. This file holds the ASK and the CONSUME;
-- the evaluator lane writes the verification against them. Keeping the two apart
-- is what makes "recv is a wake-up, confirm_tokens is truth" expressible: a
-- waiter that woke up learns nothing until it re-reads this table.
--
-- FOUR MEASURED LESSONS, MADE STRUCTURAL
--
-- 1. ONE TOKEN PER CANONICAL ASK, FOREVER. `UNIQUE (org_id, ask_key)` carries no
--    predicate. A partial index on `state = 'issued'` would open a window in
--    which re-asking one question is lawful, and a restart landing in that window
--    leaves an operator staring at two prompts for one decision — after which the
--    second consume approves something already approved once.
--
-- 2. THE STATED WAIT COVERS THE TOKEN'S OWN LIFE. `wait_timeout_s` is mandatory
--    and is checked against the TTL. That is `CONFIRM_WAIT_ABANDONED` made
--    structural: the measured trap is an executor whose `recv` gives up after a
--    default 60 seconds nobody wrote down, while the ask it was waiting on
--    remains answerable for an hour. A waiter that abandons a live decision has
--    not timed out; it has dropped the decision on the floor.
--
-- 3. EXPIRY IS DERIVED AT AN EXPLICIT INSTANT, NEVER STORED. There is no
--    `expired` state. A stored expiry needs a reaper, and between reaper runs the
--    column reads as authoritative while being wrong — the same defect shape as
--    the Mac's transcript-mtime liveness proxy. `cell.expired_confirm_tokens(at)`
--    is the shape `cell.unverified_past_verify_by` already uses.
--
-- 4. A NULL VERDICT PROJECTS `indeterminate`. MEASURED: 217 NULL-verdict rows in
--    the estate. `verdict` is nullable for exactly that case — the contract's
--    §1.4 clause 3 names it — and the projection is a VIEW so that no reader gets
--    to decide for itself what a missing verdict meant. Deciding it locally is
--    how a non-decision becomes an approval (L13).
--
-- Declared failure vocabulary added by this file (SQLSTATE class FC):
--   FC060 CONFIRM_TOKEN_NO_SUCH_TOKEN      a consume against an ask never minted
--   FC061 CONFIRM_TOKEN_ALREADY_CONSUMED   the double consume / the race loser
--   FC062 CONFIRM_TOKEN_EXPIRED            a consume past the ask's own life
--   FC063 CONFIRM_STATE_VERSION_STALE      the 0073 analog: an approval bound to
--                                          a state that has since moved
--   FC064 CONFIRM_CONSUME_REFUSED          the CAS admitted nothing and none of
--                                          the named reasons applied

-- ---------------------------------------------------------------------------
-- confirm_token — one canonical ask, one answer
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.confirm_token (
    token_id        uuid        NOT NULL,
    org_id          text        NOT NULL,
    task_id         text        NOT NULL,

    -- The canonical ask. Everything that makes this question THIS question:
    -- restart, redeploy and re-entry all derive the same key, which is why
    -- re-minting is a uniqueness violation rather than a policy check.
    ask_key         text        NOT NULL,

    state           text        NOT NULL,

    -- §1.4 clause 3 / the 0073 lesson: an approval is an approval OF something.
    -- The consume must name the same version, or it approved a different world.
    state_version   bigint      NOT NULL,

    -- The wait this ask binds its waiter to, stated in the substrate. Mandatory
    -- because the alternative is the executor's own undeclared default, and the
    -- bake-off exists to stop measuring those.
    wait_timeout_s  numeric     NOT NULL,

    issued_at       timestamptz NOT NULL,
    expires_at      timestamptz NOT NULL,

    -- NULL exactly while the token is unconsumed.
    consumed_at     timestamptz,
    consumed_by     text,

    -- NULL on an unconsumed token, and NULL on a consumed one is the MEASURED
    -- null-verdict shape the contract names (§1.4 clause 3): an operator closed
    -- the ask without recording a verdict. It projects `indeterminate`.
    verdict         text,

    CONSTRAINT confirm_token_pkey PRIMARY KEY (token_id),

    CONSTRAINT confirm_token_task_fkey
        FOREIGN KEY (org_id, task_id) REFERENCES cell.task (org_id, task_id),

    -- Lesson 1, as an index rather than as a habit.
    CONSTRAINT confirm_token_one_token_per_canonical_ask UNIQUE (org_id, ask_key),

    CONSTRAINT confirm_token_state_is_a_declared_state
        CHECK (state IN ('issued', 'consumed')),

    CONSTRAINT confirm_token_verdict_is_a_declared_verdict
        CHECK (verdict IS NULL OR verdict IN ('approve', 'reject')),

    CONSTRAINT confirm_token_consumed_token_names_its_operator_and_instant
        CHECK ((state = 'consumed')
               = (consumed_at IS NOT NULL AND consumed_by IS NOT NULL)),

    CONSTRAINT confirm_token_only_a_consumed_token_carries_a_verdict
        CHECK (state = 'consumed' OR verdict IS NULL),

    CONSTRAINT confirm_token_expires_after_it_is_issued
        CHECK (expires_at > issued_at),

    CONSTRAINT confirm_token_stated_wait_is_positive
        CHECK (wait_timeout_s > 0),

    -- Lesson 2. The waiter may wait longer than the ask lives — that is how it
    -- observes the expiry and escalates. It may never wait less.
    CONSTRAINT confirm_token_stated_wait_covers_the_token_ttl
        CHECK (wait_timeout_s >= EXTRACT(EPOCH FROM (expires_at - issued_at)))
);

COMMENT ON TABLE cell.confirm_token IS
    'Contract §1.4 clause 3. recv is a wake-up; this table is truth — a waiter '
    'that woke up has learned nothing until it re-reads the row.';

CREATE INDEX IF NOT EXISTS confirm_token_by_task
    ON cell.confirm_token (org_id, task_id, state);

-- ---------------------------------------------------------------------------
-- cell.consume_confirm_token — the CAS that admits exactly one operator
--
-- The admission test IS the UPDATE's WHERE clause: the transition out of
-- `issued` happens once, under the row lock Postgres already takes, and every
-- other caller re-evaluates the predicate against the committed row and matches
-- nothing. Diagnosis happens only AFTER the CAS has declined, so the refusal
-- names what was actually true rather than what was true when we looked first.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cell.consume_confirm_token(
    p_org_id        text,
    p_token_id      uuid,
    p_consumed_by   text,
    p_state_version bigint,
    p_verdict       text,
    p_at            timestamptz
)
RETURNS void
LANGUAGE plpgsql
AS $consume$
DECLARE
    v_token   cell.confirm_token%ROWTYPE;
    v_updated integer;
BEGIN
    UPDATE cell.confirm_token
       SET state       = 'consumed',
           consumed_at = p_at,
           consumed_by = p_consumed_by,
           verdict     = p_verdict
     WHERE org_id        = p_org_id
       AND token_id      = p_token_id
       AND state         = 'issued'
       AND state_version = p_state_version
       AND p_at          < expires_at;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 1 THEN
        RETURN;
    END IF;

    SELECT * INTO v_token
      FROM cell.confirm_token
     WHERE org_id = p_org_id AND token_id = p_token_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'CONFIRM_TOKEN_NO_SUCH_TOKEN:%/% — there is no ask with this id in '
            'this org. A consume against a token nobody minted is an approval '
            'with no question behind it.',
            p_org_id, p_token_id
            USING ERRCODE = 'FC060';

    ELSIF v_token.state = 'consumed' THEN
        RAISE EXCEPTION
            'CONFIRM_TOKEN_ALREADY_CONSUMED:% — % answered this ask at %. One '
            'canonical ask has one answer: a restart resumes against the '
            'recorded consume (§5 case 4), it never consumes again.',
            p_token_id, v_token.consumed_by, v_token.consumed_at
            USING ERRCODE = 'FC061';

    ELSIF p_at >= v_token.expires_at THEN
        RAISE EXCEPTION
            'CONFIRM_TOKEN_EXPIRED:% — the ask expired at % and the consume is '
            'stamped %. The honest outcome is a typed yield and an escalation to '
            'the assigner; an approve minted here would be an approval nobody '
            'gave.',
            p_token_id, v_token.expires_at, p_at
            USING ERRCODE = 'FC062';

    ELSIF v_token.state_version <> p_state_version THEN
        RAISE EXCEPTION
            'CONFIRM_STATE_VERSION_STALE:% — the ask was minted against state '
            'version %, the consume names %. An approval is an approval OF '
            'something (the 0073 lesson); binding it to a version that has since '
            'moved approves a different world than the operator saw.',
            p_token_id, v_token.state_version, p_state_version
            USING ERRCODE = 'FC063';

    ELSE
        -- Unreachable by construction, and loud rather than silent for exactly
        -- that reason: if the CAS declines for a reason this function cannot
        -- name, the predicate and the diagnosis have drifted apart, and a
        -- silent RETURN would report a consume that never happened.
        RAISE EXCEPTION
            'CONFIRM_CONSUME_REFUSED:% — the CAS admitted no row and none of the '
            'declared reasons (no such token, already consumed, expired, stale '
            'version) applies. The admission predicate and this diagnosis have '
            'drifted apart.',
            p_token_id
            USING ERRCODE = 'FC064';
    END IF;
END;
$consume$;

-- ---------------------------------------------------------------------------
-- cell.v_confirm_verdict — what a token PROJECTS, decided in one place
--
-- `indeterminate` is the answer for a consumed token with no verdict, and it is
-- computed here so that no reader can reach its own conclusion about what a
-- missing verdict meant. 217 rows in the estate are exactly this shape.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW cell.v_confirm_verdict AS
SELECT
    t.token_id,
    t.org_id,
    t.task_id,
    t.ask_key,
    t.state,
    t.state_version,
    t.consumed_by,
    t.consumed_at,
    CASE
        WHEN t.state <> 'consumed'  THEN 'unconsumed'
        WHEN t.verdict = 'approve'  THEN 'verified'
        WHEN t.verdict = 'reject'   THEN 'rejected'
        ELSE 'indeterminate'
    END AS projects
FROM cell.confirm_token t;

COMMENT ON VIEW cell.v_confirm_verdict IS
    'Contract §1.4 clause 3: a NULL-verdict consume projects indeterminate, '
    'never approve (MEASURED: 217 rows; L13).';

-- ---------------------------------------------------------------------------
-- cell.expired_confirm_tokens — expiry, read at an instant the caller states
--
-- No stored `expired` state and no reaper. A consumed token is never reported:
-- it was answered, and paging an operator about a decision they already made is
-- how an alert lane loses its readers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cell.expired_confirm_tokens(p_at timestamptz)
RETURNS TABLE (
    token_id      uuid,
    org_id        text,
    task_id       text,
    ask_key       text,
    issued_at     timestamptz,
    expires_at    timestamptz,
    overdue_by    interval
)
LANGUAGE sql
STABLE
AS $expired$
    SELECT t.token_id, t.org_id, t.task_id, t.ask_key, t.issued_at,
           t.expires_at, p_at - t.expires_at
      FROM cell.confirm_token t
     WHERE t.state = 'issued'
       AND p_at >= t.expires_at;
$expired$;
