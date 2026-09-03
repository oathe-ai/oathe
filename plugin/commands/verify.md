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

Call `oathe_verify` with `{task_id, engine?}`. The engine runs as a detached process and
the call waits for its verdict, then returns it: the verdict and its reason, whether the
task settled or came back reopened, and the engine log path. Report to the user exactly
what the response says — a rejection's reason is the verifier's own words, recorded on the
verify-task's completion statement; a run that died before a verdict says so and names the
retry. Nothing to poll: the answer is in the response.
