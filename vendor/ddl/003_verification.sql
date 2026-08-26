-- 003_verification.sql — the two record classes, and the ONE derived answer.
--
-- Contract: docs/a1-cell-work-spine-contract.md §1.3 (agent_statement), §1.4
-- (verification), §1.5 (completion), AMENDED 2026-08-16 by founder rulings R1
-- (verification is non-author only), R2 (mandatory verify_by clock) and R4
-- (mandatory evidence, trace_ref, privacy_class, transfer_scope; the seven
-- done-ness mechanisms collapse to these two record classes).
-- Requires 001_core.sql.
--
-- Re-apply: idempotent (CREATE ... IF NOT EXISTS / OR REPLACE; the one ALTER is
--           guarded on pg_constraint).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- WHY COMPLETION IS A VIEW AND NOT A COLUMN
--
-- On the Mac, "done" was reachable through whichever of seven overlapping
-- mechanisms a code path happened to consult, and a stored `closed` flag was one
-- of them — which is how the dependency system ended up releasing on the
-- upstream author's SELF-ASSERTED completion (contract §3.3, MEASURED). A stored
-- completion is a fact somebody can write; a derived one is a fact that follows
-- from the records, and the only way to change it is to change the records. The
-- tri-state {complete, asserted_unverified, none} is therefore computed here and
-- has no writable form anywhere in the cell.
--
-- Declared failure vocabulary added by this file (SQLSTATE class FC; this lane
-- reserves FC010-FC019):
--   FC010 VERIFICATION_AUTHOR_SELF  a verifier who authored, or holds the claim
--                                   over, the statement being verified
--   FC011 SUPERSEDES_CROSSES_TASK   a statement retracting another task's record
--   FC012 SUPERSEDES_WITHOUT_RESPONSIBILITY  a supersession by a writer holding
--                                   no claim on the work being retracted
--   FC013 SUPERSEDES_WITHOUT_EVIDENCE  a supersession with nothing addressable
--                                   behind it

-- ---------------------------------------------------------------------------
-- agent_statement — what an agent SAYS (contract §1.3)
--
-- "May be useful evidence. Never automatically authoritative truth" (L10). This
-- table is deliberately permissive about content and strict about provenance:
-- an author may say anything, and the substrate records exactly who said it,
-- under which claim, with what epistemic standing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.agent_statement (
    statement_id      uuid        NOT NULL,
    org_id            text        NOT NULL,
    task_id           text        NOT NULL,
    work_claim_id     uuid        NOT NULL,

    -- Two identities, not one (contract §1.3, §2.1): statements from temporary
    -- execution actors carry the ACTOR identity distinct from the claim-holding
    -- principal. Collapsing them would make an in-process subagent's assertion
    -- indistinguishable from its principal's, and the non-author rule below
    -- would then be enforceable against only half of the authors there are.
    execution_actor   text        NOT NULL,
    claim_principal   text        NOT NULL,

    statement_type    text        NOT NULL,
    subject_ref       text        NOT NULL,
    proposition       text        NOT NULL,

    -- An array, possibly EMPTY: a statement with no evidence is a lawful
    -- statement (that is what makes it a statement). The mandatory-evidence rule
    -- of R4 binds `verification`, where the absence of evidence would be a claim
    -- to have checked something without saying what was checked.
    evidence_refs     jsonb       NOT NULL,

    -- L13: observed | derived | inferred | unknown.
    epistemic_status  text        NOT NULL,

    -- NULL exactly when this statement supersedes nothing, which is the ordinary
    -- case; a superseded completion assertion stops counting in v_task_completion.
    supersedes_ref    uuid,

    asserted_at       timestamptz NOT NULL,

    CONSTRAINT agent_statement_pkey PRIMARY KEY (statement_id),

    -- The handle `verification` references. Task identity travels WITH the
    -- statement identity so a verification cannot name one task while evaluating
    -- a statement made about another.
    CONSTRAINT agent_statement_task_scoped_key UNIQUE (org_id, task_id, statement_id),

    CONSTRAINT agent_statement_task_fkey
        FOREIGN KEY (org_id, task_id) REFERENCES cell.task (org_id, task_id),

    CONSTRAINT agent_statement_claim_fkey
        FOREIGN KEY (org_id, work_claim_id)
        REFERENCES cell.work_claim (org_id, work_claim_id),

    CONSTRAINT agent_statement_supersedes_fkey
        FOREIGN KEY (supersedes_ref) REFERENCES cell.agent_statement (statement_id),

    CONSTRAINT agent_statement_statement_type_is_a_declared_type
        CHECK (statement_type IN ('completion', 'progress', 'result', 'observation')),

    CONSTRAINT agent_statement_epistemic_status_is_a_declared_status
        CHECK (epistemic_status IN ('observed', 'derived', 'inferred', 'unknown')),

    CONSTRAINT agent_statement_evidence_refs_is_an_array
        CHECK (jsonb_typeof(evidence_refs) = 'array'),

    CONSTRAINT agent_statement_supersedes_something_other_than_itself
        CHECK (supersedes_ref IS DISTINCT FROM statement_id)
);

COMMENT ON TABLE cell.agent_statement IS
    'Contract §1.3. A completion assertion is a statement, not completion: '
    'author-run test output, gate-hook passes and self-reports all land here.';

CREATE INDEX IF NOT EXISTS agent_statement_by_task
    ON cell.agent_statement (org_id, task_id, statement_type);

CREATE INDEX IF NOT EXISTS agent_statement_by_supersedes
    ON cell.agent_statement (supersedes_ref) WHERE supersedes_ref IS NOT NULL;

-- ------------------------------------------ a supersession is scoped to the work
--
-- `agent_statement_supersedes_fkey` checks only that the superseded statement
-- EXISTS, and v_task_completion's NOT EXISTS clause below looks at nothing but
-- the ref — so, unscoped, ANY statement anywhere could retract ANY task's
-- completion assertion. That assertion is the input to the R4 dependency release
-- bar (§4), which makes an unscoped supersession a way to move the release bar
-- for work the writer has nothing to do with, leaving no evidence and no
-- verification record anywhere in the substrate.
--
-- Three scopes, and deliberately not a fourth:
--
--   1. SAME TASK. A statement about other work cannot speak to this record.
--   2. UNDER A CLAIM ON THIS TASK. A responsibility rule, not an author rule:
--      the successor claimant after a yield MUST be able to correct the previous
--      claimant's assertion (R8 — the reopened task's next claimant resumes on
--      the same work), so what is checked is that the writer holds an interval of
--      responsibility for the work whose done-ness they are retracting.
--   3. EVIDENCE. An ordinary statement with no evidence is lawful — that is what
--      makes it a statement (see the column comment above). A statement that
--      retracts the release bar's input is a claim about the world, and L13 says
--      a claim about the world is addressable.
--
-- The fourth, NOT enforced: statement_type equality. A withdrawal is properly
-- recorded as a `progress` statement superseding a `completion` assertion, so
-- requiring the types to match would forbid the ordinary retraction.
CREATE OR REPLACE FUNCTION cell.enforce_supersession_is_scoped()
RETURNS trigger
LANGUAGE plpgsql
AS $supersede$
DECLARE
    v_superseded_task text;
    v_claim_task      text;
BEGIN
    IF NEW.supersedes_ref IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT task_id INTO v_superseded_task
      FROM cell.agent_statement
     WHERE statement_id = NEW.supersedes_ref;

    IF NOT FOUND THEN
        -- agent_statement_supersedes_fkey is the authority on whether the named
        -- statement exists, and it refuses this row at the end of the statement
        -- with the FK's own message. A second, competing refusal here would
        -- report a scoping problem for what is a dangling reference.
        RETURN NEW;
    END IF;

    IF v_superseded_task IS DISTINCT FROM NEW.task_id THEN
        RAISE EXCEPTION
            'SUPERSEDES_CROSSES_TASK:% — this statement is about ''%'' and '
            'supersedes a statement about ''%''. A completion assertion is the R4 '
            'release bar''s input; letting another task''s writer retract it moves '
            'that bar with nothing recorded about the work it actually gates.',
            NEW.statement_id, NEW.task_id, v_superseded_task
            USING ERRCODE = 'FC011';
    END IF;

    SELECT task_id INTO v_claim_task
      FROM cell.work_claim
     WHERE org_id = NEW.org_id AND work_claim_id = NEW.work_claim_id;

    IF v_claim_task IS DISTINCT FROM NEW.task_id THEN
        RAISE EXCEPTION
            'SUPERSEDES_WITHOUT_RESPONSIBILITY:%:% — this supersession is written '
            'under a claim on ''%'', not on ''%''. Retracting what the company '
            'believes about work is an act of the principal responsible for it; a '
            'bystander retraction is an authority change nobody granted (L11). '
            'This is a responsibility rule and not an author rule: the NEXT '
            'claimant of the same work supersedes freely.',
            NEW.statement_id, NEW.work_claim_id,
            coalesce(v_claim_task, '<no such claim>'), NEW.task_id
            USING ERRCODE = 'FC012';
    END IF;

    IF jsonb_array_length(NEW.evidence_refs) = 0 THEN
        RAISE EXCEPTION
            'SUPERSEDES_WITHOUT_EVIDENCE:% — a supersession retracts the record '
            'the dependency lane releases on, so it carries at least one '
            'addressable evidence ref (L13). An ordinary statement may still carry '
            'none; retracting done-ness silently is what this refuses.',
            NEW.statement_id
            USING ERRCODE = 'FC013';
    END IF;

    RETURN NEW;
END;
$supersede$;

CREATE OR REPLACE TRIGGER agent_statement_supersession_is_scoped
    BEFORE INSERT OR UPDATE ON cell.agent_statement
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_supersession_is_scoped();

-- ---------------------------------------------------------------------------
-- verification — a NON-AUTHOR evaluation against an explicit contract (§1.4)
--
-- Exactly three sources mint a row here, and nothing else does:
--   dep_verified_evaluator  the one non-author evaluator running a registered
--                           checker (contract §4)
--   acceptance_package      an acceptance-package v1 verdict whose `ruled_by` is
--                           a registered non-author seat
--   confirm_token_consume   an operator CONFIRM, state_version-bound; a REJECT
--                           consume is a verification with result='rejected'
--
-- Retracting a dependency edge mints NO row here (§4.4), and the auto-void
-- bypass class is empty by construction (§3.1) because the cell has no auto-void.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.verification (
    verification_id       uuid        NOT NULL,
    org_id                text        NOT NULL,
    task_id               text        NOT NULL,

    -- NOT NULL on purpose: every verification in the cell evaluates a RECORDED
    -- statement. It is what gives the non-author rule an author to compare
    -- against, and a verification floating free of any statement is a verdict
    -- about nothing anybody said.
    statement_id          uuid        NOT NULL,

    source                text        NOT NULL,
    result                text        NOT NULL,
    verifier_principal    text        NOT NULL,
    verifier_type         text        NOT NULL,

    -- Names the plan CLAUSE this record discharges. v_task_completion counts
    -- clauses, so a verification naming no clause discharges nothing — which is
    -- the honest outcome for a verdict that does not say what it verified.
    verification_plan_ref text        NOT NULL,

    checks                jsonb       NOT NULL,

    -- FOUNDER RULING R4: mandatory, and non-empty. The `--clears` lane's
    -- optional-evidence default does not survive into the cell.
    evidence_refs         jsonb       NOT NULL,

    -- FOUNDER RULING R4: a durable trace_id held IN THE SUBSTRATE, so bad
    -- decisions can seed DPO datasets from events. Langfuse is a replaceable
    -- view over this column, never its home (L14).
    trace_ref             text        NOT NULL,

    -- H7 / PRD §16, from day one: what this record is, and how far it may travel.
    privacy_class         text        NOT NULL,
    transfer_scope        text        NOT NULL,

    -- §1.4 source 3 is state_version-bound (the 0073 lesson). NOT NULL exactly
    -- for a confirm-token consume; meaningless — and therefore forbidden — on an
    -- evaluator verdict or an acceptance package.
    state_version         bigint,

    recorded_at           timestamptz NOT NULL,

    CONSTRAINT verification_pkey PRIMARY KEY (verification_id),

    CONSTRAINT verification_statement_fkey
        FOREIGN KEY (org_id, task_id, statement_id)
        REFERENCES cell.agent_statement (org_id, task_id, statement_id),

    CONSTRAINT verification_source_is_a_declared_source
        CHECK (source IN ('dep_verified_evaluator', 'acceptance_package',
                          'confirm_token_consume')),

    CONSTRAINT verification_result_is_a_declared_verdict
        CHECK (result IN ('verified', 'rejected', 'indeterminate')),

    CONSTRAINT verification_verifier_type_matches_its_source
        CHECK ((source = 'dep_verified_evaluator' AND verifier_type = 'evaluator')
            OR (source = 'acceptance_package'     AND verifier_type = 'seat')
            OR (source = 'confirm_token_consume'  AND verifier_type = 'operator')),

    CONSTRAINT verification_consume_is_state_version_bound
        CHECK ((source = 'confirm_token_consume') = (state_version IS NOT NULL)),

    CONSTRAINT verification_carries_addressable_evidence
        CHECK (jsonb_typeof(evidence_refs) = 'array'
               AND jsonb_array_length(evidence_refs) > 0),

    CONSTRAINT verification_checks_is_an_array
        CHECK (jsonb_typeof(checks) = 'array'),

    -- NOT NULL permits the empty string; a blank trace_ref is an absent one
    -- wearing a value's clothes, and the DPO lane would carry unresolvable refs.
    CONSTRAINT verification_trace_ref_is_addressable
        CHECK (length(btrim(trace_ref)) > 0),

    CONSTRAINT verification_privacy_class_is_a_declared_class
        CHECK (privacy_class IN ('public', 'org_internal', 'customer_derived')),

    CONSTRAINT verification_transfer_scope_is_a_declared_scope
        CHECK (transfer_scope IN ('cell_only', 'org_internal', 'exportable')),

    -- H7: raw conversation and behavioural content stays in the cell. Stated as
    -- a constraint rather than a review habit, because the review that catches
    -- this is the one nobody schedules.
    CONSTRAINT verification_customer_derived_content_stays_in_the_cell
        CHECK (privacy_class <> 'customer_derived' OR transfer_scope = 'cell_only')
);

COMMENT ON TABLE cell.verification IS
    'Contract §1.4 as amended by R1/R4. Exactly three non-author sources mint a '
    'row; retraction mints none; the auto-void bypass class is empty because the '
    'cell has no auto-void.';

CREATE INDEX IF NOT EXISTS verification_by_task_clause
    ON cell.verification (org_id, task_id, verification_plan_ref, result);

-- ------------------------------------------------ the non-author rule (R1)
--
-- A CHECK constraint cannot see another table, so this is the one rule in this
-- file that has to be a trigger. It is not application code: a caller that never
-- heard of the cell library still meets it, which is the whole lesson of the 23
-- historical `verified` settles that reached the bus past a CLI-only gate.
CREATE OR REPLACE FUNCTION cell.enforce_non_author_verification()
RETURNS trigger
LANGUAGE plpgsql
AS $non_author$
DECLARE
    v_actor     text;
    v_principal text;
BEGIN
    SELECT execution_actor, claim_principal INTO v_actor, v_principal
      FROM cell.agent_statement
     WHERE statement_id = NEW.statement_id;

    IF NEW.verifier_principal IN (v_actor, v_principal) THEN
        RAISE EXCEPTION
            'VERIFICATION_AUTHOR_SELF:% — % authored the statement under evaluation '
            '(actor %, claim principal %), so this record is a self-report wearing '
            'a verification''s name. Verification is non-author only: author-run '
            'test output and gate-hook passes are agent_statements with degraded '
            'epistemic status — they inform, they never release.',
            NEW.statement_id, NEW.verifier_principal, v_actor, v_principal
            USING ERRCODE = 'FC010';
    END IF;

    RETURN NEW;
END;
$non_author$;

CREATE OR REPLACE TRIGGER verification_is_non_author
    BEFORE INSERT OR UPDATE ON cell.verification
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_non_author_verification();

-- ------------------------------------- a declared plan names its clauses
--
-- Additive amendment to cell.task from 001_core.sql. Without it, a plan that
-- says `plan_status: declared` with an empty clause list has zero required
-- clauses, zero unsatisfied ones, and would therefore project COMPLETE off a
-- bare assertion — an undeclared plan being the easiest plan in the cell to
-- satisfy. `plan_status: unknown` remains lawful and clause-less: that is the
-- honest report of a task with no plan (§1.1, L13), and it never projects
-- complete either.
DO $declared_plan$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'task_declared_plan_names_its_clauses'
           AND conrelid = 'cell.task'::regclass
    ) THEN
        -- The `IS NOT NULL` is load-bearing, exactly as it is on 001_core.sql's
        -- plan-status constraint: with no 'clauses' key at all the -> operator
        -- yields SQL NULL, jsonb_typeof(NULL) is NULL, the AND chain is NULL, and
        -- a CHECK PASSES on NULL — so the clause-less declared plan this
        -- constraint exists to refuse would sail straight through.
        ALTER TABLE cell.task ADD CONSTRAINT task_declared_plan_names_its_clauses
            CHECK (verification_plan ->> 'plan_status' IS DISTINCT FROM 'declared'
                   OR (verification_plan -> 'clauses' IS NOT NULL
                       AND jsonb_typeof(verification_plan -> 'clauses') = 'array'
                       AND jsonb_array_length(verification_plan -> 'clauses') > 0));
    END IF;
END
$declared_plan$;

-- ---------------------------------------------------------------------------
-- v_task_completion — the derived tri-state (contract §1.5)
--
--   none                 nobody has asserted completion
--   asserted_unverified  asserted, but the plan's clauses are not all discharged
--                        by a recorded verification — the F6 read guarantee
--   complete             every declared clause carries a `verified` record
--
-- Completion is never the same event as settlement (§1.6): a completed-but-
-- unsettled task is a first-class, honestly-rendered condition, and this view
-- says nothing about settlement at all.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW cell.v_task_completion AS
SELECT
    t.org_id,
    t.task_id,
    t.department,
    t.verify_by,
    a.completion_assertions,
    p.required_clauses,
    p.satisfied_clauses,
    CASE
        WHEN a.completion_assertions = 0 THEN 'none'
        -- An unknown plan can never be discharged, so it can never complete. The
        -- ordering matters: this arm sits ABOVE the clause count so a plan with
        -- no clauses cannot fall through to the equality below.
        WHEN t.verification_plan ->> 'plan_status' = 'unknown' THEN 'asserted_unverified'
        WHEN p.satisfied_clauses = p.required_clauses THEN 'complete'
        ELSE 'asserted_unverified'
    END AS completion
FROM cell.task t
CROSS JOIN LATERAL (
    SELECT count(*)::int AS completion_assertions
      FROM cell.agent_statement s
     WHERE s.org_id = t.org_id
       AND s.task_id = t.task_id
       AND s.statement_type = 'completion'
       AND NOT EXISTS (
           SELECT 1 FROM cell.agent_statement later
            WHERE later.supersedes_ref = s.statement_id)
) a
CROSS JOIN LATERAL (
    SELECT count(*)::int AS required_clauses,
           count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM cell.verification v
                WHERE v.org_id = t.org_id
                  AND v.task_id = t.task_id
                  AND v.verification_plan_ref = clause
                  AND v.result = 'verified'))::int AS satisfied_clauses
      FROM jsonb_array_elements_text(
               coalesce(t.verification_plan -> 'clauses', '[]'::jsonb)) AS c(clause)
) p;

COMMENT ON VIEW cell.v_task_completion IS
    'Contract §1.5. The tri-state is DERIVED and has no writable form: a stored '
    'completion is a fact somebody can write, which is how the Mac''s dependency '
    'system ended up releasing on the upstream author''s self-assertion.';

-- ---------------------------------------------------------------------------
-- unverified_past_verify_by — the R2 clock leg, as a query (contract §8, F2)
--
-- The instant is an EXPLICIT argument. A function reading now() cannot be tested
-- at a stated instant, and a falsifier leg that cannot state its instant is a
-- flake wearing a green tick. Callers pass the clock they are reasoning about;
-- the pager passes the current one.
--
-- Note what this deliberately does NOT report: work nobody has asserted
-- complete. The leg is `asserted_unverified past verify_by`, not `past
-- verify_by`; reporting open work as a verification failure would bury the real
-- ones, which is the widened-arm lesson of contract §3.4(1).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cell.unverified_past_verify_by(p_as_of timestamptz)
RETURNS TABLE (
    org_id      text,
    task_id     text,
    department  text,
    completion  text,
    verify_by   timestamptz
)
LANGUAGE sql
STABLE
AS $overdue$
    SELECT c.org_id, c.task_id, c.department, c.completion, c.verify_by
      FROM cell.v_task_completion c
     WHERE c.completion = 'asserted_unverified'
       AND c.verify_by < p_as_of
     ORDER BY c.verify_by, c.task_id;
$overdue$;

COMMENT ON FUNCTION cell.unverified_past_verify_by IS
    'FOUNDER RULING R2 / F2 clock leg: every row this returns is RED and pages. '
    'The instant is an explicit argument so a leg can state the moment it means.';
