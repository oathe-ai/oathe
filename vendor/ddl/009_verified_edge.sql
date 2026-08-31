-- 009_verified_edge.sql — evaluability declared, settlement signed, failure typed.
--
-- Contract: docs/a1-cell-work-spine-contract.md §4 in full — §4.1 (evaluability
-- is a declared, substrate-visible property), §4.2 (the declare-time guard,
-- founder ruling R8), §4.3 (signer-based settlement), §4.4 (evidence-required
-- retraction, which mints no verification record), §4.5 (the registry as single
-- source of truth, written only by a governed verb), §4.6 (typed failure events,
-- each with a NAMED reader), §4.7 (dep_key validity rules).
-- Requires 001_core.sql, 003_verification.sql and 006_dependency.sql.
--
-- Re-apply: idempotent (CREATE ... IF NOT EXISTS / OR REPLACE, ON CONFLICT seeds).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- FOUR MEASURED FACTS THIS FILE IS SHAPED BY
--
-- 1. **0 of the 41 `verified` edges ever declared had a pre-registered key.** So
--    on the Mac an unevaluable edge looked exactly like an evaluable one until
--    somebody went hunting for the checker that was never written. The guard
--    below therefore refuses nearly every declare at first — an honest cost the
--    ruling accepts — with one escape: an explicit acknowledgment that MINTS a
--    typed `dep_registration_debt` event naming an owner and a due date (L8).
--
-- 2. **23 historical `verified` settles bypassed the CLI by direct bus publish**
--    (12 by one principal, 11 by another), because `verified` was the only dep
--    type with a CLI gate and no substrate trigger. The signer clause here
--    checks the WRITER — a transaction-local setting only the governed verb sets
--    — and not merely the string in the settled_by column, because writing the
--    correct evaluator's name is precisely what such a publish does.
--
-- 3. **"What counts as a valid verified release" was encoded in SEVEN places**
--    plus one stale copy, and every encoding drifted. One registry, one verb.
--
-- 4. **Four silent-failure sites**: checker crash (no record at all), registry
--    unreadable (silently switched evaluation lanes), probe error (15 sites,
--    reduced to a count, then discarded entirely in continuous mode — zero log
--    lines, measured), evaluator refusal (35 events, ZERO readers). Each is a
--    typed event here, and each type must name a reader: a failure lane without
--    a reader is a contract violation (L9), so the check RAISES rather than
--    warning — nothing anywhere reported those 35 unread events as a problem.
--
-- Declared failure vocabulary added by this file (SQLSTATE class FC):
--   FC040 DEP_KEY_UNREGISTERED           declared (or settled) against no checker
--   FC041 DEP_SETTLE_UNSIGNED            settled by other than the registered
--                                        evaluator, or by a writer that is not
--                                        the governed verb
--   FC042 CHECKER_REGISTRY_FOREIGN_WRITER a registry edit outside the verb
--   FC043 TYPED_EVENT_WITHOUT_READER     a declared failure type nothing reads
--   FC044 DEP_DECLARED_NOT_EVALUABLE     a registered key left merely `declared`
--   FC045 EDGE_NOT_SETTLED              a settle that matched no edge and
--                                       would otherwise report success

-- ---------------------------------------------------------------------------
-- checker_registry — §4.5, the single source of truth
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.checker_registry (
    org_id              text        NOT NULL,
    dep_key             text        NOT NULL,

    -- The evaluator key is thereby EXPLICIT SETTLEMENT AUTHORITY — an accepted
    -- cost of the ruling, and what makes "who released this" answerable.
    evaluator_principal text        NOT NULL,

    checker_ref         text        NOT NULL,
    registered_by       text        NOT NULL,
    registered_at       timestamptz NOT NULL,

    CONSTRAINT checker_registry_pkey PRIMARY KEY (org_id, dep_key),

    CONSTRAINT checker_registry_evaluator_is_named
        CHECK (length(btrim(evaluator_principal)) > 0),
    CONSTRAINT checker_registry_checker_ref_is_addressable
        CHECK (length(btrim(checker_ref)) > 0)
);

COMMENT ON TABLE cell.checker_registry IS
    'Contract §4.5. One registry, one governed verb. "What counts as a valid '
    'verified release" was encoded in seven places on the Mac and every '
    'encoding drifted.';

-- Registry edits are GOVERNED operations (§4.5). Matching a `registered_by`
-- column alone would be forgeable by typing the right string, and so — MEASURED
-- in review — was the transaction-local setting this guard used to read: any
-- session could `set_config('cell.registrar', 'cell.register_checker', true)` and
-- write the registry directly. The signal is cell.written_by (002_claim.sql): the
-- verb's frame is on this trigger's call stack or it is not.
CREATE OR REPLACE FUNCTION cell.enforce_governed_registry_edit()
RETURNS trigger
LANGUAGE plpgsql
AS $governed$
BEGIN
    IF NOT cell.written_by('cell.register_checker') THEN
        RAISE EXCEPTION
            'CHECKER_REGISTRY_FOREIGN_WRITER:% — the checker registry is written '
            'only by cell.register_checker. A registry a service can edit directly '
            'is the eighth encoding of "what counts as a valid verified release", '
            'and the previous seven all drifted.',
            NEW.dep_key
            USING ERRCODE = 'FC042';
    END IF;
    RETURN NEW;
END;
$governed$;

CREATE OR REPLACE TRIGGER checker_registry_is_written_by_the_governed_verb
    BEFORE INSERT OR UPDATE ON cell.checker_registry
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_governed_registry_edit();

-- ---------------------------------------------------------------------------
-- typed_event — §4.6, the four silent-failure sites made legible
--
-- Three tables, because the contract asks three separate questions: what failure
-- kinds EXIST (the vocabulary), who READS each kind (the registry L9 requires),
-- and what actually HAPPENED (the instances).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.typed_event_type (
    event_type  text NOT NULL,
    description text NOT NULL,

    CONSTRAINT typed_event_type_pkey PRIMARY KEY (event_type)
);

CREATE TABLE IF NOT EXISTS cell.typed_event_reader (
    event_type  text NOT NULL,
    reader      text NOT NULL,
    reader_kind text NOT NULL,

    CONSTRAINT typed_event_reader_pkey PRIMARY KEY (event_type),

    CONSTRAINT typed_event_reader_type_fkey
        FOREIGN KEY (event_type) REFERENCES cell.typed_event_type (event_type),

    CONSTRAINT typed_event_reader_is_named
        CHECK (length(btrim(reader)) > 0),

    CONSTRAINT typed_event_reader_kind_is_declared
        CHECK (reader_kind IN ('operator_surface', 'monitor'))
);

CREATE TABLE IF NOT EXISTS cell.typed_event (
    event_id   uuid        NOT NULL,
    org_id     text        NOT NULL,
    event_type text        NOT NULL,
    dep_key    text        NOT NULL,
    detail     jsonb       NOT NULL,
    ts         timestamptz NOT NULL,

    CONSTRAINT typed_event_pkey PRIMARY KEY (event_id),

    CONSTRAINT typed_event_type_fkey
        FOREIGN KEY (event_type) REFERENCES cell.typed_event_type (event_type),

    CONSTRAINT typed_event_detail_is_an_object
        CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX IF NOT EXISTS typed_event_by_type
    ON cell.typed_event (org_id, event_type, ts);

-- The vocabulary: the four measured silent-failure sites, plus the debt event
-- the acknowledgment path mints.
INSERT INTO cell.typed_event_type (event_type, description) VALUES
    ('checker_crash',
     'a registered checker exited non-zero; on the Mac this left NO record at all'),
    ('registry_unreadable',
     'the registry could not be read; on the Mac this silently switched evaluation lanes'),
    ('probe_error',
     'an evaluation probe failed; on the Mac 15 accumulation sites reduced these to a count, then discarded it entirely in continuous mode'),
    ('evaluator_refusal',
     'the evaluator declined to sign; on the Mac 35 such events were written and ZERO were ever read'),
    ('dep_registration_debt',
     'a verified edge was declared against an unregistered key with an explicit acknowledgment naming an owner and a due date (L8)')
ON CONFLICT (event_type) DO UPDATE SET description = EXCLUDED.description;

-- The readers §4.6 names: the operator surface routed in §3.4(4), and the
-- completed-but-unsettled age monitor — plus a due-date monitor for the debt,
-- because a dated bridge with no reader of its due date has no dated end at all.
INSERT INTO cell.typed_event_reader (event_type, reader, reader_kind) VALUES
    ('checker_crash',         'operator_surface.bus_to_messaging',      'operator_surface'),
    ('registry_unreadable',   'operator_surface.bus_to_messaging',      'operator_surface'),
    ('probe_error',           'operator_surface.bus_to_messaging',      'operator_surface'),
    ('evaluator_refusal',     'monitor.completed_but_unsettled_age',    'monitor'),
    ('dep_registration_debt', 'monitor.registration_debt_due',          'monitor')
ON CONFLICT (event_type) DO UPDATE
    SET reader = EXCLUDED.reader, reader_kind = EXCLUDED.reader_kind;

-- The H28 check: every detection path pairs a NAMED reader. It RAISES rather
-- than returning a verdict, because a warning is what the Mac's 35 unread
-- evaluator-refusal events effectively got.
CREATE OR REPLACE FUNCTION cell.assert_every_typed_event_has_a_reader()
RETURNS integer
LANGUAGE plpgsql
STABLE
AS $reader_check$
DECLARE
    v_unpaired text;
    v_total    integer;
BEGIN
    SELECT string_agg(t.event_type, ', ' ORDER BY t.event_type) INTO v_unpaired
      FROM cell.typed_event_type t
     WHERE NOT EXISTS (SELECT 1 FROM cell.typed_event_reader r
                        WHERE r.event_type = t.event_type);

    IF v_unpaired IS NOT NULL THEN
        RAISE EXCEPTION
            'TYPED_EVENT_WITHOUT_READER:% — these failure types are declared and '
            'nothing reads them. A failure lane without a reader is a contract '
            'violation (L9): the Mac wrote 35 evaluator-refusal events that no '
            'consumer ever read, and nothing anywhere reported that as a problem.',
            v_unpaired
            USING ERRCODE = 'FC043';
    END IF;

    SELECT count(*)::integer INTO v_total FROM cell.typed_event_type;
    RETURN v_total;
END;
$reader_check$;

-- ------------------------------------- §4.2 the declare-time evaluability guard
--
-- Fail-closed, per the source system's own guard doctrine (migrations 0073/0081).
-- Declaring a `verified` edge whose dep_key matches no registered checker FAILS
-- loudly, unless the declarer acknowledges the debt — which mints the typed
-- event naming its owner and due date, rather than passing silently.
--
-- The same guard runs on the transition INTO `evaluable`, so a debt cannot be
-- discharged by editing a column: evaluability is a declared, substrate-visible
-- property (§4.1) and the registry is what confers it.
CREATE OR REPLACE FUNCTION cell.enforce_declare_time_evaluability()
RETURNS trigger
LANGUAGE plpgsql
AS $evaluability$
DECLARE
    v_evaluator text;
BEGIN
    IF NEW.dep_type <> 'verified' THEN
        RETURN NEW;
    END IF;
    -- Only a DECLARE, or a transition into evaluable, is guarded. Re-stating an
    -- unchanged state must not fail for a reason unrelated to what changed.
    IF TG_OP = 'UPDATE' AND NOT (NEW.state = 'evaluable' AND OLD.state <> 'evaluable') THEN
        RETURN NEW;
    END IF;

    SELECT evaluator_principal INTO v_evaluator
      FROM cell.checker_registry
     WHERE org_id = NEW.org_id AND dep_key = NEW.dep_key;

    IF FOUND THEN
        IF NEW.state NOT IN ('evaluable', 'satisfied', 'retracted',
                             'evaluation_blocked') THEN
            RAISE EXCEPTION
                'DEP_DECLARED_NOT_EVALUABLE:% — a checker IS registered for this '
                'key (evaluator %), so the edge is EVALUABLE and must say so. '
                'Leaving it in ''%'' hides an evaluable edge among the unevaluable '
                'ones, and §4.1''s alerting keys on the state.',
                NEW.dep_key, v_evaluator, NEW.state
                USING ERRCODE = 'FC044';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.state <> 'debt_acked' THEN
        RAISE EXCEPTION
            'DEP_KEY_UNREGISTERED:% — no checker is registered for this dep_key, so '
            'this edge is not evaluable and declaring it as though it were mints a '
            'wait nothing can ever release. MEASURED: 0 of the 41 `verified` edges '
            'ever declared had a pre-registered key. Acknowledge the registration '
            'debt explicitly (state ''debt_acked'' with an owner and a due date) or '
            'register a checker first.',
            NEW.dep_key
            USING ERRCODE = 'FC040';
    END IF;

    -- The acknowledgment is not a shrug: it MINTS the typed debt event, naming
    -- the owner and the due date, so L8's "every bridge has a dated end" is a row
    -- a monitor reads rather than a sentence in a commit message.
    INSERT INTO cell.typed_event (event_id, org_id, event_type, dep_key, detail, ts)
    VALUES (gen_random_uuid(), NEW.org_id, 'dep_registration_debt', NEW.dep_key,
            jsonb_build_object(
                'owner', NEW.debt_owner,
                -- Rendered explicitly in UTC rather than let jsonb_build_object
                -- take the writer's session TimeZone: a due date whose text
                -- depends on who reads it is a due date two readers disagree
                -- about, and L8's dated end has to be one date.
                'due', to_char(NEW.debt_due AT TIME ZONE 'UTC',
                               'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'edge_id', NEW.edge_id,
                'declared_by', NEW.declared_by),
            NEW.declared_at);

    RETURN NEW;
END;
$evaluability$;

CREATE OR REPLACE TRIGGER dep_edge_declare_time_evaluability_guard
    BEFORE INSERT OR UPDATE ON cell.dep_edge
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_declare_time_evaluability();

-- --------------------------------------------- §4.3 the signer clause
--
-- This is the one filesystem-free substrate clause that closes every
-- direct-publish bypass. Two things must hold, and the second is the one the
-- Mac lacked: the settled_by column names the registered evaluator, AND the
-- writer is the governed verb. Checking only the column would leave the rule
-- satisfiable by typing the right name, which is exactly what a direct bus
-- publish does.
CREATE OR REPLACE FUNCTION cell.enforce_verified_edge_signer()
RETURNS trigger
LANGUAGE plpgsql
AS $signer$
DECLARE
    v_evaluator text;
    v_writer    text;
BEGIN
    IF NEW.dep_type <> 'verified' OR NEW.state IS DISTINCT FROM 'satisfied' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.state = 'satisfied' THEN
        RETURN NEW;
    END IF;

    SELECT evaluator_principal INTO v_evaluator
      FROM cell.checker_registry
     WHERE org_id = NEW.org_id AND dep_key = NEW.dep_key;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'DEP_KEY_UNREGISTERED:% — no checker is registered for this dep_key, so '
            'there is no evaluator whose signature could release it. An '
            'acknowledged registration debt buys time to write a checker; it does '
            'not buy the ability to release without one.',
            NEW.dep_key
            USING ERRCODE = 'FC040';
    END IF;

    -- The WRITER, read off the call stack rather than off a setting the writer
    -- could have set for itself. `v_writer` carries the evaluator's name only
    -- when the governed verb is genuinely on the stack, so the refusal below
    -- still prints what it found.
    IF cell.written_by('cell.settle_verified_edge') THEN
        v_writer := v_evaluator;
    ELSE
        v_writer := NULL;
    END IF;

    IF NEW.settled_by IS DISTINCT FROM v_evaluator OR v_writer IS DISTINCT FROM v_evaluator THEN
        RAISE EXCEPTION
            'DEP_SETTLE_UNSIGNED:% — a `verified` dep_satisfied is valid only when '
            'signed by the REGISTERED evaluator (%) through cell.settle_verified_edge. '
            'This row names % and was written by %. MEASURED: 23 historical '
            '`verified` settles reached the bus by direct publish past a CLI-only '
            'gate, which is why the writer is checked and not only the column — and '
            'the writer signal is the PL/pgSQL call stack, which a direct writer '
            'cannot fabricate, rather than a setting it could set for itself.',
            NEW.dep_key, v_evaluator, coalesce(NEW.settled_by, '<null>'),
            coalesce(v_writer, '<a writer that is not the governed verb>')
            USING ERRCODE = 'FC041';
    END IF;

    RETURN NEW;
END;
$signer$;

CREATE OR REPLACE TRIGGER dep_edge_verified_settlement_is_signed
    BEFORE INSERT OR UPDATE ON cell.dep_edge
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_verified_edge_signer();

-- ------------------------------------------------------------- the two verbs
--
-- Every argument is required; there is no default in either signature and there
-- will not be one. A default registrar, a default evaluator or a server-chosen
-- timestamp would each be a governance decision made in the substrate, invisible
-- at the call site.
CREATE OR REPLACE FUNCTION cell.register_checker(
    p_org_id              text,
    p_dep_key             text,
    p_evaluator_principal text,
    p_checker_ref         text,
    p_registered_by       text,
    p_registered_at       timestamptz
)
RETURNS text
LANGUAGE plpgsql
AS $register$
BEGIN
    -- Nothing is set to authorize this write: THIS frame, on the call stack, is
    -- the authorization, and it stops existing when the function returns.
    INSERT INTO cell.checker_registry (
        org_id, dep_key, evaluator_principal, checker_ref, registered_by,
        registered_at
    ) VALUES (
        p_org_id, p_dep_key, p_evaluator_principal, p_checker_ref, p_registered_by,
        p_registered_at
    )
    ON CONFLICT (org_id, dep_key) DO UPDATE
        SET evaluator_principal = EXCLUDED.evaluator_principal,
            checker_ref         = EXCLUDED.checker_ref,
            registered_by       = EXCLUDED.registered_by,
            registered_at       = EXCLUDED.registered_at;

    RETURN p_dep_key;
END;
$register$;

COMMENT ON FUNCTION cell.register_checker IS
    'Contract §4.5''s governed register verb — the only writer of the checker '
    'registry, and therefore the only way a dep_key becomes evaluable.';

CREATE OR REPLACE FUNCTION cell.settle_verified_edge(
    p_edge_id             uuid,
    p_evaluator_principal text,
    p_settled_at          timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
AS $settle$
DECLARE
    v_settled integer;
BEGIN
    -- Nothing is set to authorize this write: THIS frame, on the call stack, is
    -- what cell.enforce_verified_edge_signer reads, and it stops existing when
    -- the function returns.
    UPDATE cell.dep_edge
       SET state       = 'satisfied',
           settled_by  = p_evaluator_principal,
           settle_kind = 'evaluator_verdict',
           settled_at  = p_settled_at
     WHERE edge_id = p_edge_id;

    GET DIAGNOSTICS v_settled = ROW_COUNT;

    -- An UPDATE that matched nothing runs the trigger not at all, so without this
    -- the verb returned p_edge_id — the identifier of an edge it did not settle —
    -- and a caller checking the returned id against the one it asked for would
    -- read success. An error that looks like success is the one answer a
    -- release-path verb may never give.
    IF v_settled <> 1 THEN
        RAISE EXCEPTION
            'EDGE_NOT_SETTLED:%:% — this settle matched % edges, not exactly one, '
            'so nothing was released and there is no edge whose release this call '
            'could be evidence of.',
            p_edge_id, p_evaluator_principal, v_settled
            USING ERRCODE = 'FC045';
    END IF;

    RETURN p_edge_id;
END;
$settle$;

COMMENT ON FUNCTION cell.settle_verified_edge IS
    'Contract §4.3. The signer clause is enforced by the trigger, not here: a '
    'check that lives only in this function is a check a direct UPDATE skips.';
