-- 026_acceptance_authority.sql — the acceptance lane's three settlement-shaped
-- inputs, held BELOW the agent instead of beside it in an environment variable.
--
-- Contract: contract §4.5 (registry edits are governed operations) + design law
-- L1 (one authoritative owner per lifecycle) + L2 (durable state lives below the
-- agent). Requires 001_core.sql for the `cell` schema and 002_claim.sql for
-- cell.written_by, the frame-stack signal this file's guard reads. It also names
-- 023_executor_role.sql's `cell_executor` in its privilege posture below, but does
-- not require it: that block is guarded and skips when the role is absent, so an
-- apply order without 023 still yields a complete and correct 026. Nothing else in
-- the substrate is touched: no existing table, verb or trigger is altered.
--
-- Re-apply: idempotent (CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE; GRANT and
--           REVOKE are declarative).
-- Revert:   DROP TRIGGER acceptance_authority_is_written_by_the_governed_verb
--               ON cell.acceptance_authority;
--           DROP FUNCTION cell.register_acceptance_authority(text,jsonb,jsonb,jsonb,text,timestamptz);
--           DROP FUNCTION cell.enforce_governed_acceptance_authority_edit();
--           DROP TABLE cell.acceptance_authority;
--           (a reverted cell has no registration to read, so the lane's resolver
--            falls all the way back to its env bootstrap — which is the state
--            this file exists to end, not a safe resting place)
--
-- Declared failure vocabulary (FC170-FC179 reserved; one code used):
--   FC170 ACCEPTANCE_AUTHORITY_FOREIGN_WRITER  a writer other than
--         cell.register_acceptance_authority tried to set the lane's authority.
--
--
-- WHAT THIS IS FOR, AND WHAT IT REPLACES
--
-- Three environment variables decided settlement-shaped questions with nothing
-- durable behind them (the acceptance checker daemon, MEASURED before this
-- change): ACC_SEATS said WHO may transcribe a verdict, ACC_CLAUSE_SPECS said
-- WHAT the bar for a clause is, ACC_CHECKER_REFS said WHICH deployed code answers
-- a checker_ref. A deployment that changed one changed who may sign, or what
-- counts as discharged, and left no row anywhere saying it had. That is the same
-- defect cell.checker_registry (009) was built to end one level down — "what
-- counts as a valid verified release was encoded in seven places on the Mac and
-- every encoding drifted" — reappearing at the LANE's grain rather than the
-- dep_key's.
--
-- WHY NOT cell.checker_registry. It was the first place looked. Its key is
-- (org_id, dep_key) and its columns are two scalars: one evaluator principal and
-- one checker_ref, both ABOUT a single dependency key. The three values here are
-- properties of the LANE — an ordered roster, a clause_key->spec map and a
-- ref->deployed-code map, all org-grain and none of them per-dep_key. Encoding
-- them as registry rows under invented dep_keys would put three different
-- meanings in one column and make the §4.5 registry answer a question it was not
-- asked. One table, one lifecycle.
--
-- THE ENV IS STILL ALLOWED TO BOOTSTRAP, ONCE. A cell that has never been
-- registered has to learn its roster from somewhere, and the resolver
-- (`resolveAcceptanceAuthority`, src/acceptance-producer.mjs) takes the env values
-- and WRITES THEM HERE in the same startup. From the second boot on, this table
-- answers and an env value that disagrees is a typed refusal
-- (ENV_AUTHORITY_CONFLICT) rather than an override. That is the L8 shape: the
-- bridge exists, and it retires itself the first time it is crossed.
--
-- WHICH DATABASE THE LANE CONNECTS TO IS NOT HERE, deliberately. ACC_PG_URL and
-- its host/port/user siblings stay environment variables: they say WHERE the cell
-- is, not WHAT it may do. A deployment coordinate is not authority content, and
-- putting it in the substrate it addresses would be circular.

CREATE TABLE IF NOT EXISTS cell.acceptance_authority (
    org_id        text        NOT NULL,

    -- The transcribing roster, IN PREFERENCE ORDER — an array and not a set,
    -- because the lane picks the first non-author seat and the order is therefore
    -- part of the answer to "who signed this".
    seats         jsonb       NOT NULL,

    -- clause_key -> typed clause spec. The BAR. A lane with no spec for a clause
    -- blocks rather than accepting, so an empty object is lawful and an absent
    -- row is not.
    clause_specs  jsonb       NOT NULL,

    -- checker_ref -> the name of the deployed checker that answers it. The
    -- substrate says a checker must answer for a dep_key (009); this says which
    -- code is deployed to be that checker.
    checker_refs  jsonb       NOT NULL,

    registered_by text        NOT NULL,
    registered_at timestamptz NOT NULL,

    CONSTRAINT acceptance_authority_pkey PRIMARY KEY (org_id),

    -- A roster that is empty, or is not a list at all, would make the lane invent
    -- a seat at the first verdict — and an invented seat is an invented authority.
    CONSTRAINT acceptance_authority_seats_is_a_nonempty_array
        CHECK (jsonb_typeof(seats) = 'array' AND jsonb_array_length(seats) > 0),
    -- Stated as jsonpath rather than as `NOT EXISTS (SELECT ... jsonb_array_elements)`
    -- because a CHECK may not carry a subquery. A seat that is a number, or a
    -- string of spaces, is a principal nobody can be.
    CONSTRAINT acceptance_authority_seats_are_named
        CHECK (NOT jsonb_path_exists(seats, '$[*] ? (@.type() != "string")')
           AND NOT jsonb_path_exists(seats, '$[*] ? (@ like_regex "^\\s*$")')),

    CONSTRAINT acceptance_authority_clause_specs_is_an_object
        CHECK (jsonb_typeof(clause_specs) = 'object'),
    CONSTRAINT acceptance_authority_checker_refs_is_an_object
        CHECK (jsonb_typeof(checker_refs) = 'object'),

    CONSTRAINT acceptance_authority_registrar_is_named
        CHECK (length(btrim(registered_by)) > 0)
);

COMMENT ON TABLE cell.acceptance_authority IS
    'The acceptance lane''s roster, clause bars and checker_ref map, held below '
    'the agent (L2) and owned by one governed verb (L1). Was three environment '
    'variables with no record that anyone had ever set them.';

-- The same governance shape 009 gave the checker registry, for the same reason
-- and against the same forgery: a `registered_by` column alone is authorised by
-- typing the right string into it. The signal is cell.written_by (002_claim.sql)
-- — the verb's frame is on this trigger's call stack or it is not.
CREATE OR REPLACE FUNCTION cell.enforce_governed_acceptance_authority_edit()
RETURNS trigger
LANGUAGE plpgsql
AS $governed$
BEGIN
    IF NOT cell.written_by('cell.register_acceptance_authority') THEN
        RAISE EXCEPTION
            'ACCEPTANCE_AUTHORITY_FOREIGN_WRITER:% — who may transcribe a verdict, '
            'what a clause''s bar is, and which code answers a checker_ref are set '
            'only by cell.register_acceptance_authority. A service that could write '
            'this row directly would be the second authority the row exists to '
            'remove.',
            NEW.org_id
            USING ERRCODE = 'FC170';
    END IF;
    RETURN NEW;
END;
$governed$;

CREATE OR REPLACE TRIGGER acceptance_authority_is_written_by_the_governed_verb
    BEFORE INSERT OR UPDATE ON cell.acceptance_authority
    FOR EACH ROW EXECUTE FUNCTION cell.enforce_governed_acceptance_authority_edit();

-- The one verb. Every argument is required and there is no default, the rule 009
-- states and this file inherits: a default roster, a default bar or a
-- server-chosen timestamp would each be a governance decision made in the
-- substrate, invisible at the call site.
CREATE OR REPLACE FUNCTION cell.register_acceptance_authority(
    p_org_id        text,
    p_seats         jsonb,
    p_clause_specs  jsonb,
    p_checker_refs  jsonb,
    p_registered_by text,
    p_registered_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
AS $register$
BEGIN
    -- Nothing is set to authorize this write: THIS frame, on the call stack, is
    -- the authorization, and it stops existing when the function returns.
    INSERT INTO cell.acceptance_authority (
        org_id, seats, clause_specs, checker_refs, registered_by, registered_at
    ) VALUES (
        p_org_id, p_seats, p_clause_specs, p_checker_refs, p_registered_by,
        p_registered_at
    )
    ON CONFLICT (org_id) DO UPDATE
        SET seats         = EXCLUDED.seats,
            clause_specs  = EXCLUDED.clause_specs,
            checker_refs  = EXCLUDED.checker_refs,
            registered_by = EXCLUDED.registered_by,
            registered_at = EXCLUDED.registered_at;

    RETURN p_org_id;
END;
$register$;

COMMENT ON FUNCTION cell.register_acceptance_authority IS
    'The only writer of cell.acceptance_authority. A lane''s roster, bars and '
    'checker map become the cell''s answer by passing through here or not at all.';

-- ---------------------------------------------------- the executor's posture, STATED
--
-- WHY THIS FILE STATES ITS OWN INSTEAD OF LEAVING IT TO 023/024. Two reasons, both
-- MEASURED against the shipped chain rather than reasoned about.
--
-- GRANT DRIFT. 023:49 grants SELECT on ALL TABLES IN SCHEMA cell, and `ALL TABLES`
-- is resolved at GRANT time over the tables that exist THEN. On a first apply this
-- table does not exist yet when 023 runs, so the executor holds nothing on it; on a
-- SECOND apply over the same database it does, and the executor silently gains
-- SELECT. MEASURED on a scratch cell: sel|ins = f|f after one apply, t|f after two.
-- A substrate whose privileges depend on how many times it was applied has no stated
-- posture at all, so the chain ends HERE, in one state, whatever ran before it.
--
-- AND THE WIDEN-THEN-CLOSE CEREMONY. 024's five REVOKEs exist precisely so a careless
-- `GRANT ALL ON ALL TABLES` cannot re-open the capability surface, and the rt-domain
-- family proves it by widening every table and re-applying 024. A REVOKE for THIS
-- table written into 024 would break 024's own re-apply — 024 runs BEFORE 026 in the
-- declared order, so the table does not exist when it does. MEASURED: after that
-- ceremony, effect_receipt.INSERT closes to false and acceptance_authority.INSERT
-- stayed TRUE. Each surface is therefore closed by the file that owns it, and the leg
-- re-applies both.
--
-- WHY THE EXECUTOR GETS NOTHING HERE, not even SELECT. Reading the spine is never the
-- boundary (023's rule) — but this row is not the spine. It is the answer to "who may
-- sign", and the lane that reads it connects as the settlement writer, never as
-- cell_executor. An executor that could read the roster learns which seat to
-- impersonate; one that could write it IS the settlement authority. The anti-vacuity
-- half 023 asks for is unaffected: the executor still reads every table it works
-- against and still writes its own attempt and its own statement.

-- The governed verb is not PUBLIC's. A function is EXECUTE-to-PUBLIC by default, so
-- without this line every role in the cell — cell_executor included — could call the
-- one writer of the lane's authority, and the FC170 trigger would wave it through
-- because the verb's frame really is on the stack. The deployment GRANTs EXECUTE to
-- the principal that runs the lane; nobody else holds it.
REVOKE EXECUTE ON FUNCTION
    cell.register_acceptance_authority(text,jsonb,jsonb,jsonb,text,timestamptz)
    FROM PUBLIC;

-- Guarded rather than bare: 023 may not have run, and a file that fails on a role it
-- does not create would make its own Requires line a lie. Stated as an explicit
-- REVOKE and not left to an absent GRANT, for 023's own reason — the boundary reads
-- as a deliberate act rather than an omission somebody might "fix".
DO $authority_posture$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cell_executor') THEN
        REVOKE ALL ON cell.acceptance_authority FROM cell_executor;
        REVOKE ALL ON FUNCTION
            cell.register_acceptance_authority(text,jsonb,jsonb,jsonb,text,timestamptz)
            FROM cell_executor;
    END IF;
END
$authority_posture$;
