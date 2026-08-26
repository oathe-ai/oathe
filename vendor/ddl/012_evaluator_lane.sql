-- 012_evaluator_lane.sql — THE EVALUATOR SEAT: the three verbs that own
-- settlement facts, and the writer guards that make them the only way in.
--
-- Contract: docs/a1-cell-work-spine-contract.md §1.2 as amended (the executor
-- never owns settlement facts), §1.4 source 3 (the confirm consume is a
-- state_version-bound verification), §3.3 (FOUNDER RULING R4 — a task-type edge
-- releases on the upstream task's recorded verification, period), §4.3's signer
-- discipline generalised to the task lane, R8 (a rejection reopens the work).
-- Requires 001_core.sql, 002_claim.sql (cell.written_by), 003_verification.sql,
-- 006_dependency.sql, 011_confirm.sql.
--
-- Re-apply: idempotent (CREATE OR REPLACE throughout).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- WHY THIS FILE EXISTS, MEASURED
--
-- A2.4's gate-1 writer census failed against BOTH bake-off candidates, for the
-- same reason and independently: each had grown an EVALUATOR LANE inside itself
-- — an `evaluate.mjs` in one, an evaluator lane and a confirm lane in the other
-- — issuing `UPDATE cell.dep_edge SET state='satisfied'` and
-- `INSERT INTO cell.verification` from executor code. Finding
-- A2.4-F0-GATE-1-WRITER-CENSUS-FAILS states the consequence: a settlement fact
-- written by the thing that ran the work makes the executor a SECOND AUTHORITY
-- over settlement (L1). FOUNDER RULING R4 and the amended contract §1.2 rule the
-- other way — release is performed by the evaluator lane, never by the
-- completing author's runtime.
--
-- The finding's own flip condition named the shape of the fix: the lane moves
-- OUT of the candidates, deleted with its wiring in the same change (L5), and a
-- separate evaluator lane owns the release. This file is the substrate half of
-- that move, and it is deliberately more than a place to put the code:
--
-- **A seat that lives only in whoever happens to be writing is a seat with a
-- bypass.** 009_verified_edge.sql learned that at a cost — 23 historical
-- `verified` settles reached the bus by direct publish past a CLI-only gate,
-- every one of them naming the right evaluator in the row. So the task lane gets
-- the same treatment the `verified` lane already has: the guard reads the
-- PL/pgSQL CALL STACK (cell.written_by, 002_claim.sql) rather than a column or a
-- settable GUC, because a caller cannot put a frame on the stack that is not
-- there. A candidate that learns the table name still cannot release an edge.
--
-- WHAT IS NOT HERE, AND WHY
--
-- No policy. The release bar is `cell.v_dep_edge_release` and its
-- `dep_edge_release_meets_the_acceptance_bar` trigger, both untouched: this
-- file's verb meets that bar like every other writer, and a verb that could
-- waive the bar by being the sanctioned writer would be the bar moving into
-- whoever holds the seat. Six other dependency families each name a different
-- settler and none of them is reached from here.
--
-- Declared failure vocabulary added by this file (SQLSTATE class FC; this lane
-- reserves FC090-FC099):
--   FC090 TASK_EDGE_RELEASED_OUTSIDE_THE_EVALUATOR_LANE  a task-lane release
--                                          written by something that is not the
--                                          seat's verb
--   FC091 TASK_REOPENED_OUTSIDE_THE_EVALUATOR_LANE  the same, for R8's reopen
--   FC092 EVALUATOR_EDGE_IS_NOT_THE_TASK_LANES  the seat handed an edge belonging
--                                          to one of the six other families
--   FC093 EVALUATOR_EDGE_UNKNOWN           a release against an edge that is not
--                                          there
--   FC094 EVALUATOR_RELEASE_UNSIGNED       a release carrying no signer
--   FC095 EVALUATOR_TASK_UNKNOWN           a reopen against a task the company
--                                          has no record of
--   FC096 CONFIRM_VERDICT_NOT_ANSWERABLE   a transcription of an ask that is not
--                                          answered, not planned for, or has no
--                                          recorded statement to be about
--   FC097 CONFIRM_VERDICT_UNADDRESSABLE_TRACE  R4's mandatory trace_ref, blank

-- ---------------------------------------------------------------------------
-- cell.v_evaluator_confirm_ask — what one ask IS, read in one place
--
-- The lane's read surface for case 4. Four things are JOINED rather than
-- assumed, and each of them is a way a transcription could otherwise write a row
-- meaning something nobody checked:
--
--   * `cell.v_confirm_verdict` for the VERDICT — the view is the one place that
--     decides what a consumed-with-no-verdict token projects (MEASURED: 217 rows
--     of exactly that shape). A CASE anywhere else would be a second opinion.
--   * `cell.agent_statement` for the SUBJECT — §1.4 makes every verification a
--     verdict about a RECORDED statement, and the one taken is the task's LIVE
--     completion assertion (not superseded), which is the same predicate
--     v_task_completion counts by.
--   * `cell.work_claim` for the CLAIM — read OFF the statement rather than
--     joined on the task, so the claim in this row is the claim whose author
--     said the thing being judged, even where a task has been claimed more than
--     once in its life.
--   * `cell.task` for the CLAUSE — reported as a column rather than filtered
--     out, so "this claim has no ask" and "this ask discharges a clause the plan
--     never declared" stay different answers to a lane that has to log which one
--     it met.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW cell.v_evaluator_confirm_ask AS
SELECT
    v.token_id,
    v.org_id,
    v.task_id,
    v.ask_key,
    v.state,
    v.projects,
    v.consumed_by,
    v.consumed_at,
    v.state_version,
    s.statement_id,
    s.work_claim_id,
    (t.verification_plan -> 'clauses' @> to_jsonb('operator_approval'::text))
        AS clause_declared
FROM cell.v_confirm_verdict v
JOIN cell.task t
  ON t.org_id = v.org_id AND t.task_id = v.task_id
LEFT JOIN LATERAL (
    SELECT st.statement_id, st.work_claim_id
      FROM cell.agent_statement st
     WHERE st.org_id = v.org_id
       AND st.task_id = v.task_id
       AND st.statement_type = 'completion'
       AND NOT EXISTS (SELECT 1 FROM cell.agent_statement later
                        WHERE later.supersedes_ref = st.statement_id)
     ORDER BY st.asserted_at DESC, st.statement_id
     LIMIT 1
) s ON true;

COMMENT ON VIEW cell.v_evaluator_confirm_ask IS
    'The evaluator seat''s read surface for case 4: one row per canonical ask, '
    'carrying the projection, the live statement it would be a verdict about, '
    'the claim that authored it, and whether the plan declares the clause.';

-- ------------------------------------------- the task lane's writer guard (R4)
--
-- The `verified` family has had this clause since 009. The task family did not,
-- and that absence is exactly what let two executor candidates hold the
-- evaluator seat with a `UPDATE cell.dep_edge` of their own. Only a TRANSITION
-- into satisfied is checked: re-stating an already-settled edge is idempotent,
-- and re-checking it would make an unrelated correction on the row fail for a
-- reason that has nothing to do with it.
--
-- The trigger is named to sort AFTER `dep_edge_release_meets_the_acceptance_bar`
-- so a release that fails BOTH rules reports the bar it missed rather than the
-- seat it lacked: R4's substance is the older and more informative refusal.
CREATE OR REPLACE FUNCTION cell.enforce_task_edge_release_is_the_evaluator_lanes()
RETURNS trigger
LANGUAGE plpgsql
AS $task_lane_writer$
BEGIN
    IF NEW.dep_type <> 'task' OR NEW.state IS DISTINCT FROM 'satisfied' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.state = 'satisfied' THEN
        RETURN NEW;
    END IF;

    IF NOT cell.written_by('cell.settle_task_edge') THEN
        RAISE EXCEPTION
            'TASK_EDGE_RELEASED_OUTSIDE_THE_EVALUATOR_LANE:% — a task-lane '
            'dependency releases through cell.settle_task_edge and through '
            'nothing else. FOUNDER RULING R4 and contract §1.2: release is '
            'performed by the evaluator lane, never by the completing author''s '
            'runtime — an executor that wrote this row would be a second '
            'authority over settlement (L1). The writer signal is the PL/pgSQL '
            'call stack, which a direct writer cannot fabricate, rather than a '
            'column it could type or a setting it could set for itself: 23 '
            'historical `verified` settles reached the bus by direct publish '
            'naming exactly the right evaluator.',
            NEW.edge_id
            USING ERRCODE = 'FC090';
    END IF;

    RETURN NEW;
END;
$task_lane_writer$;

CREATE OR REPLACE TRIGGER dep_edge_task_release_is_the_evaluator_lanes
    BEFORE INSERT OR UPDATE ON cell.dep_edge
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_task_edge_release_is_the_evaluator_lanes();

-- ------------------------------------------------- the reopen's writer guard
--
-- R8's reopen is a settlement-adjacent fact: it says the work is NOT done and
-- the next claimant resumes on it. Two lanes needed it (a rejected gate and a
-- rejected operator answer) and both candidates had spelled it themselves, so it
-- gets one verb and the same guard. Only the TRANSITION into `reopened` is
-- guarded — a task's objective, its assignment and its plan are nobody's
-- settlement fact, and a guard over the whole row would make the assignment
-- lane's writes fail for a reason that has nothing to do with them.
CREATE OR REPLACE FUNCTION cell.enforce_task_reopen_is_the_evaluator_lanes()
RETURNS trigger
LANGUAGE plpgsql
AS $reopen_writer$
BEGIN
    IF NEW.origin IS DISTINCT FROM 'reopened' OR OLD.origin = 'reopened' THEN
        RETURN NEW;
    END IF;

    IF NOT cell.written_by('cell.reopen_rejected_task') THEN
        RAISE EXCEPTION
            'TASK_REOPENED_OUTSIDE_THE_EVALUATOR_LANE:%/% — reopening rejected '
            'work is the evaluator seat''s act (R8: the reopened task''s next '
            'claimant resumes on the same work), and it happens through '
            'cell.reopen_rejected_task. An executor that reopened its own work '
            'would be deciding that its verdict had not stood.',
            NEW.org_id, NEW.task_id
            USING ERRCODE = 'FC091';
    END IF;

    RETURN NEW;
END;
$reopen_writer$;

CREATE OR REPLACE TRIGGER task_reopen_is_the_evaluator_lanes
    BEFORE UPDATE ON cell.task
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_task_reopen_is_the_evaluator_lanes();

-- ----------------------------------------------------------------- the verbs
--
-- Every argument is required; no signature below carries a default and none may
-- grow one. A default signer, a default instant or a server-chosen trace ref
-- would each be a governance decision made in the substrate, invisible at the
-- call site and unreachable by the config object that holds every such decision.
--
-- Each verb ANSWERS WHETHER THIS CALL MOVED ANYTHING. That is not a convenience:
-- "released" and "already released" are different facts to a lane that has to
-- record what it did, and a wake that released nothing must be distinguishable
-- in evidence from a wake that never looked.

CREATE OR REPLACE FUNCTION cell.settle_task_edge(
    p_edge_id    uuid,
    p_settled_by text,
    p_settled_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
AS $settle_task$
DECLARE
    v_dep_type text;
    v_state    text;
    v_moved    integer;
BEGIN
    IF length(btrim(coalesce(p_settled_by, ''))) = 0 THEN
        RAISE EXCEPTION
            'EVALUATOR_RELEASE_UNSIGNED:% — a satisfied edge carries its signer, '
            'its kind and its stamp (dep_edge_satisfied_edge_carries_its_signer_'
            'kind_and_stamp). This seat READS the signer off the verdict that met '
            'the bar and never chooses one, so a blank signer here means the '
            'selector found an edge no verification stands behind. "Who released '
            'this, on what basis, when" is the question the Mac''s void events '
            'could not answer, which is why zero consumers ever read one.',
            p_edge_id
            USING ERRCODE = 'FC094';
    END IF;

    SELECT dep_type, state INTO v_dep_type, v_state
      FROM cell.dep_edge WHERE edge_id = p_edge_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'EVALUATOR_EDGE_UNKNOWN:% — there is no such edge, so nothing was '
            'released and there is no wait this call could be evidence of. An '
            'UPDATE that matched nothing fires no trigger at all, which is how a '
            'release path comes to report success for a row it never touched.',
            p_edge_id
            USING ERRCODE = 'FC093';
    END IF;

    IF v_dep_type <> 'task' THEN
        RAISE EXCEPTION
            'EVALUATOR_EDGE_IS_NOT_THE_TASK_LANES:%:% — cell.v_dep_edge_release '
            'names this family''s settler, and it is not `evaluator_lane`. Six '
            'other families each name a different seat — an acceptance seat, a '
            'registered checker, an operator''s consume, the reconciler''s '
            'mootness, an external-event evaluator — and a lane that released '
            'whatever edge it was handed would be silently holding five seats '
            'nobody gave it.',
            p_edge_id, v_dep_type
            USING ERRCODE = 'FC092';
    END IF;

    -- Idempotency is the PREDICATE, not a set this lane remembers: a restart
    -- takes a remembered set with it, which is the whole reason L2 puts durable
    -- state below the agent. C5-DUP-SATISFY measures it from the other side —
    -- the duplicate verdict is a second verification ROW (history is durable,
    -- L12) and the EDGE is what the predicate names.
    --
    -- Nothing is set to authorize this write: THIS frame, on the call stack, is
    -- what the guard above reads, and it stops existing when the function returns.
    UPDATE cell.dep_edge
       SET state       = 'satisfied',
           settled_by  = p_settled_by,
           settle_kind = 'evaluator_verdict',
           settled_at  = p_settled_at
     WHERE edge_id = p_edge_id
       AND state = 'declared';

    GET DIAGNOSTICS v_moved = ROW_COUNT;
    RETURN v_moved = 1;
END;
$settle_task$;

COMMENT ON FUNCTION cell.settle_task_edge IS
    'FOUNDER RULING R4 / contract §1.2: the one writer of a task-lane release. '
    'The acceptance bar is enforced by its own trigger, not here — a check that '
    'lives only in this function is a check a direct UPDATE skips.';


CREATE OR REPLACE FUNCTION cell.reopen_rejected_task(
    p_org_id  text,
    p_task_id text
)
RETURNS boolean
LANGUAGE plpgsql
AS $reopen$
DECLARE
    v_moved integer;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM cell.task
                    WHERE org_id = p_org_id AND task_id = p_task_id) THEN
        RAISE EXCEPTION
            'EVALUATOR_TASK_UNKNOWN:%/% — reopening is an act on work the company '
            'has a record of. A reopen that matched nothing would report success '
            'for a task nobody can later account for.',
            p_org_id, p_task_id
            USING ERRCODE = 'FC095';
    END IF;

    -- THE SAME TASK, never a fresh one (R8): the next claimant resumes on the
    -- same work, and minting a new task id would leave the rejected work with two
    -- records and the waiting edge gating the abandoned one.
    UPDATE cell.task
       SET origin = 'reopened'
     WHERE org_id = p_org_id
       AND task_id = p_task_id
       AND origin <> 'reopened';

    GET DIAGNOSTICS v_moved = ROW_COUNT;
    RETURN v_moved = 1;
END;
$reopen$;

COMMENT ON FUNCTION cell.reopen_rejected_task IS
    'FOUNDER RULING R8. One verb for both rejections — a gate''s and an '
    'operator''s — because they mean the same thing: this work is not done and '
    'the next claimant resumes on it.';


-- The TRANSCRIPTION, and the reason it is lawful for a lane to write a
-- verification at all: it invents nothing. The operator's name is in
-- `consumed_by`, the instant in `consumed_at`, the binding in `state_version`,
-- and what the answer MEANS is `cell.v_confirm_verdict.projects`. Every column
-- below is read off a row or is a constant this file declares; there is nowhere
-- in the statement to put a value the caller supplied except the identifier it
-- derived and the trace ref R4 makes mandatory.
CREATE OR REPLACE FUNCTION cell.record_confirm_verdict(
    p_token_id        uuid,
    p_verification_id uuid,
    p_trace_ref       text,
    p_recorded_at     timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
AS $transcribe$
DECLARE
    v_ask     cell.v_evaluator_confirm_ask%ROWTYPE;
    v_written integer;
BEGIN
    IF length(btrim(coalesce(p_trace_ref, ''))) = 0 THEN
        RAISE EXCEPTION
            'CONFIRM_VERDICT_UNADDRESSABLE_TRACE:% — FOUNDER RULING R4 puts a '
            'durable trace_id on every verification so bad decisions can seed DPO '
            'datasets from events (Langfuse is a replaceable view, L14). A blank '
            'ref is an absent one wearing a value''s clothes.',
            p_token_id
            USING ERRCODE = 'FC097';
    END IF;

    SELECT * INTO v_ask FROM cell.v_evaluator_confirm_ask
     WHERE token_id = p_token_id;

    IF NOT FOUND
       OR v_ask.projects = 'unconsumed'
       OR NOT v_ask.clause_declared
       OR v_ask.statement_id IS NULL THEN
        RAISE EXCEPTION
            'CONFIRM_VERDICT_NOT_ANSWERABLE:% — a transcription needs an ask that '
            'exists, an operator who ANSWERED it, a plan that declares the clause '
            'the answer discharges, and a recorded statement for the answer to be '
            'a verdict about (§1.4). This one has: found=%, projects=%, '
            'clause_declared=%, statement=%. Writing anyway would mint a verdict '
            'about nothing anybody said, or one discharging a clause no reader of '
            'the plan can account for.',
            p_token_id, FOUND, coalesce(v_ask.projects, '<no ask>'),
            coalesce(v_ask.clause_declared::text, '<no ask>'),
            coalesce(v_ask.statement_id::text, '<none>')
            USING ERRCODE = 'FC096';
    END IF;

    -- Exactly-once is the PRIMARY KEY on a DERIVED identifier, not a NOT EXISTS
    -- and not a set in a process: two racers on the same tick address the SAME
    -- row and the index settles it under the row lock Postgres already takes.
    -- `recorded_at` is the instant of the TRANSCRIPTION; the DECISION's instant
    -- is `consumed_at`, durable in the token and carried into `checks` so a
    -- reader holding only this row can never confuse the two.
    INSERT INTO cell.verification (
        verification_id, org_id, task_id, statement_id, source, result,
        verifier_principal, verifier_type, verification_plan_ref, checks,
        evidence_refs, trace_ref, privacy_class, transfer_scope, state_version,
        recorded_at)
    VALUES (
        p_verification_id,
        v_ask.org_id,
        v_ask.task_id,
        v_ask.statement_id,
        'confirm_token_consume',
        v_ask.projects,
        v_ask.consumed_by,
        'operator',
        'operator_approval',
        jsonb_build_array(jsonb_build_object(
            'check', 'confirm_token_consume',
            'ask_key', v_ask.ask_key,
            'token_id', v_ask.token_id,
            'projects', v_ask.projects,
            'consumed_by', v_ask.consumed_by,
            'consumed_at', v_ask.consumed_at)),
        jsonb_build_array('cell.confirm_token:' || v_ask.token_id::text,
                          'cell.agent_statement:' || v_ask.statement_id::text),
        p_trace_ref,
        -- H7 / PRD §16, chosen rather than defaulted: an operator's verdict on
        -- this org's own work is org_internal content, and `cell_only` is the
        -- tighter of the two transfer scopes that class permits. A record naming
        -- a person, a decision and the work it was about has no reason to leave
        -- the cell.
        'org_internal',
        'cell_only',
        v_ask.state_version,
        p_recorded_at)
    ON CONFLICT (verification_id) DO NOTHING;

    GET DIAGNOSTICS v_written = ROW_COUNT;
    RETURN v_written = 1;
END;
$transcribe$;

COMMENT ON FUNCTION cell.record_confirm_verdict IS
    'Contract §1.4 source 3. A TRANSCRIPTION, not a decision: every column is '
    'read off the ask, the statement and the plan, and the projection of a '
    'NULL-verdict consume is v_confirm_verdict''s (MEASURED: 217 rows).';
