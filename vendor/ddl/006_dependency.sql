-- 006_dependency.sql — dependency edges: acceptance-only release, compound AND,
-- and cross-scope resolution keyed on the GATING task's identity.
--
-- Contract: docs/a1-cell-work-spine-contract.md §3.1 (no auto-void), §3.2 (the
-- moot-wait settle and its discriminator), §3.3 (the release bar — FOUNDER
-- RULING R4, acceptance-ONLY, no selector), §3.4(1) (the widened
-- completed-but-unsettled arm), §4.1 (the edge lifecycle vocabulary), §4.4
-- (evidence-required retraction), §4.7 (dep_key validity rules).
-- Requires 001_core.sql and 003_verification.sql (the completion tri-state).
--
-- Re-apply: idempotent (CREATE ... IF NOT EXISTS / OR REPLACE).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- THE THREE MEASURED DEFECTS THIS FILE IS SHAPED BY
--
-- 1. The task-dep released on a SELF-ASSERTION. On the Mac a `task` edge
--    released on `queue_task_state.closed`, which derives from the upstream
--    author's own completion claim — "statements are not truth" living inside
--    the dependency system. R4 rules the bar to be the upstream task's recorded
--    VERIFICATION (completion tri-state `complete`), and rejects the proposed
--    per-edge opt-down selector as unnecessary flexibility: low-stakes hand-offs
--    use A2A messaging, and §1.4's mandatory verify_by bounds verification
--    latency. There is therefore NO selector column below, and none may be
--    added without a ruling — a column nobody may set is a column that gets set.
--
-- 2. The DEPARTMENT-SCOPED resolver: a cross-department gate could never
--    resolve. Every join below is keyed on (org_id, gating_task_id) and on
--    nothing else. Department is not an isolation boundary in the cell; ORG is
--    (PRD:1626, L17), and that difference is expressed as a composite foreign
--    key rather than as a convention.
--
-- 3. Completion AUTO-VOID (`realCompleteTask`, lifecycle.ts:1037-1091). It is
--    not ported — not with an allowlist, not with a carve-out. There is no
--    `voided` state for it to leave behind, an edge cannot be DELETEd, and the
--    only mootness settle is the tautologically-moot pair carrying an explicit
--    `moot_completion` discriminator (§3.2, §3.4(5)).
--
-- Declared failure vocabulary added by this file (SQLSTATE class FC; this lane
-- reserves FC070-FC079 — it previously trespassed on the delegation lane's
-- FC020-FC039 block, which made three codes mean two things each):
--   FC070 DEP_RELEASED_WITHOUT_ACCEPTANCE  a task-lane edge released while the
--                                          gating task is not `complete`
--   FC071 ACCEPTANCE_PACKAGE_NOT_VERIFIED  an acceptance edge released with no
--                                          verified acceptance-package verdict
--   FC072 DEP_EDGE_DELETED                 an edge removed rather than settled
--                                          or retracted with evidence

-- ---------------------------------------------------------------------------
-- dep_edge — one wait, of one typed family, held by one waiting task
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.dep_edge (
    edge_id                   uuid        NOT NULL,
    org_id                    text        NOT NULL,

    -- the WAITING task: the one that does not proceed until this edge settles
    task_id                   text        NOT NULL,

    dep_type                  text        NOT NULL,
    dep_key                   text        NOT NULL,

    -- The gating task's IDENTITY — the whole of the cross-scope resolution key.
    -- NOT NULL exactly for the two task-lane families, where §4.7 says the
    -- dep_key IS a task id; NULL for the five families that resolve against
    -- something outside the task table.
    gating_task_id            text,

    -- contract §4.1's state machine, shared by every family:
    --   declared ──(registered key)──→ evaluable ──(signed pass)──→ satisfied
    --      └──(acknowledgment)──→ debt_acked        └──→ evaluation_blocked
    --                                               └──(evidence)──→ retracted
    -- `voided` is DELIBERATELY absent (§3.1).
    state                     text        NOT NULL,

    declared_by               text        NOT NULL,
    declared_at               timestamptz NOT NULL,

    -- The signer, the kind, and the stamp — all three NOT NULL exactly when the
    -- edge is satisfied. "Who released this, on what basis, when" is the
    -- question the Mac's void events could not answer, which is why they had
    -- zero readers estate-wide.
    settled_by                text,
    settle_kind               text,
    settled_at                timestamptz,

    -- §4.4: retracting requires evidence_refs and mints NO verification record.
    -- Retraction is not release.
    retraction_evidence_refs  jsonb,
    retracted_at              timestamptz,

    -- L8: an acknowledged registration debt names its OWNER and its DUE date, or
    -- it is not an acknowledgment, it is a shrug. NOT NULL exactly while the edge
    -- sits in debt_acked; the durable record of the debt is the typed event, so
    -- discharging the debt clears these columns without erasing the history.
    debt_owner                text,
    debt_due                  timestamptz,

    CONSTRAINT dep_edge_pkey PRIMARY KEY (edge_id),

    CONSTRAINT dep_edge_waiting_task_fkey
        FOREIGN KEY (org_id, task_id) REFERENCES cell.task (org_id, task_id),

    -- Cross-scope, not cross-org: the gating task may live in any department and
    -- must live in this org.
    CONSTRAINT dep_edge_gating_task_fkey
        FOREIGN KEY (org_id, gating_task_id) REFERENCES cell.task (org_id, task_id),

    CONSTRAINT dep_edge_dep_type_is_a_declared_family
        CHECK (dep_type IN ('task', 'verified', 'acceptance_package',
                            'operator_approval', 'capacity_free', 'time_elapse',
                            'external_event')),

    CONSTRAINT dep_edge_dep_state_is_a_declared_lifecycle_state
        CHECK (state IN ('declared', 'debt_acked', 'evaluable', 'satisfied',
                         'evaluation_blocked', 'retracted')),

    -- §4.7: the task lane's dep_key IS the gating task_id, validated at declare
    -- time. The measured instrument bug — the reconciler resolving acceptance
    -- packages by dep_key while the operator report told humans to file them by
    -- task_id — has no shape it can take here.
    CONSTRAINT dep_edge_task_lane_dep_key_is_the_gating_task
        CHECK (dep_type NOT IN ('task', 'acceptance_package')
               OR (gating_task_id IS NOT NULL AND dep_key = gating_task_id)),

    CONSTRAINT dep_edge_outside_the_task_lane_names_no_gating_task
        CHECK (dep_type IN ('task', 'acceptance_package') OR gating_task_id IS NULL),

    CONSTRAINT dep_edge_edge_does_not_gate_itself
        CHECK (gating_task_id IS DISTINCT FROM task_id),

    CONSTRAINT dep_edge_satisfied_edge_carries_its_signer_kind_and_stamp
        CHECK ((state = 'satisfied')
               = (settled_by IS NOT NULL AND settle_kind IS NOT NULL
                  AND settled_at IS NOT NULL)),

    CONSTRAINT dep_edge_settle_kind_is_a_declared_kind
        CHECK (settle_kind IS NULL
               OR settle_kind IN ('evaluator_verdict', 'moot_completion')),

    -- §3.2: `capacity_free` is the only tautologically-moot class (6/6 measured),
    -- with `time_elapse` its clock-shaped sibling. Every other family renders as
    -- a loud completed-but-unsettled state and settles by its own evaluator.
    CONSTRAINT dep_edge_moot_settle_is_only_for_a_tautologically_moot_family
        CHECK (settle_kind IS DISTINCT FROM 'moot_completion'
               OR dep_type IN ('capacity_free', 'time_elapse')),

    -- The IS NOT NULL is load-bearing: without it a retraction carrying no
    -- evidence key at all yields NULL through the jsonb operators and a CHECK
    -- passes on NULL — the unevidenced retraction this constraint exists to
    -- refuse would sail through (the 001_core.sql lesson, restated).
    CONSTRAINT dep_edge_retracted_edge_carries_addressable_evidence
        CHECK (state <> 'retracted'
               OR (retracted_at IS NOT NULL
                   AND retraction_evidence_refs IS NOT NULL
                   AND jsonb_typeof(retraction_evidence_refs) = 'array'
                   AND jsonb_array_length(retraction_evidence_refs) > 0)),

    CONSTRAINT dep_edge_only_a_retracted_edge_carries_a_retraction
        CHECK (state = 'retracted'
               OR (retracted_at IS NULL AND retraction_evidence_refs IS NULL)),

    CONSTRAINT dep_edge_acknowledged_debt_names_its_owner_and_due
        CHECK ((state = 'debt_acked')
               = (debt_owner IS NOT NULL AND debt_due IS NOT NULL))
);

COMMENT ON TABLE cell.dep_edge IS
    'Contract §3.3 as ruled by R4: a task-type edge releases on the upstream '
    'task''s recorded VERIFICATION, period. There is no selector column and none '
    'may be added without a founder ruling.';

CREATE INDEX IF NOT EXISTS dep_edge_by_waiting_task
    ON cell.dep_edge (org_id, task_id, state);

CREATE INDEX IF NOT EXISTS dep_edge_by_gating_task
    ON cell.dep_edge (org_id, gating_task_id)
    WHERE gating_task_id IS NOT NULL;

-- ------------------------------------------ the acceptance bar, as enforcement
--
-- The view below says whether an edge MAY be released. This trigger is why that
-- answer cannot be ignored. A release bar that lives only in a projection is a
-- bar with a bypass, and the Mac's 23 direct-publish `verified` settles are the
-- measured price of exactly that shape.
CREATE OR REPLACE FUNCTION cell.enforce_acceptance_only_release()
RETURNS trigger
LANGUAGE plpgsql
AS $acceptance_only$
DECLARE
    v_completion text;
BEGIN
    -- Only a TRANSITION into satisfied is checked. Re-stating an already-settled
    -- edge is idempotent, and re-checking it would make a legitimate correction
    -- elsewhere on the row fail for a reason that has nothing to do with it.
    IF NEW.state IS DISTINCT FROM 'satisfied' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.state = 'satisfied' THEN
        RETURN NEW;
    END IF;

    IF NEW.dep_type = 'task' THEN
        SELECT completion INTO v_completion
          FROM cell.v_task_completion
         WHERE org_id = NEW.org_id AND task_id = NEW.gating_task_id;

        IF v_completion IS DISTINCT FROM 'complete' THEN
            RAISE EXCEPTION
                'DEP_RELEASED_WITHOUT_ACCEPTANCE:%/% — the gating task projects '
                '''%'', not ''complete''. FOUNDER RULING R4: a task-type dependency '
                'releases on the upstream task''s recorded VERIFICATION and on '
                'nothing else. Releasing on the upstream author''s own completion '
                'assertion is "statements are not truth" inside the dependency '
                'system itself, which is what the Mac did.',
                NEW.org_id, NEW.gating_task_id,
                coalesce(v_completion, '<no such task>')
                USING ERRCODE = 'FC070';
        END IF;

    ELSIF NEW.dep_type = 'acceptance_package' THEN
        IF NOT EXISTS (
            SELECT 1 FROM cell.verification v
             WHERE v.org_id = NEW.org_id
               AND v.task_id = NEW.gating_task_id
               AND v.source = 'acceptance_package'
               AND v.result = 'verified'
        ) THEN
            RAISE EXCEPTION
                'ACCEPTANCE_PACKAGE_NOT_VERIFIED:%/% — no acceptance-package '
                'verdict with result ''verified'' is recorded against the accepted '
                'task. A rejected or indeterminate verdict is a verification '
                'record; it is not a release (§1.4).',
                NEW.org_id, NEW.gating_task_id
                USING ERRCODE = 'FC071';
        END IF;
    END IF;

    RETURN NEW;
END;
$acceptance_only$;

CREATE OR REPLACE TRIGGER dep_edge_release_meets_the_acceptance_bar
    BEFORE INSERT OR UPDATE ON cell.dep_edge
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_acceptance_only_release();

-- ---------------------------------------------------- no auto-void, stated once
--
-- Deleting an edge is auto-void with better manners: the wait disappears and
-- nothing records that it did. An edge ends by satisfaction with a signer, or by
-- retraction with evidence — both of which leave the row and its history behind
-- (L12). TRUNCATE does not fire this trigger, which is what lets the test harness
-- reset a scratch database without disarming the rule it is testing.
CREATE OR REPLACE FUNCTION cell.refuse_dep_edge_deletion()
RETURNS trigger
LANGUAGE plpgsql
AS $no_delete$
BEGIN
    RAISE EXCEPTION
        'DEP_EDGE_DELETED:% — a dependency edge is never removed. It is satisfied '
        'by its evaluator (with a signer and a settle_kind) or retracted with '
        'evidence_refs; both leave the declared history in place. Deleting it is '
        'the completion auto-void the cell does not port — 52/52 measured voids '
        'extinguished waits nobody could later account for, and zero consumers '
        'ever read a void event.',
        OLD.edge_id
        USING ERRCODE = 'FC072';
END;
$no_delete$;

CREATE OR REPLACE TRIGGER dep_edge_is_never_deleted
    BEFORE DELETE ON cell.dep_edge
    FOR EACH ROW EXECUTE FUNCTION cell.refuse_dep_edge_deletion();

-- ---------------------------------------------------------------------------
-- v_dep_edge_release — may this edge be released, and by whom
--
-- `settles_by` is the single source of truth for release authority (§4.5's
-- discipline applied to the dependency lane). MEASURED motivation: "what counts
-- as a valid release" was encoded in SEVEN places on the Mac plus one stale copy,
-- and every encoding drifted.
--
-- The join is on (org_id, gating_task_id). There is no department predicate here
-- and there must never be one: that predicate IS the measured dept-scoped
-- resolver defect, and the dependency test suite is written cross-department by
-- default so reintroducing it turns the whole suite red.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW cell.v_dep_edge_release AS
SELECT
    e.edge_id,
    e.org_id,
    e.task_id,
    e.dep_type,
    e.dep_key,
    e.gating_task_id,
    e.state,
    g.completion AS gating_completion,
    CASE e.dep_type
        WHEN 'task'               THEN 'evaluator_lane'
        WHEN 'acceptance_package' THEN 'acceptance_seat'
        WHEN 'verified'           THEN 'registered_checker'
        WHEN 'operator_approval'  THEN 'operator_confirm'
        WHEN 'capacity_free'      THEN 'reconciler_mootness'
        WHEN 'time_elapse'        THEN 'reconciler_mootness'
        WHEN 'external_event'     THEN 'external_event_evaluator'
    END AS settles_by,
    CASE
        -- R4's bar, computed: the upstream task's tri-state, nothing weaker.
        WHEN e.dep_type = 'task'
            THEN coalesce(g.completion, '') = 'complete'
        WHEN e.dep_type = 'acceptance_package'
            THEN EXISTS (SELECT 1 FROM cell.verification v
                          WHERE v.org_id = e.org_id
                            AND v.task_id = e.gating_task_id
                            AND v.source = 'acceptance_package'
                            AND v.result = 'verified')
        -- The remaining five families release on an observation this substrate
        -- does not hold: an evaluator's signature, an operator's consume, a
        -- clock, free capacity, an external event. Reporting `false` is the
        -- honest answer to "may it be released from what is recorded here" —
        -- `settles_by` names who does hold that observation.
        ELSE false
    END AS releasable
FROM cell.dep_edge e
LEFT JOIN cell.v_task_completion g
       ON g.org_id = e.org_id AND g.task_id = e.gating_task_id;

-- ---------------------------------------------------------------------------
-- v_task_open_deps — the compound AND, and the widened board arm
--
-- Compound AND (case 5): a task proceeds when EVERY edge is satisfied. Arrival
-- order is immaterial because this is a count over recorded state, not a
-- sequence of transitions — which is also why a duplicate satisfy releases once.
--
-- A RETRACTED edge is neither open nor satisfied: it does not hold the task up,
-- and it does not release it either. It makes the task's settlement status
-- `predicate_retracted`, carrying the retraction as its evidence (§1.6) — 17
-- historical tasks project exactly this.
--
-- `board_state` is contract §3.4(1), the widened completed-but-unsettled arm:
-- `done_awaiting_deps` renders for EVERY loud edge family, not only for
-- operator-approval edges. Without that, a completed task holding a `verified`
-- or `external_event` edge renders `blocked` forever — the 2026-07-21
-- founder-surface ghost-row incident, resurrected by its own fix.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW cell.v_task_open_deps AS
SELECT
    c.org_id,
    c.task_id,
    c.department,
    c.completion,
    d.total_deps,
    d.open_deps,
    d.satisfied_deps,
    d.retracted_deps,
    d.open_dep_types,
    (d.open_deps = 0 AND d.retracted_deps = 0) AS all_deps_satisfied,
    (d.retracted_deps > 0)                     AS predicate_retracted,
    CASE
        WHEN d.retracted_deps > 0                              THEN 'predicate_retracted'
        WHEN c.completion = 'none' AND d.open_deps > 0         THEN 'blocked'
        WHEN c.completion = 'none'                             THEN 'open'
        WHEN d.open_deps > 0                                   THEN 'done_awaiting_deps'
        WHEN c.completion = 'asserted_unverified'              THEN 'done_awaiting_verification'
        ELSE 'complete'
    END AS board_state
FROM cell.v_task_completion c
CROSS JOIN LATERAL (
    SELECT
        count(*)::int AS total_deps,
        count(*) FILTER (WHERE e.state NOT IN ('satisfied', 'retracted'))::int
            AS open_deps,
        count(*) FILTER (WHERE e.state = 'satisfied')::int AS satisfied_deps,
        count(*) FILTER (WHERE e.state = 'retracted')::int AS retracted_deps,
        coalesce(
            array_agg(DISTINCT e.dep_type)
                FILTER (WHERE e.state NOT IN ('satisfied', 'retracted')),
            ARRAY[]::text[]) AS open_dep_types
      FROM cell.dep_edge e
     WHERE e.org_id = c.org_id AND e.task_id = c.task_id
) d;

COMMENT ON VIEW cell.v_task_open_deps IS
    'Contract §3.4(1): done_awaiting_deps renders for EVERY loud edge family, '
    'not only operator-approval — a completed task holding a verified edge must '
    'never render blocked forever.';
