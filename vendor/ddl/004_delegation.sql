-- 004_delegation.sql — the delegation lane: principals, grants, the enqueue
-- transaction, and the audit topic that names the TARGET department.
--
-- Contract: docs/a1-cell-work-spine-contract.md §2.3 as amended, FOUNDER RULING
-- R5, PRD §13.4 as amended — "the delegator's authority to create work in the
-- target scope is checked in the SAME TRANSACTION as the task/dependency
-- creation, against a grants table with a substrate-level check (the estate's
-- proven pattern — STF-1, 0047, 0073 triggers). No new authorization service is
-- introduced." Requires 001_core.sql.
--
-- Re-apply: idempotent (CREATE ... IF NOT EXISTS / OR REPLACE, ON CONFLICT seed).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- TWO MEASURED DEFECTS THIS FILE CLOSES — in the cell design; the Mac is
-- untouched (L3):
--
--   1. **cross-dept enqueue is unguarded** — the department is a free parameter
--      on the dispatch path, so any principal could create work in any scope.
--      The answer here is a grants table plus a BEFORE-INSERT trigger on the
--      delegation record, so the check is met by EVERY writer, including one
--      that never calls cell.enqueue_delegated_work. A rule with a CLI gate and
--      no substrate trigger is precisely the measured direct-publish bypass
--      (23 historical `verified` settles went around exactly such a gate).
--   2. **cross-dept audit topics are hardcoded** to one department's dispatch
--      prefix, so work delegated INTO another scope was audited into the
--      delegator's — invisible to the department that has to answer for it.
--      Here the topic is a GENERATED column over the row's department, and the
--      department is checked against the task's own. A hardcoded department is
--      REFUSED rather than silently rewritten: a rewrite would hide that a
--      caller still believes every dispatch belongs to one department.
--
-- Declared failure vocabulary added by this file (SQLSTATE class FC — outside
-- every class Postgres assigns; message prefix and SQLSTATE carry the SAME
-- invariant name, so a caller may key on either and an operator reading the log
-- sees the rule). This lane reserves FC020-FC039.
--
-- The FC020-FC039 block is ONE range shared by the delegation, escalation and
-- assignment lanes on purpose: those three verbs raise each other's invariants
-- (UNKNOWN_TASK and DELEGATION_NOT_GRANTED are genuinely the same rule seen from
-- three verbs), and splitting the block would force one invariant to carry two
-- codes. Codes RE-RAISED from a neighbouring file are listed below with their
-- owning file named, so this header is the whole vocabulary this file can emit —
-- tests/test_failure_vocabulary.py holds the substrate to that.
--   FC020 DELEGATION_NOT_GRANTED           work created in a scope not granted
--   FC021 UNKNOWN_TASK                     a lane record about work that does not exist
--   FC022 DELEGATION_SCOPE_MISMATCH        a delegation naming a scope the task is not in
--   FC023 AUDIT_DEPARTMENT_MISATTRIBUTED   an audit row claiming another department

-- ---------------------------------------------------------------------------
-- principal — the org chart, as rows
--
-- Needed here rather than later because BOTH halves of this lane read it: a
-- grant is held BY a principal, and the escalation chain (005) walks
-- `assigner_principal_id` from the escalating principal to the CEO, who ALONE
-- decides human contact (FOUNDER RULING R6). PRD §4.2 v1 keeps one standing
-- lead per department; the shape here is multi-principal-ready (R5), because a
-- department holding two principals must not require re-architecture.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.principal (
    org_id                text NOT NULL,
    principal_id          text NOT NULL,
    department            text NOT NULL,
    role                  text NOT NULL,

    -- Who this principal escalates to. NULL EXACTLY for the CEO principal —
    -- the one seat with nobody above it — and the CHECK below is what makes
    -- that the only lawful absence. A lead with no assigner is a chain that
    -- runs out, and an escalation that runs out is the abolished modal block
    -- wearing a different name.
    assigner_principal_id text,

    CONSTRAINT principal_pkey PRIMARY KEY (org_id, principal_id),

    CONSTRAINT principal_role_is_a_declared_seat
        CHECK (role IN ('ceo', 'lead')),

    CONSTRAINT principal_assigner_fkey
        FOREIGN KEY (org_id, assigner_principal_id)
        REFERENCES cell.principal (org_id, principal_id),

    CONSTRAINT principal_only_the_ceo_answers_to_nobody
        CHECK ((role = 'ceo') = (assigner_principal_id IS NULL)),

    -- The smallest possible cycle, and the one a chain walk cannot tell apart
    -- from progress. The longer cycles are caught by the walk itself (005).
    CONSTRAINT principal_answers_to_someone_else
        CHECK (assigner_principal_id IS DISTINCT FROM principal_id)
);

-- One root per org. Two CEO principals is a chain that FORKS, and an escalation
-- that forks is an escalation two seats can each believe the other is handling.
CREATE UNIQUE INDEX IF NOT EXISTS principal_one_ceo_per_org
    ON cell.principal (org_id) WHERE role = 'ceo';

COMMENT ON TABLE cell.principal IS
    'PRD §4.2 / FOUNDER RULING R5-R6. The org chart the grants table and the '
    'escalation chain both read. Multi-principal-ready; v1 seats one lead per '
    'department.';

-- ---------------------------------------------------------------------------
-- delegation_grant — the grants table PRD §13.4 names
--
-- "A delegation is authorized before it exists." This is the whole of that
-- authority: which principal may create work in which department. It is a
-- table and not a service because a durable store can own the semantic
-- (C.1: no new service when a store can own it), and because a table is what a
-- trigger can read inside the delegator's own transaction.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.delegation_grant (
    org_id         text        NOT NULL,
    from_principal text        NOT NULL,
    to_department  text        NOT NULL,
    state          text        NOT NULL,
    granted_by     text        NOT NULL,
    granted_at     timestamptz NOT NULL,

    -- NULL exactly while the grant is live. Paired with `state` by the CHECK
    -- below: a revoked grant with no stamp is an authority change nobody can
    -- date, and dating authority changes is the entire point of holding them
    -- as rows rather than as configuration.
    revoked_at     timestamptz,

    CONSTRAINT delegation_grant_pkey
        PRIMARY KEY (org_id, from_principal, to_department),

    CONSTRAINT delegation_grant_holder_fkey
        FOREIGN KEY (org_id, from_principal)
        REFERENCES cell.principal (org_id, principal_id),

    CONSTRAINT delegation_grant_granted_by_fkey
        FOREIGN KEY (org_id, granted_by)
        REFERENCES cell.principal (org_id, principal_id),

    CONSTRAINT delegation_grant_state_is_declared
        CHECK (state IN ('live', 'revoked')),

    CONSTRAINT delegation_grant_revoked_grant_carries_its_stamp
        CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- task_delegation — the durable record that this task was created BY a
-- delegator INTO a scope, carrying PRD §13.4's minimal delegation contract
-- fields that are not already on the task itself.
--
-- It exists as its own row rather than as columns on `task` for one reason:
-- it is the row the grant trigger fires on. A task inserted with no delegation
-- record is not a delegation — it is work a scope created for itself — and the
-- distinction is what keeps the authority check aimed at the act that needs it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.task_delegation (
    org_id         text        NOT NULL,
    task_id        text        NOT NULL,
    from_principal text        NOT NULL,
    to_department  text        NOT NULL,
    contract_ref   text        NOT NULL,
    created_at     timestamptz NOT NULL,

    CONSTRAINT task_delegation_pkey PRIMARY KEY (org_id, task_id),

    CONSTRAINT task_delegation_task_fkey
        FOREIGN KEY (org_id, task_id) REFERENCES cell.task (org_id, task_id),

    CONSTRAINT task_delegation_delegator_fkey
        FOREIGN KEY (org_id, from_principal)
        REFERENCES cell.principal (org_id, principal_id)
);

-- ---------------------------------------------------------------------------
-- audit_event — the dispatch audit lane, with the department it belongs to
--
-- `topic` is GENERATED, not supplied. A topic a caller can set is a topic a
-- caller can hardcode, and hardcoding it is the measured defect. The vocabulary
-- of `kind` is closed here for the whole lane; the verbs land across this file
-- (task_created) and 005/006 (escalated, task_assigned, task_declined), each
-- registering itself in the producer CHECK below.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.audit_event (
    audit_event_id   uuid        NOT NULL,
    org_id           text        NOT NULL,

    -- The TARGET department — the scope that must answer for the work — never
    -- the actor's. Checked against the task's own department by the trigger
    -- below, so this column cannot drift from the work it describes.
    department       text        NOT NULL,
    kind             text        NOT NULL,
    topic            text        GENERATED ALWAYS AS
                                 (department || '.dispatch.' || kind) STORED,
    task_id          text        NOT NULL,

    -- WHO acted is still recorded — the fix is not to lose the delegator, it is
    -- to stop filing the event under the delegator's department.
    actor_principal  text        NOT NULL,
    ts               timestamptz NOT NULL,
    producer         text        NOT NULL,

    CONSTRAINT audit_event_pkey PRIMARY KEY (audit_event_id),

    CONSTRAINT audit_event_task_fkey
        FOREIGN KEY (org_id, task_id) REFERENCES cell.task (org_id, task_id),

    CONSTRAINT audit_event_actor_fkey
        FOREIGN KEY (org_id, actor_principal)
        REFERENCES cell.principal (org_id, principal_id),

    CONSTRAINT audit_event_kind_is_a_declared_meaning
        CHECK (kind IN ('task_created', 'task_assigned', 'task_declined', 'escalated')),

    CONSTRAINT audit_event_producer_is_a_declared_verb
        CHECK (producer IN ('cell.enqueue_delegated_work', 'cell.escalate',
                            'cell.assign_task', 'cell.decline_task'))
);

CREATE INDEX IF NOT EXISTS audit_event_by_department
    ON cell.audit_event (org_id, department, ts);

COMMENT ON COLUMN cell.audit_event.topic IS
    'GENERATED from the TARGET department. The measured Mac defect was a '
    'hardcoded dispatch prefix, which filed cross-department delegations under '
    'the delegator''s department; a generated topic has no hand to hardcode.';

-- ------------------------------------------------------- the audit dept guard
CREATE OR REPLACE FUNCTION cell.enforce_audit_department_is_the_tasks_own()
RETURNS trigger
LANGUAGE plpgsql
AS $audit_dept$
DECLARE
    v_task_department text;
BEGIN
    SELECT department INTO v_task_department
      FROM cell.task
     WHERE org_id = NEW.org_id AND task_id = NEW.task_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'UNKNOWN_TASK:%/% — an audit event describes work, and no work by '
            'that identity exists in this org, so there is no department it '
            'could belong to.',
            NEW.org_id, NEW.task_id
            USING ERRCODE = 'FC021';
    END IF;

    IF NEW.department IS DISTINCT FROM v_task_department THEN
        RAISE EXCEPTION
            'AUDIT_DEPARTMENT_MISATTRIBUTED:%:% — this audit event claims '
            'department ''%'' for work that is in ''%''. The topic is generated '
            'from this column, so a wrong department files the event where the '
            'scope answering for the work will never read it — the measured '
            'hardcoded-dispatch-topic defect. Refused rather than rewritten: a '
            'rewrite would hide that the caller still believes otherwise.',
            NEW.org_id, NEW.task_id, NEW.department, v_task_department
            USING ERRCODE = 'FC023';
    END IF;

    RETURN NEW;
END;
$audit_dept$;

CREATE OR REPLACE TRIGGER audit_event_department_is_the_tasks_own
    BEFORE INSERT OR UPDATE ON cell.audit_event
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_audit_department_is_the_tasks_own();

-- ------------------------------------------------------- the grant guard
--
-- This is PRD §13.4's "substrate-level check", and it is a trigger rather than
-- a clause inside the enqueue function so that the check is unavoidable: the
-- delegation record cannot exist without it, whoever writes the row, through
-- whatever path. The transaction the check runs in is the caller's own — there
-- is no second round trip in which authority could have changed.
CREATE OR REPLACE FUNCTION cell.enforce_delegation_grant()
RETURNS trigger
LANGUAGE plpgsql
AS $grant_guard$
DECLARE
    v_task_department text;
    v_grant_state     text;
BEGIN
    SELECT department INTO v_task_department
      FROM cell.task
     WHERE org_id = NEW.org_id AND task_id = NEW.task_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'UNKNOWN_TASK:%/% — a delegation records that work was created in a '
            'scope, and no work by that identity exists in this org.',
            NEW.org_id, NEW.task_id
            USING ERRCODE = 'FC021';
    END IF;

    -- Checked BEFORE the grant: a delegation naming a department the task is
    -- not in would otherwise satisfy a grant for a scope the work never
    -- entered — authority checked against fiction.
    IF NEW.to_department IS DISTINCT FROM v_task_department THEN
        RAISE EXCEPTION
            'DELEGATION_SCOPE_MISMATCH:%/%:% — this delegation records scope '
            '''%'' for work that is in ''%''. The grant is checked against the '
            'recorded scope, so a scope that is not the work''s own would '
            'authorize a delegation that never happened.',
            NEW.org_id, NEW.task_id, NEW.from_principal,
            NEW.to_department, v_task_department
            USING ERRCODE = 'FC022';
    END IF;

    SELECT state INTO v_grant_state
      FROM cell.delegation_grant
     WHERE org_id = NEW.org_id
       AND from_principal = NEW.from_principal
       AND to_department = NEW.to_department;

    IF NOT FOUND OR v_grant_state IS DISTINCT FROM 'live' THEN
        RAISE EXCEPTION
            'DELEGATION_NOT_GRANTED:%:% — principal % holds no live grant to '
            'create work in ''%'' (grant state: %). A delegation is authorized '
            'BEFORE it exists; authority is a row in cell.delegation_grant, and '
            'the check runs in the same transaction as the work it authorizes.',
            NEW.from_principal, NEW.to_department, NEW.from_principal,
            NEW.to_department, coalesce(v_grant_state, '<no grant>')
            USING ERRCODE = 'FC020';
    END IF;

    RETURN NEW;
END;
$grant_guard$;

CREATE OR REPLACE TRIGGER task_delegation_requires_a_live_grant
    BEFORE INSERT OR UPDATE ON cell.task_delegation
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_delegation_grant();

-- --------------------------------------------------- the enqueue transaction
--
-- Offer-based delegation (contract §2.3): the delegator CREATEs the work in the
-- target scope and the target principal CLAIMs it. This verb therefore leaves
-- `to_principal` and `assignment_deadline` NULL — direct assignment is its own
-- verb (006), because an enqueue that quietly assigned would widen authority
-- without anyone asking for it (L11).
--
-- Every argument is required and none has a default, for the reason stated in
-- 002_claim.sql: a default here would be a policy decision made in the
-- substrate, invisible at the call site and unreachable by the one config
-- object that is supposed to hold every such decision.
CREATE OR REPLACE FUNCTION cell.enqueue_delegated_work(
    p_org_id            text,
    p_task_id           text,
    p_target_department text,
    p_from_principal    text,
    p_origin            text,
    p_objective         text,
    p_verification_plan jsonb,
    p_verify_by         timestamptz,
    p_claim_mode        text,
    p_contract_ref      text,
    p_created_at        timestamptz,
    p_audit_event_id    uuid
)
RETURNS text
LANGUAGE plpgsql
AS $enqueue$
BEGIN
    -- 1. the work itself, in the TARGET scope. Unassigned: this is the offer.
    INSERT INTO cell.task (
        org_id, task_id, department, origin, objective, verification_plan,
        verify_by, claim_mode, to_principal, assignment_deadline, created_at
    ) VALUES (
        p_org_id, p_task_id, p_target_department, p_origin, p_objective,
        p_verification_plan, p_verify_by, p_claim_mode, NULL, NULL, p_created_at
    );

    -- 2. the delegation record — and with it, IN THIS SAME TRANSACTION, the
    --    grant check (the trigger above). A refusal here takes the task with
    --    it: PRD §13.4's same-transaction clause is not a sequencing
    --    preference, it is what stops unauthorized work existing for the width
    --    of a round trip.
    INSERT INTO cell.task_delegation (
        org_id, task_id, from_principal, to_department, contract_ref, created_at
    ) VALUES (
        p_org_id, p_task_id, p_from_principal, p_target_department,
        p_contract_ref, p_created_at
    );

    -- 3. the audit event, filed under the TARGET department.
    INSERT INTO cell.audit_event (
        audit_event_id, org_id, department, kind, task_id, actor_principal,
        ts, producer
    ) VALUES (
        p_audit_event_id, p_org_id, p_target_department, 'task_created',
        p_task_id, p_from_principal, p_created_at, 'cell.enqueue_delegated_work'
    );

    RETURN p_task_id;
END;
$enqueue$;

COMMENT ON FUNCTION cell.enqueue_delegated_work IS
    'Offer-based delegation (contract §2.3): creates work in the target scope, '
    'records the delegation — whose trigger checks the grant in this same '
    'transaction — and files the audit event under the TARGET department. '
    'Leaves the task unassigned; direct assignment is cell.assign_task.';
