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
  (zero `isSidechain:true` rows in main files). Each lives at
  `<project>/<sessionId>/subagents/agent-<agentId>.jsonl` with a sibling
  `agent-<agentId>.meta.json` `{agentType, description, toolUseId, spawnDepth}` —
  `toolUseId` IS the parent's `Agent` tool_use id (measured 2026-09-01 over 16 fan-out
  transcripts: 267 joins, 21 metas without a matching tool_use, 16 tool_uses without a meta).
  Subagent rows carry `agentId`, `isSidechain: true`, `parentUuid`, and the PARENT
  `sessionId`. An `Agent` tool_use's result is an ASYNC launch receipt (271 of 283); the
  outcome arrives later as a task-notification. `<project>/<sessionId>/tool-results/` holds
  large tool outputs.
- **Who a user row is** — `origin.kind`, measured over the 40 newest transcripts
  (2026-09-01): `human` (417; `promptSource` typed/queued) is the person; absent (7,905 —
  tool-result rows, SDK runs, older rows) is the person; `task-notification` (262;
  `promptSource: system`) is the harness reporting a background task as a string
  `<task-notification><task-id>…</task-id><tool-use-id>…</tool-use-id><status>…<summary>…
  <result>…` — the task-id IS the subagent's `agentId` for an Agent (124 of 255), the
  tool-use-id the `Bash` call for a backgrounded command; `peer` (1) is another session's
  message; `auto-continuation` (1) the harness continuing. The projector routes through
  `ORIGIN_KINDS` (`src/harnesses/claude-roster.mjs`): the person's rows are user steps; the
  harness's are system steps (`llm_call_count: 0`, the kind on `extra.record.inbound`) — a
  notification's text as an observation with a `subagent_trajectory_ref` when its task-id
  is an embedded subagent, `extra.record.unresolved_inbound` when it names neither a
  subagent nor a call this record made; an unknown kind projects as the person's row AND
  quarantines as `origin.<kind>`.
- **Background sessions** (`claude --bg`): job record `~/.claude/jobs/<short-id>/state.json`
  carries the full `sessionId` + `cwd` → the transcript is the STANDARD one in the encoded
  project dir. `timeline.jsonl` is the job's own event log. `--bg` conflicts with `-p`.
- **Headless** (`claude -p`): standard transcript, keyed on the invoking cwd.
- **Hook stdin** (the documented contract): `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, plus `agent_id`/`agent_type` when fired from a subagent.
- **Resumed and compacted sessions rotate the id but not the file** (measured 2026-09-01:
  1,166 rows): after `--resume` — and after a context compaction in the same process — the
  hooks report a NEW `session_id` and `transcript_path: <new-id>.jsonl`, which is never
  written; the harness keeps appending to the original file and stamps each new row with
  `session_id: <new-id>` beside the file's own `sessionId`. `ClaudeTraceStore.transcriptFor`
  resolves the file a session's rows live in from that stamp (positive evidence, never a
  guess); the hooks, the speaker, and the verifier's evidence read all go through it, and a
  trace link is written only for a file that exists (`linkTrace`).

## Codex

- **Rollout**: `~/.codex/sessions/YYYY/MM/DD/rollout-<UTC-ts>-<threadId>.jsonl`; older files
  may be zstd-compressed (`.jsonl.zst`). Resume APPENDS; `fork`/`thread/revert` mint new
  linked files. A child spawned with `fork_turns: "all"` (5 of 27 `spawn_agent` calls
  store-wide, 2026-09-01) begins with the PARENT's rows under the parent's `payload.id`s —
  inherited context the projector marks `is_copied_context` (the RFC's field), never the
  child's own work.
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
- **The inter-agent bus** (measured 2026-09-01): an ADDRESSED `agent_message` response item
  carries `author` and `recipient` as agent paths (the root thread is `/root`, a child
  `/root/<nickname>` — `session_meta.source.subagent.thread_spawn.agent_path` names a child's
  own path) and a typed first line, `Message Type: FINAL_ANSWER | NEW_TASK | MESSAGE`, then
  `Task name:` / `Sender:` headers and the payload. The incident parent carries 24
  `FINAL_ANSWER` rows (its children's answers); each child carries one `NEW_TASK` from `/root`
  whose payload is an `encrypted_content` part — the plaintext brief is the child's own first
  `user` row; the parent's outbound spawn message is encrypted too. An UNADDRESSED
  `agent_message` (35 of 45 across the 40 newest rollouts) is the agent's own words. The
  projector keeps an addressed message out of the agent's SAID: from an ancestor it is a
  `user` step (the delegated brief), otherwise a `system` step (`llm_call_count: 0`) whose
  observation carries the message and a `subagent_trajectory_ref` to the EMBEDDED child
  (the author's path resolved through the `SubAgentActivity(started)` items, else the thread
  index — a ref must resolve, so only a child the index carries gets one); the address
  rides `extra.record.inbound`; a thread the item names but the index does not carry rides
  `inbound.agent_thread_id`, and that or an author nothing started counts in
  `extra.record.unresolved_inbound`.

## ATIF projection

The traces above are GROUND TRUTH; the converters (`src/harnesses/claude-transcript.mjs`,
`src/harnesses/codex-rollout.mjs`, on the `src/atif.mjs` base)
project them at read time into pure ATIF v1.7 (record facts under `extra.record`), and the
annotator (`src/oathe-annotator.mjs`) adds oathe's layer under `extra.oathe` — see
`docs/atif-oathe.md`. The verifier judges the annotated, aligned view; `oathe trace <task>`
exports it, and `oathe trace <task> --pure` exports the converter's output alone — no
oathe key anywhere — for a cross-implementation check against Harbor's validator and
converters.

## What oathe records (C1 linkage)

Hooks write ONE trace statement per (claim × session): `subject_ref: trace:<session_id>`,
evidence ref = the transcript path. The verifier expands each linked trace to its fan-out
(Claude: `<project>/<sessionId>/subagents/*`; Codex: `thread_spawn_edges` children) at
read time — fan-out membership is derived, never stored stale.

## How evidence is discovered (the read-time rail)

The link is the ATTRIBUTION rail (board, notch, reclaim bundle — act-time, cheap). The
EVIDENCE rail is read-time (`src/evidence-discovery.mjs`): every oathe tool result echoes
its claim's substrate-minted UUID into whatever transcript the harness keeps, so the record
self-fingerprints. `gather()` serves the union — the recorded links, plus every store file
whose mtime falls in the task's claim window (mtime only: a long-lived session's file lives
in the date partition of its BIRTH and carries today's work), whose bytes carry a claim
UUID, and whose PROJECTION performs the task (claim intervals naming it — a transcript that
merely mentions the UUID, an investigator's or the judge's own, never enters the evidence).
Linked paths lead in the record's order; discovered paths follow by store order then path —
`traces[0]` is deterministic. A surface that keeps no store (Cursor) links with empty
evidence: that is attribution, and the claim still judges; no link and no discovery hit is
an `OATHE_EVIDENCE_EMPTY` stall — the engine never judges an empty record. A store file in
the window the byte scan cannot read is reported on the read (`read()` → `unreadable`, by path
and cause; the stall note and `oathe trace` say it), never a stall — an unrelated unreadable
file must not block the task's own evidence; a file that names the claim and cannot PROJECT
still refuses typed, because that one may be the evidence.

## The row-type rosters (the pinned contract — no upstream page exists)

Neither vendor documents its trace format; these rosters, measured on live stores
(2026-08-31, Claude Code 2.1.x, Codex CLI 0.149–0.150) and declared as data on each
adapter's `traces` capability (`src/harnesses/codex-roster.mjs`, `claude-roster.mjs`),
ARE the contract. Every row type is `handled` (projected) or consciously `ignored`
(with its reason, in the roster source). A type outside both lists quarantines visibly
at projection (`extra.record.unrecognized_rows`, announced in the evidence view) and
fails the census lane (`npm run trace-census`, the doctor's trace rows) as DRIFT —
additions tolerate visibly; missing EXPECTED shapes refuse loud (founder ruling
2026-08-31). The golden roster test in `tests/harness-contract.test.mjs` deep-equals
these lists; this section and that roster are held closed against each other. Beside the
roster, each adapter declares the same six **fidelity probes** (`src/harnesses/fidelity.mjs`,
parameterized by the adapter's own raw-record extractors) the census runs against every
projection: `tool-call-args` (a raw call's arguments survive), `token-metrics` (usage the
record carries is not zeros), `claim-events` (a real oathe act is on the record),
`subagent-embedding` (every child is embedded), `cross-source` (the item stream and the
response items agree — codex), `attribution` (a message another agent or the harness sent
never surfaces as the agent's own SAID). Each is n/a where the record carries nothing to
check — never a stolen pass.

### codex rollout rows

- line types handled: `session_meta`, `response_item`, `event_msg`, `turn_context`
  (a step boundary), `compacted` (a system `[context compacted]` step).
- line types ignored: `world_state`, `inter_agent_communication_metadata`.
- response_item handled: `message` (roles user/developer/assistant — `developer` rows are
  injected instructions and project as SYSTEM), `agent_message`, `reasoning` (usually
  `encrypted_content` — the step boundary only in a file with no usage-bearing
  `token_count`, declared in `extra.record.step_boundary`), `function_call` (JSON
  `arguments`; a `namespace` composes into the name), `local_shell_call`,
  `custom_tool_call` (the command as JS source in `input` — `tools.<name>(…)`, bare-keyed
  object literals; one parseable inner call IS the action), `function_call_output`,
  `custom_tool_call_output` (content-part arrays), `tool_search_call` (object
  `arguments`), `tool_search_output` (results in `tools`), `compaction` (codex
  0.150-alpha: the compaction summary as an encrypted response item, no `compacted` line
  row beside it — the same synthetic system step, `llm_call_count: 0`).
- event_msg handled: `token_count` (`payload.info.last_token_usage` — the per-call delta;
  `total_token_usage` is cumulative and would double-count). A token_count CLOSES one model
  API call — the reference converter's partition (Harbor `codex.py`, `finish_api_call`) — so
  it is the step boundary and each step's `llm_call_count` (consecutive counts accumulate on
  one step); `info: null` is a documented vendor state (Harbor #970): the call counts and
  closes, its usage stays absent — never zeros, never a refusal; a count with no agent step
  to land on is `extra.record.orphan_token_counts`. A `compacted` row is a synthetic system
  step, `llm_call_count: 0`.
- event_msg handled, continued: `item_completed` — the typed item stream, its own roster lane
  (`item`, classified by `payload.item.type`; measured 2026-09-01: 100% of cli/exec/child
  rollouts carry it, 8/14 vscode). Row order is call → item → output → token_count; an item's
  `id` is its own (`exec-<uuid>`), so a `CommandExecution`, `McpToolCall` or `FileChange`
  completes the call in the current turn still awaiting its output whose arguments agree
  (`command` tail ↔ the parsed `cmd`; `mcp__<server>__<tool>` ↔ the inner tool name or the
  raw source). Items ENRICH the calls — never the spine:
  - item handled: `CommandExecution` (a parsed call matches by its `cmd`; a raw exec source —
    a variable, a template, several calls in one `Promise.all` — is the oldest such call
    still running, measured up to 9 commands per call; a command that outlives its call —
    `exec_command` yields after `yield_time_ms`, `write_stdin` continues it — completes late
    and lands on the answered call that named it, else the most recent completed raw exec
    without a command: every command completes the CALL's ledger entry the source named for
    it (`extra.record.executions` on the tool call — born from the source at call-start, so
    acts inside a running cell are on the record before the cell returns; ruling 2026-09-04),
    and exactly one command also lands the result's `extra.record.exit_code`, which the
    annotator's `observed` prefers to the text),
    `McpToolCall` (recovers an exec call whose source could not be parsed: `server`, `tool`,
    `arguments` from the record — never `{input: raw}` when the record knows better),
    `FileChange` (`changes` keys → the result's `files_changed` and the root `files_touched`),
    `SubAgentActivity` (`started` and `interacted` carry the CALL's id — spawn_agent,
    send_message: `started` ties the call to `agent_thread_id`/`agent_path` under the call's
    `extra.record`; `completed` carries its own id and keys by the thread the spawn started —
    lifecycle, not an orphan; `started` without a thread REFUSES), `Extension`
    (`web.search` — an action with no response_item counterpart: the item is the call, its
    `results` the observation).
  - item ignored: `Reasoning`, `AgentMessage`, `UserMessage` (the response_item rows are the
    fact), `CollabAgentToolCall` (the collaboration call and its output are the fact),
    `ContextCompaction` (the `compacted` line row is the fact), `DynamicToolCall`, `Plan`,
    `ImageView`.
  - an `item_completed` without an `item` REFUSES (`ATIF_CODEX_ITEM_SHAPE`); an item that
    completes no awaiting call is `extra.record.uncorrelated_items` — counted, announced in
    the evidence view, never invented onto a call.
- event_msg ignored: `task_started`, `task_complete`, `thread_settings_applied`,
  `user_message`, `agent_message`, `agent_reasoning`, `turn_aborted`.

### claude transcript rows

- handled: `user`, `assistant`, `system`, `ai-title`, `file-history-snapshot`.
- ignored: `last-prompt`, `mode`, `permission-mode`, `atis-latch`, `bridge-session`,
  `attachment`, `queue-operation`, `agent-name`, `agent-setting`,
  `artifact-autoreact-ledger`, `artifact-comment-monitor`, `cost-state`, `custom-title`,
  `file-history-delta`, `frame-link`, `pr-link`.

## Conformance to the reference converters

Our converters promise pure ATIF — what a Harbor converter could also emit. The Harbor
conformance lane (`npm run harbor-conformance`, nightly in the public repo) makes that
measured rather than asserted: it drives Harbor's own converters (the version pinned in
`harbor-conformance.lock.json`, through the public entry points a trial runs —
`AgentFactory.create_agent_from_name` then `populate_context_post_run`, which writes
`trajectory.json`) on every corpus fixture home, laid out the way a trial's `logs_dir` looks
(each adapter's `traces.harbor` fact names its Harbor agent and where that converter reads
sessions), projects both outputs onto one shape (root steps apart from delegated ones, call
and result ids, the token totals the record states, refs, the derived identity), and compares
it both ways. The lock carries a reviewed BASELINE of the known divergences per fixture
(2026-09-01, harbor 0.22.0: four of ten fixtures diverge in nothing; the rest in our refs
and embedded children, our recovered inner-call names, our split at the delegated brief, and
our child fold) — a run fails loud on a divergence the baseline does not carry or one it
carries that is gone, and refuses when Harbor cannot be driven (no `python3`, a Harbor other
than the pin, a moved entry point). `npm run harbor-conformance-lock` re-pins after review.
Its first runs found four defects in OUR converters — Claude's accumulated streamed usage read
from the first row, codex's model read from the provider, one Claude response split by
interleaved async receipts, codex context reports counted as calls — all fixed; that is the
lane's purpose.
