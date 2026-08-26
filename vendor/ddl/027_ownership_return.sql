-- 027_ownership_return.sql — R-A35-23's OWNERSHIP RETURN: the second interval a
-- handed-back obligation gets when the work it was waiting on comes back, the
-- succession lineage that records which interval it resumes, and the call-stack
-- guard that makes this verb the only way to either.
--
-- Contract: docs/a1-cell-work-spine-contract.md §1.2 (a claim is an interval of
-- RESPONSIBILITY; responsibility passes by a terminal, never by a second
-- claimant arriving), §1.6 (settlement is a separate fact), §4 (the dependency
-- lane whose release is the returned fact), PRD 3.0 §5.2 (the ownership
-- constitution) and design laws L1 (one authoritative owner per lifecycle), L2
-- (durable state below the agent), L11 (learning never widens authority) and L12
-- (durable judgment does not decay). FOUNDER RULINGS R-A35-25 §5 (FC-A: the
-- evaluator seat mints the deterministic SAME-PRINCIPAL successor through this
-- verb; FC-B: No, a return re-seats the predecessor) and R-A35-26/27.
-- Design of record: docs/firia-runtime-a3/a3-ownership-return-design.md §5.1-§5.6.
--
-- Requires 001_core.sql (the claim table and its unique active ownership),
-- 002_claim.sql (cell.claim_work and cell.written_by, the frame-stack signal
-- every guard here reads), 006_dependency.sql (cell.v_task_open_deps and
-- cell.dep_edge, whose release is the fact this lane turns on),
-- 012_evaluator_lane.sql (cell.settle_task_edge, the release verb this file's
-- stimulus trigger fires inside) and 017_claim_yield_causes.sql (the handback
-- cause and the basis prefix G2 discriminates on).
--
-- Re-apply: idempotent (ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS
--           before ADD, CREATE OR REPLACE / IF NOT EXISTS throughout, and a
--           DROP FUNCTION IF EXISTS that is a no-op on a fresh install).
-- Revert:   DROP TRIGGER work_claim_return_resumption_is_a_declared_cause
--               ON cell.work_claim;
--           DROP TRIGGER dep_edge_release_records_a_return_stimulus ON cell.dep_edge;
--           DROP TRIGGER return_stimulus_is_written_by_the_release ON cell.return_stimulus;
--           DROP FUNCTION cell.reclaim_returned_work(text,text,uuid,timestamptz,uuid);
--           DROP FUNCTION cell.enforce_returned_resumption_is_a_declared_cause();
--           DROP FUNCTION cell.record_return_stimulus();
--           DROP FUNCTION cell.enforce_return_stimulus_is_the_releases();
--           DROP VIEW cell.v_returned_work;
--           DROP TABLE cell.return_stimulus;
--           DROP INDEX cell.work_claim_one_successor_per_predecessor;
--           ALTER TABLE cell.work_claim
--               DROP CONSTRAINT work_claim_predecessor_is_not_itself,
--               DROP CONSTRAINT work_claim_predecessor_fkey,
--               DROP COLUMN predecessor_work_claim_id;
--           (a reverted cell has the hole back: any writer may claim a second
--            interval on a yielded task and nothing refuses it. That is the state
--            this file exists to end, not a safe resting place. Reverting also
--            requires restoring 002's eleven-argument cell.claim_work.)
--
-- WHY THIS FILE EXISTS, MEASURED
--
-- 017 gave a parent with delegated work outstanding a lawful way to hand
-- responsibility back. Nothing gave the obligation a way to come back. When the
-- delegated work returns — the child completes, a non-author verifies it, and
-- cell.settle_task_edge releases the edge — the work sits at a terminal with
-- nobody answerable for it, and the only road to a second interval is a bare
-- cell.claim_work from whatever process happened to notice. MEASURED at
-- f45e9e64: `cell.work_claim` carried four triggers and NONE of them looked at a
-- prior yield, so that road was open to every writer in the cell, including one
-- that had no business naming who answers for work next.
--
-- 016 is the sibling and the shape: R8's reopen-after-rejection has a verb, a
-- call-stack guard and a transcription discipline. This is the OTHER resumption
-- cause, and it gets its own guard rather than a shared registry — see below.
--
-- WHY TWO INDEPENDENT GUARDS AND NOT A RESUMPTION-CAUSE REGISTRY (L8, dated)
--
-- 017's cause registry exists because ONE meaning (`work_claim.yielded`) had
-- several causes each wanting to write the row. That is not this situation: the
-- meaning here is `work_claim.claimed`, whose producer is already singular and
-- registered (`cell.claim_work`, 002:65-67), and this verb PERFORMs through it.
-- So there is no new topic, no ALTER of either topic CHECK, and no new
-- producer-registry row. What there are two of is RESUMPTION CAUSES — 016's
-- reopen and this one's return — and two is not a registry. Moving 016's FC130
-- into a shared reader would break the vocabulary test that requires a file to
-- raise what it declares, for no gain.
--   RETIREMENT CONDITION: the first verb that writes `aborted`, `taken_over` or
--   `expired` onto a claim — a THIRD resumption cause is what makes a registry
--   cheaper than three guards. DELETION OWNER: whoever lands that verb, in the
--   same change. That is the same trigger `delegation.mjs:170-175` already names
--   as its own retirement condition, and it is W4's FC-E grid.
--
-- WHY THE ELIGIBILITY SURFACE IS A VIEW
--
-- Every fact it needs is already durable and already owned by a verb: the yield
-- terminal by cell.record_claim_yield, the dependency release by
-- cell.settle_task_edge. A table would need a writer, and a writer of
-- eligibility is a SECOND AUTHORITY over the work lifecycle (L1) — which is
-- exactly what 005_escalation.sql refuses when it says "nothing keys a row to an
-- escalation and no trigger turns one into a consequence". The view answers
-- "what is returnable" and never "who may resume it".
--
-- WHY THE STIMULUS IS NOT THAT WRITER
--
-- `cell.return_stimulus` is EVIDENCE, not eligibility. It records that a release
-- happened, what verdict it rested on, when, and which interval later consumed
-- it — so the fact survives every process that might have noticed it (L2) and so
-- "who resumed on this release" has exactly one answer. NOTHING READS IT AS A
-- PRECONDITION: the verb's guards read the view and the claim rows, so a missing
-- stimulus cannot make a lawful return unlawful and a present one cannot make an
-- unlawful return lawful. That is the difference between a durable record and a
-- second authority, and it is why this table may exist where an eligibility
-- table may not.
--
-- WHAT THE STIMULUS DOES NOT COVER, STATED RATHER THAN LEFT TO BE DISCOVERED
--
-- It is recorded only where a `verified` verification stands behind the release,
-- which is the task and acceptance-package lanes. The other five dependency
-- families release on an observation this substrate does not hold (an operator's
-- consume, a clock, free capacity, an external event) and there is no verdict to
-- name, so no stimulus is written — the obligation is still RETURNABLE and
-- `cell.v_returned_work` still says so, because the view reads the release and
-- not the evidence of it. OWNER: W4's residual-owner map, beside FC-D. PHASE: W4.
--
-- Declared failure vocabulary (FC180-FC189 reserved; 8 codes used):
--   FC180 RETURNED_WORK_RESUMED_OUTSIDE_A_DECLARED_CAUSE  a second interval on a
--                                          task whose last holder handed the work
--                                          back, claimed by something that is not
--                                          this file's verb
--   FC181 RETURN_RECLAIM_TASK_UNKNOWN      a return of work the company has no
--                                          record of
--   FC182 RETURN_RECLAIM_NO_YIELDED_PREDECESSOR  a return of work whose last
--                                          interval did not end by handback
--   FC183 RETURN_RECLAIM_YIELD_WAS_NOT_A_HANDBACK  a return of a yield whose
--                                          cause was an expired ask — an
--                                          escalation, not work coming back
--   FC184 RETURN_RECLAIM_DEPENDENCY_STILL_OPEN  a return of work whose declared
--                                          dependencies have not been released
--   FC185 RETURN_RECLAIM_RESUMES_BEFORE_THE_INTERVAL_IT_FOLLOWS  a resumption
--                                          stamped inside the previous holder's
--                                          own window
--   FC186 RETURN_RECLAIM_PREDECESSOR_ALREADY_RESUMED  a SECOND interval, under a
--                                          different id, claiming to be the
--                                          return of one yield
--   FC188 RETURN_STIMULUS_RECORDED_OUTSIDE_THE_RELEASE  a return stimulus written
--                                          by something that is not a dependency
--                                          release
--   FC189 RETURN_STIMULUS_CONSUMED_OUTSIDE_THE_RETURN_VERB  a stimulus marked
--                                          consumed by something that is not this
--                                          file's verb, or consumed twice
--
-- FC187 (CLAIM_SETTLEMENT_SUPERSEDED_BY_A_SUCCESSOR) was reserved in this block
-- while FOUNDER CHECKPOINT FC-C was open and is RELEASED: FC-C is ruled S2
-- (R-A35-25 §5), so the settlement guard amends 014_claim_settlement.sql in place
-- and takes FC115 from that file's own block rather than splitting one verb's
-- definition across two migrations. FC187 is unallocated; it is named here so a
-- reader who greps the design's earlier table finds the disposition.

-- =========================================================================
-- 1. SUCCESSION PROVENANCE — a column of its own, and not the parent link
-- =========================================================================
--
-- MEASURED consequence of overloading `parent_work_claim_id` instead: the
-- successor would become an ACTIVE DELEGATED CHILD of the predecessor, and
-- cell.yield_claim_with_delegated_work_outstanding derives its recorded fact
-- from exactly that (`child.parent_work_claim_id = p_work_claim_id AND
-- child.state = 'active'`, 017:310-315). FC144's "nothing outstanding" refusal
-- would stop firing and a claim could yield on the strength of its own
-- successor. That is a reachable data corruption with a named verb and a named
-- refusal that stops working, not a style objection.
--
-- 001_core.sql's CREATE TABLE carries the same column and constraints inline, so
-- a fresh install and an ALTERed one agree. The ALTERs below are written
-- idempotently because 001 uses CREATE TABLE IF NOT EXISTS and therefore does
-- not reach a database that already exists.

ALTER TABLE cell.work_claim
    ADD COLUMN IF NOT EXISTS predecessor_work_claim_id uuid;

COMMENT ON COLUMN cell.work_claim.predecessor_work_claim_id IS
    'R-A35-23: the interval this one RESUMES. SUCCESSION lineage — same work, '
    'same principal, a later interval — and deliberately NOT '
    'parent_work_claim_id, which is DELEGATION lineage (§2.1: a child claim '
    'owned by a DIFFERENT principal). Overloading the parent column would make '
    'a successor look like an outstanding delegated child to '
    'cell.yield_claim_with_delegated_work_outstanding (017), letting a claim '
    'yield on the strength of its own successor. NULL for every interval that '
    'resumed nothing, which is the majority case.';

ALTER TABLE cell.work_claim
    DROP CONSTRAINT IF EXISTS work_claim_predecessor_fkey;
ALTER TABLE cell.work_claim
    ADD CONSTRAINT work_claim_predecessor_fkey
        FOREIGN KEY (org_id, predecessor_work_claim_id)
        REFERENCES cell.work_claim (org_id, work_claim_id);

ALTER TABLE cell.work_claim
    DROP CONSTRAINT IF EXISTS work_claim_predecessor_is_not_itself;
ALTER TABLE cell.work_claim
    ADD CONSTRAINT work_claim_predecessor_is_not_itself
        CHECK (predecessor_work_claim_id IS DISTINCT FROM work_claim_id);

-- EXACTLY ONE successor per interval, unstorable to violate, for EVERY writer —
-- the same argument 001_core.sql:187-193 makes for unique active ownership. It
-- is the layer that holds when the predicate cannot: the unique-ACTIVE index is
-- partial and stops refusing the moment a successor reaches its own terminal,
-- which is precisely the quiet window between an assertion and its settlement.
CREATE UNIQUE INDEX IF NOT EXISTS work_claim_one_successor_per_predecessor
    ON cell.work_claim (org_id, predecessor_work_claim_id)
    WHERE predecessor_work_claim_id IS NOT NULL;

-- ---------------------------------------------------- the OLD claim signature
--
-- 002 now declares cell.claim_work with twelve arguments. CREATE OR REPLACE
-- FUNCTION with a different argument list installs a SECOND function rather than
-- replacing the first, so the eleven-argument form is dropped here — leaving
-- both would be two claim paths, which is the one thing 002 exists not to have,
-- and a caller that kept the old shape would write successor claims with no
-- provenance at all. L5: the obsolete mechanism goes in the same change.
--
-- A no-op on a fresh install, where 002 created only the twelve-argument form.
DROP FUNCTION IF EXISTS cell.claim_work(
    text, text, uuid, uuid, text, text, text, timestamptz, text, timestamptz, uuid);

-- =========================================================================
-- 1-bis. ONE SPELLING OF "IS THIS A HANDBACK"
-- =========================================================================
--
-- Three places in this file ask it — the view's WHERE, the writer guard's
-- narrowing, and the verb's G2 — and three spellings of one predicate is how a
-- fourth cause comes to be recognised by two of them and not the third. It is a
-- FUNCTION and not a repeated expression for the same reason `cell.written_by`
-- is: two answers to a question the whole guard family rests on is two answers.
--
-- It resolves through the REGISTRY (`cell.claim_yield_cause`, 017:122-125)
-- rather than matching the prefix as a literal, so a third cause reaches every
-- one of the three readers by landing its row.
CREATE OR REPLACE FUNCTION cell.terminal_basis_is_a_handback(p_basis text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $is_handback$
    SELECT EXISTS (
        SELECT 1 FROM cell.claim_yield_cause c
         WHERE c.basis_prefix = split_part(p_basis, ':', 1)
           AND c.cause = 'cell.yield_claim_with_delegated_work_outstanding')
$is_handback$;

COMMENT ON FUNCTION cell.terminal_basis_is_a_handback IS
    'Does this terminal_basis name the delegated-work-outstanding yield cause — '
    'the ONE yield that has a resumption verb. Read from cell.claim_yield_cause '
    'rather than matched as a literal, and stated once because the view, the '
    'writer guard and the verb''s G2 all ask it.';

-- =========================================================================
-- 2. THE ELIGIBILITY SURFACE — a view, holding no authority
-- =========================================================================

CREATE OR REPLACE VIEW cell.v_returned_work AS
SELECT pred.org_id,
       pred.task_id,
       pred.work_claim_id            AS predecessor_work_claim_id,
       pred.principal_id             AS resuming_principal,
       pred.department,
       pred.terminal_basis,
       pred.ownership_ended_at       AS returned_after,
       d.total_deps, d.satisfied_deps
  FROM cell.work_claim pred
  JOIN cell.v_task_open_deps d
    ON d.org_id = pred.org_id AND d.task_id = pred.task_id
 WHERE pred.state = 'yielded'
   AND cell.terminal_basis_is_a_handback(pred.terminal_basis)
   -- `total_deps > 0` is load-bearing: all_deps_satisfied is
   -- (open_deps = 0 AND retracted_deps = 0), which is trivially TRUE for a task
   -- carrying no edges at all — and a yield that never waited on anything is not
   -- work that came back.
   AND d.total_deps > 0
   AND d.all_deps_satisfied
   AND NOT EXISTS (SELECT 1 FROM cell.work_claim live
                    WHERE live.org_id = pred.org_id AND live.task_id = pred.task_id
                      AND live.state = 'active')
   AND NOT EXISTS (SELECT 1 FROM cell.work_claim succ
                    WHERE succ.org_id = pred.org_id
                      AND succ.predecessor_work_claim_id = pred.work_claim_id);

COMMENT ON VIEW cell.v_returned_work IS
    'What is RETURNABLE: an obligation handed back with delegated work '
    'outstanding, whose declared dependencies have since been released, with no '
    'live owner and no successor yet. A view and not a table because every fact '
    'in it is already owned by a verb, and a writer of eligibility would be a '
    'second authority over the work lifecycle (L1). It never answers who may '
    'resume — that is cell.reclaim_returned_work''s, under FC-A.';

-- =========================================================================
-- 3. THE DURABLE, CONSUMED-ONCE RETURN STIMULUS
-- =========================================================================

CREATE TABLE IF NOT EXISTS cell.return_stimulus (
    org_id                    text        NOT NULL,
    task_id                   text        NOT NULL,

    -- The interval that handed the work back. It is also the IDENTITY of this
    -- row: a stable idempotency key that needs no derivation, because at most
    -- one interval is ever the predecessor of at most one successor
    -- (work_claim_one_successor_per_predecessor, above).
    predecessor_work_claim_id uuid        NOT NULL,

    -- What the release rested on. NOT NULL: a stimulus that could not name the
    -- verdict behind it would be a release nobody can audit, which is the exact
    -- shape of the Mac's void events (zero consumers, because they could not
    -- answer "who released this, on what basis, when").
    release_verification_id   uuid        NOT NULL,
    released_at               timestamptz NOT NULL,

    -- WHICH POLICY ROUTED THE RETURN. Today the cell has exactly one and it is
    -- a ruling rather than a row: FC-B is ruled No, so a return re-seats the
    -- predecessor's principal and cross-principal movement is a different verb.
    -- L8 (dated bridge): when PRD §8.4's policy-driven stimulus routing lands,
    -- this column names the policy ROW instead of the ruling. RETIREMENT
    -- CONDITION: a policy registry exists that this column can reference.
    -- DELETION OWNER: the A4 admission/gateway lane (the post-extraction
    -- supervisor task, R-A35-25 §4). PHASE: A4.
    routing_policy_ref        text        NOT NULL,

    recorded_at               timestamptz NOT NULL,

    -- CONSUMED-ONCE. NULL exactly while no interval has resumed on this release;
    -- the pair is written together by cell.reclaim_returned_work and by nothing
    -- else, and the guard below refuses a second transition.
    consumed_at               timestamptz,
    consumed_by_work_claim_id uuid,

    CONSTRAINT return_stimulus_pkey PRIMARY KEY (org_id, predecessor_work_claim_id),

    CONSTRAINT return_stimulus_predecessor_fkey
        FOREIGN KEY (org_id, predecessor_work_claim_id)
        REFERENCES cell.work_claim (org_id, work_claim_id),

    CONSTRAINT return_stimulus_task_fkey
        FOREIGN KEY (org_id, task_id) REFERENCES cell.task (org_id, task_id),

    CONSTRAINT return_stimulus_verification_fkey
        FOREIGN KEY (release_verification_id)
        REFERENCES cell.verification (verification_id),

    CONSTRAINT return_stimulus_consumer_fkey
        FOREIGN KEY (org_id, consumed_by_work_claim_id)
        REFERENCES cell.work_claim (org_id, work_claim_id),

    -- A consumption is an instant AND a consumer, or it is not a consumption.
    -- One without the other is a row that says a wake happened and cannot say
    -- whose, which is the hole L13's provenance requirement exists to close.
    CONSTRAINT return_stimulus_consumption_names_its_consumer
        CHECK ((consumed_at IS NULL) = (consumed_by_work_claim_id IS NULL)),

    CONSTRAINT return_stimulus_consumption_follows_the_release
        CHECK (consumed_at IS NULL OR consumed_at >= released_at),

    CONSTRAINT return_stimulus_routing_policy_is_named
        CHECK (length(btrim(routing_policy_ref)) > 0)
);

COMMENT ON TABLE cell.return_stimulus IS
    'R-A35-24 §3: an accepted release of delegated work records ONE durable, '
    'consumed-once return stimulus. EVIDENCE, never eligibility — nothing reads '
    'it as a precondition, so a lost stimulus cannot make a lawful return '
    'unlawful. It is what makes "the release happened and exactly one interval '
    'resumed on it" answerable after every process that saw it has died (L2).';

-- The stimulus is written by the RELEASE, and consumed by the RETURN. Both are
-- the PL/pgSQL call stack rather than a column a writer could type: a
-- `recorded_by` column alone is authorised by typing the right string into it,
-- and MEASURED, 23 historical `verified` settles reached the Mac's bus by direct
-- publish naming exactly the right evaluator.
CREATE OR REPLACE FUNCTION cell.enforce_return_stimulus_is_the_releases()
RETURNS trigger
LANGUAGE plpgsql
AS $stimulus_writer$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT cell.written_by('cell.record_return_stimulus') THEN
            RAISE EXCEPTION
                'RETURN_STIMULUS_RECORDED_OUTSIDE_THE_RELEASE:%/% — a return '
                'stimulus records what a DEPENDENCY RELEASE did, and it is '
                'written by the trigger that observes the release and by nothing '
                'else. A writer that could type one would be declaring that work '
                'came back when no verdict released it — the eligibility view '
                'would still refuse the return, and the evidence record would '
                'still be a lie.',
                NEW.org_id, NEW.task_id
                USING ERRCODE = 'FC188';
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE. Only the transition INTO a consumed stimulus is guarded, and only
    -- once: a row that is already consumed carries a settled fact, and a second
    -- transition would give "who resumed on this release" two answers.
    IF NEW.consumed_at IS NOT DISTINCT FROM OLD.consumed_at
       AND NEW.consumed_by_work_claim_id IS NOT DISTINCT FROM OLD.consumed_by_work_claim_id THEN
        RETURN NEW;
    END IF;

    IF OLD.consumed_at IS NOT NULL
       OR NOT cell.written_by('cell.reclaim_returned_work') THEN
        RAISE EXCEPTION
            'RETURN_STIMULUS_CONSUMED_OUTSIDE_THE_RETURN_VERB:%/%:% — a stimulus '
            'is consumed exactly once, by cell.reclaim_returned_work, in the same '
            'transaction as the interval that resumed on it. This row was '
            'consumed at % already, or by something that is not that verb.',
            NEW.org_id, NEW.task_id, NEW.predecessor_work_claim_id,
            coalesce(OLD.consumed_at::text, '<not yet>')
            USING ERRCODE = 'FC189';
    END IF;

    RETURN NEW;
END;
$stimulus_writer$;

CREATE OR REPLACE TRIGGER return_stimulus_is_written_by_the_release
    BEFORE INSERT OR UPDATE ON cell.return_stimulus
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_return_stimulus_is_the_releases();

-- The observer. AFTER UPDATE on cell.dep_edge, narrowed to the transition INTO
-- `satisfied`, and firing only when that release was the LAST one this
-- obligation was waiting on — a stimulus per edge would say "something moved",
-- and what a wake needs to know is "this obligation is returnable now".
--
-- The instant is the EDGE's own `settled_at`, never now(): the release said when
-- it happened and this row transcribes it (011:263-287 / 015:162-171).
CREATE OR REPLACE FUNCTION cell.record_return_stimulus()
RETURNS trigger
LANGUAGE plpgsql
AS $record_stimulus$
DECLARE
    v_pred          cell.work_claim%ROWTYPE;
    v_verification  uuid;
BEGIN
    IF NEW.state IS DISTINCT FROM 'satisfied' OR OLD.state = 'satisfied' THEN
        RETURN NULL;
    END IF;

    -- The interval that handed this work back, if there is one. The predicate is
    -- the view's own, spelled here rather than SELECTed from it: a trigger that
    -- read the view would fire on a row the view has already excluded for a
    -- reason (an active claim, an existing successor) that has nothing to do
    -- with whether a release happened.
    SELECT * INTO v_pred
      FROM cell.work_claim pred
     WHERE pred.org_id = NEW.org_id AND pred.task_id = NEW.task_id
       AND pred.state = 'yielded'
       AND cell.terminal_basis_is_a_handback(pred.terminal_basis)
     ORDER BY pred.ownership_ended_at DESC, pred.claimed_at DESC, pred.work_claim_id
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN NULL;                    -- an ordinary release; nothing came back
    END IF;

    -- Not the last edge: the obligation is still blocked, and a stimulus here
    -- would name a return that has not happened.
    IF NOT EXISTS (SELECT 1 FROM cell.v_task_open_deps d
                    WHERE d.org_id = NEW.org_id AND d.task_id = NEW.task_id
                      AND d.total_deps > 0 AND d.all_deps_satisfied) THEN
        RETURN NULL;
    END IF;

    -- Already recorded. The predicate is the readable path and the primary key
    -- is the guarantee (002's own words): two concurrent releases racing here
    -- both pass this check and one meets return_stimulus_pkey, which is a loud
    -- rollback rather than two answers.
    IF EXISTS (SELECT 1 FROM cell.return_stimulus s
                WHERE s.org_id = NEW.org_id
                  AND s.predecessor_work_claim_id = v_pred.work_claim_id) THEN
        RETURN NULL;
    END IF;

    -- The verdict the release rested on, read over the GATING task and at or
    -- before the release instant. Absent for the five families that release on
    -- an observation this substrate does not hold, and the row is then not
    -- written at all rather than written with a hole (see the header).
    SELECT v.verification_id INTO v_verification
      FROM cell.verification v
     WHERE v.org_id = NEW.org_id
       AND v.task_id = NEW.gating_task_id
       AND v.result = 'verified'
       AND v.recorded_at <= NEW.settled_at
     ORDER BY v.recorded_at, v.verification_id
     LIMIT 1;

    IF v_verification IS NULL THEN
        RETURN NULL;
    END IF;

    INSERT INTO cell.return_stimulus (
        org_id, task_id, predecessor_work_claim_id, release_verification_id,
        released_at, routing_policy_ref, recorded_at, consumed_at,
        consumed_by_work_claim_id)
    VALUES (
        NEW.org_id, NEW.task_id, v_pred.work_claim_id, v_verification,
        NEW.settled_at,
        -- FOUNDER RULING R-A35-25 §5 (FC-B, "No"): the return re-seats the
        -- predecessor's principal, and that is the whole of the routing policy
        -- the cell has. Named as the RULING because there is no policy row to
        -- point at; the L8 terms for replacing it are on the column.
        'R-A35-25:same_principal_return',
        NEW.settled_at, NULL, NULL);

    RETURN NULL;
END;
$record_stimulus$;

CREATE OR REPLACE TRIGGER dep_edge_release_records_a_return_stimulus
    AFTER UPDATE ON cell.dep_edge
    FOR EACH ROW EXECUTE FUNCTION cell.record_return_stimulus();

-- =========================================================================
-- 4. THE WRITER GUARD — what closes today's hole
-- =========================================================================
--
-- BEFORE INSERT, because a resumption is a NEW claim row and never an update of
-- the interval it follows (§1.2: the ended interval stays in the record exactly
-- as it ended, L12). Narrowed to the one intersection that matters: a SECOND
-- interval on a task whose holder handed the work back. A first claim on work
-- nobody yielded is an ordinary claim and stays one.
CREATE OR REPLACE FUNCTION cell.enforce_returned_resumption_is_a_declared_cause()
RETURNS trigger
LANGUAGE plpgsql
AS $returned_writer$
DECLARE
    v_last cell.work_claim%ROWTYPE;
BEGIN
    -- The interval this row would follow: the LAST one to END on this task. Not
    -- "any yielded interval anywhere in the history" — a task whose second
    -- episode ended by assertion is not waiting on anything, and a guard that
    -- read the whole history would refuse every later claim on any task that ever
    -- had a handback in it.
    SELECT * INTO v_last
      FROM cell.work_claim prior
     WHERE prior.org_id = NEW.org_id
       AND prior.task_id = NEW.task_id
       AND prior.work_claim_id <> NEW.work_claim_id
       AND prior.ownership_ended_at IS NOT NULL
     ORDER BY prior.ownership_ended_at DESC, prior.claimed_at DESC, prior.work_claim_id
     LIMIT 1;

    -- Not a return-resumption. Three ways, each deliberate:
    --
    --   (i)  no ended interval at all, or the last one ended some other way. The
    --        claim path's own refusals (FC001/FC002/FC003) are what apply.
    --
    --   (ii) the last interval yielded for the OTHER declared cause. 017 declares
    --        two, and only the handback has a resumption verb: a
    --        `confirm_ask_expired` yield is a question nobody answered, and what
    --        may follow it is FOUNDER CHECKPOINT FC-D, which is open and is W4's.
    --        A guard that refused every writer there would settle FC-D by side
    --        effect — this file may refuse the road it owns and may not close one
    --        nobody has designed yet.
    --
    --   (iii) a basis no registered cause could have derived. `cell.claim_yield_cause`
    --        (017:122-125) is what makes "why did responsibility pass" resolvable,
    --        and a prefix outside it names no cause at all. Read from the registry
    --        rather than spelled here, so a third cause reaches this guard by
    --        landing its row and not by remembering to edit this file.
    IF NOT FOUND
       OR v_last.state IS DISTINCT FROM 'yielded'
       OR NOT cell.terminal_basis_is_a_handback(v_last.terminal_basis)
    THEN
        RETURN NEW;
    END IF;

    -- The OTHER declared resumption cause steps through here untouched. 016's own
    -- guard (FC130) is what governs a reopen — it requires
    -- cell.reclaim_reopened_task on the stack for a second interval on a task the
    -- seat reopened — and two guards demanding two different verbs of one INSERT
    -- would make a task that was both reopened AND handed back unclaimable by
    -- anything at all. The more specific, already-shipped cause wins, and D1's
    -- retirement condition covers the case where a THIRD cause makes naming them
    -- here worse than a registry.
    IF NOT cell.written_by('cell.reclaim_returned_work')
       AND NOT cell.written_by('cell.reclaim_reopened_task') THEN
        RAISE EXCEPTION
            'RETURNED_WORK_RESUMED_OUTSIDE_A_DECLARED_CAUSE:%/% — the next '
            'claimant of work that was handed back is seated by '
            'cell.reclaim_returned_work and by nothing else. A runtime that '
            'seated this claim would be naming the principal who answers for '
            'work next, on the strength of noticing that a dependency closed — '
            'the authority L11 says a capability may never widen for itself. The '
            'writer signal is the PL/pgSQL call stack, which a direct writer '
            'cannot fabricate, rather than a column it could type: 23 historical '
            '`verified` settles reached the bus by direct publish naming exactly '
            'the right evaluator.',
            NEW.org_id, NEW.task_id
            USING ERRCODE = 'FC180';
    END IF;

    RETURN NEW;
END;
$returned_writer$;

CREATE OR REPLACE TRIGGER work_claim_return_resumption_is_a_declared_cause
    BEFORE INSERT ON cell.work_claim
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_returned_resumption_is_a_declared_cause();

-- =========================================================================
-- 5. THE VERB
-- =========================================================================
--
-- Every argument is required and none may grow a default. The three the caller
-- supplies are an IDENTITY, an INSTANT and an EVENT ID — the same three 013, 015
-- and 016 take — and everything the row MEANS is read off the substrate. There
-- is nowhere in this signature to put a principal a caller picked, which is
-- FC-B's ruling expressed as a shape rather than as a check.
--
-- It ANSWERS WHETHER THIS CALL MOVED ANYTHING, like every verb in 012, 013, 015
-- and 016: an eligibility wake may fire arbitrarily often, and "the work was
-- resumed" and "somebody already resumed it" are different facts to a seat that
-- has to write down what its wake did. A wake that resumed nothing must be
-- distinguishable in evidence from one that never looked.
CREATE OR REPLACE FUNCTION cell.reclaim_returned_work(
    p_org_id        text,
    p_task_id       text,
    p_work_claim_id uuid,
    p_claimed_at    timestamptz,
    p_event_id      uuid
)
RETURNS boolean
LANGUAGE plpgsql
AS $reclaim_returned$
DECLARE
    v_verify_by  timestamptz;
    v_pred       cell.work_claim%ROWTYPE;
    v_live       uuid;
    v_successor  uuid;
    v_deps       cell.v_task_open_deps%ROWTYPE;
BEGIN
    -- G0. The task's policy row, locked before anything is read off it: two
    -- wakes resuming the same work on the same tick serialize HERE, and the
    -- loser re-reads after the winner has committed rather than both seeing an
    -- unowned obligation.
    SELECT verify_by INTO v_verify_by
      FROM cell.task
     WHERE org_id = p_org_id AND task_id = p_task_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'RETURN_RECLAIM_TASK_UNKNOWN:%/% — resuming is an act on work the '
            'company has a record of. A return that matched nothing would report '
            'a claimant for a task nobody can later account for.',
            p_org_id, p_task_id
            USING ERRCODE = 'FC181';
    END IF;

    -- G1. The interval being resumed: the LAST one to END, which is the one
    -- whose holder was answerable for this work most recently. Everything the
    -- fresh claim says about WHO is read from this row.
    SELECT * INTO v_pred
      FROM cell.work_claim
     WHERE org_id = p_org_id AND task_id = p_task_id
       AND ownership_ended_at IS NOT NULL
     ORDER BY ownership_ended_at DESC, claimed_at DESC, work_claim_id
     LIMIT 1;

    IF NOT FOUND OR v_pred.state IS DISTINCT FROM 'yielded' THEN
        -- Before refusing: a handback on this task that has ALREADY been resumed,
        -- whose successor has since reached its own terminal, is why the last
        -- ENDED interval is not the yield any more. That is a REPLAY of a wake
        -- this verb already answered, not work with no handback behind it, and
        -- L1-2's discipline is that a wake which resumed nothing says `false`
        -- rather than raising. It is also §7.1 leg 18's shape from the other
        -- side: an older yield under a later interval is not returnable, and the
        -- honest report of that is "nothing to do" rather than an error.
        SELECT succ.work_claim_id INTO v_successor
          FROM cell.work_claim pred
          JOIN cell.work_claim succ
            ON succ.org_id = pred.org_id
           AND succ.predecessor_work_claim_id = pred.work_claim_id
         WHERE pred.org_id = p_org_id AND pred.task_id = p_task_id
           AND pred.state = 'yielded'
         ORDER BY pred.ownership_ended_at DESC, pred.work_claim_id
         LIMIT 1;

        IF FOUND THEN
            -- G5's rule, reached early. Replay and duplicate are different facts
            -- here for the same reason they are there: the same id resumed
            -- nothing and says so; a different id over a handback that has
            -- already been returned is a second interval claiming to be the
            -- return of one yield, and it is refused loudly whether or not its
            -- predecessor is still the last interval to have ended.
            IF v_successor = p_work_claim_id THEN
                RETURN false;
            END IF;
            RAISE EXCEPTION
                'RETURN_RECLAIM_PREDECESSOR_ALREADY_RESUMED:%:%:% — this work''s '
                'handback was already resumed by %, and this call names a '
                'different id. One yield has one return: two intervals both '
                'claiming to be it would make "which one answers for this work" '
                'unanswerable from the record.',
                p_org_id, p_task_id, p_work_claim_id, v_successor
                USING ERRCODE = 'FC186';
        END IF;

        RAISE EXCEPTION
            'RETURN_RECLAIM_NO_YIELDED_PREDECESSOR:%/%:% — a return resumes a '
            'HANDBACK. This work''s last interval ended some other way — by '
            'assertion, abort, takeover or expiry — or it has no ended interval '
            'at all, and a resumption of it (if there should be one) belongs to a '
            'different cause with a different verb.',
            p_org_id, p_task_id,
            coalesce(v_pred.state, '<no ended interval>')
            USING ERRCODE = 'FC182';
    END IF;

    -- G2. 017 declares TWO yield causes, and only one of them is work coming
    -- back. A `confirm_ask_expired` yield is a question nobody answered — an
    -- escalation to the assigner — and resuming it would restart a principal on
    -- work whose blocking decision still does not exist. The basis PREFIX is the
    -- registry-resolvable discriminator (cell.claim_yield_cause, 017:122-125).
    IF NOT cell.terminal_basis_is_a_handback(v_pred.terminal_basis) THEN
        RAISE EXCEPTION
            'RETURN_RECLAIM_YIELD_WAS_NOT_A_HANDBACK:%/%:% — this interval ended '
            'by a yield whose recorded cause is not delegated work outstanding. '
            'Two causes write one meaning (017); only the handback is work coming '
            'back, and the other is an escalation somebody still owes an answer '
            'to.',
            p_org_id, p_task_id, coalesce(v_pred.terminal_basis, '<none>')
            USING ERRCODE = 'FC183';
    END IF;

    -- G3. THE RETURNED FACT ITSELF. `total_deps > 0` is load-bearing for the
    -- same reason it is in the view: all_deps_satisfied is trivially true for a
    -- task with no edges, and a yield that never waited on anything did not have
    -- anything come back.
    SELECT * INTO v_deps
      FROM cell.v_task_open_deps
     WHERE org_id = p_org_id AND task_id = p_task_id;

    IF NOT FOUND OR NOT v_deps.total_deps > 0 OR NOT v_deps.all_deps_satisfied THEN
        RAISE EXCEPTION
            'RETURN_RECLAIM_DEPENDENCY_STILL_OPEN:%/%:% — the work this '
            'obligation was waiting on has not been released. The dependency '
            'release IS the returned fact: without it this verb would seat a '
            'principal on work that is still blocked, and the handback it '
            'reverses would have reversed nothing.',
            p_org_id, p_task_id,
            coalesce(v_deps.open_deps::text, '<no declared dependency>')
            USING ERRCODE = 'FC184';
    END IF;

    -- G4. A LIVE OWNER ends this call, and it is the idempotency PREDICATE
    -- rather than a set this verb remembers: a restart takes a remembered set
    -- with it, which is the whole reason L2 puts durable state below the agent.
    -- It is also the honest answer for work somebody else has already picked up.
    SELECT work_claim_id INTO v_live
      FROM cell.work_claim
     WHERE org_id = p_org_id AND task_id = p_task_id AND state = 'active';

    IF FOUND THEN
        RETURN false;
    END IF;

    -- G5. Replay and duplicate are DIFFERENT FACTS. A replay of the same derived
    -- id resumed nothing and says so; a different id over the same predecessor is
    -- a second interval claiming to be the return of one yield, and it is refused
    -- loudly. Beneath both, work_claim_pkey and
    -- work_claim_one_successor_per_predecessor hold against a writer that never
    -- called this verb.
    SELECT work_claim_id INTO v_successor
      FROM cell.work_claim
     WHERE org_id = p_org_id
       AND predecessor_work_claim_id = v_pred.work_claim_id;

    IF FOUND THEN
        IF v_successor = p_work_claim_id THEN
            RETURN false;
        END IF;
        RAISE EXCEPTION
            'RETURN_RECLAIM_PREDECESSOR_ALREADY_RESUMED:%:%:% — interval % was '
            'already resumed by %, and this call names a different id. One yield '
            'has one return: two intervals both claiming to be it would make '
            '"which one answers for this work" unanswerable from the record.',
            p_org_id, p_task_id, p_work_claim_id,
            v_pred.work_claim_id, v_successor
            USING ERRCODE = 'FC186';
    END IF;

    -- G6. Two intervals of responsibility over one task may not overlap in the
    -- record: a history saying two principals were answerable at once is the
    -- exact state unique active ownership exists to make impossible, and a
    -- runtime that could pick the instant could write one by choosing an earlier
    -- clock (016:234-245's reasoning, verbatim).
    IF p_claimed_at < v_pred.ownership_ended_at THEN
        RAISE EXCEPTION
            'RETURN_RECLAIM_RESUMES_BEFORE_THE_INTERVAL_IT_FOLLOWS:%:% — the '
            'interval this return follows ended at %, and this claim is stamped '
            '%.',
            p_task_id, p_work_claim_id, v_pred.ownership_ended_at, p_claimed_at
            USING ERRCODE = 'FC185';
    END IF;

    -- THE ONE CLAIM PATH, called rather than re-spelled. The lock, the mode
    -- check (R7), the unique-active-ownership refusal and the claim-meaning event
    -- are the same ones every other claimant meets. Nothing is set to authorize
    -- the write: THIS frame, on the call stack, is what the guard above reads,
    -- and it stops existing when the function returns.
    --
    -- Every value is READ. `p_principal_id` is the predecessor's — FC-B, ruled
    -- No — the delegation lineage is PROPAGATED, and the ownership window is the
    -- TASK's own verify_by, the one recorded answer to "by when is this due".
    PERFORM cell.claim_work(
        p_org_id                    => p_org_id,
        p_task_id                   => p_task_id,
        p_work_claim_id             => p_work_claim_id,
        p_parent_work_claim_id      => v_pred.parent_work_claim_id,
        p_predecessor_work_claim_id => v_pred.work_claim_id,
        p_principal_id              => v_pred.principal_id,
        p_department                => v_pred.department,
        p_claim_mode                => v_pred.claim_mode,
        p_ownership_valid_until     => v_verify_by,
        p_contract_ref              => v_pred.contract_ref,
        p_claimed_at                => p_claimed_at,
        p_event_id                  => p_event_id);

    -- The stimulus, consumed in the SAME transaction as the interval that
    -- resumed on it. `WHERE consumed_at IS NULL` and not a re-read: the row lock
    -- the UPDATE takes is what settles two wakes, and a row that is already
    -- consumed is simply not matched. A stimulus that is absent — the five
    -- dependency families with no verdict behind them — leaves this a no-op,
    -- because the stimulus is evidence and never a precondition.
    UPDATE cell.return_stimulus
       SET consumed_at               = p_claimed_at,
           consumed_by_work_claim_id = p_work_claim_id
     WHERE org_id = p_org_id
       AND predecessor_work_claim_id = v_pred.work_claim_id
       AND consumed_at IS NULL;

    RETURN true;
END;
$reclaim_returned$;

COMMENT ON FUNCTION cell.reclaim_returned_work IS
    'R-A35-23 / FOUNDER RULING R-A35-25 §5: the obligation handed back with '
    'delegated work outstanding gets a SECOND interval when that work returns, '
    'and the same principal answers for it. A TRANSCRIPTION — the principal, '
    'department, mode, contract ref and delegation lineage are read off the '
    'interval being resumed and the ownership window off the task''s own '
    'verify_by — and it goes through cell.claim_work rather than around it.';
