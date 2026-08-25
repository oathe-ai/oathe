# The trace contract — how oathe reads harness session records

Verified on this machine 2026-08-25 (Claude Code 2.1.241, Codex CLI 0.149.1) by experiment;
both vendors DISCLAIM transcript-schema stability, so `npm test` and `oathe doctor` validate
the live stores against this contract and FAIL LOUD on drift (see `tests/traces-contract.test.mjs`).

## Claude Code

- **Transcript**: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — encoded-cwd replaces
  `/`, `_` and `.` path separators with `-`. One file per session; **resume APPENDS** to the
  same file (verified: 29→37 lines, still one file). `--continue`/`--fork-session` mint new
  linked sessions (`bridge-session` metadata rows).
- **Message entries** (`type: user|assistant|system`): `uuid`, `parentUuid`, `sessionId`,
  `isSidechain`, `cwd`, `gitBranch` (branch AT WORK TIME), `timestamp`, `version`,
  `message.{role,content}` (thinking/text/tool_use/tool_result), `usage` (per-message tokens).
- **Metadata rows** in the same file: `ai-title` (human session title),
  `file-history-snapshot` (`snapshot.trackedFileBackups` — the files the session touched),
  `last-prompt`, `bridge-session`, `queue-operation`, `attachment`, …
- **Subagents** (Task tool / research agents / workflow agents): NOT in the parent file
  (zero `isSidechain:true` rows observed). Each lives at
  `<project>/<sessionId>/subagents/agent-<agentId>.jsonl` with a sibling
  `agent-<agentId>.meta.json` `{agentType, description, toolUseId, spawnDepth}`. Entries
  carry `agentId` + the PARENT `sessionId`. `<project>/<sessionId>/tool-results/` holds
  large tool outputs.
- **Background sessions** (`claude --bg`): job record `~/.claude/jobs/<short-id>/state.json`
  carries the full `sessionId` + `cwd` → the transcript is the STANDARD one in the encoded
  project dir. `timeline.jsonl` is the job's own event log. `--bg` conflicts with `-p`.
- **Headless** (`claude -p`): standard transcript, keyed on the invoking cwd.
- **Hook stdin** (the documented contract): `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, plus `agent_id`/`agent_type` when fired from a subagent.

## Codex

- **Rollout**: `~/.codex/sessions/YYYY/MM/DD/rollout-<UTC-ts>-<threadId>.jsonl`; older files
  may be zstd-compressed (`.jsonl.zst`). Resume APPENDS; `fork`/`thread/revert` mint new
  linked files.
- **Lines**: `{timestamp, ordinal?, type, payload}`. First line `session_meta`:
  `id`, `session_id`, `parent_thread_id?`, `forked_from_id?`, `cwd`, `git`, `source`,
  `originator`, `cli_version`, `model_provider`. Ground truth for content is
  `response_item` lines; `event_msg` persistence is history-mode-dependent.
- **The index**: `~/.codex/state_5.sqlite` — `threads` (thread id → `rollout_path`, `cwd`,
  `title`, `first_user_message`, `tokens_used`, `git_sha`, `git_branch`, `git_origin_url`,
  `model`, `source`, agent nickname/role) and `thread_spawn_edges(parent_thread_id,
  child_thread_id)` for background-agent fan-outs. A subagent thread's `source` is JSON:
  `{"subagent":{"thread_spawn":{"parent_thread_id":…,"agent_nickname":…}}}`.
- **Headless** (`codex exec`): same rollout machinery, `source: "exec"`; REFUSES untrusted
  directories unless `--skip-git-repo-check` (the verifier engine passes it deliberately for
  its scratch cwd).
- **Hook stdin**: `session_id`, `transcript_path` (= the live rollout, materialized before
  dispatch), `cwd`; `SubagentStop` adds `agent_transcript_path`.

## ATIF projection

The traces above are GROUND TRUTH; `src/atif.mjs` projects them at read time into ATIF v1.7
trajectories carrying the `extra.oathe` convention — see `docs/atif-oathe.md`. The verifier
judges the projected, aligned view; `oathe trace <task>` exports it.

## What oathe records (C1 linkage)

Hooks write ONE trace statement per (claim × session): `subject_ref: trace:<session_id>`,
evidence ref = the transcript path. The verifier expands each linked trace to its fan-out
(Claude: `<project>/<sessionId>/subagents/*`; Codex: `thread_spawn_edges` children) at
read time — fan-out membership is derived, never stored stale.
