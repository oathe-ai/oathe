-- 019_verification_contract_freeze.sql — the verification contract is FROZEN at
-- claim time, and the live plan equals the bound contract by construction.
--
-- Contract: A3 worksheet §7 (acceptance lane) + a3-verification-strategy.md §3.2
-- row ACC-CONTRACT-FROZEN. Verification report 3 (a3-founder-rulings.md) MEASURED
-- the defect this closes: judgment currently FLOATS on the mutable live plan —
-- `cell.task.verification_plan` can be edited directly under an active claim, so
-- the bar a claim was accepted against and the bar it is settled against are two
-- different objects, and nothing records the change. That is the AC-01-drift /
-- bar-lowering class (strategy §5). Requires 001_core.sql, 002_claim.sql (the
-- `cell.written_by` writer signal) and 009_verified_edge.sql (the typed-event
-- vocabulary + reader registry the CONTRACT_CHANGED event registers into).
--
-- Re-apply: idempotent (CREATE ... IF NOT EXISTS / OR REPLACE; ON CONFLICT seed).
-- Revert:   DROP FUNCTION cell.amend_verification_contract(text,text,jsonb,timestamptz,uuid,text);
--           DROP FUNCTION cell.contract_drift();  DROP VIEW cell.v_contract_parity;
--           DROP TRIGGER task_verification_contract_is_frozen ON cell.task;
--           DROP TRIGGER work_claim_freezes_its_contract ON cell.work_claim;
--           DROP FUNCTION cell.enforce_verification_contract_frozen();
--           DROP FUNCTION cell.freeze_verification_contract();
--           DROP FUNCTION cell.hash_verification_contract(jsonb);
--           DROP TABLE cell.verification_contract;
--           DELETE FROM cell.typed_event_reader WHERE event_type='contract_changed';
--           DELETE FROM cell.typed_event_type   WHERE event_type='contract_changed';
--
-- Declared failure vocabulary (SQLSTATE class FC; this lane reserves FC160-FC169):
--   FC160 CONTRACT_FROZEN_UNDER_CLAIM   a direct verification_plan edit under an
--                                       active claim, by any writer but the one
--                                       typed amend verb
--   FC161 CONTRACT_AMEND_NO_ACTIVE_CLAIM  the amend verb called on work no
--                                       principal currently holds — where the
--                                       plan is freely mutable and needs no verb

-- ---------------------------------------------------------------------------
-- the canonical hash of a verification contract
--
-- The contract IS the task's verification_plan (its clauses and their status).
-- jsonb text output is canonical in Postgres — keys sorted, no insignificant
-- whitespace — so md5(plan::text) is a stable fingerprint that does not depend on
-- how the plan was spelled at the call site. IMMUTABLE so it may sit in a view's
-- WHERE and in an index later without re-evaluation surprises.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cell.hash_verification_contract(p_plan jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $hash$
    SELECT md5(p_plan::text);
$hash$;

COMMENT ON FUNCTION cell.hash_verification_contract IS
    'The canonical fingerprint of a verification contract: md5 over the jsonb '
    'canonical text of the plan. The claim binds this hash; the parity check '
    'reads it back against the live plan.';

-- ---------------------------------------------------------------------------
-- verification_contract — the bar a claim was accepted against, bound at claim
-- time. One row per work_claim: the interval of responsibility and the contract
-- it answers to are the same lifetime.
--
-- This is a BINDING, not a second settlement authority: nothing reads it to
-- decide completion (that is still v_task_completion over the live plan). What it
-- exists for is to make the sentence "the live plan still equals the bound
-- contract" a mechanical fact the parity check can read, instead of a hope.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.verification_contract (
    work_claim_id   uuid        NOT NULL,
    org_id          text        NOT NULL,
    task_id         text        NOT NULL,

    -- The hash bound at claim time (or re-bound by an amend). Non-empty by
    -- construction: md5 is 32 hex chars, and a blank hash would make the parity
    -- check compare a value against nothing.
    contract_hash   text        NOT NULL,

    -- The exact plan the hash was taken over, kept so an amend's before/after is
    -- addressable and a parity failure can show WHAT drifted, not only that it did.
    plan_snapshot   jsonb       NOT NULL,

    frozen_at       timestamptz NOT NULL,

    CONSTRAINT verification_contract_pkey PRIMARY KEY (work_claim_id),

    CONSTRAINT verification_contract_claim_fkey
        FOREIGN KEY (org_id, work_claim_id)
        REFERENCES cell.work_claim (org_id, work_claim_id),

    CONSTRAINT verification_contract_task_fkey
        FOREIGN KEY (org_id, task_id) REFERENCES cell.task (org_id, task_id),

    CONSTRAINT verification_contract_hash_is_addressable
        CHECK (length(btrim(contract_hash)) > 0),

    CONSTRAINT verification_contract_snapshot_is_an_object
        CHECK (jsonb_typeof(plan_snapshot) = 'object')
);

COMMENT ON TABLE cell.verification_contract IS
    'The verification contract bound to a work_claim at claim time. A binding '
    'the parity check reads, never a settlement authority — completion is still '
    'derived from the live plan by v_task_completion.';

-- ------------------------------------------------ the freeze, at claim time
--
-- Fires in the SAME transaction as the claim (cell.claim_work INSERTs the claim
-- row; this AFTER INSERT trigger runs before that transaction commits), so a
-- claim and its bound contract appear together or not at all — the split-brain of
-- a claim with no bound bar is impossible by construction. Only an ACTIVE claim
-- binds a contract: a terminal claim row (a takeover record, an expiry) is not a
-- live interval of responsibility and has no bar to answer to.
CREATE OR REPLACE FUNCTION cell.freeze_verification_contract()
RETURNS trigger
LANGUAGE plpgsql
AS $freeze$
DECLARE
    v_plan jsonb;
BEGIN
    SELECT verification_plan INTO v_plan
      FROM cell.task
     WHERE org_id = NEW.org_id AND task_id = NEW.task_id;

    -- The claim's own FK to cell.task guarantees the task exists; if it somehow
    -- does not, the claim insert itself fails on that FK and this trigger never
    -- reached a commit anyway.
    INSERT INTO cell.verification_contract (
        work_claim_id, org_id, task_id, contract_hash, plan_snapshot, frozen_at
    ) VALUES (
        NEW.work_claim_id, NEW.org_id, NEW.task_id,
        cell.hash_verification_contract(v_plan), v_plan, NEW.claimed_at
    );

    RETURN NEW;
END;
$freeze$;

CREATE OR REPLACE TRIGGER work_claim_freezes_its_contract
    AFTER INSERT ON cell.work_claim
    FOR EACH ROW WHEN (NEW.state = 'active')
    EXECUTE FUNCTION cell.freeze_verification_contract();

-- ------------------------------------------------ the freeze, enforced
--
-- A direct UPDATE of the plan under an active claim is refused for EVERY writer
-- but the one typed amend verb — the same call-stack writer signal the claim and
-- evaluator lanes already use (002_claim.sql cell.written_by), so a service that
-- learned the table name cannot lower the bar by typing an UPDATE, and cannot
-- forge the amend frame without CREATE on schema cell (owner authority).
--
-- Scoped to a plan CHANGE: objective, origin, assignment and every other column
-- of cell.task stay freely updatable (the evaluator-seat suite asserts exactly
-- that). A guard on the whole row would break the assignment lane for a reason
-- that has nothing to do with the contract.
CREATE OR REPLACE FUNCTION cell.enforce_verification_contract_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $frozen$
BEGIN
    -- Only a plan change is a contract change. IS NOT DISTINCT FROM handles the
    -- jsonb NULL cases the way '=' cannot.
    IF NEW.verification_plan IS NOT DISTINCT FROM OLD.verification_plan THEN
        RETURN NEW;
    END IF;

    IF EXISTS (SELECT 1 FROM cell.work_claim
                WHERE org_id = NEW.org_id
                  AND task_id = NEW.task_id
                  AND state = 'active')
       AND NOT cell.written_by('cell.amend_verification_contract') THEN
        RAISE EXCEPTION
            'CONTRACT_FROZEN_UNDER_CLAIM:%/% — the verification contract is bound '
            'to the active claim on this work, and a direct edit of the plan would '
            'settle the claim against a bar different from the one it was accepted '
            'against with nothing recorded (the AC-01 / bar-lowering class). Lower '
            'or change the bar through cell.amend_verification_contract, which '
            're-binds the contract and emits CONTRACT_CHANGED so the change is '
            'visible, never silent.',
            NEW.org_id, NEW.task_id
            USING ERRCODE = 'FC160';
    END IF;

    RETURN NEW;
END;
$frozen$;

CREATE OR REPLACE TRIGGER task_verification_contract_is_frozen
    BEFORE UPDATE ON cell.task
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_verification_contract_frozen();

-- ------------------------------------------------ the ONE amendment verb
--
-- The only lawful way to change the bar under an active claim. It re-binds the
-- contract (so the live plan and the bound hash stay equal by construction) and
-- emits a typed CONTRACT_CHANGED event with a named reader, so bar-lowering is a
-- fact on a lane a monitor reads rather than an invisible UPDATE.
CREATE OR REPLACE FUNCTION cell.amend_verification_contract(
    p_org_id      text,
    p_task_id     text,
    p_new_plan    jsonb,
    p_amended_at  timestamptz,
    p_event_id    uuid,
    p_reason      text
)
RETURNS text
LANGUAGE plpgsql
AS $amend$
DECLARE
    v_claim    uuid;
    v_old_plan jsonb;
    v_old_hash text;
    v_new_hash text;
BEGIN
    -- Lock the task row: an amend and a competing claim terminal serialize here,
    -- the same discipline cell.claim_work uses.
    SELECT verification_plan INTO v_old_plan
      FROM cell.task
     WHERE org_id = p_org_id AND task_id = p_task_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'CONTRACT_AMEND_NO_ACTIVE_CLAIM:%/% — no task by that identity exists.',
            p_org_id, p_task_id
            USING ERRCODE = 'FC161';
    END IF;

    SELECT work_claim_id INTO v_claim
      FROM cell.work_claim
     WHERE org_id = p_org_id AND task_id = p_task_id AND state = 'active';

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'CONTRACT_AMEND_NO_ACTIVE_CLAIM:%/% — no principal holds an active '
            'claim on this work, so there is no bound contract to amend and the '
            'plan is freely mutable. This verb exists only for the frozen window; '
            'edit the plan directly when nobody is responsible for the work.',
            p_org_id, p_task_id
            USING ERRCODE = 'FC161';
    END IF;

    v_old_hash := cell.hash_verification_contract(v_old_plan);
    v_new_hash := cell.hash_verification_contract(p_new_plan);

    -- The plan edit. This frame is on the call stack, so the freeze guard admits
    -- it and refuses everyone else.
    UPDATE cell.task
       SET verification_plan = p_new_plan
     WHERE org_id = p_org_id AND task_id = p_task_id;

    -- Re-bind: the live plan and the bound hash are equal again by construction.
    UPDATE cell.verification_contract
       SET contract_hash = v_new_hash,
           plan_snapshot = p_new_plan,
           frozen_at     = p_amended_at
     WHERE work_claim_id = v_claim;

    -- The change, on a lane a named reader consumes (L9).
    INSERT INTO cell.typed_event (event_id, org_id, event_type, dep_key, detail, ts)
    VALUES (p_event_id, p_org_id, 'contract_changed', p_task_id,
            jsonb_build_object('work_claim_id', v_claim,
                               'old_hash', v_old_hash,
                               'new_hash', v_new_hash,
                               'reason', p_reason),
            p_amended_at);

    RETURN v_new_hash;
END;
$amend$;

COMMENT ON FUNCTION cell.amend_verification_contract IS
    'The one verb that changes the verification bar under an active claim: '
    're-binds the frozen contract and emits CONTRACT_CHANGED. Bar-lowering is '
    'visible on a monitored lane, never a silent UPDATE (the AC-01 class).';

-- The CONTRACT_CHANGED lane, declared into the §4.6 typed-event vocabulary with
-- a NAMED reader — the H28 assertion (cell.assert_every_typed_event_has_a_reader)
-- refuses a declared type nothing reads.
INSERT INTO cell.typed_event_type (event_type, description) VALUES
    ('contract_changed',
     'the verification contract was amended under an active claim via cell.amend_verification_contract; bar-lowering is a visible fact on this lane, never a silent plan UPDATE (the AC-01 / bar-lowering class)')
ON CONFLICT (event_type) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO cell.typed_event_reader (event_type, reader, reader_kind) VALUES
    ('contract_changed', 'monitor.contract_change_audit', 'monitor')
ON CONFLICT (event_type) DO UPDATE
    SET reader = EXCLUDED.reader, reader_kind = EXCLUDED.reader_kind;

-- ------------------------------------------------ the standing parity check
--
-- The live plan equals the bound contract for every active claim — the invariant
-- ACC-CONTRACT-FROZEN asserts holds BY CONSTRUCTION. Every row this returns is a
-- red: either an active claim whose frozen contract hash no longer matches its
-- task's live plan (a plan changed out from under the bar), or an active claim
-- with no bound contract at all (a claim that never froze). Both are impossible
-- while the trigger and verb above are installed and enabled; the check exists to
-- MEASURE that, exactly as cell.unverified_past_verify_by measures the R2 clock.
CREATE OR REPLACE VIEW cell.v_contract_parity AS
SELECT
    c.org_id,
    c.task_id,
    c.work_claim_id,
    f.contract_hash                                  AS bound_hash,
    cell.hash_verification_contract(t.verification_plan) AS live_hash,
    CASE
        WHEN f.work_claim_id IS NULL THEN 'unbound'
        WHEN f.contract_hash IS DISTINCT FROM
             cell.hash_verification_contract(t.verification_plan) THEN 'drifted'
        ELSE 'bound'
    END AS parity
FROM cell.work_claim c
JOIN cell.task t
  ON t.org_id = c.org_id AND t.task_id = c.task_id
LEFT JOIN cell.verification_contract f
  ON f.work_claim_id = c.work_claim_id
WHERE c.state = 'active';

CREATE OR REPLACE FUNCTION cell.contract_drift()
RETURNS TABLE (
    org_id        text,
    task_id       text,
    work_claim_id uuid,
    parity        text
)
LANGUAGE sql
STABLE
AS $drift$
    SELECT p.org_id, p.task_id, p.work_claim_id, p.parity
      FROM cell.v_contract_parity p
     WHERE p.parity <> 'bound'
     ORDER BY p.task_id, p.work_claim_id;
$drift$;

COMMENT ON FUNCTION cell.contract_drift IS
    'ACC-CONTRACT-FROZEN: every row is RED — an active claim whose bound contract '
    'no longer equals its live plan, or one with no bound contract at all. Empty '
    'by construction while the freeze trigger and amend verb are installed.';
