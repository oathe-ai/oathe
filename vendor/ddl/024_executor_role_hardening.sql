-- 024_executor_role_hardening.sql — the executor's boundary stated in full, and
-- the ONE door left open through it.
--
-- Contract: docs/a3-entry.md "Entry gate (inherited, RULED)" (signed assumption
-- 6) + a3-verification-strategy.md §3.2 row RT-ROLE-DENIED, carried forward to
-- the A3.4 capability surface (R-A3.4-2: INTENT / IDENTITY / RECONCILIATION are
-- the three things A3.4 makes the runtime responsible for, and all three are
-- readable-not-writable for the role that runs the work).
--
-- AMENDS, NEVER REWRITES. 023 (the gate) and 008 (the R3 effect verbs) are
-- shipped. This file changes their effect with GRANT / REVOKE / ALTER FUNCTION
-- rather than editing them, because a migration that rewrites its predecessors
-- leaves a history nobody can read: the reviewer of 008 would be reading a file
-- that never applied in the shape it now claims. ALTER FUNCTION rather than
-- CREATE OR REPLACE for the same reason one level down — restating those bodies
-- here would create a second copy of the R3 rule to drift against the first.
-- Requires 008_effect_receipt.sql and 023_executor_role.sql. Applied LAST.
--
-- Re-apply: idempotent (CREATE OR REPLACE; GRANT / REVOKE / ALTER FUNCTION are
--           all declarative).
-- Revert:   re-apply 008_effect_receipt.sql (it CREATE OR REPLACEs the unfenced,
--               invoker-rights cell.claim_effect_receipt over this file's);
--           ALTER FUNCTION cell.confirm_effect_receipt(text,text,text,text,timestamptz)
--               SECURITY INVOKER RESET search_path;
--           GRANT EXECUTE ON FUNCTION cell.claim_effect_receipt(text,text,uuid,uuid,text,text,text,text,timestamptz),
--                                     cell.confirm_effect_receipt(text,text,text,text,timestamptz) TO PUBLIC;
--           (the REVOKEs below need no revert — 023 never granted what they revoke)
--
-- Declared failure vocabulary. This file re-owns cell.claim_effect_receipt (see
-- THE FENCE MOVES INTO THE VERB, below), so it carries the WHOLE of that verb's
-- vocabulary — the two codes it adds and the two it inherits from 008 verbatim.
-- It stays inside the RECEIPT lane's own block, FC080-FC089, which 008 opened,
-- rather than taking a block of its own: every one of these is a refusal by 008's
-- claim verb about 008's receipt, and a consumer keying on the code reads ONE
-- lane, not two.
--   FC080 RECEIPT_KEY_PAYLOAD_CONFLICT      a reused key with a different payload   (from 008)
--   FC081 RECEIPT_KEY_ADDRESS_CONFLICT      a reused key aimed somewhere else       (from 008)
--   FC084 RECEIPT_ATTEMPT_NOT_CURRENT       the presented attempt is not the claim's running one
--   FC085 RECEIPT_MULTIPLE_RUNNING_ATTEMPTS  the claim holds more than one running attempt
--
-- THE DUPLICATION THAT CREATES, NAMED. After this file applies, 008's copy of the
-- claim body NEVER RUNS — this one replaces it. 008 keeps its copy because it is
-- the revert path (re-applying 008 restores the unfenced invoker-rights verb) and
-- because a migration that guts its predecessor leaves no history to read. The
-- live risk is an edit to FC080/FC081 landing in 008 and being silently
-- overwritten here. RETIREMENT CONDITION: when the receipt lane is next opened for
-- a semantic change, 008 and 024 collapse into one file and this note goes with
-- the second copy. DELETION OWNER: whoever makes that change.
--
--
-- THE CAPABILITY SURFACE, AND WHY THESE FIVE
--
-- 023 closed the SETTLEMENT surface: cell.verification (the non-author verdict)
-- and cell.work_claim (the terminal and its settlement stamp). A3.4 gives the
-- runtime real work to do, and that work runs alongside five more tables whose
-- rows are not settlement but are still not the executor's to write:
--
--   cell.dep_edge             what work waits on what. An executor that could
--                             declare or settle an edge could release its own
--                             gate — §4.1's lifecycle would be advisory.
--   cell.delegation_grant     who may hand work across a scope boundary
--                             (PRD §13.4). Writing it is granting yourself
--                             reach, which is L11 exactly: improving HOW a
--                             capability works never widens WHAT it may do.
--   cell.task_delegation      the delegated-work record R8's parent gate reads.
--                             Same authority, one table over.
--   cell.verification_clause  the acceptance clause a verdict is measured
--                             against (022). Editing the bar is passing the
--                             test by moving it.
--   cell.effect_receipt       the durable pre-image of an irreversible external
--                             effect (008, FOUNDER RULING R3). A direct writer
--                             here can mint a receipt for an effect that never
--                             fired, or erase the one record a reconciler had.
--
-- WHY EXPLICIT, WHEN THE GRANT WAS NEVER THERE — AND WHAT THAT DOES NOT PROVE
--
-- 023 (line 47) states the reason for its own explicit REVOKEs: so a future
-- `GRANT ... ON ALL TABLES` cannot silently re-open the boundary, and so the
-- boundary reads as a deliberate act rather than an omission somebody might
-- "fix". The same reasoning covers these five, and the same honesty is owed
-- about its limit: PostgreSQL records no NEGATIVE grant. Revoking a privilege a
-- role never held writes nothing at all to pg_class.relacl, so no catalog query
-- can distinguish "revoked" from "never granted", and any test claiming to read
-- the revoke off the catalog would be reading 023's GRANT SELECT instead.
--
-- What IS falsifiable is the scenario the statement exists for, and the suite
-- runs exactly that: widen every table at once with `GRANT ALL ON ALL TABLES IN
-- SCHEMA cell TO cell_executor`, observe the surface open, re-apply this file,
-- observe it closed — inside a rolled-back transaction, so the widening leaves
-- no residue. That is the difference between belt-and-suspenders and prose.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON cell.dep_edge            FROM cell_executor;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON cell.delegation_grant    FROM cell_executor;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON cell.task_delegation     FROM cell_executor;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON cell.verification_clause FROM cell_executor;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON cell.effect_receipt      FROM cell_executor;

-- ------------------------------------------------------- the one door, and its lock
--
-- THE ANTI-VACUITY HALF, at the surface A3.4 actually runs on. A role that
-- cannot record that an effect was about to fire does not have a boundary; it
-- has a dead lane — and worse, R3's `unknown` becomes permanent by construction
-- for every effect the executor performs, which is the precise failure 008 was
-- written to prevent. So the SAME role that cannot touch cell.effect_receipt
-- must still be able to claim and confirm a receipt through the committed verbs.
--
-- MEASURED, before this file (scratch cell, DDL 001..023, role cell_executor):
--   prosecdef(claim_effect_receipt)   = false
--   prosecdef(confirm_effect_receipt) = false
--   SELECT cell.claim_effect_receipt(...)  ->  42501 permission denied for
--                                              table effect_receipt
-- No function anywhere in this DDL tree was definer-rights. These two are the
-- first, and they are definer-rights for a reason that is the opposite of
-- convenience: it is what makes "the EXECUTOR writes receipts ONLY through these
-- verbs" a substrate fact rather than a calling convention. Said precisely: the
-- door is role-scoped. It is the only door for a caller with no direct DML on
-- cell.effect_receipt — which is every caller inside the executor boundary — and
-- it is one door among the owner's several, because the owner has the table.
--
-- The verbs own the idempotency key, the payload/address conflict refusals
-- (FC080/FC081), the no-claim-behind-it refusal (FC082) and the contradiction
-- refusal (FC083); a caller with direct INSERT rights owns none of them.
--
-- DEPLOY REQUIREMENT — LEDGERED FOR THE A5 DEPLOY CHECKLIST, and stated here so
-- it travels with the DDL rather than with a report: definer rights inherit the
-- OWNER's privileges, so cell.claim_effect_receipt and cell.confirm_effect_receipt
-- MUST be owned by the cell's schema owner and NEVER by a superuser in a real
-- cell — a superuser-owned definer function hands the executor superuser reach
-- for the duration of the call. Nothing in this file can enforce that (the owner
-- is whoever applies it), and the scratch databases these suites run in are
-- superuser-owned, which is why the test asserts the search_path pin instead.
--
-- search_path is pinned because an unpinned definer function is the classic
-- escalation shape: a caller sets search_path, and an unqualified reference
-- inside the body resolves to an object the caller planted. Both bodies
-- schema-qualify everything they touch, so pg_catalog alone would run them —
-- `cell` is listed anyway so a later edit that forgets to qualify resolves to
-- the cell's own object rather than silently to whatever `public` holds, and
-- `public` is deliberately absent. pg_temp is last, never first.
--
--
-- THE FENCE MOVES INTO THE VERB (ORCHESTRATOR RULING, A3.4 Task 3 fix round 1)
--
-- A3.4 Task 1 closed the stale-attempt TOCTOU on the CALLER side: performEffect
-- opened a transaction, took `FOR SHARE` on the claim's running attempt row, and
-- claimed the receipt before committing. An earlier draft of THIS file recorded
-- the decision NOT to restate that check verb-side, on L1 grounds — one authority
-- over one question.
--
-- THAT DECISION IS REVERSED HERE, and the caller-side lock path is DELETED rather
-- than duplicated, because the fact it rested on turned out to be false. MEASURED
-- (scratch cell, 001..023, role cell_executor):
--
--   SELECT ... FROM cell.execution_attempt ... FOR SHARE
--       -> 42501 permission denied for table execution_attempt
--   FOR KEY SHARE            -> 42501       plain SELECT (no lock) -> OK
--   FOR SHARE + GRANT UPDATE -> OK          (column-level UPDATE is enough too)
--
-- PostgreSQL checks EVERY row-locking clause against UPDATE privilege on the
-- table (ACL_SELECT_FOR_UPDATE is ACL_UPDATE). cell_executor holds SELECT and
-- INSERT on cell.execution_attempt and nothing more, so the caller-side fence
-- could not run at all under the role that runs the work — the lane was blocked
-- one step EARLIER than the receipt denial this file was written to repair. The
-- only caller-side fix is `GRANT UPDATE ON cell.execution_attempt TO
-- cell_executor`, which hands the executor its own attempt's state,
-- outcome_status and reconcile_by. That is the trade this whole file refuses.
--
-- So the fence goes where the state it guards is owned: INSIDE the definer-rights
-- claim verb, which runs as the OWNER and therefore may take the lock. L1 is
-- satisfied by DELETION, not by duplication — there is now exactly ONE fence, and
-- it is this one. It is also STRONGER than what it replaces: the lock, the
-- currency test and the INSERT are one statement, so no window exists between
-- them at all, and no caller can forget to open the transaction that made the
-- old one work.
--
-- The refusals are typed in 008's own vocabulary (FC080-FC089), because they are
-- refusals of 008's claim about 008's receipt:
--   FC084 the presented attempt is not the claim's single running attempt — it
--         ended, it belongs to another claim, or the claim has none running
--   FC085 the claim holds MORE THAN ONE running attempt. Currency is
--         unanswerable, so the verb fails closed rather than picking a winner;
--         a coin toss dressed as a fact is the one answer worse than a refusal.
--
-- THE FENCE IS ROLE-SCOPED, AND THE COVERAGE STATEMENT THAT OWES (L9)
--
-- ENFORCED ON 100% OF EXECUTOR-ROLE CLAIMS. ENFORCED ON 0% OF OWNER-LANE CLAIMS,
-- BY DESIGN. That is the whole coverage number, stated up front, because a
-- blocking rule that does not publish what it is actually enforced on is L9's
-- unpublishable coverage — and this one is deliberately not universal.
--
-- WHY. The fence's threat model is a superseded SCOPE still firing effects: an
-- agent process that outlived its ExecutionAttempt, holding a connection whose
-- ONLY path to cell.effect_receipt is this verb. A caller that already holds
-- direct INSERT on the table is not fenced by anything this verb does — it can
-- write the row itself — so applying the check to it buys no security whatsoever.
--
-- And it costs something real. MEASURED: the SUPERVISOR lane (the page, journal
-- and reconciler workflows that run beside the executor, not inside it) connects
-- as the OWNER with no SET ROLE, and its page lane claims a receipt for an
-- escalation AFTER the attempt has reached its terminal state — post-terminal page
-- attribution, which is A2 PRODUCTION-PROVEN behaviour and exactly what the
-- harness matrix's C6-SIGSTOP leg builds. An unconditional fence refused that
-- seed outright:
--
--   LEG_SEED_FAILED:C6-SIGSTOP — ERROR: RECEIPT_ATTEMPT_NOT_CURRENT:... attempt
--   253be835 (recorded state interrupted) is not the running attempt of work
--   claim 99de565e (running: <none>)
--
-- So the fence applies to the callers it is FOR. Attribution is unchanged for
-- both lanes — the receipt still names the attempt the caller passed — and no
-- authority is widened: the owner lane could always write this table, and the
-- executor lane still cannot.
--
-- AND THAT COVERAGE IS SELF-ASSERTED, NOT ASSUMED. Because the scope of this
-- fence is a property of GRANTS, a later `GRANT INSERT ON cell.effect_receipt`
-- to the effect sidecar's login — or a COLUMN-level grant on one column, which
-- has_table_privilege cannot see — would take that sidecar outside the fence
-- while every suite stayed green. So the governed-effect server evaluates this
-- same predicate FOR ITSELF at connect time (has_table_privilege OR
-- has_any_column_privilege) and refuses to serve when the answer is "unfenced",
-- with the frozen typed code EFFECT_PRINCIPAL_UNFENCED, recording the resolved
-- principal in its startup line. The coverage number below is therefore checked
-- against the REAL caller on every run rather than asserted by intent.
--
-- HOW THE CALLER IS CLASSIFIED, AND A DEVIATION STATED. The ruling named
-- `pg_has_role(session_user, 'cell_executor', 'MEMBER')`. MEASURED, that
-- predicate cannot do the job in the environment the cell is tested in:
--
--   pg_has_role(session_user, cell_executor, MEMBER) = true
--   pg_has_role(current_user, cell_executor, MEMBER) = true
--
-- pg_has_role is TRUE for a superuser against EVERY role, and every scratch cell
-- these suites run in is superuser-owned — so a role-name predicate fences the
-- owner lane too, the C6-SIGSTOP leg stays red, and the check becomes untestable
-- in the only environment that can test it.
--
-- What is used instead is the ruling's own RATIONALE, stated as the fact it rests
-- on rather than as a proxy for it: fence exactly those callers for whom this
-- verb is the ONLY door — `NOT has_table_privilege(<caller>, 'cell.effect_receipt',
-- 'INSERT')`. It classifies the executor correctly (no INSERT -> fenced), the
-- owner correctly (INSERT -> not fenced) whether or not the owner is a superuser,
-- and a future read-only lane correctly without having to be told its name. See
-- WHO IS CALLING in the body for how `<caller>` is recovered, which is the part
-- that is genuinely subtle.

-- Everything else about the verb — the ON CONFLICT DO NOTHING, the boolean that
-- tells "I claimed it" from "somebody already did", FC080 and FC081 — is 008's,
-- restated verbatim (see THE DUPLICATION THAT CREATES, in the header). This file
-- changes WHEN the insert is allowed to happen, not what it means.

CREATE OR REPLACE FUNCTION cell.claim_effect_receipt(
    p_org_id        text,
    p_receipt_key   text,
    p_work_claim_id uuid,
    p_attempt_id    uuid,
    p_bus_event_ref text,
    p_connector     text,
    p_address       text,
    p_payload_hash  text,
    p_claimed_at    timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, cell, pg_temp
AS $claim_receipt$
DECLARE
    v_claimed         boolean := false;
    v_payload_hash    text;
    v_address         text;
    v_connector       text;
    v_running         uuid[];
    v_presented_state text;
    v_caller          name;
BEGIN
    -- WHO IS CALLING. Harder than it looks inside a SECURITY DEFINER function,
    -- and got wrong once here, so the measurement is written down:
    --
    --                              current_user  session_user  current_setting('role')
    --   owner lane                 <owner>       <owner>       none
    --   after SET ROLE cell_executor  <owner>    <owner>       cell_executor
    --
    -- `current_user` is the function OWNER for the whole body — that is what
    -- definer rights MEAN — so it cannot see the caller at all. `session_user` is
    -- the LOGIN, which SET ROLE does not change, so in any cell whose owner logs
    -- in as a superuser (every scratch cell these suites use) it cannot tell the
    -- two lanes apart either. The `role` GUC survives the definer switch and is
    -- the one thing that does. A deploy where the executor has its OWN login and
    -- never issues SET ROLE reads 'none' here, and falls back to session_user,
    -- which is then correct: that login inherits cell_executor and holds no
    -- INSERT on the receipt table.
    v_caller := coalesce(nullif(current_setting('role', true), 'none'), session_user);

    -- THE FENCE, SCOPED TO THE CALLERS IT IS FOR. See THE FENCE IS ROLE-SCOPED,
    -- above: a caller that may INSERT into cell.effect_receipt directly is not
    -- fenced by anything this verb does, and fencing it would only break the
    -- supervisor lane's post-terminal writes for no security at all.
    IF NOT has_table_privilege(v_caller, 'cell.effect_receipt', 'INSERT') THEN
        -- FOR SHARE on the claim's running attempt row(s), held until this
        -- statement's transaction ends — which, for a bare SELECT of this
        -- function, is the statement itself. FOR SHARE and not FOR UPDATE: the
        -- fence is a reader, and must serialise only against the writer that
        -- would END the attempt. org_id leads the predicate so it can use
        -- execution_attempt's (org_id, ...) index prefix rather than scanning.
        SELECT array_agg(a.attempt_id)
          INTO v_running
          FROM (SELECT ea.attempt_id
                  FROM cell.execution_attempt ea
                 WHERE ea.org_id = p_org_id
                   AND ea.work_claim_id = p_work_claim_id
                   AND ea.state = 'running'
                 ORDER BY ea.attempt_id
                   FOR SHARE) a;

        IF v_running IS NOT NULL AND array_length(v_running, 1) > 1 THEN
            RAISE EXCEPTION
                'RECEIPT_MULTIPLE_RUNNING_ATTEMPTS:% — work claim % holds % running '
                'attempts (%), so which one owns this effect is unanswerable. The '
                'fence fails closed rather than choosing: an irreversible effect '
                'attributed to a guessed attempt is a receipt no reconciler can trust.',
                p_receipt_key, p_work_claim_id, array_length(v_running, 1), v_running
                USING ERRCODE = 'FC085';
        END IF;

        IF v_running IS NULL OR v_running[1] IS DISTINCT FROM p_attempt_id THEN
            SELECT ea.state INTO v_presented_state
              FROM cell.execution_attempt ea
             WHERE ea.org_id = p_org_id
               AND ea.work_claim_id = p_work_claim_id
               AND ea.attempt_id = p_attempt_id;
            RAISE EXCEPTION
                'RECEIPT_ATTEMPT_NOT_CURRENT:% — attempt % (recorded state %) is not '
                'the running attempt of work claim % (running: %). A survivor of a '
                'superseded attempt must not claim a receipt: it would leave a durable '
                'pre-image for an effect nobody authorised, attributed to a binding '
                'that no longer owns the work.',
                p_receipt_key, p_attempt_id, coalesce(v_presented_state, '<not recorded>'),
                p_work_claim_id, coalesce(v_running::text, '<none>')
                USING ERRCODE = 'FC084';
        END IF;
    END IF;

    -- 008's claim, unchanged from here down.
    INSERT INTO cell.effect_receipt (
        org_id, receipt_key, work_claim_id, attempt_id, bus_event_ref,
        connector, address, payload_hash, claimed_at, confirmed_at, outcome,
        remote_ref
    ) VALUES (
        p_org_id, p_receipt_key, p_work_claim_id, p_attempt_id, p_bus_event_ref,
        p_connector, p_address, p_payload_hash, p_claimed_at, NULL, 'claimed',
        NULL
    )
    ON CONFLICT (org_id, receipt_key) DO NOTHING;

    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    IF v_claimed THEN
        RETURN true;
    END IF;

    SELECT payload_hash, address, connector
      INTO v_payload_hash, v_address, v_connector
      FROM cell.effect_receipt
     WHERE org_id = p_org_id AND receipt_key = p_receipt_key;

    IF v_payload_hash IS DISTINCT FROM p_payload_hash THEN
        RAISE EXCEPTION
            'RECEIPT_KEY_PAYLOAD_CONFLICT:% — this key already holds a receipt for '
            'a DIFFERENT payload (recorded %, offered %). Overwriting it would '
            'leave the reconciler reading a receipt for an effect that was never '
            'fired with those contents; a key that can be re-pointed at another '
            'payload is not an idempotency key.',
            p_receipt_key, v_payload_hash, p_payload_hash
            USING ERRCODE = 'FC080';
    END IF;

    IF v_address IS DISTINCT FROM p_address OR v_connector IS DISTINCT FROM p_connector THEN
        RAISE EXCEPTION
            'RECEIPT_KEY_ADDRESS_CONFLICT:% — this key already holds a receipt '
            'aimed at %/%, and this call aims at %/%. Same reasoning as the '
            'payload clause, one field over.',
            p_receipt_key, v_connector, v_address, p_connector, p_address
            USING ERRCODE = 'FC081';
    END IF;

    -- An identical re-claim: the effect was already claimed by this or an
    -- earlier attempt, and the caller must NOT fire again.
    RETURN false;
END;
$claim_receipt$;

ALTER FUNCTION cell.confirm_effect_receipt(text, text, text, text, timestamptz)
    SECURITY DEFINER
    SET search_path = pg_catalog, cell, pg_temp;

-- Definer rights that PUBLIC may execute are definer rights handed to every role
-- in the cluster — the door would be open, just differently. EXECUTE goes to the
-- one role that needs it, and to nobody else.
REVOKE EXECUTE ON FUNCTION
    cell.claim_effect_receipt(text, text, uuid, uuid, text, text, text, text, timestamptz),
    cell.confirm_effect_receipt(text, text, text, text, timestamptz)
    FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
    cell.claim_effect_receipt(text, text, uuid, uuid, text, text, text, text, timestamptz),
    cell.confirm_effect_receipt(text, text, text, text, timestamptz)
    TO cell_executor;

COMMENT ON FUNCTION cell.claim_effect_receipt(
        text, text, uuid, uuid, text, text, text, text, timestamptz) IS
    'FOUNDER RULING R3, claim-before-fire. SECURITY DEFINER (024): the executor '
    'role has NO direct DML on cell.effect_receipt, so this verb and its confirm '
    'are the only path an executor has to a receipt — and the FC080/FC081 '
    'conflict refusals therefore cannot be walked around. The attempt fence '
    '(FC084/FC085) is enforced on 100%% of claims by callers without direct '
    'INSERT on cell.effect_receipt and on 0%% of owner-lane claims, by design '
    '(L9 coverage): a caller that can write the row is not fenced by this verb. '
    'The effect sidecar checks that predicate against ITSELF at connect and '
    'refuses to serve unfenced (EFFECT_PRINCIPAL_UNFENCED), so the coverage is '
    'self-asserted against the real caller rather than assumed.';

-- ------------------------------------------- what this file deliberately does NOT do
--
-- cell.unresolved_receipts STAYS INVOKER-RIGHTS. It is a reader, and 023's first
-- ruling is that reading is never the boundary: cell_executor already holds
-- SELECT on every table in this schema, so R6's MID-EFFECT-HOLD read and R3's
-- reconciler set both work as the invoker. Making it definer would buy nothing
-- and cost the property that matters — a future revocation of the executor's
-- SELECT would then be invisible through this function, and an enforcement change
-- nobody can observe is L9's unpublishable coverage in miniature. The suite
-- asserts prosecdef = false so the decision cannot drift into place unnoticed.
--
-- And it does NOT grant UPDATE on cell.execution_attempt. That would make the
-- OLD caller-side fence runnable again, and it is the one thing the fence-in-the-
-- verb design exists to avoid buying: the executor would hold write authority
-- over its own attempt's state, outcome_status and reconcile_by — R3's whole
-- reconciliation surface — in exchange for a lock it no longer needs. The runtime
-- suite asserts has_table_privilege(cell_executor, cell.execution_attempt,
-- UPDATE) = false in the same leg that proves the lane works, so the two facts
-- can never drift apart: the lane runs, and it runs without that grant.
