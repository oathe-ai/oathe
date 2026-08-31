-- 008_effect_receipt.sql — claim the receipt BEFORE the effect fires.
--
-- Contract: docs/a1-cell-work-spine-contract.md §1.2 (R3's interrupted attempts
-- and their reconciliation), §5 case 3 (kill after external effect, before
-- completion bookkeeping) and case 6's MID-EFFECT-HOLD; FOUNDER RULING R3
-- ("bundled inseparably: effect receipts — an irreversible external effect
-- claims a durable receipt in-substrate before firing; WITHOUT RECEIPTS,
-- UNKNOWN IS PERMANENT BY CONSTRUCTION"). Field shape per the A2 verification
-- strategy §2 (the measured Slack gateway sequence).
-- Requires 001_core.sql.
--
-- Re-apply: idempotent (CREATE ... IF NOT EXISTS / OR REPLACE).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- WHY THE RECEIPT IS CLAIMED FIRST, AND WHY THAT IS THE WHOLE POINT
--
-- R3 makes `execution_attempt.outcome_status='unknown'` a state with a deadline
-- and a named resolver rather than a permanent shrug. That only works if there
-- is something to reconcile AGAINST. If the sole record that an effect was about
-- to fire lives in the process that fires it, then killing that process between
-- the remote commit and the local checkpoint destroys the only evidence, and
-- `unknown` becomes permanent by construction — which is why `evidence_lost` was
-- REJECTED as a terminal: it mints an unobserved fact. The receipt row is the
-- durable pre-image, written before the effect, surviving the process that wrote
-- it. The source system's own `slack_post_marker` is the measured precedent: built,
-- tested, and zero rows, because nothing made it mandatory.
--
-- The sequence this table stands under (strategy §2):
--   receipt-claim → POST → remote apply → response → receipt-confirm → statement
-- Killing at any of those points leaves a row that says exactly how far it got.
--
-- Declared failure vocabulary added by this file (SQLSTATE class FC; this lane
-- reserves FC080-FC089 — it previously trespassed on the assignment lane's half
-- of the FC020-FC039 block, which made FC030/FC031 mean two things each):
--   FC080 RECEIPT_KEY_PAYLOAD_CONFLICT     a reused key with a different payload
--   FC081 RECEIPT_KEY_ADDRESS_CONFLICT     a reused key aimed somewhere else
--   FC082 RECEIPT_CONFIRMED_WITHOUT_CLAIM  a confirmation with no claim behind it
--   FC083 RECEIPT_OUTCOME_CONTRADICTED     two different answers about one effect

CREATE TABLE IF NOT EXISTS cell.effect_receipt (
    org_id          text        NOT NULL,

    -- The idempotency key, chosen by the caller and meaningful to it. This is
    -- the primary key with org_id and nothing else: exactly-once is a property
    -- of the KEY, so a second row under the same key must be impossible for
    -- every writer, not only for callers that remembered to check first.
    receipt_key     text        NOT NULL,

    -- Whose responsibility, and which runtime binding, was mid-effect. R6's
    -- kill exclusion reads this: an attempt holding a claimed-unresolved receipt
    -- is not terminated until the receipt resolves via ledger reconciliation.
    work_claim_id   uuid        NOT NULL,
    attempt_id      uuid        NOT NULL,

    bus_event_ref   text        NOT NULL,

    -- strategy §2: WHICH connector, at WHAT address. "What have we already done
    -- to this destination" is answerable from the substrate alone, without
    -- asking the remote service — which matters most precisely when the remote
    -- service is the thing that is unreachable.
    connector       text        NOT NULL,
    address         text        NOT NULL,

    payload_hash    text        NOT NULL,
    claimed_at      timestamptz NOT NULL,

    -- NULL exactly while the outcome is still `claimed`.
    confirmed_at    timestamptz,

    outcome         text        NOT NULL,

    -- The pointer into the remote's own append-only ledger — the "remote truth"
    -- the reconciler reads to settle an `unknown` (R3). A resolved receipt with
    -- no pointer is a resolution nobody can check.
    remote_ref      text,

    CONSTRAINT effect_receipt_pkey PRIMARY KEY (org_id, receipt_key),

    CONSTRAINT effect_receipt_claim_fkey
        FOREIGN KEY (org_id, work_claim_id)
        REFERENCES cell.work_claim (org_id, work_claim_id),

    CONSTRAINT effect_receipt_attempt_fkey
        FOREIGN KEY (attempt_id) REFERENCES cell.execution_attempt (attempt_id),

    CONSTRAINT effect_receipt_outcome_is_a_declared_outcome
        CHECK (outcome IN ('claimed', 'applied', 'deduped', 'conflict', 'refused')),

    CONSTRAINT effect_receipt_claimed_receipt_is_the_unconfirmed_one
        CHECK ((outcome = 'claimed') = (confirmed_at IS NULL)),

    CONSTRAINT effect_receipt_resolved_receipt_points_at_the_remote_record
        CHECK (outcome NOT IN ('applied', 'deduped', 'conflict')
               OR remote_ref IS NOT NULL),

    CONSTRAINT effect_receipt_unconfirmed_receipt_has_no_remote_record
        CHECK (outcome <> 'claimed' OR remote_ref IS NULL),

    -- NOT NULL permits the empty string. A blank connector or address is an
    -- absent one wearing a value's clothes, and the receipt would then say an
    -- effect was claimed somewhere without saying where.
    CONSTRAINT effect_receipt_connector_is_addressable
        CHECK (length(btrim(connector)) > 0),
    CONSTRAINT effect_receipt_address_is_addressable
        CHECK (length(btrim(address)) > 0),
    CONSTRAINT effect_receipt_bus_event_ref_is_addressable
        CHECK (length(btrim(bus_event_ref)) > 0)
);

COMMENT ON TABLE cell.effect_receipt IS
    'FOUNDER RULING R3: an irreversible external effect claims a durable receipt '
    'here BEFORE firing. Without receipts, outcome_status=''unknown'' is '
    'permanent by construction.';

CREATE INDEX IF NOT EXISTS effect_receipt_unresolved_by_attempt
    ON cell.effect_receipt (org_id, attempt_id)
    WHERE outcome = 'claimed';

-- ------------------------------------------------------------- claim the receipt
--
-- Returns TRUE when this call took the key and FALSE when it found an identical
-- claim already there. The boolean is the point: a caller that cannot tell
-- "I claimed it" from "somebody already did" has no way to decide whether to
-- fire, and firing on both answers is the duplicate-effect bug.
--
-- ON CONFLICT DO NOTHING rather than DO UPDATE, deliberately: an upsert would
-- make a reused key silently overwrite the first claim's payload and address,
-- and the reconciler would then be reading a receipt for an effect that was
-- never fired with those contents. Divergence is RAISED instead.
CREATE OR REPLACE FUNCTION cell.claim_effect_receipt(
    p_org_id        text,
    p_receipt_key   text,
    p_work_claim_id uuid,
    p_attempt_id    uuid,
    p_bus_event_ref text,
    p_connector     text,
    p_address       text,
    p_payload_hash  text,
    p_claimed_at    timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
AS $claim_receipt$
DECLARE
    v_claimed       boolean := false;
    v_payload_hash  text;
    v_address       text;
    v_connector     text;
BEGIN
    INSERT INTO cell.effect_receipt (
        org_id, receipt_key, work_claim_id, attempt_id, bus_event_ref,
        connector, address, payload_hash, claimed_at, confirmed_at, outcome,
        remote_ref
    ) VALUES (
        p_org_id, p_receipt_key, p_work_claim_id, p_attempt_id, p_bus_event_ref,
        p_connector, p_address, p_payload_hash, p_claimed_at, NULL, 'claimed',
        NULL
    )
    ON CONFLICT (org_id, receipt_key) DO NOTHING;

    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    IF v_claimed THEN
        RETURN true;
    END IF;

    SELECT payload_hash, address, connector
      INTO v_payload_hash, v_address, v_connector
      FROM cell.effect_receipt
     WHERE org_id = p_org_id AND receipt_key = p_receipt_key;

    IF v_payload_hash IS DISTINCT FROM p_payload_hash THEN
        RAISE EXCEPTION
            'RECEIPT_KEY_PAYLOAD_CONFLICT:% — this key already holds a receipt for '
            'a DIFFERENT payload (recorded %, offered %). Overwriting it would '
            'leave the reconciler reading a receipt for an effect that was never '
            'fired with those contents; a key that can be re-pointed at another '
            'payload is not an idempotency key.',
            p_receipt_key, v_payload_hash, p_payload_hash
            USING ERRCODE = 'FC080';
    END IF;

    IF v_address IS DISTINCT FROM p_address OR v_connector IS DISTINCT FROM p_connector THEN
        RAISE EXCEPTION
            'RECEIPT_KEY_ADDRESS_CONFLICT:% — this key already holds a receipt '
            'aimed at %/%, and this call aims at %/%. Same reasoning as the '
            'payload clause, one field over.',
            p_receipt_key, v_connector, v_address, p_connector, p_address
            USING ERRCODE = 'FC081';
    END IF;

    -- An identical re-claim: the effect was already claimed by this or an
    -- earlier attempt, and the caller must NOT fire again.
    RETURN false;
END;
$claim_receipt$;

-- ----------------------------------------------------------- confirm the fire
--
-- Returns TRUE when this call moved the receipt and FALSE when it restated an
-- outcome already recorded — case 3's REPLAY-N, where the gateway sequence is
-- replayed and the substrate must end in the same state with no second effect
-- implied.
CREATE OR REPLACE FUNCTION cell.confirm_effect_receipt(
    p_org_id       text,
    p_receipt_key  text,
    p_outcome      text,
    p_remote_ref   text,
    p_confirmed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
AS $confirm_receipt$
DECLARE
    v_outcome    text;
    v_remote_ref text;
BEGIN
    SELECT outcome, remote_ref INTO v_outcome, v_remote_ref
      FROM cell.effect_receipt
     WHERE org_id = p_org_id AND receipt_key = p_receipt_key
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'RECEIPT_CONFIRMED_WITHOUT_CLAIM:% — no receipt was claimed under this '
            'key, so an effect fired with no durable record that it was about to. '
            'Claim-before-fire is the whole of R3: without the pre-image there is '
            'nothing for a reconciler to resolve an unknown outcome against.',
            p_receipt_key
            USING ERRCODE = 'FC082';
    END IF;

    IF v_outcome <> 'claimed' THEN
        IF v_outcome = p_outcome AND v_remote_ref IS NOT DISTINCT FROM p_remote_ref THEN
            RETURN false;   -- an identical replay
        END IF;
        RAISE EXCEPTION
            'RECEIPT_OUTCOME_CONTRADICTED:% — this receipt already records ''%'' '
            '(remote %), and this call says ''%'' (remote %). Two different answers '
            'about whether one irreversible effect happened is not a value to '
            'overwrite; it is a fact to investigate.',
            p_receipt_key, v_outcome, coalesce(v_remote_ref, '<none>'),
            p_outcome, coalesce(p_remote_ref, '<none>')
            USING ERRCODE = 'FC083';
    END IF;

    UPDATE cell.effect_receipt
       SET outcome = p_outcome,
           remote_ref = p_remote_ref,
           confirmed_at = p_confirmed_at
     WHERE org_id = p_org_id AND receipt_key = p_receipt_key;

    RETURN true;
END;
$confirm_receipt$;

-- ------------------------------------------- what the reconciler and the killer read
--
-- Two readers, one set. R3: this is what an `outcome_status='unknown'` is
-- reconciled against. R6: an attempt appearing here is one the supervisor may
-- NOT terminate until the receipt resolves (MID-EFFECT-HOLD, KILLED_MID_EFFECT).
--
-- The instant is an explicit argument, as everywhere else in this substrate: a
-- sweep reading now() cannot be asserted at a stated moment, and a leg that
-- cannot state its moment is a flake wearing a green tick. `claimed_at < p_as_of`
-- is strict, so "unresolved as of the instant it was claimed" is empty rather
-- than reporting an effect that had not yet been claimed when the caller looked.
CREATE OR REPLACE FUNCTION cell.unresolved_receipts(p_as_of timestamptz)
RETURNS TABLE (
    org_id        text,
    receipt_key   text,
    work_claim_id uuid,
    attempt_id    uuid,
    connector     text,
    address       text,
    claimed_at    timestamptz
)
LANGUAGE sql
STABLE
AS $unresolved$
    SELECT r.org_id, r.receipt_key, r.work_claim_id, r.attempt_id,
           r.connector, r.address, r.claimed_at
      FROM cell.effect_receipt r
     WHERE r.outcome = 'claimed'
       AND r.claimed_at < p_as_of
     ORDER BY r.receipt_key;
$unresolved$;

COMMENT ON FUNCTION cell.unresolved_receipts IS
    'R3 + R6: the set an unknown outcome is reconciled against, and the set whose '
    'attempts a supervisor may not terminate until they resolve.';
