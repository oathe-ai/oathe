# ATIF in oathe — the converters (`extra.record`) and the annotation (`extra.oathe`)

oathe projects the Claude Code and Codex session records into **ATIF v1.7** (Harbor's Agent
Trajectory Interchange Format, `rfcs/0001-trajectory-format.md` in harbor-framework/harbor)
at read time. Raw transcripts/rollouts stay ground truth; a projection is derived, validated,
and never stored as a source of record. Custom fields outside `extra` are forbidden by the
reference models (`extra: "forbid"` — verified in source), so everything beyond the spec
lives in the sanctioned `extra` slots, in two namespaces with two owners:

- **`extra.record` — the converter's.** A projector (`src/harnesses/claude-transcript.mjs`
  for Claude, `src/harnesses/codex-rollout.mjs` for Codex, on the `src/atif.mjs` base) emits
  **pure ATIF**: what a Harbor converter
  could also emit. Raw-record facts ATIF has no field for ride here. No oathe concept ever
  appears in a converter output — `tests/atif.test.mjs` pins that no `oathe` key exists
  anywhere in one.
- **`extra.oathe` — the annotator's.** `OatheAnnotator` (`src/oathe-annotator.mjs`) applies
  oathe's claims-vs-actions layer over any valid ATIF trajectory: a copy, `extra.oathe` only,
  nothing else changed (annotated − `extra.oathe` deep-equals the input). Every oathe consumer
  performs the ONE read `projectAnnotated(file)` — the owning store's converter, then the
  annotation: the verifier's evidence, the turn-end heartbeat, the census probes, the
  `oathe trace` export.

Every trajectory oathe emits, pure or annotated, is valid for any ATIF consumer (Harbor
validator, viewers, trajectories.sh, Phoenix, SFT/RL pipelines).

Convention version: **`oathe_convention: 2`** (1 → 2: the record facts moved out of
`extra.oathe` into `extra.record`; `harness` became `agent.name`). Bumped on any breaking
change to this file.

## Converter facts — `extra.record`

| where | field | presence | meaning |
|---|---|---|---|
| root | `source_path` | always | the raw trace file (ground truth) |
| root | `session_title` | when recorded | Claude's `ai-title` (human name for the session) |
| root | `files_touched` | when recorded | Claude file-history `trackedFileBackups` keys |
| root | `unrecognized_rows` | when any | `{<channel.type>: count}` — rows outside the declared roster, quarantined visibly (announced in the evidence view, DRIFT in the census) |
| root | `step_boundary` | codex | `'token_count'` or `'reasoning'` — how this file's steps were partitioned, from its own evidence |
| root | `orphan_token_counts` | codex, when any | token counts that closed no call — no agent row since the last count, or an all-zero context-size report (measured after a compaction) — counted, attributed to nobody, never a second call on a closed step |
| root | `uncorrelated_items` | codex, when any | `{<item type>: count}` — items that completed no call (a join that failed; the cross-source probe flags it) |
| root | `unresolved_inbound` | when any | inbound messages nothing in the record names (codex: an author no spawn started; Claude: a notification naming neither a subagent nor a call) — the step stands, without a ref |
| step | `inbound` | on a message another agent or the harness sent | codex: `{author, recipient, message_type?}` — the inter-agent bus: a `user` step from an ancestor (the delegated brief), a `system` step otherwise (a child's answer, with `subagent_trajectory_ref` on its observation result). Claude: `{kind, task_id?, tool_use_id?}` from `origin.kind` — a `system` step (a task-notification with its text as an observation and a ref when the task is an embedded subagent; a peer's or the harness's own message) |
| tool call | `agent_thread_id`, `agent_path` | codex, on a spawn call | the thread the spawn started (`SubAgentActivity(started)`) |
| observation result | `exit_code` / `executions` / `files_changed` | codex, from the item stream | the structural exit code (one command), or every command with its exit code and every inner MCP act (several), or the files a patch changed |
| child root | `subagent_meta` | embedded subagents | Claude `agent-<id>.meta.json` (`agentType`, `description`, `toolUseId`, `spawnDepth`); Codex `{kind: 'thread_spawn', status, agent_nickname, agent_role, agent_path, depth}` — the spawn identity and how the edge ended |

Spec fields the converter owns: `session_id`, `agent.{name, version, model_name}` (the name
is the adapter's harness name; the model is the first turn's — codex `turn_context.model`,
Claude's first assistant row — never the provider, null when unstated), `steps` with `timestamp`/`metrics` where the record states
them, `final_metrics` (accumulated), `subagent_trajectories` (embedded, unique
`trajectory_id`). Emitted `schema_version` is `ATIF-v1.7`.

## Annotation — `extra.oathe`

| where | field | presence | meaning |
|---|---|---|---|
| root | `oathe_convention` | always | this convention's version |
| root | `org_id`, `task_id`, `work_claim_id`, `contract_ref`, `workspace` | on export (`oathe trace`) | the OBLIGATION this trajectory is evidence for |
| root | `verdict` | after verification, on export | `{result, verifier_principal, verification_id}` from `cell.verification` |
| root | `sliced` | on a `sliceForTask` output that changed anything | `{task_id, original_step_ids, subagents_elided}` — the slice announces itself and renumbers `step_id` sequentially (validator-safe) |
| step | `claim_events` | when the step's tool calls include oathe speech acts | `[{verb, task_id}]`, matched against the MCP server's own tool names (`oathe_claim`, `oathe_statement`, `oathe_done`, `oathe_yield`, …). **The agent's on-the-record claims are structurally separable from everything else it says.** |
| tool call | `files` | when the call's arguments name a `file_path` | what the action was aimed at |
| observation result | `observed` | when the record or the output STATES a fact | today `{exit_code}`: the converter's structural `extra.record.exit_code` (the codex item stream) first, else an explicit "Exit code N" as the output's OWN last line (measured 2026-09-01: a mention inside printed content is never one) — **absent when unstated, never fabricated** |

The annotator refuses invalid input (`ATIF_ANNOTATE_INVALID_INPUT`): it judges nothing it
cannot validate. Children are annotated too; the obligation is stamped on the root only.

## Projection mapping (summary)

- **Claude** (`~/.claude/projects/<cwd>/<session>.jsonl`): assistant rows → agent steps
  (text→`message`, thinking→`reasoning_content`, tool_use→`tool_calls`; consecutive assistant
  rows merge into one turn; usage is one entry per API response id, the LAST row's — Claude
  Code accumulates it across a message's streamed rows, measured 2026-09-01 — and
  `llm_call_count` is the responses behind the step); user tool_result rows attach to
  the owning step's `observation` (a user row always ends the current turn); metadata rows are
  noise — dropped from steps, with titles/file-history promoted to `extra.record`;
  `<session>/subagents/agent-<id>.jsonl` → embedded `subagent_trajectories`, and the `Agent`
  call's receipt (`meta.toolUseId` IS its tool_use id) carries the `subagent_trajectory_ref`
  `{trajectory_id, extra: {agent_type}}`.
- **Codex** (`~/.codex/sessions/…/rollout-*.jsonl`): `session_meta` → `agent` + identity;
  `response_item` message/reasoning/function_call/function_call_output → the same channels;
  `event_msg token_count` → step metrics; `thread_spawn_edges` children → embedded
  trajectories (an unresolvable child REFUSES — fan-out members are never silently dropped),
  and the `spawn_agent` call's receipt carries the ref `{trajectory_id, extra: {agent_path}}`
  — the call `SubAgentActivity(started)` tied to the thread, else the call whose `task_name`
  is the child's nickname; a call that never got an output row gets a content-less result to
  carry it.
- **Codex forks** (`spawn_agent` with `fork_turns: "all"` — 5 of 27 spawns store-wide,
  2026-09-01): the child begins with the parent's rows under the parent's `payload.id`s. A
  child step built entirely from rows the parent already holds is `is_copied_context: true`
  (the RFC excludes such steps from SFT): the annotator gives it no claim events (the parent's
  acts are never the child's), the evidence view elides it and says so
  (`[N copied-context steps elided]`), and slicing never attributes the parent's claim to
  the child.
- **Both**: the ref sits on the observation result of the call that delegated — the reference
  converters' placement (Harbor `qwen_code.py`) — and each child's `final_metrics` fold into
  the root's totals (a run that delegates is not under-counted); `total_steps` stays the
  trajectory's own, and the `token-metrics` probe reads the root's own steps so a fold can
  never mask a root whose usage was lost.

## The evidence view

`renderEvidenceView(trajectory, {budget})` renders the aligned record the verifier judges —
over an ANNOTATED trajectory: `SAID:` (claims) / `CLAIM(verb task)` (speech acts) /
`DID: tool(args)` (actions) / `GOT [exit N]: …` (outcomes) / `FROM <author> (<type>) [→ subagent
<id>]: …` (a message another agent sent this one — never SAID), tail-prioritized under
`verifierEvidenceBudget` with elisions announced (`[N earlier steps elided: M tool calls,
K claims]`). The header reads the converter's record facts (title, files touched,
unrecognized rows) and the annotator's slice marker.

## Fail-loud posture

The projector refuses (typed `AtifError`/`TraceContractError`) on: unmappable rows, tool
results with no owning call, unparseable tool arguments, children without rollout paths, and
any output that fails our re-implementation of the reference validation rules (which Harbor's
own golden fixture must always pass — `tests/fixtures/harbor-golden-terminus2.trajectory.json`).
The validator accepts the reference models' whole version ladder inbound (`ATIF-v1.0` through
`ATIF-v1.8`; v1.8 added audio content parts) while the converters emit `ATIF-v1.7`, what the
reference converters emit. A `subagent_trajectory_ref` is validated to the reference
`SubagentTrajectoryRef`: an array of refs, unknown fields forbidden, each resolvable by
`trajectory_id` or `trajectory_path` (`session_id` is informational, never a key) — and a
`trajectory_id` must name an embedded child, the RFC's resolution rule, which we hold
although the reference model checks only the one-of.
`npm test` projects the NEWEST real record in both stores; `oathe doctor` and the
trace-census lane sweep the recent window against the declared rosters and fidelity probes;
the Harbor conformance lane (`docs/traces.md`) drives the reference converters on the corpus
and holds the measured divergence to a reviewed baseline.
A harness format change is a loud break, never a quiet degradation — with one refinement
(founder ruling 2026-08-31): an UNKNOWN row type quarantines visibly instead of refusing
(counted in `extra.record.unrecognized_rows`, announced in the evidence view, DRIFT in the
census); only a missing EXPECTED shape refuses.
