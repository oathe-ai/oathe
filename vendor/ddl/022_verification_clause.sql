-- 022_verification_clause.sql — the acceptance-clause object, minimal.
--
-- Contract: worksheet §7 acceptance lane ("the acceptance-package v1 port —
-- author/executor/seat split, task_id-keyed, +evidence_refs/trace_ref/
-- privacy_class/transfer_scope") + a3-verification-strategy.md §3.3 rows
-- ACC-CLAUSE-SCHEMA / ACC-PACKAGE-SPLIT / ACC-NON-AUTHOR. Requires 001_core.sql.
--
-- Re-apply: idempotent (CREATE ... IF NOT EXISTS).
-- Revert:   DROP TABLE cell.verification_clause;
--
-- MINIMAL BY RULING. This is the clause OBJECT and its split — not the acceptance
-- lane. The registered-checker runner, the fail-toward-blocked verdict producer
-- and the eval-is-not-a-verdict gate are a later layer (REC-1); this file gives
-- the schema those legs will assert against, and the two invariants that are a
-- property of the object itself: the author/executor/seat split is TYPED (three
-- distinct identity fields, not one), and the seat that releases a clause is not
-- the author of the work it releases (ACC-NON-AUTHOR, the R1 rule at clause
-- grain). Everything a clause carries that a verification carries — evidence,
-- trace, privacy, transfer — is mandatory here for the same R4 reason.

CREATE TABLE IF NOT EXISTS cell.verification_clause (
    clause_id           uuid        NOT NULL,
    org_id              text        NOT NULL,

    -- Keyed to the task (worksheet §7: "task_id-keyed"), the anchor the
    -- verification plan's clauses and the completion tri-state both count over.
    task_id             text        NOT NULL,

    -- WHICH plan clause this object is about — the same clause name a
    -- verification's verification_plan_ref discharges (e.g. 'acceptance_package').
    clause_key          text        NOT NULL,

    -- The split, TYPED as three identities rather than one (ACC-PACKAGE-SPLIT):
    --   author    — who made the completion claim this clause evaluates
    --   executor  — the runtime actor that produced the work
    --   seat      — the non-author seat that releases the clause
    -- Collapsing any two of these is exactly what let author-run output release
    -- work on the Mac. NULL author/executor is lawful for a clause DECLARED
    -- before any claim; the seat is present only once the clause is released.
    author_principal    text,
    executor_principal  text,
    seat_principal      text,

    -- R4, mandatory and non-empty when a seat has released (an unreleased clause
    -- carries none yet). A released clause with no evidence is a verdict about
    -- nothing checked.
    evidence_refs       jsonb       NOT NULL,

    -- R4: addressable trace, and H7 privacy/transfer, from day one — the same
    -- clauses cell.verification carries, so a clause and the verification that
    -- discharges it cannot disagree about how far the record may travel.
    trace_ref           text,
    privacy_class       text        NOT NULL,
    transfer_scope      text        NOT NULL,

    created_at          timestamptz NOT NULL,

    CONSTRAINT verification_clause_pkey PRIMARY KEY (clause_id),

    CONSTRAINT verification_clause_task_fkey
        FOREIGN KEY (org_id, task_id) REFERENCES cell.task (org_id, task_id),

    -- One object per (task, clause): the plan names a clause once, and a second
    -- object for the same clause is two ideas of what releases it.
    CONSTRAINT verification_clause_task_clause_key UNIQUE (org_id, task_id, clause_key),

    CONSTRAINT verification_clause_key_is_addressable
        CHECK (length(btrim(clause_key)) > 0),

    CONSTRAINT verification_clause_evidence_refs_is_an_array
        CHECK (jsonb_typeof(evidence_refs) = 'array'),

    CONSTRAINT verification_clause_privacy_class_is_a_declared_class
        CHECK (privacy_class IN ('public', 'org_internal', 'customer_derived')),

    CONSTRAINT verification_clause_transfer_scope_is_a_declared_scope
        CHECK (transfer_scope IN ('cell_only', 'org_internal', 'exportable')),

    -- H7, the same constraint verification carries: customer-derived content
    -- stays in the cell.
    CONSTRAINT verification_clause_customer_derived_content_stays_in_the_cell
        CHECK (privacy_class <> 'customer_derived' OR transfer_scope = 'cell_only'),

    -- A released clause (seat present) is non-author (ACC-NON-AUTHOR at clause
    -- grain) and carries its R4 evidence and trace. Before release the seat is
    -- absent and these are not yet due.
    CONSTRAINT verification_clause_release_is_non_author
        CHECK (seat_principal IS NULL
               OR (seat_principal IS DISTINCT FROM author_principal
                   AND seat_principal IS DISTINCT FROM executor_principal)),

    CONSTRAINT verification_clause_release_carries_evidence
        CHECK (seat_principal IS NULL OR jsonb_array_length(evidence_refs) > 0),

    CONSTRAINT verification_clause_release_carries_a_trace
        CHECK (seat_principal IS NULL OR length(btrim(coalesce(trace_ref, ''))) > 0)
);

COMMENT ON TABLE cell.verification_clause IS
    'Minimal acceptance-clause object (worksheet §7). Task-keyed; the '
    'author/executor/seat split is three typed identities; a released clause is '
    'non-author and carries R4 evidence/trace/privacy/transfer. The runner and '
    'the verdict producer are a later layer (REC-1).';

CREATE INDEX IF NOT EXISTS verification_clause_by_task
    ON cell.verification_clause (org_id, task_id, clause_key);
