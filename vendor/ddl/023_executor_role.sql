-- 023_executor_role.sql — the executor database role: the A3 ENTRY GATE.
--
-- Contract: docs/a3-entry.md "Entry gate (inherited, RULED)" (signed assumption
-- 6) + a3-verification-strategy.md §3.2 row RT-ROLE-DENIED. A2 proved the
-- executor's SOURCE does not write settlement (a source-half proof). This gate
-- converts that into "the executor CANNOT" — a substrate-enforced privilege
-- boundary. Applied LAST so every settlement table it revokes already exists.
--
-- Re-apply: idempotent (DO-guarded CREATE ROLE; GRANT/REVOKE are declarative).
-- Revert:   DROP OWNED BY cell_executor;  DROP ROLE cell_executor;
--
-- THE SETTLEMENT SURFACE, AND THE ANTI-VACUITY HALF
--
-- The settlement surface is where a completion or a verdict becomes the company's
-- truth: cell.verification (the non-author verdict) and cell.work_claim (the
-- claim terminal and its settlement stamp). The executor role gets NO write there.
--
-- But "cannot write settlement" proves nothing if the role cannot write ANYTHING
-- — a role denied everything denies settlement vacuously. So the role is granted
-- exactly the writes the executor legitimately makes — an execution_attempt is
-- its own disposable runtime binding (R1), and an agent_statement is what an
-- agent SAYS (never truth, L10) — and those INSERTs SUCCEED. The gate's falsifier
-- runs a settlement write under this role expecting DENIED, and a permitted write
-- under the same role expecting ACCEPTED, so the denial is proven to be a real
-- privilege boundary and not the role being inert.

-- The guard is BOTH a look-before and a catch-after, deliberately. Roles are
-- CLUSTER-global while this file is applied per-database, so the check and the
-- CREATE are not atomic against a concurrent applier: two scratch cells loading
-- the DDL at the same instant — which is the normal case, the suites run nine
-- appliers in parallel — can both see the role absent and both try to create it.
-- The loser gets `duplicate_object`, and an idempotent migration must not fail on
-- having already got what it wanted. Only that one condition is swallowed.
DO $executor_role$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cell_executor') THEN
        -- NOLOGIN: a privilege template a connection SETs to, not a login of its
        -- own. The deploy binds a login role to it; the cell owns the boundary.
        CREATE ROLE cell_executor NOLOGIN;
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;   -- another applier won the race; that is the outcome we wanted
END
$executor_role$;

-- Reach the schema and read all of it — the executor compiles context and reads
-- the spine constantly; reading is never the boundary.
GRANT USAGE ON SCHEMA cell TO cell_executor;
GRANT SELECT ON ALL TABLES IN SCHEMA cell TO cell_executor;

-- The writes the executor legitimately makes (the anti-vacuity half): its own
-- runtime binding, and what it SAYS. Neither is a settlement fact.
GRANT INSERT ON cell.execution_attempt TO cell_executor;
GRANT INSERT ON cell.agent_statement   TO cell_executor;

-- The boundary. No write on the settlement surface, for this role — stated as an
-- explicit REVOKE as well as an absent GRANT, so a future GRANT ON ALL TABLES
-- cannot silently re-open it and the boundary reads as a deliberate act.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON cell.verification FROM cell_executor;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON cell.work_claim   FROM cell_executor;

COMMENT ON ROLE cell_executor IS
    'A3 entry gate (signed assumption 6): the executor runs work but CANNOT write '
    'the settlement surface (cell.verification, cell.work_claim). It may write its '
    'own execution_attempt and agent_statement — the anti-vacuity half that proves '
    'the settlement denial is a real boundary (RT-ROLE-DENIED).';
