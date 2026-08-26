-- 005_escalation.sql — the escalation lane: the typed act that replaces the
-- abolished modal block.
--
-- Contract: FOUNDER RULING R6 — "Modal/input-blocking is abolished in the
-- headless cell. Needing input is a typed act: the `escalate` tool — a typed
-- escalation event addressed to the agent's ASSIGNER (`dispatched_by` / parent
-- chain), cascading to the CEO principal, who ALONE decides human contact...
-- The escalation channel is exempt from every gate (the deep-research-launch-
-- guard self-deadlock lesson)." Also contract §2.3 / R5: deadline lapse with
-- neither claim nor decline escalates to the assigner. Requires 001_core.sql
-- and 004_delegation.sql.
--
-- Re-apply: idempotent (CREATE ... IF NOT EXISTS / OR REPLACE).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- WHY THIS LANE IS DELIBERATELY UNGUARDED
--
-- Every other verb in this substrate refuses something. This one refuses only
-- what it cannot RESOLVE — an unknown principal, a cycle, a chain with nobody
-- above it. It performs no grant check, reads no claim state, and consults no
-- tombstone, because the measured lesson is a guard that blocked the request
-- for help and thereby turned one stuck agent into a system that could not say
-- it was stuck. A gate on this lane is a self-deadlock by construction.
--
-- WHY AN ESCALATION IS NEVER SETTLEMENT-BEARING
--
-- "I need input" is a fact about an agent, never a fact about whether work is
-- done. If any settlement writer consumed these rows, escalation would become a
-- second authority over the work lifecycle (L1). Nothing here writes a
-- settlement fact, nothing keys a row to an escalation, and no trigger turns an
-- escalation into a consequence — asserted against the live catalog by
-- tests/test_escalation.py rather than promised in this comment.
--
-- Declared failure vocabulary added by this file (SQLSTATE class FC; this lane
-- reserves FC020-FC039):
--   FC021 UNKNOWN_TASK                   an escalation ABOUT work that does not
--                                        exist (re-raised; owned by 004)
--   FC024 ESCALATION_UNKNOWN_PRINCIPAL   a seat the org chart does not have
--   FC025 ESCALATION_CHAIN_CYCLE         a chain that returns to a seat it visited
--   FC026 ESCALATION_CHAIN_UNTERMINATED  a chain with no seat above it

-- ---------------------------------------------------------------------------
-- escalation — the typed event
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.escalation (
    escalation_id  uuid        NOT NULL,
    org_id         text        NOT NULL,
    from_principal text        NOT NULL,

    -- The RESOLVED first seat on the chain. Stored rather than recomputed on
    -- read: the org chart changes, and an escalation must still say who it was
    -- addressed to at the moment it was raised (L12 — durable judgment does not
    -- decay).
    to_principal   text        NOT NULL,

    -- HOW that seat was resolved: the dispatcher who handed out the work, or
    -- the organizational parent when nobody did. Kept instead of storing
    -- `dispatched_by` so the column is NOT NULL and still says which rule ran.
    chain_basis    text        NOT NULL,

    reason         text        NOT NULL,
    task_id        text        NOT NULL,

    -- NULL EXACTLY for a lapsed assignment. Every other reason arises INSIDE an
    -- interval of responsibility, so the claim is the anchor an operator needs
    -- to find the work; a lapse is the one escalation raised precisely because
    -- nobody took responsibility at all. The CHECK below is what keeps that the
    -- only lawful absence.
    work_claim_id  uuid,

    created_at     timestamptz NOT NULL,

    CONSTRAINT escalation_pkey PRIMARY KEY (escalation_id),

    CONSTRAINT escalation_from_principal_fkey
        FOREIGN KEY (org_id, from_principal)
        REFERENCES cell.principal (org_id, principal_id),

    CONSTRAINT escalation_to_principal_fkey
        FOREIGN KEY (org_id, to_principal)
        REFERENCES cell.principal (org_id, principal_id),

    CONSTRAINT escalation_task_fkey
        FOREIGN KEY (org_id, task_id) REFERENCES cell.task (org_id, task_id),

    CONSTRAINT escalation_work_claim_fkey
        FOREIGN KEY (org_id, work_claim_id)
        REFERENCES cell.work_claim (org_id, work_claim_id),

    CONSTRAINT escalation_reason_is_a_declared_meaning
        CHECK (reason IN ('input_needed', 'assignment_deadline_lapsed',
                          'max_attempts_exhausted', 'external_wait_unresolved')),

    CONSTRAINT escalation_chain_basis_is_a_declared_rule
        CHECK (chain_basis IN ('dispatcher', 'organizational_parent')),

    CONSTRAINT escalation_without_a_claim_is_the_lapse_case
        CHECK (work_claim_id IS NOT NULL OR reason = 'assignment_deadline_lapsed'),

    -- An escalation addressed to its own author is a request for help that
    -- arrives nowhere, and is indistinguishable from one that was handled.
    CONSTRAINT escalation_never_addresses_its_own_author
        CHECK (to_principal <> from_principal)
);

CREATE INDEX IF NOT EXISTS escalation_by_addressee
    ON cell.escalation (org_id, to_principal, created_at);

COMMENT ON TABLE cell.escalation IS
    'FOUNDER RULING R6. The typed act that replaces input-blocking. Addressed '
    'to the assigner chain, cascading to the CEO principal who alone decides '
    'human contact. NEVER settlement-bearing: no settlement writer consumes '
    'these rows, and nothing keys a row to one.';

-- ------------------------------------------------------- the chain resolution
--
-- `dispatched_by` first when there is one — a cross-scope delegation's assigner
-- is NOT the assignee's organizational parent, and a chain walked from the
-- parent alone would route the request for help past the one seat that knows
-- why the work exists. Then the organizational parent chain, to the CEO.
--
-- The cycle guard is an exact one (the set of seats already visited), not a
-- depth cap: a depth cap is a number somebody has to justify, and it answers
-- "how long may a chain be" when the question is "did this chain come back".
CREATE OR REPLACE FUNCTION cell.escalation_chain(
    p_org_id         text,
    p_from_principal text,
    p_dispatched_by  text
)
RETURNS TABLE (
    chain_depth     int,
    chain_principal text,
    chain_role      text,
    chain_basis     text
)
LANGUAGE plpgsql
AS $chain$
DECLARE
    v_cursor  text;
    v_role    text;
    v_assigner text;
    v_depth   int    := 0;
    v_basis   text;
    v_seen    text[] := ARRAY[]::text[];
BEGIN
    -- The escalating principal must exist even when a dispatcher is named: an
    -- escalation from a seat the org does not have is a record nobody can act
    -- on, and it would still write a row.
    PERFORM 1 FROM cell.principal p
     WHERE p.org_id = p_org_id AND p.principal_id = p_from_principal;
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'ESCALATION_UNKNOWN_PRINCIPAL:%/% — the escalating seat is not in '
            'this org''s chart, so no chain can be walked from it.',
            p_org_id, p_from_principal
            USING ERRCODE = 'FC024';
    END IF;

    IF p_dispatched_by IS NOT NULL THEN
        v_cursor := p_dispatched_by;
        v_basis  := 'dispatcher';
    ELSE
        SELECT p.assigner_principal_id INTO v_cursor
          FROM cell.principal p
         WHERE p.org_id = p_org_id AND p.principal_id = p_from_principal;
        v_basis := 'organizational_parent';

        IF v_cursor IS NULL THEN
            RAISE EXCEPTION
                'ESCALATION_CHAIN_UNTERMINATED:%/% — this seat has nobody above '
                'it and no dispatcher was named. The cascade ends AT the CEO '
                'principal, who alone decides human contact; there is no seat to '
                'address above them. Returning an empty chain would read as '
                '''escalated to nobody, fine''.',
                p_org_id, p_from_principal
                USING ERRCODE = 'FC026';
        END IF;
    END IF;

    LOOP
        IF v_cursor = ANY (v_seen) THEN
            RAISE EXCEPTION
                'ESCALATION_CHAIN_CYCLE:%/%:% — the chain returns to a seat it '
                'already visited (%). A walk that cannot tell a cycle from '
                'progress is an escalation that never arrives and never fails '
                'either.',
                p_org_id, p_from_principal, v_cursor, array_to_string(v_seen, ' -> ')
                USING ERRCODE = 'FC025';
        END IF;
        v_seen := v_seen || v_cursor;

        SELECT p.role, p.assigner_principal_id INTO v_role, v_assigner
          FROM cell.principal p
         WHERE p.org_id = p_org_id AND p.principal_id = v_cursor;

        IF NOT FOUND THEN
            RAISE EXCEPTION
                'ESCALATION_UNKNOWN_PRINCIPAL:%/% — the chain names a seat this '
                'org does not have, so the request for help has no addressee.',
                p_org_id, v_cursor
                USING ERRCODE = 'FC024';
        END IF;

        v_depth         := v_depth + 1;
        chain_depth     := v_depth;
        chain_principal := v_cursor;
        chain_role      := v_role;
        chain_basis     := CASE WHEN v_depth = 1 THEN v_basis
                                ELSE 'organizational_parent' END;
        RETURN NEXT;

        EXIT WHEN v_role = 'ceo';

        v_cursor := v_assigner;
        IF v_cursor IS NULL THEN
            -- Unreachable while principal_only_the_ceo_answers_to_nobody holds;
            -- kept loud rather than assumed, because the day that CHECK is
            -- relaxed this is the leg that tells us instead of a chain that
            -- silently stops one seat short.
            RAISE EXCEPTION
                'ESCALATION_CHAIN_UNTERMINATED:%/% — the chain ran out below the '
                'CEO principal.',
                p_org_id, p_from_principal
                USING ERRCODE = 'FC026';
        END IF;
    END LOOP;

    RETURN;
END;
$chain$;

COMMENT ON FUNCTION cell.escalation_chain IS
    'assigner -> parent chain -> CEO principal (FOUNDER RULING R6). Refuses an '
    'unknown seat, a cycle, and a chain with nobody above it; never returns an '
    'empty chain, which a caller would read as ''escalated to nobody''.';

-- ------------------------------------------------------------- the escalate verb
--
-- Every argument required, none defaulted — `dispatched_by` and `work_claim_id`
-- are genuinely absent in real cases and the caller says which case it is.
-- No grant check, no claim-state check, no tombstone check: see the header.
CREATE OR REPLACE FUNCTION cell.escalate(
    p_org_id         text,
    p_escalation_id  uuid,
    p_from_principal text,
    p_dispatched_by  text,
    p_reason         text,
    p_task_id        text,
    p_work_claim_id  uuid,
    p_created_at     timestamptz,
    p_audit_event_id uuid
)
RETURNS text
LANGUAGE plpgsql
AS $escalate$
DECLARE
    v_to_principal    text;
    v_basis           text;
    v_task_department text;
BEGIN
    SELECT c.chain_principal, c.chain_basis INTO v_to_principal, v_basis
      FROM cell.escalation_chain(p_org_id, p_from_principal, p_dispatched_by) c
     WHERE c.chain_depth = 1;

    SELECT t.department INTO v_task_department
      FROM cell.task t
     WHERE t.org_id = p_org_id AND t.task_id = p_task_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'UNKNOWN_TASK:%/% — an escalation is raised ABOUT work, and no work '
            'by that identity exists in this org.',
            p_org_id, p_task_id
            USING ERRCODE = 'FC021';
    END IF;

    INSERT INTO cell.escalation (
        escalation_id, org_id, from_principal, to_principal, chain_basis,
        reason, task_id, work_claim_id, created_at
    ) VALUES (
        p_escalation_id, p_org_id, p_from_principal, v_to_principal, v_basis,
        p_reason, p_task_id, p_work_claim_id, p_created_at
    );

    -- Audited under the department of the WORK, by the same generated-topic
    -- rule as every other event in this lane (004_delegation.sql).
    INSERT INTO cell.audit_event (
        audit_event_id, org_id, department, kind, task_id, actor_principal,
        ts, producer
    ) VALUES (
        p_audit_event_id, p_org_id, v_task_department, 'escalated', p_task_id,
        p_from_principal, p_created_at, 'cell.escalate'
    );

    RETURN v_to_principal;
END;
$escalate$;

COMMENT ON FUNCTION cell.escalate IS
    'FOUNDER RULING R6: needing input is a typed act, not a modal block. '
    'Addresses the first seat on the assigner chain and records the event. '
    'EXEMPT FROM EVERY GATE by design — a guard on this verb is a self-deadlock, '
    'and this verb writes no settlement fact.';
