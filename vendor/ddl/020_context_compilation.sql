-- 020_context_compilation.sql — the ContextCompilation provenance record.
--
-- Contract: R-A3-5 (FOUNDER RULING 2026-08-20 — "Context is disposable, context
-- compilation is reproducible, and company state is authoritative"; the
-- ContextCompilation first-class object) + R-A3-6 point 4/5, worksheet §7,
-- a3-verification-strategy.md §3.3 rows CTX-PROVENANCE / CTX-FRONTIER /
-- CTX-ARTIFACT / CTX-BUDGET. Requires 001_core.sql.
--
-- Re-apply: idempotent (CREATE ... IF NOT EXISTS throughout).
-- Revert:   DROP TABLE cell.context_compilation;
--
-- WHY THIS TABLE HOLDS NO LOAD-BEARING FK
--
-- A ContextCompilation answers "what did the agent know when it decided?" — it is
-- FOOTAGE, an evidence asset (L14), not a second authority for settlement. So it
-- carries its subject identifiers as plain columns and NOT as foreign keys into
-- the work spine: a compilation row must never be able to block a claim from
-- settling, and a settlement path must never wait on a provenance write. The
-- attempt row references a compilation by id (021), but that reference is itself
-- nullable and non-load-bearing — the spine settles whether or not the footage
-- was captured, and a MISSING compilation is a red the CTX-* falsifiers read, not
-- a constraint that stops the company from working.

CREATE TABLE IF NOT EXISTS cell.context_compilation (
    compilation_id        uuid        NOT NULL,
    org_id                text        NOT NULL,

    -- The subject of the compilation, as plain (non-FK) identifiers — the work
    -- claim it was compiled for, and optionally the principal and decision. A
    -- soft reference on purpose (see header): footage names its subject without
    -- becoming load-bearing for it.
    work_claim_id         uuid        NOT NULL,
    principal_id          text        NOT NULL,
    decision_id           text,

    objective             text        NOT NULL,

    -- INITIAL | DELTA | RECONCILE | RECOMPILE — the three continuity mechanisms
    -- R-A3-5 names (resume→DELTA, compact→RECONCILE, fresh→RECOMPILE) plus the
    -- first allocation. CTX-RECOMPILE/-DELTA/-RECONCILE assert the SessionStart
    -- source-router recorded which one produced this package.
    mode                  text        NOT NULL,

    compiled_at           timestamptz NOT NULL,

    -- CTX-PROVENANCE: per-source refs AND hashes, so the package can be traced
    -- back to exactly which company-state reads produced it. An object keyed by
    -- source name; each value carries the ref(s) consulted and their hash.
    source_refs           jsonb       NOT NULL,

    -- CTX-FRONTIER: the per-source frontier, valid_at vs known_at PRESERVED — a
    -- projection claiming currency without declaring the instant it is current AS
    -- OF and the instant it was KNOWN AS OF is a hindsight leak waiting to happen.
    -- Candidate PRD law (staged A3.1): derived state declares its source frontier.
    source_frontier       jsonb       NOT NULL,

    strategy_version      text        NOT NULL,

    -- CTX-BUDGET: ONE budget, and everything dropped to fit it recorded in
    -- excluded[] with its reason. Silent omission is the failure; an explicit
    -- (possibly empty) array is the honest report.
    budget                bigint      NOT NULL,
    excluded              jsonb       NOT NULL,

    -- CTX-ARTIFACT: the content-addressed package. package_hash is the hash of
    -- the compiled context; exact_context_artifact_ref resolves to the EXACT
    -- bytes supplied to the model, so a recomputed hash can be checked equal.
    package_hash          text        NOT NULL,
    exact_context_artifact_ref text   NOT NULL,

    CONSTRAINT context_compilation_pkey PRIMARY KEY (compilation_id),

    CONSTRAINT context_compilation_mode_is_a_declared_mode
        CHECK (mode IN ('initial', 'delta', 'reconcile', 'recompile')),

    CONSTRAINT context_compilation_source_refs_is_an_object
        CHECK (jsonb_typeof(source_refs) = 'object'),

    -- Load-bearing IS NOT NULL echo of 001's plan-status guard: with no frontier
    -- key the -> yields SQL NULL, jsonb_typeof(NULL) is NULL, and a CHECK passes
    -- on NULL — so an object is required, not merely "not a non-object".
    CONSTRAINT context_compilation_frontier_is_an_object
        CHECK (jsonb_typeof(source_frontier) = 'object'),

    CONSTRAINT context_compilation_excluded_is_an_array
        CHECK (jsonb_typeof(excluded) = 'array'),

    CONSTRAINT context_compilation_budget_is_positive
        CHECK (budget > 0),

    CONSTRAINT context_compilation_package_hash_is_addressable
        CHECK (length(btrim(package_hash)) > 0),

    CONSTRAINT context_compilation_artifact_ref_is_addressable
        CHECK (length(btrim(exact_context_artifact_ref)) > 0)
);

COMMENT ON TABLE cell.context_compilation IS
    'R-A3-5: the ContextCompilation. Footage answering "what did the agent know '
    'when it decided?" — per-source refs+hashes, the valid_at/known_at frontier, '
    'the budget and what it excluded, and the content-addressed exact context '
    'artifact. Evidence (L14), never a settlement authority: no load-bearing FK.';

CREATE INDEX IF NOT EXISTS context_compilation_by_claim
    ON cell.context_compilation (org_id, work_claim_id, compiled_at);
