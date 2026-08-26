# The `extra.oathe` convention — oathe's claims-vs-actions layer on ATIF

oathe projects both harnesses' raw session records into **ATIF v1.7** (Harbor's Agent
Trajectory Interchange Format, `rfcs/0001-trajectory-format.md` in harbor-framework/harbor)
at read time. Raw transcripts/rollouts stay ground truth; a projection is derived, validated,
and never stored as a source of record. Custom fields outside `extra` are forbidden by the
reference models (`extra: "forbid"` — verified in source), so everything oathe adds lives in
the sanctioned `extra` slots, namespaced under `oathe`, exactly the way the spec's own
`extra.context_management` convention does it. Every trajectory oathe emits is valid for any
ATIF consumer (Harbor validator, viewers, trajectories.sh, Phoenix, SFT/RL pipelines).

Convention version: **`oathe_convention: 1`** (bumped on any breaking change to this file).

## Fields

### Trajectory root — `extra.oathe`

| field | presence | meaning |
|---|---|---|
| `oathe_convention` | always | this convention's version |
| `harness` | always | `claude` \| `codex` — which store the projection read |
| `source_path` | always | the raw trace file (ground truth) |
| `session_id` | always | the harness session/thread id |
| `session_title` | when recorded | Claude's `ai-title` (human name for the session) |
| `files_touched` | when recorded | Claude file-history `trackedFileBackups` keys |
| `subagent_meta` | embedded subagents | Claude `agent-<id>.meta.json` (`agentType`, `description`, `toolUseId`, `spawnDepth`) |
| `org_id`, `task_id`, `work_claim_id`, `contract_ref`, `workspace` | on export (`oathe trace`) | the OBLIGATION this trajectory is evidence for |
| `verdict` | after verification | `{result, verifier_principal, verification_id}` from `cell.verification` |

### Step — `extra.oathe.claim_events`

Present when a step's tool calls include oathe speech acts (matched against the MCP server's
own tool names — `oathe_claim`, `oathe_statement`, `oathe_done`, `oathe_yield`, …):
`[{verb, task_id}]`. This is the load-bearing distinction: **the agent's on-the-record
claims are structurally separable from everything else it says.**

### Tool call — `extra.oathe.files`

File paths named by the call's arguments (any tool with a string `file_path` argument) —
what the action was aimed at.

### Observation result — `extra.oathe.observed`

Facts the tool output actually STATES, parsed conservatively: today `{exit_code}` from an
explicit "Exit code N" in the result text. **Absent when unstated — never fabricated.**
This is where verifiable ground truth accumulates as parsing deepens (diff stats, git shas).

## Projection mapping (summary)

- **Claude** (`~/.claude/projects/<cwd>/<session>.jsonl`): assistant rows → agent steps
  (text→`message`, thinking→`reasoning_content`, tool_use→`tool_calls`; consecutive assistant
  rows merge into one turn; usage deduped by API response id); user tool_result rows attach to
  the owning step's `observation` (a user row always ends the current turn); metadata rows are
  noise — dropped from steps, with titles/file-history promoted to root `extra.oathe`;
  `<session>/subagents/agent-<id>.jsonl` → embedded `subagent_trajectories`.
- **Codex** (`~/.codex/sessions/…/rollout-*.jsonl`): `session_meta` → `agent` + identity;
  `response_item` message/reasoning/function_call/function_call_output → the same channels;
  `event_msg token_count` → step metrics; `thread_spawn_edges` children → embedded
  trajectories (an unresolvable child REFUSES — fan-out members are never silently dropped).

## The evidence view

`renderEvidenceView(trajectory, {budget})` renders the aligned record the verifier judges:
`SAID:` (claims) / `CLAIM(verb task)` (speech acts) / `DID: tool(args)` (actions) /
`GOT [exit N]: …` (outcomes), tail-prioritized under `verifierEvidenceBudget` with elisions
announced (`[N earlier steps elided: M tool calls, K claims]`).

## Fail-loud posture

The projector refuses (typed `AtifError`/`TraceContractError`) on: unmappable rows, tool
results with no owning call, unparseable tool arguments, children without rollout paths, and
any output that fails our re-implementation of the reference validation rules (which Harbor's
own golden fixture must always pass — `tests/fixtures/harbor-golden-terminus2.trajectory.json`).
`npm test` projects the NEWEST real record in both stores; `oathe doctor` does the same at
run time. A harness format change is a loud break, never a quiet degradation.
