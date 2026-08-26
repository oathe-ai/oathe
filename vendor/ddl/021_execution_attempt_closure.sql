-- 021_execution_attempt_closure.sql — the execution attempt names its EXACT
-- runtime/config/capability closure, and its context compilation.
--
-- Contract: R-A3-12 (an ExecutionAttempt owns a complete execution tree) + plan
-- §4 ScopeAllocator ("the attempt row carries harness+SDK version, model,
-- session_id, context_compilation_ref and the full runtime/config/capability
-- closure") + a3-verification-strategy.md §3.2 row RT-CLOSURE and §3.3
-- HANDOFF-PROVENANCE. Requires 001_core.sql (extends its execution_attempt) and
-- is ordered after 020 so the context_compilation it references already exists.
--
-- Re-apply: idempotent (ADD COLUMN IF NOT EXISTS; CREATE OR REPLACE).
-- Revert:   ALTER TABLE cell.execution_attempt
--             DROP COLUMN harness_version, DROP COLUMN sdk_version,
--             DROP COLUMN model, DROP COLUMN image_digest,
--             DROP COLUMN config_spine_revision, DROP COLUMN capability_set,
--             DROP COLUMN context_compilation_ref, DROP COLUMN closure;
--           DROP FUNCTION cell.attempts_unattributed();
--
-- WHY THESE COLUMNS ARE NULLABLE, AND WHAT THAT MEANS FOR THE FALSIFIER
--
-- 001_core.sql's execution_attempt is the disposable runtime binding beneath a
-- claim; the work spine (A1/A2) writes attempt rows for the claim lifecycle and
-- knows nothing of an SDK version or a context artifact. Making these ADDED
-- columns NOT NULL would retroactively demand a closure of every spine-written
-- attempt and break the A1/A2 suites that predate the runtime. So the columns are
-- nullable at the SCHEMA level and the completeness rule lives in a FALSIFIER
-- (RT-CLOSURE): cell.attempts_unattributed() returns every attempt missing any
-- closure field, and the runtime's own attempts must return none. A null here is
-- a red the falsifier reads, exactly as an asserted-unverified task past its
-- verify_by is a red cell.unverified_past_verify_by reads — not a state the
-- schema makes unreachable, but one the substrate can NAME.

ALTER TABLE cell.execution_attempt
    ADD COLUMN IF NOT EXISTS harness_version        text,
    ADD COLUMN IF NOT EXISTS sdk_version            text,
    ADD COLUMN IF NOT EXISTS model                  text,
    ADD COLUMN IF NOT EXISTS image_digest           text,
    ADD COLUMN IF NOT EXISTS config_spine_revision  text,
    ADD COLUMN IF NOT EXISTS capability_set         jsonb,
    ADD COLUMN IF NOT EXISTS context_compilation_ref uuid,
    ADD COLUMN IF NOT EXISTS closure                jsonb;

COMMENT ON COLUMN cell.execution_attempt.closure IS
    'R-A3-12 / plan §4: the full runtime/config/capability closure this attempt '
    'was bound with — MCP set, hooks, permission posture, budgets, egress class '
    '— rebound from Oathe state at allocation, never inherited from a prior '
    'process (RT-CLOSURE, RT-ATTEMPT-PROVENANCE).';

COMMENT ON COLUMN cell.execution_attempt.context_compilation_ref IS
    'The cell.context_compilation this attempt was allocated from (R-A3-5). '
    'Non-load-bearing by design: the reference is nullable and the spine settles '
    'without it — a missing ref is a red HANDOFF-PROVENANCE reads, not a block.';

-- ------------------------------------------------ RT-CLOSURE, as a query
--
-- Every attempt names its exact closure: harness+SDK version, model, image
-- digest, config-spine revision, capability set and the context compilation it
-- was allocated from. Every row this returns has a null in one of them and is a
-- red — the runtime's attempts must return NONE. The columns checked are exactly
-- the seven RT-CLOSURE names plus context_compilation_ref; session_id and
-- executor_version are already NOT NULL in 001 and cannot be missing.
CREATE OR REPLACE FUNCTION cell.attempts_unattributed()
RETURNS TABLE (
    attempt_id    uuid,
    work_claim_id uuid,
    missing       text
)
LANGUAGE sql
STABLE
AS $unattributed$
    SELECT a.attempt_id, a.work_claim_id,
           concat_ws(',',
               CASE WHEN a.harness_version        IS NULL THEN 'harness_version' END,
               CASE WHEN a.sdk_version            IS NULL THEN 'sdk_version' END,
               CASE WHEN a.model                  IS NULL THEN 'model' END,
               CASE WHEN a.image_digest           IS NULL THEN 'image_digest' END,
               CASE WHEN a.config_spine_revision  IS NULL THEN 'config_spine_revision' END,
               CASE WHEN a.capability_set          IS NULL THEN 'capability_set' END,
               CASE WHEN a.context_compilation_ref IS NULL THEN 'context_compilation_ref' END
           ) AS missing
      FROM cell.execution_attempt a
     WHERE a.harness_version        IS NULL
        OR a.sdk_version            IS NULL
        OR a.model                  IS NULL
        OR a.image_digest           IS NULL
        OR a.config_spine_revision  IS NULL
        OR a.capability_set          IS NULL
        OR a.context_compilation_ref IS NULL
     ORDER BY a.work_claim_id, a.attempt_id;
$unattributed$;

COMMENT ON FUNCTION cell.attempts_unattributed IS
    'RT-CLOSURE: every row is RED — an execution attempt missing a runtime, '
    'config or capability closure field. A runtime-written attempt names its '
    'whole closure and returns nothing here.';
