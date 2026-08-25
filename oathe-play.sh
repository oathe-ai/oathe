#!/usr/bin/env bash
# oathe-play — a founder's sandbox over the REAL cell DDL on a scratch Postgres.
# The substrate is real (55 plpgsql verbs, the shipped 26 DDL files); everything
# else is deliberately missing: no cage, no lease enforcement, no recovery, no
# verification seat. This is for feeling the claim/statement/yield loop, not for
# work that matters. DB: oathe_play · org: play · principal: shez.
set -euo pipefail
DB=oathe_play; ORG=play; ME=shez; DEPT=founder
Q() { psql -X -q -t -A -d "$DB" "$@"; }

case "${1:-help}" in
  claim)  # ./oathe-play.sh claim <task-id> "<objective>"
    TID="$2"; OBJ="$3"
    Q -c "INSERT INTO cell.task (org_id,task_id,department,objective,origin,verification_plan,verify_by,claim_mode,created_at)
          VALUES ('$ORG','$TID','$DEPT',\$\$${OBJ}\$\$,'minted_at_claim','{\"plan_status\":\"unknown\"}'::jsonb,
                  now()+interval '1 day','exclusive',now()) ON CONFLICT DO NOTHING"
    Q -c "SELECT cell.claim_work('$ORG','$TID',gen_random_uuid(),NULL,'$ME','$DEPT','exclusive',
          now()+interval '4 hours','contract:$ORG/$TID@v1',now(),gen_random_uuid())" >/dev/null
    echo "claimed: $TID (lease 4h — the plan_status is honestly 'unknown'; a real cell would page you at verify_by)";;
  ls)
    Q -c "SELECT state||'  '||task_id||'  ('||principal_id||', lease until '||to_char(ownership_valid_until,'HH24:MI')||')'
          FROM cell.work_claim WHERE org_id='$ORG' ORDER BY claimed_at DESC LIMIT 20";;
  note)   # ./oathe-play.sh note <task-id> "<proposition>" [evidence-ref]
    TID="$2"; PROP="$3"; REF="${4:-note:manual}"
    CID=$(Q -c "SELECT work_claim_id FROM cell.work_claim WHERE org_id='$ORG' AND task_id='$TID' AND state='active' LIMIT 1")
    [ -n "$CID" ] || { echo "no active claim on $TID"; exit 1; }
    Q -c "INSERT INTO cell.agent_statement (statement_id,org_id,task_id,work_claim_id,execution_actor,claim_principal,
          statement_type,subject_ref,proposition,evidence_refs,epistemic_status,asserted_at)
          VALUES (gen_random_uuid(),'$ORG','$TID','$CID','play-session','$ME',
          'progress','task:$TID',\$\$${PROP}\$\$,'[\"$REF\"]'::jsonb,'observed',now())"
    echo "statement recorded (a statement, not truth — nothing settled)";;
  yield)  # ./oathe-play.sh yield <task-id> "<typed-basis>"
    TID="$2"; BASIS="${3:-operator-decision}"
    CID=$(Q -c "SELECT work_claim_id FROM cell.work_claim WHERE org_id='$ORG' AND task_id='$TID' AND state='active' LIMIT 1")
    [ -n "$CID" ] || { echo "no active claim on $TID"; exit 1; }
    Q -c "SELECT cell.play_yield_operator('$CID'::uuid,\$\$${BASIS}\$\$,now(),gen_random_uuid())" >/dev/null
    echo "yielded with typed basis '$BASIS' — the obligation is back on the board, unowned";;
  render) # SessionStart-style board (pipe into a hook someday)
    echo "## Oathe board ($ORG)"; echo
    Q -c "SELECT '- ['||state||'] '||task_id||' — '||objective||' ('||COALESCE(principal_id,'unclaimed')||')'
          FROM cell.task t LEFT JOIN cell.work_claim w USING (org_id,task_id) WHERE t.org_id='$ORG'";;
  reset)  dropdb "$DB" && createdb "$DB" && for f in /Users/firiya/firia-monorepo/packages/firia-cell-domain/firia_cell_domain/ddl/*.sql; do psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"; done
    Q -c "INSERT INTO cell.principal (org_id,principal_id,role,assigner_principal_id,department) VALUES ('$ORG','$ME','ceo',NULL,'$DEPT')"
    Q -c "CREATE OR REPLACE FUNCTION cell.play_yield_operator(p_work_claim_id uuid, p_note text, p_at timestamptz, p_event_id uuid) RETURNS void LANGUAGE plpgsql AS \$fn\$ BEGIN PERFORM cell.record_claim_yield(p_work_claim_id, 'operator_decision: ' || p_note, p_at, p_event_id); END \$fn\$"
    Q -c "INSERT INTO cell.claim_yield_cause (cause, basis_prefix) VALUES ('cell.play_yield_operator','operator_decision') ON CONFLICT (cause) DO UPDATE SET basis_prefix=EXCLUDED.basis_prefix"
    echo "fresh cell, principal $ME seeded, play yield cause declared";;
  *) sed -n '2,6p' "$0"; echo "verbs: claim <id> \"<objective>\" · ls · note <id> \"<text>\" [ref] · yield <id> [basis] · render · reset";;
esac
