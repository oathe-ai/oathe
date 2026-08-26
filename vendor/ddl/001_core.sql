-- 001_core.sql — the cell work-spine core: task / work_claim / execution_attempt
-- and the claim-event ledger the terminals are read from.
--
-- Contract: docs/a1-cell-work-spine-contract.md §1-§2, AMENDED 2026-08-16 by
-- founder rulings R1 (ownership/attempt split), R2 (uniform assertion terminal +
-- mandatory verify_by), R3 (interrupted attempts carry outcome_status with a
-- clock), R5 (direct assignment), R7 (exclusive-only) and R8 (parent COMPLETE is
-- verification-gated, so nothing here blocks a parent's assertion).
--
-- Re-apply: idempotent (CREATE ... IF NOT EXISTS throughout).
-- Revert:   DROP SCHEMA cell CASCADE;
--
-- Two standing rules for everything below:
--
--   1. Enforcement lives HERE, not in a service. The estate's measured lesson
--      (STF-1 / migrations 0047 / 0073) is that a rule with a CLI gate and no
--      substrate trigger gets bypassed by direct publish — 23 historical
--      `verified` settles did exactly that. A rule this file does not enforce is
--      a rule whose coverage cannot be published (L9).
--   2. Columns are NOT NULL unless the amended contract says the fact is absent.
--      Every nullable column below carries a comment naming the contract clause
--      that makes it absent, and a CHECK constraint that makes the absence
--      lawful only in that case. A nullable column with no such pairing is a
--      state the falsifiers cannot see (F2 legs a/b/c).
--
-- Constraint names are the failure vocabulary: the refusal text an operator or a
-- falsifier reads is the constraint name, so each one is written to name the
-- invariant it defends rather than the columns it happens to cover.

CREATE SCHEMA IF NOT EXISTS cell;

-- ---------------------------------------------------------------------------
-- task — work the company believes should be done (contract §1.1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.task (
    org_id                text        NOT NULL,
    task_id               text        NOT NULL,
    department            text        NOT NULL,
    origin                text        NOT NULL,
    objective             text        NOT NULL,

    -- The verification plan lives on the task (contract §1.1): settlement
    -- predicate ownership is task-anchored. It is NOT NULL even when nothing is
    -- known — an undeclared plan is recorded as plan_status 'unknown' and never
    -- as an absent row, because "unknown" is a reportable epistemic status and
    -- NULL is a hole a projection would have to guess about (L13).
    verification_plan     jsonb       NOT NULL,

    -- FOUNDER RULING R2: the deadline is mandatory, never optional. minutes for
    -- business-consequential effects, longer explicitly for routine work. This
    -- column is what makes "asserted_unverified past verify_by" a RED leg rather
    -- than an opinion.
    verify_by             timestamptz NOT NULL,

    -- FOUNDER RULING R7: exclusive is the only mode. Carried on the task because
    -- the claim transaction reads the task's policy under lock before it writes.
    claim_mode            text        NOT NULL,

    -- FOUNDER RULING R5 / contract §2.3: to_principal is a real routing field.
    -- NULL exactly and only for offer-based delegation, where the contract says
    -- assignment is absent and the target principal CLAIMs instead. When it is
    -- present the claim-or-refuse deadline is present with it — an assignment
    -- with no deadline is the measured re-dispatch-forever defect.
    to_principal          text,
    assignment_deadline   timestamptz,

    created_at            timestamptz NOT NULL,

    CONSTRAINT task_pkey PRIMARY KEY (org_id, task_id),

    CONSTRAINT task_origin_is_a_declared_class
        CHECK (origin IN ('enqueued', 'minted_at_claim', 'reopened')),

    CONSTRAINT task_claim_mode_no_such_mode
        CHECK (claim_mode = 'exclusive'),

    -- The IS NOT NULL is load-bearing: a CHECK passes on NULL, so
    -- `->> 'plan_status' IN (...)` alone would accept a plan with no status at
    -- all — exactly the absent-plan hole this constraint exists to close.
    CONSTRAINT task_verification_plan_declares_its_status
        CHECK (jsonb_typeof(verification_plan) = 'object'
               AND verification_plan ->> 'plan_status' IS NOT NULL
               AND verification_plan ->> 'plan_status' IN ('declared', 'unknown')),

    CONSTRAINT task_assignment_is_paired_with_its_deadline
        CHECK ((to_principal IS NULL) = (assignment_deadline IS NULL))
);

COMMENT ON TABLE cell.task IS
    'Contract §1.1. Origin classes are first-class: claim-time minting is a '
    'shipped production origin, not an anomaly.';

-- ---------------------------------------------------------------------------
-- work_claim — one principal, one interval of RESPONSIBILITY (contract §1.2)
--
-- The R1 split, stated as a table: a work_claim is organizational, not runtime.
-- It survives Claude death, runtime death, session change, executor restart and
-- container restart; nothing in this table names a session, a runtime or a
-- heartbeat, because those live one level down in execution_attempt. A new claim
-- appears only when RESPONSIBILITY changes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.work_claim (
    work_claim_id         uuid        NOT NULL,
    org_id                text        NOT NULL,
    task_id               text        NOT NULL,

    -- contract §2.1: a delegated child claim is a full work_claim owned by a
    -- DIFFERENT principal, linked here. NULL for a root claim — the absence of
    -- a delegator, which is the majority case.
    parent_work_claim_id  uuid,

    -- R-A35-23 (027_ownership_return.sql): the interval this one RESUMES.
    -- SUCCESSION lineage — same work, same principal, a later interval — and
    -- deliberately NOT the column above, which is DELEGATION lineage. NULL for
    -- every interval that resumed nothing, which is the majority case. Stated
    -- here as well as in 027's ALTER because CREATE TABLE IF NOT EXISTS does not
    -- reach a database that already exists, so a fresh install and an ALTERed one
    -- must be made to agree by hand.
    predecessor_work_claim_id uuid,

    principal_id          text        NOT NULL,
    department            text        NOT NULL,

    -- Claim terminals EXACTLY per contract §1.2 as amended by R1/R2:
    -- completion assertion, yield-with-typed-basis, abort, takeover/reassignment,
    -- organizational expiry. `orphaned` and `failed` are DELIBERATELY absent —
    -- R1 moved them to execution_attempt, and accepting them here would re-merge
    -- the two lifecycles this split exists to separate.
    state                 text        NOT NULL,

    claim_mode            text        NOT NULL,
    ownership_valid_until timestamptz NOT NULL,
    contract_ref          text        NOT NULL,

    -- "yield-with-typed-basis" (§1.2). Required on yield and abort; forbidden
    -- while the claim is live or ended by assertion, where there is no basis to
    -- state. Permitted on takeover/expiry, where the reason is useful but the
    -- terminal is not the principal's own act.
    terminal_basis        text,

    claimed_at            timestamptz NOT NULL,

    -- The ownership terminal stamp. NULL exactly while state = 'active'; this
    -- column is what F2 leg (a) reads to call a claim past its
    -- ownership_valid_until with no terminal RED.
    ownership_ended_at    timestamptz,

    -- The two named terminals that carry their own stamp (contract §1.2/R2).
    yielded_at            timestamptz,
    completed_at          timestamptz,

    -- contract §1.6: settlement is a separate fact from completion, and never
    -- earlier than the end of responsibility.
    settled_at            timestamptz,

    CONSTRAINT work_claim_pkey PRIMARY KEY (work_claim_id),

    -- The org-consistent handle every child row references, so a child cannot
    -- silently attach across an org boundary (PRD:1626).
    CONSTRAINT work_claim_org_scoped_key UNIQUE (org_id, work_claim_id),

    CONSTRAINT work_claim_task_fkey
        FOREIGN KEY (org_id, task_id) REFERENCES cell.task (org_id, task_id),

    CONSTRAINT work_claim_parent_fkey
        FOREIGN KEY (org_id, parent_work_claim_id)
        REFERENCES cell.work_claim (org_id, work_claim_id),

    CONSTRAINT work_claim_predecessor_fkey
        FOREIGN KEY (org_id, predecessor_work_claim_id)
        REFERENCES cell.work_claim (org_id, work_claim_id),

    CONSTRAINT work_claim_predecessor_is_not_itself
        CHECK (predecessor_work_claim_id IS DISTINCT FROM work_claim_id),

    CONSTRAINT work_claim_state_is_a_declared_claim_terminal
        CHECK (state IN ('active', 'completion_asserted', 'yielded',
                         'aborted', 'taken_over', 'expired')),

    CONSTRAINT work_claim_claim_mode_no_such_mode
        CHECK (claim_mode = 'exclusive'),

    CONSTRAINT work_claim_active_claim_has_no_ownership_end
        CHECK ((state = 'active') = (ownership_ended_at IS NULL)),

    CONSTRAINT work_claim_yielded_at_is_the_yield_terminal
        CHECK ((state = 'yielded') = (yielded_at IS NOT NULL)),

    CONSTRAINT work_claim_completed_at_is_the_assertion_terminal
        CHECK ((state = 'completion_asserted') = (completed_at IS NOT NULL)),

    CONSTRAINT work_claim_yield_or_abort_carries_a_typed_basis
        CHECK (state NOT IN ('yielded', 'aborted') OR terminal_basis IS NOT NULL),

    CONSTRAINT work_claim_live_claim_has_no_typed_basis
        CHECK (state NOT IN ('active', 'completion_asserted') OR terminal_basis IS NULL),

    CONSTRAINT work_claim_settlement_follows_a_claim_terminal
        CHECK (settled_at IS NULL
               OR (state <> 'active' AND settled_at >= ownership_ended_at))
);

-- Unique active ownership (FOUNDER RULING R7), enforced beneath the claim
-- transaction rather than only inside it. The transaction is the path; this
-- index is the guarantee — it is what makes two live owners of one task
-- impossible for ANY writer, including one that never calls cell.claim_work.
-- PARTIAL by construction: terminal claims on the same task coexist without
-- limit, because claim history is durable (L12) and reclaim after a terminal is
-- a new, distinct episode.
CREATE UNIQUE INDEX IF NOT EXISTS work_claim_unique_active_ownership
    ON cell.work_claim (org_id, task_id) WHERE state = 'active';

-- ---------------------------------------------------------------------------
-- execution_attempt — the disposable runtime binding beneath a claim (R1)
--
-- Everything the Mac used as a liveness proxy lives here and nowhere else. An
-- attempt dying is an attempt terminal; the claim above it does not move.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.execution_attempt (
    attempt_id            uuid        NOT NULL,
    work_claim_id         uuid        NOT NULL,
    org_id                text        NOT NULL,
    runtime_id            text        NOT NULL,
    session_id            text        NOT NULL,
    executor_version      text        NOT NULL,
    started_at            timestamptz NOT NULL,

    -- NULL exactly while the attempt is running; F2 leg (b) reads this to call
    -- an attempt with no attempt terminal RED.
    ended_at              timestamptz,

    -- Attempt terminals per contract §1.2: orphaned, failed, interrupted —
    -- plus 'running' and the ordinary 'completed' end.
    state                 text        NOT NULL,

    -- FOUNDER RULING R3: an INTERRUPTED attempt carries an outcome status, and
    -- only an interrupted attempt does. `evidence_lost` was rejected as a
    -- terminal because it mints an unobserved fact — the honest word for that
    -- state is 'unknown', with a clock on it.
    outcome_status        text,

    -- 'unknown' REQUIRES a deadline and a named resolver. Without them, unknown
    -- is permanent by construction and there is no deadline for F2 leg (c) to be
    -- red against. Resolution flows through the existing reconciler evaluator
    -- lane — this pair names WHEN and WHO, not a new resolver species.
    reconcile_by          timestamptz,
    resolver_principal    text,

    CONSTRAINT execution_attempt_pkey PRIMARY KEY (attempt_id),

    CONSTRAINT execution_attempt_claim_fkey
        FOREIGN KEY (org_id, work_claim_id)
        REFERENCES cell.work_claim (org_id, work_claim_id),

    CONSTRAINT execution_attempt_state_is_a_declared_runtime_state
        CHECK (state IN ('running', 'completed', 'failed', 'orphaned', 'interrupted')),

    CONSTRAINT execution_attempt_running_attempt_has_no_end
        CHECK ((state = 'running') = (ended_at IS NULL)),

    CONSTRAINT execution_attempt_outcome_status_is_a_declared_status
        CHECK (outcome_status IS NULL
               OR outcome_status IN ('known_success', 'known_failure', 'unknown')),

    CONSTRAINT execution_attempt_outcome_status_is_the_interrupted_terminal
        CHECK ((state = 'interrupted') = (outcome_status IS NOT NULL)),

    -- IS NOT DISTINCT FROM, not '=': with a NULL outcome_status the '=' form
    -- evaluates to NULL and a CHECK passes on NULL, which would leave a
    -- reconciliation deadline lawful on an attempt that needs no reconciling.
    CONSTRAINT execution_attempt_unknown_requires_reconcile_by
        CHECK ((outcome_status IS NOT DISTINCT FROM 'unknown') = (reconcile_by IS NOT NULL)),

    CONSTRAINT execution_attempt_unknown_requires_a_named_resolver
        CHECK ((outcome_status IS NOT DISTINCT FROM 'unknown') = (resolver_principal IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS execution_attempt_by_claim
    ON cell.execution_attempt (org_id, work_claim_id, started_at);

-- ---------------------------------------------------------------------------
-- work_claim_event — terminals identified by MEANING, never by code path
--
-- MEASURED on the Mac: orphan events had three distinct producers, so "what
-- happened" could not be read off the event without knowing which code path
-- wrote it. The cell has exactly one producer per meaning; the topic vocabulary
-- is closed here, and the producer registry that enforces the other half of
-- that sentence is installed with the verb that owns each topic (002 registers
-- the claim producer).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.work_claim_event (
    event_id              uuid        NOT NULL,
    org_id                text        NOT NULL,
    work_claim_id         uuid        NOT NULL,
    topic                 text        NOT NULL,
    ts                    timestamptz NOT NULL,
    producer              text        NOT NULL,

    CONSTRAINT work_claim_event_pkey PRIMARY KEY (event_id),

    CONSTRAINT work_claim_event_claim_fkey
        FOREIGN KEY (org_id, work_claim_id)
        REFERENCES cell.work_claim (org_id, work_claim_id),

    CONSTRAINT work_claim_event_claim_event_topic_is_a_declared_meaning
        CHECK (topic IN ('work_claim.claimed', 'work_claim.completion_asserted',
                         'work_claim.yielded', 'work_claim.aborted',
                         'work_claim.taken_over', 'work_claim.expired'))
);

CREATE INDEX IF NOT EXISTS work_claim_event_by_claim
    ON cell.work_claim_event (org_id, work_claim_id, ts);
