# Oathe D0.1 — Product Handoff

**Version 0.1.2 · 2026-08-25 · status: live on the founder's machine, 162/162 tests, all
settlement paths proven with real engines.** This document is the complete technical handoff:
an agent reading nothing else should be able to work on this codebase correctly.

Oathe is an npm package that puts an **organizational spine under interactive AI coding
sessions**: work is claimed before it is done, progress is recorded as statements, completion
is asserted (never self-settled), and a **non-author verification lane actually settles or
reopens work** by reading the agent's own session traces. It onboards BOTH installed
harnesses — Claude Code and OpenAI Codex — from one `oathe init`.

**Design authority:** `~/firia-migration/docs/oathe-oss/` (the D0 doc + specs) and the
firia-monorepo runtime/DDL. The substrate (26 DDL files, ~55 plpgsql verbs) is consumed
READ-ONLY from `~/firia-monorepo` via a `file:` dependency + one sanctioned path import.
Nothing here edits the monorepo; nothing is published anywhere (`private: true` until the
post-A3.5 extraction).

**House rules (founder rulings, binding):** never hardcode (everything tunable flows through
`OatheConfig`); OOP core with thin functional edges, DRY (one implementation per concept);
fail loud, never silently defer (typed refusal errors everywhere; the ONE sanctioned
exception is session-lifecycle hooks, which are fail-soft but still visibly report);
TDD red-first for all behavior.

---

## 1. System overview

```
 ~/oathe-playground (this package)
 ├─ oathe CLI ──────────────┐
 ├─ MCP server (oathe mcp) ─┤        ┌────────────────────────────────┐
 ├─ plugin (both harnesses) ┼───────▶│  cell substrate (oathe_local)  │
 │   hooks: SessionStart /  │        │  26 DDL files, plpgsql verbs,  │
 │   Stop / PreCompact      │        │  refusals-by-construction      │
 ├─ launchers (cage+host) ──┤        └────────────────────────────────┘
 └─ verifier ───────────────┘                      ▲
        │ reads                                    │ settles via
        ▼                                          │ acceptance lane
 ~/.claude/projects/*  ~/.codex/sessions/*   firia-runtime (read-only file: dep)
 (trace ground truth)  (+ state_5.sqlite)
```

The claim loop is the product: **claim → statements (+ automatic trace linkage) → done →
verification task → verify → settle or reopen**. Refusals are features: a second claimant is
refused, a statement against no claim is refused, self-verification is refused (FC010), a
yield needs a declared cause, settlement without a verdict is refused (FC110–FC114).

---

## 2. The substrate (`src/substrate.mjs`)

- `oathe init` detects Postgres (homebrew socket default, `pgHost`/`pgPort` config), creates
  `oathe_local`, and applies the monorepo's 26 DDL files **in `apply.py`'s exact order**
  (never glob — a unit test cross-checks our list against `apply.py` AND the directory).
- Idempotency is oathe's own bookkeeping (`oathe.ddl_applied`: filename + sha). A re-run
  skips applied files; a **changed** applied file is a `DDL_DRIFT` refusal. Never DROP.
- Seeds the operator principal (role `ceo`) and the **verifier principal** (role `lead`,
  assigned by the operator — FC010 requires a non-author signer to exist).
- Registers the **acceptance authority** through the substrate's own governed verb
  (`cell.register_acceptance_authority`; any other writer → FC170): seats
  `[verifierPrincipal, operator]`, the standard clause specs, checker refs.
- Registers the operator **yield cause**: `cell.oathe_yield_operator` (a real plpgsql
  function — `record_claim_yield` resolves its caller off the call stack) with basis prefix
  `operator_decision`.

## 3. Install / onboarding (`src/init.mjs`, `src/harness.mjs`, `src/manifest.mjs`, `src/blocks.mjs`)

One `Harness` base class; each subclass owns its harness's ONE sanctioned install path:

- **Claude**: two owned keys in `~/.claude/settings.json`
  (`extraKnownMarketplaces.oathe = {source: {source: "directory", path: <pkg>}}` — note:
  **"directory", not the docs' "local"; the installed CLI's schema outranks the docs**,
  verified empirically on 2.1.241 — plus `enabledPlugins."oathe@oathe": true`), THEN
  materialized via the CLI (`claude plugin marketplace add` + `claude plugin install`),
  **verified against `~/.claude/plugins/installed_plugins.json`** with version-mismatch
  eviction (the plugin is CACHED BY COPY, keyed by version — a content change requires a
  version bump to propagate; hook/MCP *scripts* are live because the plugin calls the bin).
- **Codex**: sanctioned CLIs only (`codex plugin marketplace add <pkg>`, `codex plugin add
  oathe@oathe`, `codex mcp add oathe -- oathe mcp`), each **verified** by the stanza it must
  leave in `~/.codex/config.toml` — an install that can't be proven is refused. Codex reads
  the same `.claude-plugin/marketplace.json` (source-verified fallback) — one marketplace
  file at the package root serves both harnesses.
- Every write to a user surface is managed: text files get versioned fences
  (`# >>> oathe v0.1.2 >>>` / HTML-comment style for CLAUDE.md/AGENTS.md), JSON files get
  manifest-recorded owned key paths (no in-file markers — Claude validates settings.json).
  All recorded in `~/.oathe/install-manifest.json` with pre-first-write backups.
- `oathe doctor` verifies every manifest row (`ok`/`user-edited`/`removed`/…; a user edit is
  REPORTED, never overwritten), substrate status, plugin resolution, and the **live trace
  contract** (full ATIF projection of the newest record in each store → `DRIFT` fails).
- `oathe uninstall` removes exactly the recorded entries via the inverse CLIs/fence
  removals; the database stays (`--purge-db` is the one exception).

## 4. The plugin (`plugin/`) — one tree, both harnesses

Path-free (the bin on PATH is the only address — cache-proof in both harnesses):
`hooks.json` commands are `oathe hook render-board|heartbeat|frame-note`; `.mcp.json` is
`{command: "oathe", args: ["mcp"]}` with `OATHE_WORKSPACE_DIR=${CLAUDE_PROJECT_DIR}`.
The three hook events (`SessionStart`, `Stop`, `PreCompact`) exist **verbatim in both
harnesses** (Codex source-verified; TurnStart/TurnEnd do not exist).

- **SessionStart** (`render-board`): emits hook JSON — `additionalContext` = the markdown
  board for the MODEL; `systemMessage` = the visible line for the USER:
  `🎉 Oathe just saved your session state — N tasks still yours! ⭐ <starUrl>` (recovery —
  the only place the star ask appears) · `🔒 Oathe: N open tasks · M asserted · K held` ·
  `🍺 No open tasks in this folder — Oathe is keeping track.`
- **Stop** (`heartbeat`): renews leases for this principal's active claims in this workspace
  AND **links the session trace** — one statement per (claim × session), `subject_ref:
  trace:<session_id>`, transcript path as evidence. Covers claims in `active` **and**
  `completion_asserted` (unsettled) states — a claim taken and asserted within one turn gets
  its evidence at that turn's end (live-found fix).
- **PreCompact** (`frame-note`): records a durable statement on active claims before context
  compression.
- **Skill** `oathe-work` (Agent Skills spec-compliant): the loop — claim before you build,
  statements as you go, pickup don't re-derive, done when done, yield what you can't finish;
  refusals are the product.
- Hooks are fail-soft (never block a session) but always report visibly/stderr.

## 5. Launchers (`src/launch.mjs`, `src/session-host.mjs`)

`oathe claude` / `oathe codex` = one `runHarness`:

1. **Pre-flight**: refuses if the harness was never onboarded; ensures the cwd's CLAUDE.md
   (+ AGENTS.md when Codex installed) carries the managed fence (project-scope manifest row;
   creates a minimal file when absent).
2. **Verifier choice**: first TTY launch in a folder where the engine was never explicitly
   chosen prompts `[1] claude [2] codex` once, records to `.oathe.json` (config provenance:
   `source(key)` distinguishes chosen from defaulted); off-TTY announces the default on
   stderr — never silently assumed.
3. **Codex-only ANSI splash** (Codex buries hook output in its ctrl+T overlay, unrendered):
   the board in bold/dim aligned columns + a TTY-gated 3s pause (`Enter to go now`). Claude
   launches clean — its own banner is the good experience.
4. **The cage**: `spawnCaged` (imported by path from the monorepo — the one sanctioned path
   import) — REPLACED environment (curated; `--hermetic` = terminal-plumbing whitelist +
   oathe wiring only), `FIRIA_EXECUTION_ATTEMPT_ID` fence stamp, and **proven-empty
   teardown** after exit. The binary resolves against the LAUNCH env's PATH.
5. **Session host**: leases renew exactly while `cage.enumerate()` shows live pids
   (SIGSTOP'd = still held). Killed → renewals stop, the lease visibly runs out, **no
   statement is fabricated** (R10: an absence is an absence). Clean exit → an exit statement
   on every held claim. Everything after the verb passes to the harness VERBATIM (only the
   first `--hermetic` and one `--` are oathe's).

Custody model: oathe-launched sessions have **liveness custody**; bare `claude`/`codex`
sessions (plugin still active) have **turn custody** (Stop-hook renewal only).

## 6. The board & the speech-act verbs (`src/mcp/oathe-tools.mjs`)

MCP tools (ndjson JSON-RPC stdio server, governed-effect shape: legacy `initialize`
advertising `2025-06-18`, `-32601` on unknown methods so modern clients fall back; pure
`dispatch()` testable with a fake tools map; every tool failure is `isError:true` with a
typed code — fail-loud, never a bland success):

| tool / verb | semantics |
|---|---|
| `oathe_claim` | mints the task if new (`plan_status: "unknown"` — NEVER fabricated) + `cell.claim_work` (lease `leaseHours`); **assigns the verifier engine on the record** (statement `verifier:<engine>`); a task with `origin='reopened'` routes through `cell.reclaim_reopened_task` (R8's second half — the PRIOR principal is re-seated; plain claim_work is FC130-refused) |
| `oathe_board` | ONE classification serving every surface: `mine` (active, yours) / `held` (active, others) / `asserted` (completion_asserted, unsettled) / `open` (everything else, incl. `reopened`); **settled rows are off the board** |
| `oathe_statement` | progress statement against your active claim — "a statement, not truth" |
| `oathe_done` | three acts: (1) if the plan is unknown, **bind the policy-standard plan** via `cell.amend_verification_contract` (G2-b policy binder; FC161 allows amendment only under an ACTIVE claim, i.e. exactly now); (2) completion statement + `cell.assert_claim_completion` (the statement must be `statement_type='completion'`); (3) **mint `verify:<task>`** on the board carrying the assigned engine (verification tasks mint no verifier for themselves — the regress ends at the deterministic bar). The result coaches FC010: you cannot verify your own work, including via your own sub-agents |
| `oathe_yield` | `cell.oathe_yield_operator` — the obligation returns to the board with a declared cause |
| `oathe_verify` | the verification lane (below); also `oathe verify` CLI |
| `oathe_pickup` | the founder-ruled "continue task-x": the verified successor sequence — `buildProductionDeps → readPriorAttemptStep → reallocateStep` (RECOMPILE decided inside `allocate()`), frozen contract read from 019's claim-time freeze; refusal on a yielded task COACHES the recovery (claim again, then pick up) |

Workspace identity (`src/workspace.mjs`): `ws-<12hex>` from git-root realpath + origin URL
(plain dir realpath otherwise), carried in each claim's `contract_ref`
(`workspace:<ws>;contract:<org>/<task>@v1`) — the additive `workspace_ref` column is a
flagged post-episode upstream ask.

## 7. The trace layer (`src/traces.mjs`, `docs/traces.md`)

Ground truth, discovered by experiment and PINNED (both vendors disclaim schema stability):

- **Claude**: `~/.claude/projects/<encoded-cwd>/<session>.jsonl`; subagent fan-outs at
  `<project>/<session>/subagents/agent-<id>.jsonl` (+ `.meta.json`); resume APPENDS;
  `--bg` links via `~/.claude/jobs/<id>/state.json`. Rich per-message metadata: `gitBranch`,
  `usage`, `ai-title`, file-history `trackedFileBackups`.
- **Codex**: `~/.codex/sessions/Y/M/D/rollout-<ts>-<threadId>.jsonl` (`.zst` possible);
  first line `session_meta`; `state_5.sqlite` indexes threads (rollout_path, cwd, git_sha,
  tokens_used) and `thread_spawn_edges` (fan-out). `codex exec` refuses untrusted dirs
  without `--skip-git-repo-check`.
- `TraceStore` base + `ClaudeTraceStore`/`CodexTraceStore`: typed `TraceContractError`
  refusals; **drift fails loud in `npm test` (live-store contract tests) and in `oathe
  doctor`** — a harness update that moves the format breaks the suite by design.

## 8. ATIF projection (`src/atif.mjs`, `docs/atif-oathe.md`)

Traces project at read time into **Harbor ATIF v1.7** — statement/action/outcome split
structurally (`message` / `reasoning_content` / `tool_calls` / `observation.results` keyed by
`source_call_id`). Custom fields outside `extra` are forbidden by the reference models
(`extra:"forbid"`, source-verified), so oathe's layer rides the sanctioned slots as the
**versioned `extra.oathe` convention** (`oathe_convention: 1`):

- root: harness, source_path, session_id, session_title, files_touched, and (on export) the
  obligation linkage (org/task/work_claim/contract_ref/workspace) + settled `verdict`
- step: `claim_events` — the agent's on-the-record oathe speech acts, structurally separable
  (verb names derived from `makeToolDefs()`, never retyped)
- tool_call: `files` (any call with a `file_path` argument)
- observation_result: `observed.exit_code` parsed CONSERVATIVELY from stated "Exit code N" —
  **absent when unstated, never fabricated**

`AtifValidator` re-implements the reference rules (sequential step_ids, call-ref integrity,
agent-only fields, known-fields-only, unique embedded trajectory_ids) — and **Harbor's own
golden fixture must pass it** (`tests/fixtures/harbor-golden-terminus2.trajectory.json`; it
already corrected us once: `source_call_id` is optional). Every projector output is
validator-asserted before return. `renderEvidenceView` renders the aligned record —
`SAID:` / `CLAIM(verb task)` / `DID: tool(args)` / `GOT [exit N]: …` — under
`verifierEvidenceBudget`, tail-prioritized with **announced** elisions.
`oathe trace <task> [--out dir]` exports (pure JSON stdout; summary on stderr).

## 9. The verification lane (`src/verifier.mjs`, `src/plans.mjs`)

The ruled shape: **verification is ordinary work; agent evaluators are allocated on demand
per obligation, never a standing grader; the LLM only produces EVIDENCE — every settlement
is signed by a deterministic lane under a non-author seat.**

Per `oathe verify [task] [--all] [--engine claude|codex]`:

1. Claims `verify:<task>` as `oathe-verifier` (visible lease on the board).
2. Gathers: objective + bound plan, the completion statement, the linked traces projected to
   ATIF (fan-outs embedded; contract failures refuse — never less evidence than recorded).
3. ONE fresh headless engine run (`claude -p --output-format json` / `codex exec
   --skip-git-repo-check`) — fresh context, different eyes ("same-harness verification is
   never a subagent of the worker session": FC010's two-part author split + the
   anti-laundering ruling). Strict JSON verdict; malformed → typed refusal, the lane never
   guesses.
4. The verdict lands as the verification task's completion statement (evidence ref
   `verdict:<verdict>:<task>`).
5. **Settlement — deterministic**: `buildProductionAcceptanceLane({pool, seatPrincipal:
   'oathe-verifier', registry})` with the composed `oathe-verdict` checker (standard clause
   conditions AND the recorded verdict — data on the clause, provenance in the substrate).
   Accepted → `cell.verification` row (`verified | seat | acceptance_package`, FC010-clean)
   + `cell.settle_work_claim` in ONE transaction (FC113/FC114 hold by construction).
   Rejected → rejected verification row + `cell.reopen_rejected_task` (R8) — the task shows
   `[reopened]`, and the next `oathe_claim` resumes it via `reclaim_reopened_task`.
6. The review itself settles under the OPERATOR seat (non-author of the verdict statement) —
   non-author all the way down, the a2a review-task shape.

**The standard plan** (`src/plans.mjs`, G2-b's "policy supplies a standard plan for routine
work"): `plan_status: declared`, clause `acceptance_package`, conditions
`statement_kind=completion` + `evidence_present≥1` + `trace_ref_present`, stamped
`bound_by: policy:oathe-standard@1`. Pre-pipeline asserted claims (frozen unknown plans)
verify through the deployment-spec fallback — same bar, no amendment needed.

**Stated bound (the design's own discipline):** the deterministic bar checks the verdict's
PRESENCE and PROVENANCE; judgment quality is the engine's; a fabricated-but-well-formed
record could pass. The trace linkage exists precisely to keep the judgment auditable.
This lane verifies **occurrence** (did the agent do what it said), not quality, and it is
**terminal, not longitudinal** — see §13 for the drift-layer roadmap.

## 10. Configuration (`src/config.mjs`)

Layered `OatheConfig`: defaults → `~/.oathe/config.json` (global) → `<workspace>/.oathe.json`
→ env. Unknown keys / invalid values refuse AT LOAD. `source(key)` reports provenance.
`oathe config <key> [value] [--global]`.

| key | default | env |
|---|---|---|
| `org` / `principal` / `department` | `oathe` / `$USER` / `founder` | `OATHE_ORG` / `OATHE_PRINCIPAL` / `OATHE_DEPARTMENT` |
| `db` / `pgHost` / `pgPort` | `oathe_local` / `/tmp` / `5432` | `OATHE_DB` / `OATHE_PG_HOST` / `OATHE_PG_PORT` |
| `leaseHours` / `verifyByHours` | `4` / `24` | `OATHE_LEASE_HOURS` / `OATHE_VERIFY_BY_HOURS` |
| `verifier` / `verifierPrincipal` | `claude` / `oathe-verifier` | `OATHE_VERIFIER` / `OATHE_VERIFIER_PRINCIPAL` |
| `verifierEvidenceBudget` | `24000` chars | `OATHE_VERIFIER_EVIDENCE_BUDGET` |
| `starUrl` | `https://github.com/oathe-ai/oathe` (404 until extraction) | `OATHE_STAR_URL` |

Also env-overridable: `OATHE_MONOREPO`, `OATHE_HOME` (paths.mjs).

## 11. CLI reference

`init · claude · codex · claim · ls · note · done · verify · trace · yield · config ·
doctor · status · uninstall [--purge-db] · hook <name> · mcp` (last two are the plugin's
bin-addressed entry points). Every run ends with the machine-parseable
`oathe: <verb> ok|refused|error|attention|exit N` (stderr for `trace`, whose stdout is pure
JSON). Substrate refusals surface non-zero as `refused`.

## 12. Testing strategy (`tests/`, 162 tests)

- **TDD red-first for every behavior**; each unit committed green.
- **Real substrate in tests**: scratch Postgres databases per suite — the 26-file DDL apply,
  claim/yield/done refusals, and the ENTIRE settlement lane (acceptance lane, FC010, R8
  reopen+reclaim) run against real plpgsql, not mocks. Only the LLM engine is faked (seam).
- **Sandboxed integration**: fresh `$HOME`, fake harness binaries + CLI fakes that mirror the
  real CLIs' file writes; init idempotency is byte-diffed; uninstall byte-restores.
- **Live contract tests**: the newest REAL transcript/rollout on the machine must parse AND
  project to valid ATIF — harness drift breaks `npm test` and `oathe doctor`.
- **Golden cross-check**: Harbor's own fixture must pass our validator.
- **The full loop over the real stdio server**: initialize → claim → note → pickup (real
  successor) → yield, plus double-yield refusal.
- `claude plugin validate` clean on plugin + marketplace.

## 13. Live-proven results (all on this machine, real engines, real settlement)

1. **First real settlement**: `live-verify-demo`, verified by the claude engine against THIS
   build session's own 3.4MB transcript → `verified | oathe-verifier | seat`, both claims
   settled, board count dropped.
2. **The liar-task**: claimed "migrate the production database," linked only a 17×3
   calculator session as its trace → **rejected** ("no database, schema, migration, or
   table-conversion actions or outcomes appear anywhere") → reopened on the board.
3. **ATIF export of the build session**: 513 steps, 9 embedded subagent trajectories, verdict
   stamped, validator-clean.
4. **Live-found fixes** (each became a test): "local" vs "directory" settings schema; plugin
   cache path-dangling → bin-shim; Codex TUI burying hook output → splash; same-turn
   claim+done leaving zero linked traces; reopened tasks stuck in the asserted bucket;
   `ls` bypassing the settled filter.

## 14. Known bounds & roadmap

- **Drift over long-context tasks is NOT yet detected** — this lane is terminal
  occurrence-verification. The instrumentation is ready (interleaved claim_events + DID/GOT
  + compaction markers); the planned layer: per-claim segmented alignment scoring, checkpoint
  verification (PreCompact / `verify_by`-triggered, non-settling), deterministic drift
  telemetry (exit-code streaks, claim/action cadence), head-anchored evidence views, and
  rich contracts (G2-b worker-proposes path).
- CLI-driven speech acts (`Bash(oathe done …)`) are visible as DID lines but not marked as
  `claim_events` — a small convention extension if wanted.
- The verifier engine run is `spawnSync`, not caged, and inherits the invoking env — below
  the launcher's posture; flagged.
- Quality verification (judging the diff via `git_sha` metadata — evidence that
  dereferences) is designed but unbuilt; the `verify_by` overdue pager likewise.
- The 6 pre-pipeline asserted smoke tasks in the repo workspace have no verification tasks
  (backfill on request). Extraction gates (publish to npm/GitHub): firia-runtime dependency,
  cage import-by-path, `private: true`, star URL 404.
- `extra.oathe` is upstream-RFC-shaped for harbor-framework/harbor (external-contribution
  precedent exists: NVIDIA in v1.7).

## 15. File map

```
bin/oathe.mjs            CLI router (parseArgs; verbatim arg passthrough to harnesses)
src/config.mjs           OatheConfig — every tunable, layered, provenance-aware
src/paths.mjs            all filesystem locations, env-overridable
src/blocks.mjs           managed writes: FencedBlock (text) + JsonEntries (owned key paths)
src/manifest.mjs         install manifest + pre-first-write backups
src/harness.mjs          Harness base → ClaudeHarness / CodexHarness (verified installs)
src/substrate.mjs        PG detect/create, ordered DDL apply, seeds, authority registration
src/workspace.mjs        ws-<hash> identity (git root + origin)
src/context.mjs          the composition seam every verb starts from
src/init.mjs / doctor.mjs / uninstall.mjs
src/launch.mjs           preflight, verifier prompt, splash, cage, runHarness
src/session-host.mjs     liveness-custody lease renewal (R10 absences)
src/mcp/oathe-tools.mjs  the speech-act MCP server + tool implementations
src/plans.mjs            the G2-b policy-standard plan + verification-task naming
src/traces.mjs           TraceStore family (ground-truth readers, drift refusals)
src/atif.mjs             AtifProjector family + AtifValidator + renderEvidenceView
src/verifier.mjs         the allocated-on-demand verifier + acceptance-lane settlement
src/successor.mjs        the pickup successor sequence (real runtime wiring)
plugin/                  hooks (bin-addressed), skill, .mcp.json, .claude-plugin/plugin.json
.claude-plugin/marketplace.json   one marketplace, both harnesses
docs/traces.md           the trace ground-truth contract
docs/atif-oathe.md       the extra.oathe convention spec
tests/                   162 tests incl. live-store contracts + Harbor golden fixture
```

## 16. Key refusal codes (a working vocabulary)

`OATHE_NO_ACTIVE_CLAIM` · `OATHE_OBJECTIVE_REQUIRED` · `OATHE_RECLAIM_REFUSED` ·
`OATHE_PICKUP_UNAVAILABLE` · `OATHE_NOTHING_TO_VERIFY` · `OATHE_NO_COMPLETION` ·
`OATHE_VERDICT_MALFORMED` · `OATHE_SETTLEMENT_BLOCKED` · `OATHE_REVIEW_UNSETTLED` ·
`OATHE_ENGINE_UNKNOWN/FAILED` · `TRACE_*` (contract drift) · `ATIF_UNMAPPABLE/INVALID` ·
`OATHE_CONFIG_KEY_UNKNOWN/VALUE_INVALID` · `DDL_DRIFT/DDL_APPLY_FAILED` ·
`CLAUDE_/CODEX_VERIFICATION_FAILED` (install unproven) · `OATHE_SUBSTRATE_UNREACHABLE` ·
`OATHE_NOT_INSTALLED` · `OATHE_HARNESS_NOT_FOUND` · `OATHE_DUPLICATE_FENCE`.
Substrate-side: FC003 (second claimant), FC010 (self-verification), FC110–FC114
(settlement gates), FC130–FC134 (reopen/reclaim), FC140/FC141 (yield cause), FC160/FC161
(contract freeze/amend), FC170 (authority writer).

---

*Provenance: built 2026-08-25 in one session (transcript `836af10b-…`, itself the first
really-verified obligation in `oathe_local`). Plan file history and founder rulings are in
`PLAN.md` and the commit messages — read `git log` for the decision trail; every commit
message states what changed AND why the design says so.*
