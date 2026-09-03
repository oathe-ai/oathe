# Oathe — Product Handoff

**This document is the complete technical handoff**: an agent reading nothing else should be
able to work on this codebase correctly. The version is `package.json`'s; each release's proof
is in its notes and in `git log`.

Oathe is an npm package that puts an **organizational spine under interactive AI coding
sessions**: work is claimed before it is done, progress is recorded as statements, completion
is asserted (never self-settled), and a **non-author verification lane actually settles or
reopens work** by reading the agent's own session traces. It onboards every installed
harness — Claude Code, Codex, Cursor — from one `oathe init`.

**Design authority:** the D0 interface doc + specs, and the oathe runtime/DDL (developed
privately). The substrate DDL is vendored under `vendor/ddl/` (28 files, sha256-manifested);
a runtime checkout, when one is present, is consumed READ-ONLY via
`OATHE_MONOREPO` + `npm run link-runtime` through the runtime seam (§5); without one the
package runs on its standalone provider. Nothing here edits that checkout.

**House rules (founder rulings, binding):** never hardcode (everything tunable flows through
`OatheConfig`); OOP core with thin functional edges, DRY (one implementation per concept);
fail loud, never silently defer (typed refusal errors everywhere; the ONE sanctioned
exception is session-lifecycle hooks, which are fail-soft but still visibly report);
TDD red-first for all behavior.

---

## 1. System overview

```
 this package
 ├─ oathe CLI ──────────────┐
 ├─ MCP server (oathe mcp) ─┤        ┌────────────────────────────────┐
 ├─ plugin (all harnesses)  ┼───────▶│  cell substrate (oathe_local)  │
 │   hooks: SessionStart /  │        │  28 DDL files, plpgsql verbs,  │
 │   Stop / PreCompact      │        │  refusals-by-construction      │
 ├─ launchers (cage+host) ──┤        └────────────────────────────────┘
 └─ verifier ───────────────┘                      ▲
        │ reads                                    │ settles via
        ▼                                          │ acceptance lane
 ~/.claude/projects/*  ~/.codex/sessions/*   oathe-runtime (read-only, when present)
 (trace ground truth)  (+ state_5.sqlite)
```

The claim loop is the product: **claim → statements (+ automatic trace linkage) → done →
verification task → verify → settle or reopen**. Refusals are features: a second claimant is
refused, a statement against no claim is refused, self-verification is refused (FC010), a
yield needs a declared cause, settlement without a verdict is refused (FC110–FC114).

---

## 2. The substrate (`src/substrate.mjs`)

- `oathe init` detects Postgres (homebrew socket default, `pgHost`/`pgPort` config), creates
  `oathe_local`, and applies the monorepo's 28 DDL files **in `apply.py`'s exact order**
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

## 3. Install / onboarding (`src/init.mjs`, `src/harnesses/`, `src/manifest.mjs`, `src/blocks.mjs`)

**The harness adapter catalog** (`src/harnesses/catalog.mjs`) is the one registry over every
adapter, and **a supported harness is one whose adapter declares every touchpoint** (ruling
R-HARNESS-TOUCHPOINTS): identity facts (`bin`, `clientNames`, `contextFiles`,
`projectDirEnvVar`, `globalContextFiles`, `docs`, `install`, synthetic-workspace rule) and
named, frozen, nullable **capabilities** — `wiring` (with the instance's own `describe()` of
what init writes, from the same data `onboard()` writes), `hooks {dialect}`, `launch
{splash}`, `headless {auth, command(prompt, model), extract}`, `traces {store, newest,
projector, ownsPath}` — each fully supported or `null`, never half-done, never hardcoded
elsewhere. `detect()` is structured — `{app, cli, configHome}` plus the adapter's own
`installedFrom(presence)` verdict — so a headless run asks for the CLI and wiring asks for the
config home, never one bit. Consumers ask the catalog by capability (`verifierCapable`,
`verifiers(census)`, `traceStores`, `launchable`, `wireable`, `ownerOfTracePath`,
`projectorFor`, `harnessForClient`); no `'claude'`/`'codex'`/`'cursor'` literal survives
outside `src/harnesses/`. Trace stores and projectors are named by the adapter that builds
them; a trace path no store owns is `TRACE_OWNER_UNKNOWN`, never "probably Claude". The
detect-only surfaces (Cowork, ChatGPT web) are adapters with `wiring: null` and a `note`.
`tests/harness-contract.test.mjs` is the contributor's spec: a roll-call per capability with
shape checks and a **golden capability table** (adding a harness or a capability is a visible
row change), with hook payload shapes pinned as fixtures (`tests/fixtures/hooks/`) sourced
from the `.harness-docs/` snapshot (re-pull with `scripts/pull-harness-docs.mjs`); a new
harness version means a new fixture beside the old, and the dialect must serve both.

`oathe init` is a **setup plan rendered by a prompter** (`src/setup.mjs`; the rules are
`docs/UX.md`, ruling R-UX). The `SetupPlan` derives one step per wiring adapter from the
census — its presence as facts, what saying yes writes from the adapter's own `describe()`, a
harness that is not here already answered — plus the verifier candidates (`verifiers(census)`:
headless-capable AND the CLI is present, so an IDE-only Cursor is not offered) with a default,
an already-made machine-wide choice as a statement, and the detect-only surfaces as
explanations. Order: census → plan → the substrate's reachability (nobody answers a setup that
cannot come up) → **ask everything** → **do everything** → summary. On a TTY the
`SetupPrompter` is ONE screen (raw-mode keys, plain ANSI, no TUI dependency): every detected
harness a pre-selected `[x] Name (covers)` row — `covers` the adapter's own statement of the
surfaces its wiring serves — with the highlighted row's writes dimmed below; ↑↓ to move, space
to toggle, the verifier as a radio row (← →) preset to the recorded machine-wide choice
(re-running init IS how the verifier is changed; init rewrites the global value only when it
changed); not-found harnesses, `--harness`-decided steps and detect-only surfaces are dim fixed
rows; Esc/q/ctrl-c is `OATHE_INIT_ABORTED`; no numbers anywhere. `--yes` and no-TTY apply the plan's defaults and
announce them ("init: --yes — applying defaults: wire: …; skip: … (not installed); verifier:
…"); `--harness a,b` refuses an unknown name (`OATHE_INIT_HARNESS_UNKNOWN`) and one not on
this machine (`OATHE_INIT_HARNESS_ABSENT`). The bin's summary is the plan's outcomes — each
harness wired with the files that landed, or skipped with the reason as a sentence — then the
verifier and where it is recorded, substrate, principal, surfaces, and the `Next:` line. The
verifier choice is machine-wide (the global config layer alone decides whether it was made; a
per-folder `.oathe.json` never silences the question). Each adapter owns its harness's ONE
sanctioned install path:

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
  file at the package root serves both CLI harnesses. The standing rule for folderless sessions
  (ChatGPT desktop) is a global fence in `~/.codex/AGENTS.override.md` when that file exists,
  else `~/.codex/AGENTS.md` — the harness's own precedence (`globalContextFiles`).
- **Cursor**: installer-written owned entries — `mcpServers.oathe` in `~/.cursor/mcp.json`
  (JSON owned path) and three owned ARRAY elements among the user's own hooks in
  `~/.cursor/hooks.json` (`JsonArrayEntries`: append-if-absent by ownership predicate, remove
  exactly ours). Commands are ABSOLUTE (the resolved `oathe` bin, else `<node> <pkg>/bin/
  oathe.mjs` — Cursor runs user hooks from `~/.cursor` and GUI apps read no shell rc), every
  write verified after landing (`CURSOR_VERIFICATION_FAILED`), byte-reversible. Detection is
  structured: the config home `~/.cursor` is the IDE (enough to wire — the IDE leaves no bin
  on PATH); the `agent` CLI on PATH is what makes Cursor a verifier
  candidate (`headless`: `agent -p --trust --output-format json`).
- **The workspace registry** (`~/.oathe/workspaces.json`, `src/registry.mjs`): the machine-wide
  record of which folders carry a board — root realpath, identity, first registrar, last-seen,
  harnesses seen, fence versions. Hooks, MCP tools, CLI verbs, and launchers all upsert it on
  use; writes are atomic (temp-then-rename) under a bounded lock (`src/fslock.mjs`) that gives
  up and proceeds — registration is idempotent, a hook never deadlocks on a foreign lock.
- Every write to a user surface is managed: text files get versioned fences
  (`# >>> oathe v<version> >>>` / HTML-comment style for CLAUDE.md/AGENTS.md), JSON files get
  manifest-recorded owned key paths (no in-file markers — Claude validates settings.json).
  All recorded in `~/.oathe/install-manifest.json` with pre-first-write backups. The manifest is
  written against the FILE, never a snapshot (ruling 2026-09-03): a long-lived holder — the
  MCP server's context, built once per config change — re-reads it inside the activation lock
  before adding a row (`InstallManifest.refresh()`), and `init`/`uninstall` merge-refresh under
  the same lock before their one save (rows that landed mid-run are kept, this run's removals
  hold, this run's rows win), so an open session can no longer overwrite what an init recorded.
- `oathe doctor` verifies every manifest row (`ok`/`user-edited`/`removed`/…; a user edit is
  REPORTED, never overwritten), substrate status, plugin resolution, and the **live trace
  contract** (full ATIF projection of the newest record in each store → `DRIFT` fails).
- `oathe uninstall` removes exactly the recorded entries via the inverse CLIs/fence
  removals; the database stays (`--purge-db` is the one exception).
- `oathe update` (`src/update.mjs`) is the documented upgrade as one verb: `npm i -g
  @oathe/oathe@latest` through the npm beside the node running this bin (`process.execPath` —
  never PATH's, which on an nvm machine can be another node's), then `init` through the NEW bin
  under npm's global prefix (`npm prefix -g` — node's own directory by default, elsewhere with a
  custom prefix) as a child with the terminal attached (this process still holds the old modules). A checkout
  is refused typed (`OATHE_UPDATE_NOT_GLOBAL` — it updates by git); npm's failure is
  `OATHE_UPDATE_FAILED` with npm's own last line.

## 4. The plugin (`plugin/`) — one tree, thin manifest adapters per harness

Path-free (the bin on PATH is the only address — cache-proof in every harness):
`hooks.json` commands are `oathe hook render-board|heartbeat|frame-note`; `.mcp.json` is
`{command: "oathe", args: ["mcp"]}` — **no env block**: the server's resolution ladder owns
workspace discovery (§6), and a `${...}` a harness never expands must have nothing to poison.
`.claude-plugin/plugin.json` serves Claude and Codex; `.cursor-plugin/plugin.json` is the
Cursor adapter in the SAME tree (inline cursor-dialect hooks + mcpServers — one tree, N thin
root manifests). The three lifecycle moments (`SessionStart`, `Stop`, `PreCompact`; Cursor:
`sessionStart`, `stop`, `preCompact`) exist verbatim in every wired harness.

Hook payloads arrive in each harness's own **dialect** (`src/harnesses/dialects.mjs`):
Claude/Codex hand `cwd` and take the camelCase `hookSpecificOutput` reply; Cursor hands
`workspace_roots[]` and takes snake_case fire-and-forget `additional_context`. The hook spine
(`plugin/hooks/lib.mjs`) sniffs the shape, normalizes, and answers in kind. Hooks fire in
EVERY session, and SessionStart **activates** the
workspace: central registry row + the context-file fences through the one writer
(`src/activation.mjs`), disclosed in the render; `autoActivate: false` registers only.

- **SessionStart** (`render-board`): activation, then hook JSON — `additionalContext` = the
  markdown board for the MODEL; `systemMessage` = breaches-or-silence (R-QUIET, 2026-08-29:
  breaches push, status pulls, and the restored-state banner rides the actual `oathe_pickup`,
  never ambient session start). An
  activation write's disclosure still speaks once. A session with no resolvable workspace
  exits silently — there is no board to speak about.
- **Stop** (`heartbeat`): **links the session trace** — one statement per (claim × session),
  `subject_ref: trace:<session_id>`, transcript path as evidence — and registers the session's
  liveness. It never touches the ownership horizon (R1, 2026-08-26: session liveness is not an
  organizational act; the horizon is set once by the claim verb and expires on its own). Covers claims in `active` **and**
  `completion_asserted` (unsettled) states — a claim taken and asserted within one turn gets
  its evidence at that turn's end (live-found fix).
- **PreCompact** (`frame-note`): records a durable statement on active claims before context
  compression.
- **Skill** `oathe-work` (Agent Skills spec-compliant): the loop — claim before you build,
  statements as you go, pickup don't re-derive, done when done, yield what you can't finish;
  refusals are the product.
- Hooks are fail-soft (never block a session) but always report visibly/stderr.

## 5. Launchers (`src/launch.mjs`, `src/session-host.mjs`)

The everyday way into a folder's board is the harness itself — `claude`, `codex`, `agent` —
because the plugin rides every session (§4). The launcher is what the notch's continue runs
(`oathe <agent> 'continue <task>'` in the task's home, §8) and an opt-in for a person who
wants a session tracked as one attempt or run `--hermetic`. `oathe claude` / `oathe codex` /
`oathe cursor` = one `runHarness`:

1. **Pre-flight**: refuses if the harness was never onboarded; activates the cwd's workspace
   through the ONE writer (`src/activation.mjs`) — the fences land in the union of the
   detected adapters' declared context files (CLAUDE.md for Claude; AGENTS.md for Codex and
   Cursor), project-scope manifest rows, registry recorded.
2. **Verifier**: chosen at `oathe init`, never here — `ensureVerifierChoice` only ANNOUNCES a
   still-default value on stderr (config provenance: `source(key)` distinguishes chosen from
   defaulted). Per-folder override: `oathe config verifier <engine>`.
3. **Adapter-declared ANSI splash** (the adapter's `launch.splash` — Codex buries hook output in its ctrl+T overlay, unrendered):
   the board in bold/dim aligned columns + a TTY-gated 3s pause (`Enter to go now`). Claude
   launches clean — its own banner is the good experience.
4. **The cage**: `spawnCaged` from the runtime seam below — the runtime's (imported by path
   from the monorepo, the one sanctioned path import) or the standalone `SimpleCage` —
   REPLACED environment (curated; `--hermetic` = terminal-plumbing whitelist +
   oathe wiring only), `OATHE_EXECUTION_ATTEMPT_ID` fence stamp, and **proven-empty
   teardown** after exit. The binary resolves against the LAUNCH env's PATH.
5. **Session host**: observes liveness and nothing else — each tick asks the cage's
   `enumerate()` (SIGSTOP'd = still alive) and never touches the ownership horizon (R1: the
   horizon is set once at claim time and expires on its own). Killed → the host halts and
   writes **nothing** (R10: an absence is an absence). Clean exit → one exit statement on
   every claim this principal still holds: "session ended (exit N) with this claim still held
   — the lease will expire unless the work is picked up or yielded". Everything after the verb passes to the harness VERBATIM (only the
   first `--hermetic` and one `--` are oathe's).

Custody model: oathe-launched sessions have **liveness custody**; bare sessions on any wired
harness (plugin/hooks active) have **turn custody** (Stop-hook trace linkage only).
`OATHE_LAUNCHED_HARNESS` is the custody marker and nothing more — tool access is gated by
workspace RESOLUTION (§6), not by who spawned the session.

**The runtime seam (`src/runtime/provider.mjs` — ruling: ONE seam, never a fork).** Two
providers serve one capability surface — cage, settlement, pickup — chosen by
`runtimeProvider` (`auto|oathe|standalone`; `auto` is `oathe` exactly when the sanctioned cage
path resolves on disk). The `oathe` provider binds the runtime checkout: the cage above, the
runtime's acceptance lane, and the thin-path pickup (§6). The `standalone` provider is what
the published package runs on a clean machine: `SimpleCage` (`src/runtime/simple-cage.mjs`, a
clean-room implementation of the same contract — replaced environment, attempt-id stamp, a
fresh process group, teardown with the emptiness re-observed), `SqlAcceptanceLane`
(`src/runtime/sql-acceptance-lane.mjs` — the shared deterministic clause discharge,
`src/runtime/discharge.mjs`, then `cell.verification` + `cell.settle_work_claim` in one
transaction; the substrate's triggers stay the enforcement), and a pickup that refuses typed
(`OATHE_PICKUP_UNAVAILABLE`, naming the recovery). Requesting `oathe` where the checkout does
not resolve is `OATHE_RUNTIME_UNAVAILABLE`; a checkout present but unlinked is
`OATHE_RUNTIME_UNLINKED` (`npm run link-runtime`).

## 6. The board & the speech-act verbs (`src/mcp/oathe-tools.mjs`, `src/mcp/connection.mjs`)

MCP tools (ndjson JSON-RPC stdio server, governed-effect shape: legacy `initialize`
advertising `2025-06-18`, `-32601` on unknown methods so modern clients fall back; pure
`dispatch()` testable with a fake tools map; every tool failure is `isError:true` with a
typed code — fail-loud, never a bland success).

**Startup is crash-proof by construction**: `McpConnection` builds NOTHING beyond the
transport until the first `tools/call` — `initialize`/`tools/list` answer under any
environment, and the tool context comes lazily from the ONE resolution ladder
(`src/workspace-resolver.mjs`):

1. `OATHE_WORKSPACE_DIR` (an unexpanded `${...}` template or dangling path SKIPS with a
   diagnostic — the desktop-surface ENOENT bug this ladder killed);
2. each adapter's declared project-dir env var (`CLAUDE_PROJECT_DIR`, `CURSOR_PROJECT_DIR` —
   the catalog sweep);
3. MCP `roots/list` — an id-correlated server-initiated request, only to clients that declared
   the capability at `initialize`, bounded by `rootsTimeoutMs`;
4. the process cwd — refusing `/` and the home directory (a home-dir board is silently wrong);
5. per-call typed `OATHE_WORKSPACE_UNRESOLVED` naming every input received verbatim.

`notifications/roots/list_changed` closes the stale context and re-resolves. **Resolution IS
the gate**: every successful call registers the workspace in
`~/.oathe/workspaces.json`; `oathe_claim` — the write-intent act — ACTIVATES it (fences via
`src/activation.mjs`) and discloses in its result. `OATHE_WORKSPACE_DIR` stays session env
by design, NOT an `OatheConfig` key: it names a per-process workspace binding, not a
preference — a config file must never pin every session to one folder.

| tool / verb | semantics |
|---|---|
| `oathe_claim` | mints the task if new (`plan_status: "unknown"` — NEVER fabricated) + `cell.claim_work` (lease `leaseHours`); **assigns the verifier engine on the record** (statement `verifier:<engine>`); a task with `origin='reopened'` routes through `cell.reclaim_reopened_task` (R8's second half — the PRIOR principal is re-seated; plain claim_work is FC130-refused) |
| `oathe_board` | ONE classification serving every surface: `mine` (active, yours) / `held` (active, others) / `asserted` (completion_asserted, unsettled) / `open` (everything else, incl. `reopened`); **settled rows are off the board**. Scoped by the HOME rule below — this folder's tasks + homeless ones; the full board for `all:true` or a synthetic surface (`workspace: null`) |
| `oathe_statement` | progress statement against your active claim — "a statement, not truth" |
| `oathe_done` | three acts: (1) if the plan is unknown, **bind the policy-standard plan** via `cell.amend_verification_contract` (G2-b policy binder; FC161 allows amendment only under an ACTIVE claim, i.e. exactly now); (2) completion statement + `cell.assert_claim_completion` (the statement must be `statement_type='completion'`); (3) **mint `verify:<task>`** on the board carrying the assigned engine (verification tasks mint no verifier for themselves — the regress ends at the deterministic bar). The result coaches FC010: you cannot verify your own work, including via your own sub-agents |
| `oathe_yield` | `cell.oathe_yield_operator` — the obligation returns to the board with a declared cause |
| `oathe_verify` | the verification lane (below); also `oathe verify` CLI |
| `oathe_pickup` | the founder-ruled "continue task-x": the verified successor sequence — `buildProductionDeps → readPriorAttemptStep → reallocateStep` (RECOMPILE decided inside `allocate()`), frozen contract read from 019's claim-time freeze; refusal on a yielded task COACHES the recovery (claim again, then pick up). Served where the runtime resolves (§5); the standalone provider refuses `OATHE_PICKUP_UNAVAILABLE` and names the recovery |

Workspace identity (`src/workspace.mjs`): `ws-<12hex>` from git-root realpath + origin URL
(plain dir realpath otherwise), carried in each claim's `contract_ref`
(`workspace:<ws>;contract:<org>/<task>@v1`) — the additive `workspace_ref` column is a
flagged as an upstream ask.

**Home boards (R-HOME-BOARD — `src/home.mjs`).** A task's board is its HOME: fixed at mint,
DERIVED and never stored — the workspace named by the EARLIEST claim whose `contract_ref`
names a real workspace (a `verify:<task>` review inherits its parent's home). Later claims
INHERIT it and never restamp it with the claiming session's folder; `oathe_claim` returns the
claim row's actual `contract_ref` plus `home` on every branch. A task minted from a synthetic
surface is HOMELESS — sentinel `workspace:none;contract:<org>/<task>@v1` — until the first
real folder claims it (adoption); a reclaim transcribes the prior ref (016), so a reopened
homeless task stays homeless. The folder board is a STRICT lens: tasks homed here plus every
homeless task (unclaimed, legacy claim-less, synthetic mints — visible everywhere so a real
folder can adopt them); a foreign-homed claim you hold does NOT appear here — the pager is
the recourse. `ContractRef` and `HomeBoard` are the ONE owner of the ref grammar, in JS and in
the SQL fragment the board and the pager share; custody queries (heartbeat linkage, the
compaction note, the session-host exit) scope by principal + state, never by folder.

**Board scope is a per-surface fact (R-BOARD-SCOPE).** Each adapter declares
`isSyntheticWorkspaceDir({dir, home})` (base false; Codex names
`~/.codex/.chatgpt-projects/<id>`, the ChatGPT desktop staging dir). `WorkspaceResolver.describe()`
derives a directory's facts ONCE — `{root, ref, synthetic}` — and every surface threads them:
a synthetic session's `oathe_board` serves the FULL board whatever it asked (rendered as
`all workspaces`), and `activateWorkspace` refuses to activate it — no fences, no registry
row, disclosed. The tools' activation seam is one class, `ActivationSeam`
(`src/activation.mjs`), shared by the MCP factory and the CLI: every speech act registers,
`oathe_claim` activates through the one writer. The standing rule still reaches a folderless
session two ways: each adapter may declare its `globalContextFiles` in the harness's own
precedence (Codex: `AGENTS.override.md` if present, else `AGENTS.md`, under `~/.codex` — read
before any work in every session) and `oathe init` puts the managed block where it is read —
through the same fence writer (`src/fence.mjs`), recorded as a fence row `uninstall` strips —
and the board render states the rule on every render, not only the empty state.

**The breach pager (R-PAGER — `src/pager.mjs`) and its digest (`src/breach-digest.mjs`).**
The pager reads four conditions machine-wide, in sharpness order: a rejection nobody
reclaimed (`reopened` — the latest claim predating the latest rejected verification); a
verification that died before a verdict and released its claim (`stalled`); a completion
asserted and unverified past its `verify_by` (`overdue` — `cell.unverified_past_verify_by`,
the R2 clock leg); an active claim silent past `pagerQuietHours` (`quiet` — its last word =
latest non-trace progress statement, else the claim itself). Condition-based — it repeats
every session while true, with no read-state — and stateless; a lapsed lease is lifecycle,
not a breach; one row per task under its sharpest breach, or per sibling group (children
spawned under one claim fold into one row); homes shown as folders via the registry
(`homeless` for a synthetic mint); the data whole. `BreachDigest` is the ONE budget every
surface renders: counts by kind, the push line (`3 to fix · 1 to verify · 2 gone quiet`),
rows capped at eight sharpest-first, then one `+N more` naming the pull — `oathe_board` for
the model (`breaches`: every kind, grouped, uncapped, this board), `oathe ls` for the
terminal (uncapped, no flag), the glass's own count. The SessionStart context, the launcher
splash, tool attention (this board's rejected and verify-failed work only) and the notch
frame render the same digest, and every word about a kind lives in its `KINDS` table. The
hook computes it in its own fail-soft try (a broken pager reaches stderr; the board still
renders). The system only SHOWS — no auto-yield; only a principal speaks. UX rules 17–20
hold this.

**Lineage (ruling 2026-09-01: provenance now, delegation later — `src/statements.mjs`).**
Work claimed while a session holds a claim is recorded as SPAWNED under it: one observation
statement on the parent's claim (`spawn:<child>`, evidence `task:<child>`, idempotent per
claim × child), decided before the child's claim lands (`spawnParentFor`: omit `parent` for
the session's root — the oldest active claim this principal holds that is linked to the
session; an id names the claim it serves and must be held, else `OATHE_SPAWN_PARENT_NOT_HELD`;
`null` is standalone) and written right after it (`linkSpawn`). `spawnParentSql` is the ONE
read — the board folds children under a parent in view and gives the parent a counts line
(`spawned 3 — 2 active · 1 settled`); the pager's rows carry `parent`, so the digest groups
siblings into one row under their sharpest breach and attention names the parent once. The
delegation column (`cell.work_claim.parent_work_claim_id`, DDL 010's forward contract with
`assert_children_verified`) stays reserved for accountable cross-principal delegation; when
the delegate verb ships, the read fragment unions both edges and no renderer changes. Stated
limitation: nested fan-out inside one session attaches to the session's root claim — the
trace's spawn tree is the exact record. UX rule 21 holds this.

### 6b. Session identity & continuation — the SPEAKER primitive (ruling 2026-08-30)

Every speech act is spoken by a SPEAKER, and the writer resolves WHO from its own process
ancestry — never from the model's word, never from an MCP client's self-declared name when
the process tree says more (ChatGPT-embedded codex is `chatgpt`, not `codex`). One shape,
resolved by `resolveSpeaker` (`src/speaker.mjs`) — the ancestry walk once per writer process,
the session at every act (ruling 2026-09-03: a `/clear` or a resume registers a new id under
the same process, and the next act speaks as it; a long-lived server never keeps the session it
first saw):

```
{ surface:  which glass is speaking, named by the adapters (or null)
  app:      {bundle, pid} — the focusable app above the speaker; the switch target (or null)
  session:  {sessionId, transcriptPath|null, harness} — the registered harness session this
            process speaks FOR, found by the parent chain in the device registry (or null) }
```

The primitive spans TWO homes, chosen so the substrate's cloud move needs zero rework:

| fact | examples | home | lifetime |
|---|---|---|---|
| PORTABLE — which session spoke | session_id, surface, transcript | the substrate (travels) | durable |
| DEVICE — which process embodies it now | pid, ancestry, app, aliveness | `~/.oathe/sessions.json` | self-sweeping |

**Attribution rides the speech act.** Every successful WRITE through a serving tool surface
stamps the durable trace-link statement (`linkTrace`, `src/statements.mjs` — subject_ref
`trace:<session_id>`, transcript as evidence, empty evidence for surfaces with no store like
Cursor) the moment the act lands — never deferred to turn end. The Stop-hook heartbeat calls
the same writer as an idempotent sweep for claims the transcript proves were worked without
a substrate write. The wire (`src/wire.mjs`) carries `{via, app}` as an EPHEMERAL hint only —
its identity role is limited to session-less surfaces (a desktop app with no hooks).

`speaker` is REQUIRED where consumed: `createOatheTools` with the activation seam (the
serving surfaces — MCP server, CLI) refuses construction without one
(`OATHE_SPEAKER_REQUIRED`); read-only compositions (board render, the verifier's seat) build
no write wrapper and carry none. Each field is observed truth or null — resolution gaps
resolve to nulls, a malformed registry refuses typed, and nothing is ever guessed.

**The continue ladder** (the notch's resume, `bin/oathe.mjs`): claim → latest trace-link →
my `sessions.json` → alive? `activate` the app · else launchable agent + home path?
`spawn-terminal` · else a live heard app? `activate`/`open-app` · else `copy-only`. "Is it
on this device" is answered by construction: the session resolves in MY registry or it
doesn't. Known gap: a desktop surface with no hooks (ChatGPT) attributes only while its
process lives — durable binding is the `chatgpt-desktop-workspace-binding` task.

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

## 8. ATIF projection (`src/atif.mjs`, `src/harnesses/claude-transcript.mjs`, `src/harnesses/codex-rollout.mjs`, `src/oathe-annotator.mjs`, `docs/atif-oathe.md`)

Traces project at read time into **Harbor ATIF v1.7** — statement/action/outcome split
structurally (`message` / `reasoning_content` / `tool_calls` / `observation.results` keyed by
`source_call_id`). Custom fields outside `extra` are forbidden by the reference models
(`extra:"forbid"`, source-verified), so everything beyond the spec rides the sanctioned
`extra` slot in two namespaces with two owners (`oathe_convention: 2`):

- **`extra.record` — the converter's.** Each adapter's projector emits pure ATIF, what a
  Harbor converter could also emit, with the raw-record facts ATIF has no field for
  (`source_path`, `session_title`, `files_touched`, `unrecognized_rows`; codex's
  `step_boundary`, `orphan_token_counts`, `uncorrelated_items`; the inter-agent `inbound` on a
  step; structural `exit_code` / `executions` / `files_changed` on a result; `subagent_meta`
  on an embedded child). No oathe concept appears in a converter output.
- **`extra.oathe` — the annotator's.** `OatheAnnotator` applies the claims-vs-actions layer
  over any valid trajectory: root `oathe_convention` and, on export, the obligation linkage
  (org/task/work_claim/contract_ref/workspace), the settled `verdict`, and the `sliced`
  marker; step `claim_events` — the agent's on-the-record oathe speech acts, structurally
  separable (verb names derived from `makeToolDefs()`, never retyped); tool_call `files` (any
  call with a `file_path` argument); observation_result `observed.exit_code` — the
  converter's structural code first, else an explicit "Exit code N" as the output's own last
  line — **absent when unstated, never fabricated**. `projectAnnotated(file)` is the ONE read
  every oathe consumer performs.

`AtifValidator` re-implements the reference rules (sequential step_ids, call-ref integrity,
agent-only fields, known-fields-only, unique embedded trajectory_ids, subagent refs resolving
to an embedded child; `ATIF-v1.0`…`v1.8` accepted inbound, `v1.7` emitted) — and **Harbor's
own golden fixture must pass it** (`tests/fixtures/harbor-golden-terminus2.trajectory.json`;
it already corrected us once: `source_call_id` is optional). Every projector output is
validator-asserted before return. The evidence renderer (`src/evidence.mjs`,
`renderEvidenceView`) renders the aligned record — `SAID:` / `CLAIM(verb task)` / `DID:
tool(args)` / `GOT [exit N]: …` / `FROM <author>` — under `verifierEvidenceBudget`,
budget-true and tail-prioritized with **announced** elisions. `oathe trace <task> [--out dir]
[--pure]` exports (pure JSON stdout; summary on stderr; `--pure` is the converter's output
alone, for a check against Harbor's validator and converters).

**The notch** (R-QUIET's glass): `oathe notch` serves the machine frame — the digest's
rows with their kind and act words, the count beyond the budget (`more`), work in motion
with its resumption, the board's sections, the machine's default agent — as pure JSON from
anywhere, with no workspace resolution and no registry write (a surface that only SHOWS).
`src/notch-frame.mjs` assembles the frame and owns every word in it; the verb fetches and
serves. `oathe notch --serve` LISTENs on the wire (`src/wire.mjs`: one pg_notify per
successful WRITE tool, emitted from the activation wrapper; reads silent) and streams one
ndjson frame per speech act — the event's notice rides the frame it caused — plus a
`notchHeartbeatSeconds` drift-guard frame. The macOS renderer (`notch/`, Swift, in this
repo) supervises the feed as a child and plays the frame: it reads no config and composes no
sentence, and `tests/notch-frame.test.mjs` holds the frame to its decoder (`Feed.swift`)
field by field. Lifecycle: the package carries the built app (`prepack`); init writes the
LaunchAgent (manifest-owned, `src/notch.mjs`) and bootstraps it now; uninstall boots it out
and removes it; `oathe config notchApp <path> --global` overrides the packaged app.

## 9. The verification lane (`src/verifier.mjs`, `src/plans.mjs`)

The ruled shape: **verification is ordinary work; agent evaluators are allocated on demand
per obligation, never a standing grader; the LLM only produces EVIDENCE — every settlement
is signed by a deterministic lane under a non-author seat.**

Per `oathe verify [task] [--all] [--engine claude|codex|cursor]`:

1. Claims `verify:<task>` as `oathe-verifier` (visible lease on the board).
2. Gathers: objective + bound plan, the completion statement, the linked traces projected to
   ATIF (fan-outs embedded; contract failures refuse — never less evidence than recorded).
3. ONE fresh headless engine run (each adapter's declared `headless` command — `claude -p
   --output-format json`, `codex exec --skip-git-repo-check`, `agent -p --trust
   --output-format json`) — fresh context, different eyes ("same-harness verification is
   never a subagent of the worker session": FC010's two-part author split + the
   anti-laundering ruling). Strict JSON verdict; malformed → typed refusal, the lane never
   guesses.
4. The verdict lands as the verification task's completion statement (evidence ref
   `verdict:<verdict>:<task>`).
5. **Settlement — deterministic**: the runtime seam's acceptance lane (§5 — the runtime's
   `buildProductionAcceptanceLane({pool, seatPrincipal: 'oathe-verifier', registry})` with the
   composed `oathe-verdict` checker, or the standalone `SqlAcceptanceLane` over the same clause
   discharge): standard clause conditions AND the recorded verdict — data on the clause,
   provenance in the substrate.
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

**The trust boundary is the blocking boundary (founder ruling 2026-08-31).** On the
user's own machine, a speech act that owes an answer WAITS for it: `oathe_done` and
`oathe_verify` dispatch the judgment and block until the verdict, returning it in-result
(a rejection carries the fork: prove it, or descope it with amend). When the substrate is
REMOTE (the cloud), reporting work to someone else is naturally async — submission
completes the act, the verdict arrives later; `verifierSeam` (src/verify-dispatch.mjs) is
the ONE place that flips, never a config knob. The wait is bounded by the verifier
child's own life (`awaitVerdict` — verdict, recorded failure after the claim's release,
or child death with one closing read), never an arbitrary budget; MCP transport limits
(stdio idle 30min; the client backgrounds calls past 2min) comfortably hold a 1–3min
engine run. The engine still NEVER runs inside the server: `oathe_verify` dispatches
the `oathe verify` bin verb as a DETACHED process
(`src/verify-dispatch.mjs` — own process group, unref'd, log at `~/.oathe/logs/verify-<task>.log`
overwritten per run, env scrubbed of `OATHE_EXECUTION_ATTEMPT_ID`/`OATHE_LAUNCHED_HARNESS` so
the verifier's statements never carry the judged session's provenance) and returns the durable
addresses immediately. The detached child deliberately leaves the launcher cage's process
group — a stated exception to the containment story, not an accident. Concurrency is the
substrate's own claim: the child claims `verify:<task>` before its engine runs, so a
concurrent dispatch loses on FC003 pre-engine; a live in-flight review is a typed
`OATHE_VERIFY_IN_FLIGHT` refusal naming the holder (an expired lease names `oathe yield` —
no auto-heal). Recovery is idempotent by construction: an already-settled claim reads as
settled on re-verify (never `OATHE_SETTLEMENT_BLOCKED` — the kill-window wedge), duplicate
verification rows are lawful, the reopen verb is idempotent. `bin oathe verify` stays
synchronous — a human or CI wants the answer and the exit code; its engine run uses async
`spawn` all the same.

**Amendment (R-AMEND).** `oathe_amend {task_id, objective, why}` / `oathe amend` changes what
done means, on the record: active claim only, acceptance-seat only, never the verifier; one
transaction locking the claim row first (`oathe_done` takes the same lock, so "the version in
force at assertion" is exact); the trail is an appended `amend:<task>` observation statement
carrying old→new and why; the version is derived from the trail — `contract_ref` stays `@v1`.
The verifier's prompt carries the AMENDMENT TRAIL, so a late move of the bar is visible
evidence.

## 10. Configuration (`src/config.mjs`)

Layered `OatheConfig`: defaults → `~/.oathe/config.json` (global) → `<workspace>/.oathe.json`
→ env. Unknown keys / invalid values refuse AT LOAD. `source(key)` reports provenance.
`oathe config <key> [value] [--global]`.

| key | default | env |
|---|---|---|
| `org` / `principal` / `department` | `oathe` / `$USER` / `operator` | `OATHE_ORG` / `OATHE_PRINCIPAL` / `OATHE_DEPARTMENT` |
| `db` / `pgHost` / `pgPort` | `oathe_local` / `$PGHOST`, else `/tmp` (darwin) or `/var/run/postgresql` / `5432` | `OATHE_DB` / `OATHE_PG_HOST` / `OATHE_PG_PORT` |
| `leaseHours` / `verifyByHours` | `4` / `24` | `OATHE_LEASE_HOURS` / `OATHE_VERIFY_BY_HOURS` |
| `verifier` / `verifierPrincipal` | the first verifier-capable harness / `oathe-verifier` | `OATHE_VERIFIER` / `OATHE_VERIFIER_PRINCIPAL` |
| `defaultAgent` | `null` (the launchable harness that picks work back up — the notch's continue; asked at init) | `OATHE_DEFAULT_AGENT` |
| `verifierEvidenceBudget` | `24000` chars | `OATHE_VERIFIER_EVIDENCE_BUDGET` |
| `runtimeProvider` | `auto` (`oathe` exactly when the cage path resolves, else `standalone` — §5) | `OATHE_RUNTIME_PROVIDER` |
| `traceCensusDays` / `traceCensusMaxFiles` | `3` / `40` (the doctor's and the census lane's sweep window) | `OATHE_TRACE_CENSUS_DAYS` / `OATHE_TRACE_CENSUS_MAX_FILES` |
| `autoActivate` | `true` (false = register only, no fence writes) | `OATHE_AUTO_ACTIVATE` |
| `rootsTimeoutMs` | `2000` | `OATHE_ROOTS_TIMEOUT_MS` |
| `pagerQuietHours` | `24` (hours an active claim may stay silent before it is paged) | `OATHE_PAGER_QUIET_HOURS` |
| `notchApp` / `notchMotionMinutes` / `notchHeartbeatSeconds` | `null` (the packaged app; a path overrides it) / `60` / `300` | `OATHE_NOTCH_APP` / `OATHE_NOTCH_MOTION_MINUTES` / `OATHE_NOTCH_HEARTBEAT_SECONDS` |

Also env-overridable: `OATHE_MONOREPO`, `OATHE_HOME` (paths.mjs). `OatheConfig.global()`
loads defaults → global file → env with no workspace layer (the server's pre-resolution
bootstrap); a nonexistent `cwd` refuses at construction (`OATHE_CONFIG_CWD_INVALID`) —
never a silently-wrong config root. `OATHE_WORKSPACE_DIR` is deliberately NOT a config key
(§6).

## 11. CLI reference

`init [--harness a,b] [--yes]` (a setup plan rendered by a prompter — `docs/UX.md`) `· claude · codex · cursor · claim · amend · ls · note · done · verify · trace [--pure] ·
notch [--welcome] · yield · config · doctor [--surface] · status · version · update [--yes] · uninstall [--purge-db] · hook <name> · mcp`
(last two are the plugin's bin-addressed entry points; `doctor --surface` prints the
resolution report — ladder inputs as received, winning rung, registry status — with no
substrate contact, the probe the unknown surfaces get pointed at alongside
`scripts/surface-canary.mjs`). Every run ends with the machine-parseable
`oathe: <verb> ok|refused|error|attention|exit N` (stderr for `trace`, whose stdout is pure
JSON). Substrate refusals surface non-zero as `refused`.

## 12. Testing strategy (`tests/`, two lanes)

- **TDD red-first for every behavior**; each unit committed green.
- **Real substrate in tests**: scratch Postgres databases per suite — the 28-file DDL apply,
  claim/yield/done refusals, and the ENTIRE settlement lane (acceptance lane, FC010, R8
  reopen+reclaim) run against real plpgsql, not mocks. Only the LLM engine is faked (seam).
- **Sandboxed integration**: fresh `$HOME`, fake harness binaries + CLI fakes that mirror the
  real CLIs' file writes; init idempotency is byte-diffed; uninstall byte-restores.
- **Live contract tests**: the newest REAL transcript/rollout on the machine must parse AND
  project to valid ATIF — harness drift breaks `npm test` and `oathe doctor`.
- **Golden cross-check**: Harbor's own fixture must pass our validator.
- **The trace corpus and its lanes**: sanitized REAL records under `tests/fixtures/traces/`,
  each carrying its expected projection (`scripts/trace-fixtures.mjs`,
  `derive-trace-fixtures.mjs`); the Harbor conformance lane drives the reference converters
  on the corpus and holds the divergence to a reviewed baseline (`docs/traces.md`); the trace
  census sweeps both real stores against the declared rosters and fidelity probes (`npm run
  trace-census`).
- **The full loop over the real stdio server**: initialize → claim → note → pickup (real
  successor) → yield, plus double-yield refusal.
- `claude plugin validate` clean on plugin + marketplace.
- **Drift lanes** (founder ruling 2026-08-29: fail loud when a harness changes under us). Each
  adapter declares its facts — `docs` (snapshot pages), `install` (how a runner gets the real
  CLI), `headless` (the one-shot run + auth env) — and the contract suite refuses orphan pins.
  Three lanes hold them to the world, each a package script runnable locally and a workflow in
  the public repo: `harness-docs-drift` (a tracked `harness-docs.lock.json`; re-pull, compare,
  exit 3 naming page + dependents; daily, never blocks PRs), `install-contract -- <h>` (real CLI
  at @latest in a throwaway HOME; `oathe init` proven through the doctor's row verification,
  byte-idempotent re-run, byte-restoring uninstall, global-fence precedence; blocks PRs),
  `live-contract -- <h> [--in-place]` (one real headless session; the hook payload captured via
  `OATHE_HOOK_CAPTURE_DIR`, normalized through the dialect with a field diff against the newest
  `tests/fixtures/hooks/<harness>/<date>-<event>.json`, the transcript projected, RUNTIME told
  apart from DRIFT; nightly with the adapters' auth env from secrets). The fix for a red lane is a
  pin — a new dated fixture beside the old, a re-locked page — never a silence.

**The UX contract is held by tests, not walks.** `tests/setup.test.mjs` renders the prompter
over fixture machines and holds every question to `docs/UX.md` (no numbered menus, writes
shown from `describe()`, Enter = default, refuse-and-re-ask, one line per question, EOF
refuses); `tests/ux-contract.test.mjs` refuses a UX rule without an existing test behind it and
a §3 that omits a file some adapter's `describe()` says init writes; the install-contract lane
replays `oathe init` under a real pty (`script`), Enter throughout, and holds the transcript to
the same rules (`init-tty`) on every PR.

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
- The verifier engine run is not caged and inherits the invoking env — below the launcher's
  posture; disclosed in `docs/PRIVACY.md`.
- **Sandbox surfaces (canary-confirmed 2026-08-28)**: Cowork sessions run in a cloud sandbox
  with a Linux-VM shell — an attached folder's fence reaches them, the local board does not;
  ChatGPT desktop hands sessions a synthetic `~/.codex/.chatgpt-projects/<id>` cwd — served
  the FULL board and never activated (R-BOARD-SCOPE); a task minted there is homeless until a
  real folder adopts it (R-HOME-BOARD). Cowork's remote shell still cannot reach a local
  substrate: a hosted/remote substrate surface (tracked on the board, deferred) is the answer,
  and also unlocks the cross-machine continuation D0 disclaims.
- Quality verification (judging the diff via `git_sha` metadata — evidence that
  dereferences) is designed but unbuilt.
- The pager's four reads run unindexed over `verify_by` / `origin` / `claimed_at` — fine at
  local scale (hundreds of tasks); an index is the first fix should a SessionStart ever near
  its 8s budget.
- `extra.oathe` is upstream-RFC-shaped for harbor-framework/harbor (external-contribution
  precedent exists: NVIDIA in v1.7).

## 15. File map

```
bin/oathe.mjs            CLI router (parseArgs; verbatim arg passthrough to harnesses; the node floor at the door)
bin/node-floor.mjs       the same floor at npm's install door (package.json preinstall)
src/node-floor.mjs       the engines.node floor, executed (ERROR_NODE_VERSION) — read from package.json by both doors
src/config.mjs           OatheConfig — every tunable, layered, provenance-aware
src/paths.mjs            all filesystem locations, env-overridable
src/blocks.mjs           managed writes: FencedBlock (text) + JsonEntries + JsonArrayEntries
src/manifest.mjs         install manifest + pre-first-write backups (atomic writes)
src/fslock.mjs           atomic temp-then-rename JSON + bounded advisory lock
src/registry.mjs         the central workspace registry (~/.oathe/workspaces.json)
src/sessions.mjs         the device session registry (~/.oathe/sessions.json): which living process speaks for a session
src/speaker.mjs          the SPEAKER primitive: {surface, app, session} resolved from process ancestry
src/harnesses/           the adapter catalog: base, dialects, claude/codex/cursor, surfaces; the rosters
                         (claude-roster, codex-roster), the projectors (claude-transcript, codex-rollout), the fidelity probes
src/workspace-resolver.mjs  the ONE resolution ladder (env → adapters' vars → roots → cwd)
src/fence.mjs            the managed fence, owned once: folder + global bodies, THE write (backup, apply, manifest row)
src/activation.mjs       workspace activation (preflight, hooks, and claim all call it) + ActivationSeam
src/home.mjs             ContractRef + HomeBoard — the ONE owner of the contract_ref grammar and the home rule
src/statements.mjs       statement vocabulary: the trace-subject grammar, linkTrace, spawn lineage, the latest-progress SQL fragment
src/pager.mjs            the breach pager — four conditions machine-wide (R-PAGER)
src/breach-digest.mjs    BreachDigest — the ONE budget over the pager's facts; KINDS owns every word about a kind
src/board-render.mjs     the ONE board renderer: markdown context + ANSI splash, the digest included
src/notch-frame.mjs      the notch frame: every word the glass shows, assembled from fetched facts
src/notch.mjs            the notch lifecycle (darwin): the LaunchAgent, the materialized app, boot in/out
src/welcome.mjs          the one-time welcome tour, consumed on emit
src/wire.mjs             one pg_notify per successful speech act — how the ambient surfaces wake
src/substrate.mjs        PG detect/create, ordered DDL apply, seeds, authority registration, the transaction gate
src/workspace.mjs        ws-<hash> identity (git root + origin) + root/identity exports
src/context.mjs          the composition seam every verb starts from (packageVersion lives here)
src/setup.mjs            oathe init as data: SetupPlan (from the census + describe()) and the TTY SetupPrompter — docs/UX.md
src/init.mjs / doctor.mjs / uninstall.mjs / update.mjs   (update: the upgrade as one verb — this node's npm, then init through the new bin)
src/launch-env.mjs       the env block a launched session carries (the custody marker + oathe wiring)
src/launch.mjs           preflight (via activation), splash, cage, runHarness
src/session-host.mjs     liveness observation for a launched session: nothing on a kill, one exit statement per held claim on a clean exit (R1, R10)
src/mcp/oathe-tools.mjs  the speech-act MCP server + tool implementations
src/mcp/connection.mjs   the transport: lazy context, roots requests, list_changed
src/plans.mjs            the G2-b policy-standard plan + verification-task naming
src/traces.mjs           TraceStore family (ground-truth readers, drift refusals, transcriptFor)
src/trace-census.mjs     the store sweep behind `oathe doctor` and `npm run trace-census`
src/atif.mjs             the AtifProjector base + AtifValidator + claimIntervals / sliceForTask
src/oathe-annotator.mjs  the annotator: extra.oathe over any valid trajectory; projectAnnotated, the ONE read
src/evidence.mjs         the budget-true evidence renderer the verifier reads
src/verifier.mjs         the allocated-on-demand verifier + settlement through the provider's lane
src/verify-dispatch.mjs  verifierSeam: oathe_verify dispatches the bin verb detached and awaits the verdict
src/successor.mjs        the pickup successor sequence (delegates to oathe-runtime/seam, or refuses typed)
src/runtime/provider.mjs the runtime seam: OatheRuntimeProvider | StandaloneRuntimeProvider (cage, settlement, pickup)
src/runtime/simple-cage.mjs / sql-acceptance-lane.mjs / discharge.mjs   the standalone cage and lane, and the clause discharge both providers share
plugin/                  hooks (bin-addressed, dialect-aware), the oathe-work skill, the verify command, .mcp.json,
                         .claude-plugin/plugin.json + .cursor-plugin/plugin.json (adapters)
.claude-plugin/marketplace.json   one marketplace, both CLI harnesses
notch/                   the macOS glass (Swift): Feed.swift decodes the frame; make-app.sh assembles the signed universal app
scripts/pull-harness-docs.mjs / surface-canary.mjs   dev-only: docs snapshot + surface probe
scripts/harness-docs-drift.mjs / harness-install-contract.mjs / harness-live-contract.mjs   the drift lanes (lane-report.mjs: their one report)
scripts/trace-fixtures.mjs / derive-trace-fixtures.mjs / trace-census.mjs   the trace corpus tools (list · materialize · project · repin), the sanitizing deriver (marker-scan gated, `--repin` rewrites an expectation from its record), the live-store census
scripts/harbor-conformance.mjs   the Harbor conformance lane (drives the reference converters on the corpus; `--lock` re-pins)
scripts/marker-scan.mjs / vendor-ddl.mjs / link-runtime.mjs / pack-notch.mjs   the private-marker scan, the DDL re-vendor, the monorepo re-link, the prepack notch build
harness-docs.lock.json   the tracked pin of every snapshot page (url + sha) the docs lane compares against
harbor-conformance.lock.json   the Harbor pin + the reviewed divergence baseline per fixture
docs/UX.md               the UX contract every prompt and output follows (each rule names its test)
docs/traces.md           the trace ground-truth contract and the row-type rosters
docs/atif-oathe.md       the extra.record / extra.oathe convention spec
docs/PRIVACY.md          what oathe reads, stores, and sends
tests/                   two lanes (test:unit / test:heavy) incl. live-store contracts, the trace corpus, and the Harbor golden fixture
```

## 16. Key refusal codes (a working vocabulary)

`OATHE_NO_ACTIVE_CLAIM` · `OATHE_OBJECTIVE_REQUIRED` · `OATHE_RECLAIM_REFUSED` ·
`OATHE_PICKUP_UNAVAILABLE` · `OATHE_NOTHING_TO_VERIFY` · `OATHE_NO_COMPLETION` ·
`OATHE_VERDICT_MALFORMED` · `OATHE_SETTLEMENT_BLOCKED` · `OATHE_REVIEW_UNSETTLED` ·
`OATHE_ENGINE_UNKNOWN/FAILED` · `TRACE_*` (contract drift) · `ATIF_UNMAPPABLE/INVALID` ·
`OATHE_CONFIG_KEY_UNKNOWN/VALUE_INVALID/CWD_INVALID` · `DDL_DRIFT/DDL_APPLY_FAILED` ·
`CLAUDE_/CODEX_/CURSOR_VERIFICATION_FAILED` (install unproven) · `OATHE_SUBSTRATE_UNREACHABLE` ·
`OATHE_NOT_INSTALLED` · `OATHE_HARNESS_NOT_FOUND` · `OATHE_DUPLICATE_FENCE` ·
`OATHE_WORKSPACE_UNRESOLVED` (the ladder's per-call refusal) · `OATHE_REGISTRY_MALFORMED` ·
`OATHE_JSON_TARGET_INVALID` · `OATHE_INIT_HARNESS_UNKNOWN/ABSENT` · `OATHE_INIT_INPUT_CLOSED` · `OATHE_INIT_ABORTED` · `OATHE_VERIFY_IN_FLIGHT` ·
`OATHE_AMEND_AFTER_DONE` · `OATHE_AMEND_UNAUTHORIZED` · `OATHE_AMEND_VERIFY_TASK` ·
`TRACE_OWNER_UNKNOWN` · `TRACE_STORE_HARNESS_REQUIRED`.
`ERROR_NODE_VERSION` carries no oathe prefix on purpose (founder ruling 2026-09-02): it is
the Node floor refusing at both doors — npm's `preinstall` and the bin — to someone who is
not yet running oathe at all, so it speaks plainly rather than in oathe's vocabulary.
Substrate-side: FC003 (second claimant), FC010 (self-verification), FC110–FC114
(settlement gates), FC130–FC134 (reopen/reclaim), FC140/FC141 (yield cause), FC160/FC161
(contract freeze/amend), FC170 (authority writer).
The 2026-08-28 rulings (R-HOME-BOARD, R-BOARD-SCOPE, R-PAGER) add ONE code —
`OATHE_CONTRACT_REF_MALFORMED` (a `contract_ref` outside the grammar, `src/home.mjs`) — and
no others: homelessness, synthetic scope, and breaches are facts the tools report, not refusals.

---

*Provenance: built 2026-08-25 in one session (transcript `836af10b-…`, itself the first
really-verified obligation in `oathe_local`). Plan file history and founder rulings are in
`PLAN.md` and the commit messages — read `git log` for the decision trail; every commit
message states what changed AND why the design says so.*
