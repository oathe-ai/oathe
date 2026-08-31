---
description: Verify a task's asserted completion — optionally on a specific engine (claude | codex | cursor)
argument-hint: <task-id> [engine]
---

Run verification for the named task with the `oathe_verify` MCP tool.

Arguments: `$ARGUMENTS` — the first word is the task id; the optional second word is the
engine to judge with (`claude`, `codex`, or `cursor` — any harness CLI present on this
machine can verify). Passing an engine is how you retry a STALLED verification on a
different engine after an outage (e.g. a usage limit): the failed run already released its
claim and recorded the failure, so the retry claims cleanly.

Call `oathe_verify` with `{task_id, engine?}`. It returns immediately — verification runs
in a detached background process. Report to the user exactly what the response says: the
verdict lands on the board; a rejection reopens the task with the reason recorded on the
verify-task's completion statement; the engine log path is in the response. Do not wait or
poll unless the user asks.
