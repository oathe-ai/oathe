-- 010_parent_child_verification.sql — R8: the parent's VERIFICATION is child-gated.
--
-- Contract: docs/a1-cell-work-spine-contract.md §2.2, FOUNDER RULING R8
-- (2026-08-16). Requires 001_core.sql, 003_verification.sql and
-- 008_effect_receipt.sql (the mid-effect hold reads unresolved receipts).
--
-- Re-apply: idempotent (CREATE ... IF NOT EXISTS / OR REPLACE).
-- Revert:   DROP SCHEMA cell CASCADE;  (this file installs nothing outside it)
--
-- THE RULING, AND THE LINE IT DRAWS
--
--   "The parent's completion assertion is NEVER structurally blocked — an
--    assertion is an agent_statement, and blocking statements is the abolished
--    modal pattern — but the parent's VERIFICATION requires its delegated
--    children settled by default: the parent's acceptance checker refuses while
--    a child's verification is missing, and an early-asserting parent sits
--    `asserted_unverified` under its own verify_by clock, visibly."
--
-- Nothing in this file touches the statement path. That is deliberate and it is
-- half the ruling: the measured cost of blocking an assertion is the 8h04m
-- modal-block incident, and the cost of NOT gating the verification is that
-- delegation launders an unverified result into a verified one — the parent says
-- "done", somebody verifies the parent, and the work actually delegated was
-- never checked by anyone.
--
-- THE WIND-DOWN IS NOT A CASCADE
--
-- Child claims are owned by their own principals (R1). Parent YIELD leaves
-- children untouched, because the reopened parent's next claimant resumes
-- waiting on the same edges. Parent ABORT records a typed retraction ADDRESSED
-- TO the child's principal, who winds down via decline or yield with the
-- retraction as the typed basis. This file therefore records the retraction and
-- moves nothing: a substrate that ended the child's claim here would be the
-- hard-kill cascade the ruling refuses, wearing a typed name.
--
-- Declared failure vocabulary added by this file (SQLSTATE class FC):
--   FC050 PARENT_VERIFICATION_CHILD_UNVERIFIED  a parent verified while a
--                                               delegated child is unverified
--   FC051 RETRACTION_WITHOUT_PARENT_ABORT       a retraction with no abort behind it
--   FC052 CHILD_RETRACTION_MID_EFFECT           a child told to stand down while
--                                               holding an unresolved receipt
--   FC053 RETRACTION_NOT_MY_CHILD               a retraction addressed to somebody
--                                               else's delegate
--   FC054 PARENT_CLAIM_UNKNOWN                  the acceptance checker was asked
--                                               about a claim that does not exist

-- ---------------------------------------------------------------------------
-- v_parent_child_verification — one row per delegated child, with its verdict
--
-- The parent's TASK travels with the parent's claim, because delegation edges
-- outlive the claim episode that created them. A child is linked to the specific
-- parent CLAIM it was delegated under (§2.1), but R8 says parent YIELD leaves
-- children untouched "because the reopened parent's next claimant resumes
-- waiting on the same edges" — so the lineage the gate walks is the parent
-- TASK's, and every claim episode of that task sees the same children.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW cell.v_parent_child_verification AS
SELECT
    parent.org_id,
    parent.work_claim_id  AS parent_work_claim_id,
    child.work_claim_id   AS child_work_claim_id,
    child.principal_id    AS child_principal,
    child.task_id         AS child_task_id,
    c.completion          AS child_completion,
    (c.completion = 'complete') AS child_verified,
    -- Appended rather than placed beside parent_work_claim_id where it reads
    -- best: CREATE OR REPLACE VIEW may only ADD columns at the end, and this
    -- file's declared re-apply contract is idempotence over an installed cell.
    parent.task_id        AS parent_task_id
FROM cell.work_claim parent
JOIN cell.work_claim child
  ON child.org_id = parent.org_id
 AND child.parent_work_claim_id = parent.work_claim_id
JOIN cell.v_task_completion c
  ON c.org_id = child.org_id AND c.task_id = child.task_id;

COMMENT ON VIEW cell.v_parent_child_verification IS
    'Contract §2.2 / R8. MEASURED: zero historical events carry '
    'parent_work_claim_id — this is forward contract, not history reconstruction.';

-- ------------------------------------------ the check the acceptance path consults
--
-- A verb in its own right, not a rule reachable only by attempting a write: §2.2
-- says "the parent's acceptance checker refuses while a child's verification is
-- missing", and the checker has to be able to ASK.
--
-- Returns the number of delegated children, all of them verified. Zero children
-- returns 0 and raises nothing — the gate must not become a tax on undelegated
-- work. A claim id that names no claim RAISES: "0 children, all verified" is a
-- clean bill of health, and issuing one about work the company has no record of
-- is an error that looks like success.
--
-- The lineage walked is the parent TASK's, not the single claim episode's. R8:
-- "parent YIELD leaves children untouched, because the reopened parent's next
-- claimant resumes waiting on the SAME EDGES." Children stay linked to the claim
-- episode they were delegated under and nothing re-links them, so a gate keyed to
-- the asserting claim's own id forgets every delegated child the instant the
-- parent yields — and the next claimant verifies straight through.
CREATE OR REPLACE FUNCTION cell.assert_children_verified(
    p_org_id        text,
    p_work_claim_id uuid
)
RETURNS integer
LANGUAGE plpgsql
STABLE
AS $children$
DECLARE
    v_parent_task text;
    v_unverified  text;
    v_total       integer;
BEGIN
    SELECT task_id INTO v_parent_task
      FROM cell.work_claim
     WHERE org_id = p_org_id AND work_claim_id = p_work_claim_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'PARENT_CLAIM_UNKNOWN:%/% — no claim by that identity exists in this '
            'org, so it has no task, no delegation lineage, and nothing this '
            'checker could truthfully report about. Answering 0 here would be an '
            'acceptance checker issuing a clean bill of health about work the '
            'company has no record of.',
            p_org_id, p_work_claim_id
            USING ERRCODE = 'FC054';
    END IF;

    SELECT string_agg(v.child_work_claim_id::text || ' (' || v.child_principal ||
                      ', ' || v.child_completion || ')', ', '
                      ORDER BY v.child_work_claim_id)
      INTO v_unverified
      FROM cell.v_parent_child_verification v
     WHERE v.org_id = p_org_id
       AND v.parent_task_id = v_parent_task
       AND NOT v.child_verified;

    IF v_unverified IS NOT NULL THEN
        RAISE EXCEPTION
            'PARENT_VERIFICATION_CHILD_UNVERIFIED:% — these delegated children are '
            'not verified: %. FOUNDER RULING R8: the parent''s ASSERTION is never '
            'blocked, but its VERIFICATION requires its delegated children settled. '
            'Verifying the parent here would launder an unverified result into a '
            'verified one — the delegated work would be the only part nobody checked.',
            p_work_claim_id, v_unverified
            USING ERRCODE = 'FC050';
    END IF;

    SELECT count(*)::integer INTO v_total
      FROM cell.v_parent_child_verification v
     WHERE v.org_id = p_org_id AND v.parent_task_id = v_parent_task;

    RETURN v_total;
END;
$children$;

-- The same check, on the write path. A rule the acceptance checker consults but
-- the substrate does not enforce is a rule with a bypass (the §4.3 lesson,
-- applied one level up).
--
-- EVERY `verified` verdict is gated, whatever type of statement it hangs on. The
-- gate deliberately does NOT narrow to `statement_type = 'completion'`:
-- v_task_completion (003_verification.sql) counts any `verified` row naming a
-- declared plan clause and never looks at the type of the statement underneath
-- it, so a completion-only gate is walked around by attaching the same verdict to
-- a `result` statement under the same claim. The parent then projects `complete`
-- with its delegated child unverified — the exact laundering R8 prohibits, and it
-- releases the R4 task-type dependency edges gated on that parent.
--
-- A `rejected` or `indeterminate` verdict stays ungated: those are information
-- the cell wants recorded, and gating them would mean the only verdict a
-- delegating parent could ever receive is silence.
CREATE OR REPLACE FUNCTION cell.enforce_parent_verification_is_child_gated()
RETURNS trigger
LANGUAGE plpgsql
AS $child_gate$
DECLARE
    v_work_claim_id uuid;
BEGIN
    IF NEW.result <> 'verified' THEN
        RETURN NEW;
    END IF;

    SELECT work_claim_id INTO v_work_claim_id
      FROM cell.agent_statement
     WHERE statement_id = NEW.statement_id;

    IF NOT FOUND THEN
        -- Not a tolerated absence: verification_statement_fkey is the authority
        -- on whether the named statement exists, and it refuses this row at the
        -- end of the statement with the FK's own message. Raising a second,
        -- competing refusal here would report a delegation problem for what is a
        -- dangling reference.
        RETURN NEW;
    END IF;

    PERFORM cell.assert_children_verified(NEW.org_id, v_work_claim_id);
    RETURN NEW;
END;
$child_gate$;

CREATE OR REPLACE TRIGGER verification_is_child_gated
    BEFORE INSERT OR UPDATE ON cell.verification
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_parent_verification_is_child_gated();

-- ---------------------------------------------------------------------------
-- child_retraction — the typed retraction a parent ABORT sends to its children
--
-- What this table is NOT: an instruction the substrate carries out. It records
-- that the parent withdrew, addressed to the child's principal, who winds down
-- via decline or yield with this retraction as the typed basis (§1.2's
-- yield-with-typed-basis). Nothing here moves the child's claim.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cell.child_retraction (
    retraction_id        uuid        NOT NULL,
    org_id               text        NOT NULL,
    parent_work_claim_id uuid        NOT NULL,
    child_work_claim_id  uuid        NOT NULL,
    basis                text        NOT NULL,

    -- L13: the retraction carries its own evidence, exactly as §4.4's dependency
    -- retraction does. "The parent withdrew" is a claim about the world and the
    -- child's principal is entitled to the reference.
    evidence_refs        jsonb       NOT NULL,

    ts                   timestamptz NOT NULL,

    CONSTRAINT child_retraction_pkey PRIMARY KEY (retraction_id),

    CONSTRAINT child_retraction_parent_fkey
        FOREIGN KEY (org_id, parent_work_claim_id)
        REFERENCES cell.work_claim (org_id, work_claim_id),

    CONSTRAINT child_retraction_child_fkey
        FOREIGN KEY (org_id, child_work_claim_id)
        REFERENCES cell.work_claim (org_id, work_claim_id),

    CONSTRAINT child_retraction_basis_is_a_declared_basis
        CHECK (basis IN ('parent_aborted', 'parent_withdrawn')),

    CONSTRAINT child_retraction_carries_addressable_evidence
        CHECK (jsonb_typeof(evidence_refs) = 'array'
               AND jsonb_array_length(evidence_refs) > 0),

    CONSTRAINT child_retraction_is_not_addressed_to_the_parent_itself
        CHECK (child_work_claim_id <> parent_work_claim_id)
);

CREATE INDEX IF NOT EXISTS child_retraction_by_child
    ON cell.child_retraction (org_id, child_work_claim_id, ts);

CREATE OR REPLACE FUNCTION cell.enforce_child_retraction_preconditions()
RETURNS trigger
LANGUAGE plpgsql
AS $retraction$
DECLARE
    v_parent_state text;
    v_child_parent uuid;
    v_receipt      text;
BEGIN
    SELECT state INTO v_parent_state
      FROM cell.work_claim
     WHERE org_id = NEW.org_id AND work_claim_id = NEW.parent_work_claim_id;

    IF v_parent_state IS DISTINCT FROM 'aborted' THEN
        RAISE EXCEPTION
            'RETRACTION_WITHOUT_PARENT_ABORT:% — the parent claim is ''%'', not '
            '''aborted''. R8: parent YIELD leaves children UNTOUCHED, because the '
            'reopened parent''s next claimant resumes waiting on the same edges. '
            'Only abort or withdrawal sends a retraction; recording one for a yield '
            'tells a principal to stand down from work that is about to resume.',
            NEW.parent_work_claim_id, coalesce(v_parent_state, '<no such claim>')
            USING ERRCODE = 'FC051';
    END IF;

    SELECT parent_work_claim_id INTO v_child_parent
      FROM cell.work_claim
     WHERE org_id = NEW.org_id AND work_claim_id = NEW.child_work_claim_id;

    IF v_child_parent IS DISTINCT FROM NEW.parent_work_claim_id THEN
        RAISE EXCEPTION
            'RETRACTION_NOT_MY_CHILD:% — this claim''s parent is %, not %. A '
            'retraction addressed to somebody else''s delegate is an instruction to '
            'stand down from work this parent never delegated.',
            NEW.child_work_claim_id, coalesce(v_child_parent::text, '<none>'),
            NEW.parent_work_claim_id
            USING ERRCODE = 'FC053';
    END IF;

    -- R3/R6 discipline, applied identically: a mid-effect child resolves its
    -- receipts first. Telling a principal to stand down mid-effect is how an
    -- irreversible effect ends up with nobody left to reconcile it.
    SELECT receipt_key INTO v_receipt
      FROM cell.effect_receipt
     WHERE org_id = NEW.org_id
       AND work_claim_id = NEW.child_work_claim_id
       AND outcome = 'claimed'
     ORDER BY claimed_at
     LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION
            'CHILD_RETRACTION_MID_EFFECT:% — this child holds an unresolved effect '
            'receipt (%). R8 with R3/R6: a mid-effect child resolves its receipts '
            'first. Standing it down now leaves an irreversible effect claimed and '
            'nobody responsible for reconciling it.',
            NEW.child_work_claim_id, v_receipt
            USING ERRCODE = 'FC052';
    END IF;

    RETURN NEW;
END;
$retraction$;

CREATE OR REPLACE TRIGGER child_retraction_meets_its_preconditions
    BEFORE INSERT OR UPDATE ON cell.child_retraction
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_child_retraction_preconditions();

COMMENT ON TABLE cell.child_retraction IS
    'R8: parent ABORT sends a TYPED RETRACTION to its children — never a '
    'hard-kill cascade. This table records the withdrawal; the child''s own '
    'principal winds down with it as the typed basis.';
