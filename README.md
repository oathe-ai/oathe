# oathe-playground

The founder's sandbox over the **real cell DDL** (the shipped 26 files, 55 plpgsql verbs)
on a scratch Postgres (`oathe_play`). The substrate is real; everything else is deliberately
missing — no cage, no lease enforcement, no recovery, no verification seat, no daemons.
This is for *feeling* the claim/statement/yield loop while the runtime finishes. Toy data only.

## Play

    ./oathe-play.sh claim task-x "Refactor the auth module"
    ./oathe-play.sh note  task-x "Found the root cause" ref:commit-abc
    ./oathe-play.sh ls
    ./oathe-play.sh yield task-x "handing off for tonight"
    ./oathe-play.sh render          # the SessionStart-style board
    ./oathe-play.sh reset           # fresh cell

Things the substrate will teach you by refusing (all seen live while building this):
a claim never mints the work it claims · a task without a plan must say `plan_status:
"unknown"`, never fabricate one · a second claimant is refused — responsibility passes by
a terminal · a yield without a **declared cause** is refused ("a reason the company does
not hold") — the play cause is registered the same way the shipped verbs are.

## Wire it into your real Claude sessions (optional, hand-edit — the managed-block
installer is D0's job)

Add to `~/.claude/settings.json` hooks → SessionStart:

    { "type": "command", "command": "/Users/firiya/oathe-playground/oathe-play.sh render" }

Every new session then opens with your board. Have the session run the CLI itself to
claim/note/yield — that's the D0 skill's behavior, hand-driven for now.

## What this is not

Not the runtime. Kills here just lose the process (no successor, no frame — the lease
simply expires and nothing pages). When D0.1 lands, `oathe init` replaces all of this
with the real thing; this repo is throwaway by declaration.
