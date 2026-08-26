-- 007_assignment.sql — direct assignment: claim-or-refuse, the decline
-- tombstone, and the deadline lapse that escalates to the assigner.
--
-- Contract: docs/a1-cell-work-spine-contract.md §2.3 as amended, FOUNDER RULING
-- R5 — "Direct assignment is built now rather than deferred: `to_principal` is a
-- real routing field; a claim-or-refuse contract with an explicit deadline; a
-- typed `task_declined` event — the bar whitelist comes from the never-defer
-- rules, extended with `not-my-capability` and `wrong-principal`; declines
-- TOMBSTONE, closing the measured re-dispatch-forever defect; deadline lapse
-- with neither claim nor decline → escalation to the assigner."
-- Requires 001_core.sql, 004_delegation.sql and 005_escalation.sql.
--
-- Re-apply: idempotent (CREATE ... IF NOT EXISTS / OR REPLACE, ON CONFLICT seed).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- THE DEFECT THE TOMBSTONE CLOSES, stated precisely because it decides the
-- shape of the rule: declined work kept being re-dispatched, so the same
-- refusal was collected forever and nobody was ever told. A tombstone is
-- therefore a REFUSAL of any subsequent assignment — not merely the absence of
-- one — and it holds for a re-offer to a DIFFERENT principal too, because
-- re-dispatch-forever never required the same addressee.
--
-- WHY ASSIGNING NEEDS THE SAME GRANT AS CREATING
--
-- Routing existing work into a department decides who that department answers
-- for; treating it as a lesser act would leave an ambient authority the grants
-- table exists to remove. So the assignment record meets the SAME
-- cell.enforce_delegation_grant question — may this principal put work in this
-- department — through its own substrate trigger. A deployment seats each
-- lead's own department grant explicitly; nothing is implied by membership.
--
-- WHY THE LAPSE IS A QUERY AND NOT A DAEMON
--
-- "Deadline lapse with neither claim nor decline" is a CONDITION over rows, so
-- it is a function over rows, evaluated at an instant the caller supplies. A
-- condition that reads the wall clock cannot be asserted by a falsifier, and an
-- operator asking "what had lapsed at 14:30" is asking something the substrate
-- should be able to answer. The escalation it yields is a separate, explicit
-- verb that RE-CHECKS the condition, because an escalation minted from a
-- condition that no longer holds is a page nobody can act on.
--
-- Declared failure vocabulary added by this file (SQLSTATE class FC; this lane
-- reserves FC020-FC039):
--   FC020 DELEGATION_NOT_GRANTED        work put in a scope not granted
--                                       (re-raised; owned by 004)
--   FC021 UNKNOWN_TASK                  an assignment routing work that does not
--                                       exist (re-raised; owned by 004)
--   FC027 ASSIGNMENT_TOMBSTONED         a re-offer of work that was declined
--   FC028 DECLINE_BAR_NOT_WHITELISTED   a bar outside the ruled vocabulary
--   FC029 DECLINE_BY_NON_ASSIGNEE       a decline by someone it was not offered to
--   FC030 TASK_ALREADY_DECLINED         a second decline of the same work
--   FC031 ASSIGNMENT_NOT_LAPSED         escalating a lapse that has not happened

-- ---------------------------------------------------------------------------
-- task_decline_bar — the whitelist R5 names
--
-- A table AND a CHECK, deliberately. The table is the readable registry a lead
-- can query to see which refusals are answerable; the CHECK is the governance —
-- without it, "which refusals are answerable" would be widenable by anyone who
-- could write a row, and the whitelist would stop being a ruling. Widening it
-- takes a migration, which is what a ruling looks like in a substrate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.task_decline_bar (
    bar    text NOT NULL,
    source text NOT NULL,

    CONSTRAINT task_decline_bar_pkey PRIMARY KEY (bar),

    CONSTRAINT task_decline_bar_source_is_declared
        CHECK (source IN ('never_defer_rules', 'r5_extension')),

    CONSTRAINT task_decline_bar_is_a_ruled_bar
        CHECK (bar IN ('operator-decision-needed', 'dependency-unmet',
                       'lead-busy-on-claim', 'not-my-capability',
                       'wrong-principal'))
);

INSERT INTO cell.task_decline_bar (bar, source) VALUES
    ('operator-decision-needed', 'never_defer_rules'),
    ('dependency-unmet',         'never_defer_rules'),
    ('lead-busy-on-claim',       'never_defer_rules'),
    ('not-my-capability',        'r5_extension'),
    ('wrong-principal',          'r5_extension')
ON CONFLICT (bar) DO UPDATE SET source = EXCLUDED.source;

COMMENT ON TABLE cell.task_decline_bar IS
    'FOUNDER RULING R5: the bar whitelist comes from the never-defer rules, '
    'extended with not-my-capability and wrong-principal. An invented bar is a '
    'refusal nobody can act on — "because" is not an answerable reason.';

-- ---------------------------------------------------------------------------
-- task_declined — the typed decline event, and the tombstone itself
--
-- One row per task, by the unique constraint: the tombstone IS this row, so
-- "has this work been declined" is a question with one answer and no state
-- column anywhere that could disagree with it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.task_declined (
    decline_id  uuid        NOT NULL,
    org_id      text        NOT NULL,
    task_id     text        NOT NULL,
    declined_by text        NOT NULL,
    bar         text        NOT NULL,

    -- The bar says WHICH answerable reason; the basis says why it applies here.
    -- NOT NULL: a decline whose basis is absent is a refusal the assigner can
    -- only re-litigate by asking, which is the conversation the typed event
    -- exists to replace.
    basis       text        NOT NULL,
    declined_at timestamptz NOT NULL,

    CONSTRAINT task_declined_pkey PRIMARY KEY (decline_id),

    -- The tombstone. One decline per task, forever.
    CONSTRAINT task_declined_one_per_task UNIQUE (org_id, task_id),

    CONSTRAINT task_declined_task_fkey
        FOREIGN KEY (org_id, task_id) REFERENCES cell.task (org_id, task_id),

    CONSTRAINT task_declined_principal_fkey
        FOREIGN KEY (org_id, declined_by)
        REFERENCES cell.principal (org_id, principal_id),

    CONSTRAINT task_declined_bar_fkey
        FOREIGN KEY (bar) REFERENCES cell.task_decline_bar (bar)
);

-- ---------------------------------------------------------------------------
-- task_assignment — the durable assignment record
--
-- `cell.task.to_principal` is the routing PROJECTION the claim path and the
-- board read; this is the history. Multi-principal-ready (R5): the same work
-- may be assigned to different principals over time, and each attempt is a row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.task_assignment (
    assignment_id uuid        NOT NULL,
    org_id        text        NOT NULL,
    task_id       text        NOT NULL,

    -- the assigner — `dispatched_by` in escalation terms, and the seat a lapse
    -- escalates back to
    assigned_by   text        NOT NULL,
    to_principal  text        NOT NULL,

    -- The explicit claim-or-refuse deadline. NOT NULL is the whole contract: an
    -- assignment with no deadline is an offer with no lapse condition, which is
    -- the re-dispatch-forever defect in its other form.
    deadline      timestamptz NOT NULL,
    assigned_at   timestamptz NOT NULL,

    CONSTRAINT task_assignment_pkey PRIMARY KEY (assignment_id),

    CONSTRAINT task_assignment_one_per_task_and_assignee
        UNIQUE (org_id, task_id, to_principal),

    CONSTRAINT task_assignment_task_fkey
        FOREIGN KEY (org_id, task_id) REFERENCES cell.task (org_id, task_id),

    CONSTRAINT task_assignment_assigner_fkey
        FOREIGN KEY (org_id, assigned_by)
        REFERENCES cell.principal (org_id, principal_id),

    CONSTRAINT task_assignment_assignee_fkey
        FOREIGN KEY (org_id, to_principal)
        REFERENCES cell.principal (org_id, principal_id)
);

CREATE INDEX IF NOT EXISTS task_assignment_by_deadline
    ON cell.task_assignment (org_id, deadline);

-- ------------------------------------------------- the assignment guard
--
-- A trigger, not a clause inside the verb: a rule enforced only by the verb is
-- a rule bypassed by direct insert (the measured 0073 lesson). It asks the two
-- questions an assignment has to pass — may this seat put work in this
-- department, and is this work still offerable at all.
CREATE OR REPLACE FUNCTION cell.enforce_assignment_is_offerable()
RETURNS trigger
LANGUAGE plpgsql
AS $assignable$
DECLARE
    v_task_department text;
    v_grant_state     text;
    v_declined_by     text;
    v_bar             text;
BEGIN
    SELECT t.department INTO v_task_department
      FROM cell.task t
     WHERE t.org_id = NEW.org_id AND t.task_id = NEW.task_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'UNKNOWN_TASK:%/% — an assignment routes work, and no work by that '
            'identity exists in this org.',
            NEW.org_id, NEW.task_id
            USING ERRCODE = 'FC021';
    END IF;

    -- The tombstone is checked BEFORE authority: a granted seat re-offering
    -- declined work is exactly the measured defect, and reporting it as an
    -- authority problem would send an operator looking for the wrong fix.
    SELECT d.declined_by, d.bar INTO v_declined_by, v_bar
      FROM cell.task_declined d
     WHERE d.org_id = NEW.org_id AND d.task_id = NEW.task_id;

    IF FOUND THEN
        RAISE EXCEPTION
            'ASSIGNMENT_TOMBSTONED:%/%:% — % already declined this work with the '
            'bar ''%''. A decline tombstones the task: there are no re-offers, to '
            'this principal or any other. Re-dispatching declined work collects '
            'the same refusal forever and tells nobody; the escalation lane is '
            'how a decline gets answered.',
            NEW.org_id, NEW.task_id, NEW.to_principal, v_declined_by, v_bar
            USING ERRCODE = 'FC027';
    END IF;

    SELECT g.state INTO v_grant_state
      FROM cell.delegation_grant g
     WHERE g.org_id = NEW.org_id
       AND g.from_principal = NEW.assigned_by
       AND g.to_department = v_task_department;

    IF NOT FOUND OR v_grant_state IS DISTINCT FROM 'live' THEN
        RAISE EXCEPTION
            'DELEGATION_NOT_GRANTED:%:% — principal % holds no live grant to put '
            'work in ''%'' (grant state: %). Routing work into a department '
            'decides who answers for it, so it is the same authority question as '
            'creating work there, checked against the same grants table.',
            NEW.assigned_by, v_task_department, NEW.assigned_by,
            v_task_department, coalesce(v_grant_state, '<no grant>')
            USING ERRCODE = 'FC020';
    END IF;

    RETURN NEW;
END;
$assignable$;

CREATE OR REPLACE TRIGGER task_assignment_is_granted_and_untombstoned
    BEFORE INSERT OR UPDATE ON cell.task_assignment
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_assignment_is_offerable();

-- ------------------------------------------------------------ the assign verb
CREATE OR REPLACE FUNCTION cell.assign_task(
    p_org_id         text,
    p_task_id        text,
    p_assignment_id  uuid,
    p_assigned_by    text,
    p_to_principal   text,
    p_deadline       timestamptz,
    p_assigned_at    timestamptz,
    p_audit_event_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
AS $assign$
DECLARE
    v_task_department text;
BEGIN
    -- Lock the task's row: the routing field and the assignment record must not
    -- be decided by two assigners interleaving.
    SELECT t.department INTO v_task_department
      FROM cell.task t
     WHERE t.org_id = p_org_id AND t.task_id = p_task_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'UNKNOWN_TASK:%/% — there is no work by that identity in this org to '
            'route.',
            p_org_id, p_task_id
            USING ERRCODE = 'FC021';
    END IF;

    -- The record first, so the trigger's refusals (tombstone, grant) take the
    -- routing update with them. The check and the write are one transaction.
    INSERT INTO cell.task_assignment (
        assignment_id, org_id, task_id, assigned_by, to_principal, deadline,
        assigned_at
    ) VALUES (
        p_assignment_id, p_org_id, p_task_id, p_assigned_by, p_to_principal,
        p_deadline, p_assigned_at
    );

    -- to_principal is a real routing field (R5), and 001_core's pairing
    -- constraint means it is never written without its deadline.
    UPDATE cell.task
       SET to_principal = p_to_principal,
           assignment_deadline = p_deadline
     WHERE org_id = p_org_id AND task_id = p_task_id;

    INSERT INTO cell.audit_event (
        audit_event_id, org_id, department, kind, task_id, actor_principal,
        ts, producer
    ) VALUES (
        p_audit_event_id, p_org_id, v_task_department, 'task_assigned', p_task_id,
        p_assigned_by, p_assigned_at, 'cell.assign_task'
    );

    RETURN p_assignment_id;
END;
$assign$;

-- ----------------------------------------------------------- the decline verb
CREATE OR REPLACE FUNCTION cell.decline_task(
    p_org_id         text,
    p_task_id        text,
    p_decline_id     uuid,
    p_declined_by    text,
    p_bar            text,
    p_basis          text,
    p_declined_at    timestamptz,
    p_audit_event_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
AS $decline$
DECLARE
    v_task_department text;
    v_assigned        boolean;
    v_already         text;
BEGIN
    SELECT t.department INTO v_task_department
      FROM cell.task t
     WHERE t.org_id = p_org_id AND t.task_id = p_task_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'UNKNOWN_TASK:%/% — there is no work by that identity in this org to '
            'decline.',
            p_org_id, p_task_id
            USING ERRCODE = 'FC021';
    END IF;

    -- The bar, before anything is written. The FK to the whitelist would refuse
    -- this too, but with an untyped constraint violation; the caller needs to
    -- key on the RULE, and an operator reading the log needs to see which
    -- vocabulary was missed.
    PERFORM 1 FROM cell.task_decline_bar b WHERE b.bar = p_bar;
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'DECLINE_BAR_NOT_WHITELISTED:% — a decline cites one of the ruled '
            'bars (see cell.task_decline_bar). An invented bar is a refusal '
            'nobody can act on, which is how work stops moving without anyone '
            'being able to say why.',
            coalesce(p_bar, '<null>')
            USING ERRCODE = 'FC028';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM cell.task_assignment a
         WHERE a.org_id = p_org_id AND a.task_id = p_task_id
           AND a.to_principal = p_declined_by
    ) INTO v_assigned;

    IF NOT v_assigned THEN
        RAISE EXCEPTION
            'DECLINE_BY_NON_ASSIGNEE:%/%:% — this work was never offered to that '
            'principal. `wrong-principal` is a bar the ASSIGNEE may cite, not a '
            'licence for a third party to decline on their behalf: a decline by '
            'anyone else tombstones work its assignee never saw.',
            p_org_id, p_task_id, p_declined_by
            USING ERRCODE = 'FC029';
    END IF;

    SELECT d.declined_by INTO v_already
      FROM cell.task_declined d
     WHERE d.org_id = p_org_id AND d.task_id = p_task_id;

    IF FOUND THEN
        RAISE EXCEPTION
            'TASK_ALREADY_DECLINED:%/%:% — this work already carries a decline '
            '(by %). The tombstone is one row and one answer; a second decline '
            'would be a second answer to a question that is already settled.',
            p_org_id, p_task_id, p_declined_by, v_already
            USING ERRCODE = 'FC030';
    END IF;

    INSERT INTO cell.task_declined (
        decline_id, org_id, task_id, declined_by, bar, basis, declined_at
    ) VALUES (
        p_decline_id, p_org_id, p_task_id, p_declined_by, p_bar, p_basis,
        p_declined_at
    );

    INSERT INTO cell.audit_event (
        audit_event_id, org_id, department, kind, task_id, actor_principal,
        ts, producer
    ) VALUES (
        p_audit_event_id, p_org_id, v_task_department, 'task_declined', p_task_id,
        p_declined_by, p_declined_at, 'cell.decline_task'
    );

    RETURN p_decline_id;
END;
$decline$;

COMMENT ON FUNCTION cell.decline_task IS
    'FOUNDER RULING R5. The second branch of claim-or-refuse. Writes the typed '
    'decline event, which IS the tombstone: no re-offer of this work is possible '
    'afterwards, to this principal or any other.';

-- ------------------------------------------------------- the lapse condition
--
-- "Deadline lapse with NEITHER claim NOR decline" — both branches of the
-- claim-or-refuse contract close the condition, and both are stated here, so a
-- query that only knew about claims could not answer this question.
--
-- The instant is an argument, never now(): a condition that reads the wall clock
-- cannot be asserted by a falsifier.
CREATE OR REPLACE FUNCTION cell.assignments_lapsed(
    p_org_id text,
    p_as_of  timestamptz
)
RETURNS TABLE (
    lapsed_task_id  text,
    lapsed_assignee text,
    lapsed_assigner text,
    lapsed_deadline timestamptz
)
LANGUAGE sql
STABLE
AS $lapsed$
    SELECT a.task_id, a.to_principal, a.assigned_by, a.deadline
      FROM cell.task_assignment a
     WHERE a.org_id = p_org_id
       AND a.deadline < p_as_of
       AND NOT EXISTS (
           SELECT 1 FROM cell.work_claim w
            WHERE w.org_id = a.org_id AND w.task_id = a.task_id
              AND w.principal_id = a.to_principal
              -- C4 (R-A35-24 §2, 2026-08-25): a LIVE claim, not any claim ever.
              -- A claim row is durable (L12), so without this clause an assignee
              -- who claimed and then handed the work back suppressed the lapse
              -- condition FOREVER: the assigner was told nothing, and
              -- cell.escalate_lapsed_assignment — which re-checks through this
              -- same function — raised FC031 ASSIGNMENT_NOT_LAPSED instead of a
              -- page. Written as the NAMED state and not
              -- `w.ownership_ended_at IS NULL` (its biconditional twin,
              -- 001_core.sql:183-184) so a seventh claim state is a visible edit
              -- here rather than a silent reclassification — the argument
              -- delegation.mjs:154-158 makes for CHILD_CLAIM_TERMINALS.
              AND w.state = 'active')
       AND NOT EXISTS (
           SELECT 1 FROM cell.task_declined d
            WHERE d.org_id = a.org_id AND d.task_id = a.task_id)
$lapsed$;

COMMENT ON FUNCTION cell.assignments_lapsed IS
    'FOUNDER RULING R5: deadline lapse with neither claim nor decline, as a '
    'queryable condition evaluated at an explicit instant.';

-- ------------------------------------------- the lapse escalation
--
-- A separate, explicit verb that RE-CHECKS the condition. Trusting a caller's
-- claim that something lapsed would mint pages for conditions that no longer
-- hold — and a page nobody can act on is how an escalation lane goes unread.
CREATE OR REPLACE FUNCTION cell.escalate_lapsed_assignment(
    p_org_id         text,
    p_task_id        text,
    p_escalation_id  uuid,
    p_as_of          timestamptz,
    p_created_at     timestamptz,
    p_audit_event_id uuid
)
RETURNS text
LANGUAGE plpgsql
AS $lapse_escalation$
DECLARE
    v_assignee     text;
    v_assigner     text;
    v_dispatched_by text;
BEGIN
    SELECT l.lapsed_assignee, l.lapsed_assigner INTO v_assignee, v_assigner
      FROM cell.assignments_lapsed(p_org_id, p_as_of) l
     WHERE l.lapsed_task_id = p_task_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'ASSIGNMENT_NOT_LAPSED:%/%:% — at that instant this work carried no '
            'assignment that had lapsed: it was claimed, declined, or its '
            'deadline had not passed. An escalation minted from a condition that '
            'does not hold is a page nobody can act on.',
            p_org_id, p_task_id, p_as_of
            USING ERRCODE = 'FC031';
    END IF;

    -- The escalation goes to the ASSIGNER (R5) — dispatched_by, not a walk up
    -- the assignee's organizational parents, which for a cross-department
    -- assignment is a different seat entirely. The one exception is a seat that
    -- assigned to itself: there is no dispatcher above it to answer, so the
    -- chain resolves through its organizational parent instead. Stated here
    -- rather than left to the chain, because cell.escalation refuses to address
    -- an escalation to its own author.
    v_dispatched_by := CASE WHEN v_assigner = v_assignee THEN NULL ELSE v_assigner END;

    RETURN cell.escalate(
        p_org_id, p_escalation_id, v_assignee, v_dispatched_by,
        'assignment_deadline_lapsed', p_task_id, NULL, p_created_at,
        p_audit_event_id);
END;
$lapse_escalation$;
