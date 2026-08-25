# Oathe D0.1 — the npm package + plugin, built standalone in ~/oathe-playground

> EXECUTION NOTE: on approval, the first act is `cp` this plan to `~/oathe-playground/PLAN.md` (the founder's requested home; plan-mode wrote it here). The build runs in a SEPARATE session whose working directory is `~/oathe-playground`; this plan is written to be self-contained for that session.

## Context

The founder wants to start building the real Oathe interface now, while the A3.5 episode closes in the monorepo: an npm package where `oathe init` automatically onboards BOTH installed harnesses (Claude Code plugin/hooks/MCP; Codex config + AGENTS.md) with deduplication and version control, and `oathe claude` launches a normal interactive session while ensuring (a) the cwd's CLAUDE.md/AGENTS.md carries Oathe's managed line and (b) the user's global-or-project Claude config carries the plugin/hooks. Design authority: `~/firia-migration/docs/oathe-oss/d0-interface-and-npm-plan-2026-08-24.md` (the D0 doc — claims are speech acts; one cell many sessions; cage-side liveness is the floor; managed fenced blocks + install manifest). Founder decisions (2026-08-24): home = `~/oathe-playground` standalone package (NOT the monorepo); wave 1 = init onboards both harnesses, `oathe codex` launcher is wave 2; PG posture = detect + createdb, instruct-and-exit if absent; build = separate session. The existing toy files in ~/oathe-playground (`oathe-play.sh`, README) are throwaway by their own declaration — DELETE in the first commit, superseded by the package.

## Hard constraints (verified 2026-08-24)

- The monorepo episode freeze pins 39/43 `src/*.mjs` + listed falsifiers/DDL files. **Importing pinned modules is harmless (the freeze is a content-hash drift detector); editing any is forbidden; adding files under `falsifiers/episode/` is forbidden (glob-pinned).** This package NEVER edits the monorepo — it consumes it read-only via a `file:` dependency.
- Nothing lands in public `oathe-ai/oathe` or npm from this tree (extraction is fresh-tree + scan-gated, post-A3.5). Package stays `"private": true`.
- Never touch `firia_bus`/`firia_langfuse`; the local cell DB is `oathe_local` (a NEW substrate — no L3 interaction).
- The user's personal configs (~/.claude, ~/.codex, project CLAUDE.md/AGENTS.md) are modified ONLY inside version-stamped managed fences, recorded in the install manifest, backed up before first write.

## Package skeleton (all new files, ~/oathe-playground)

```
package.json          private:true, type:module, engines node>=22, deps: pg ^8.23.0,
                      "firia-runtime": "file:/Users/firiya/firia-monorepo/packages/firia-runtime"
                      bin: { "oathe": "./bin/oathe.mjs" }, scripts.test: node --test tests/*.test.mjs
bin/oathe.mjs         subcommand router (node:util parseArgs; verbs below)
src/paths.mjs         MONOREPO/DDL_DIR/ARTIFACT_DIR/OATHE_HOME(~/.oathe) constants, env-overridable
src/init/census.mjs   harness detection via profiles (claude: `claude` on PATH + ~/.claude; codex: ~/.codex)
src/init/blocks.mjs   the managed-fence engine (see §Managed blocks)
src/init/manifest.mjs install-manifest read/write/verify (~/.oathe/install-manifest.json + backups/)
src/init/substrate.mjs PG detect (reuse conventions: homebrew socket default) + createdb oathe_local +
                      DDL apply loop (import DDL_DIR/DDL_FILES data from firia-runtime's setup-db export
                      path if importable without side effects — else own 15-line scan of the ddl dir;
                      ADDITIVE apply, never DROP; idempotent via IF-EXISTS checks)
src/launch/claude.mjs `oathe claude` (see §Launch)
src/session-host.mjs  the ONE new runtime semantic: interactive attempt (bind attempt row via
                      firia-runtime allocator path, lease renewal on cage liveness, terminal from exit
                      + statements, R10 absences-as-absences)
src/mcp/oathe-tools.mjs  claim/board/statement/yield MCP server — COPY THE SHAPE of
                      firia-runtime src/governed-effect-mcp-server.mjs (unpinned; ndjson JSON-RPC stdio,
                      no SDK, pure dispatch() testable core, run-as-main guard)
plugin/               the Claude Code plugin (shape per explorer findings, pending)
  hooks/hooks.json    SessionStart render-inject · Stop heartbeat+suggest · PreCompact frame-note
  skills/oathe-work/SKILL.md  (+ handoff, delegate in wave 2)
  .mcp.json           oathe-tools server registration
profiles/claude.yaml  detection rule + config surfaces + fence file targets
profiles/codex.yaml   detection + config.toml mcp_servers entry + AGENTS.md fence target
tests/                node:test; every module unit-tested; blocks engine round-trip tests;
                      init idempotency test (run twice = byte-identical configs)
PLAN.md               this plan (copied on approval)
```

## Managed blocks + install manifest (the dedupe/versioning contract — founder requirement)

- Every write to a user file lives inside `# >>> oathe v<pkg.version> >>> … # <<< oathe <<<` fences (JSON files get a single namespaced key instead: hooks/mcp entries carry `"__oathe": "<version>"` marker fields, since JSON has no comments — the blocks engine handles BOTH styles: fenced-text (CLAUDE.md/AGENTS.md/config.toml) and marked-JSON (settings.json/.mcp.json)).
- `init` re-run: replace own block/entries only, byte-idempotent; NEVER touch outside fences; detect marketplace-duplicate plugin registration and prefer one source, loudly.
- `~/.oathe/install-manifest.json`: `{harness, file, kind: fence|json-marker, block_version, sha256, installed_at}` + `~/.oathe/backups/<sha>-<basename>` pre-edit copies.
- `oathe doctor`: verify every manifest row's block still sha-matches (user edited inside fence → REPORT, never overwrite); verify DB reachable + DDL count; verify plugin resolves.
- `oathe uninstall`: remove exactly the recorded blocks/entries, restore nothing else, drop nothing (DB kept unless `--purge-db`).

## Verbs (wave 1)

`oathe init` — census → substrate (detect PG → createdb oathe_local → additive DDL apply → seed principal from $USER/git config, role 'ceo') → per-harness onboarding (Claude: plugin install into ~/.claude config via managed entries; Codex: config.toml mcp_servers fence + note) → manifest write → summary table of what was installed where.
`oathe claude [--hermetic] [args…]` — pre-flight: ensure cwd CLAUDE.md contains the managed Oathe line (create file if absent? NO — only append fence if CLAUDE.md exists OR --create-md; ask-free default: create a minimal CLAUDE.md with just the fence when absent, recorded in manifest as project-scope row); ensure config carries plugin (global manifest check, else project .claude fence); THEN launch interactive claude via the cage (import spawnCaged from firia-runtime falsifiers/acp-probe/acp-cage.mjs — unpinned, standalone-importable, env-REPLACES; pass a curated env: user's PATH/HOME/TERM etc. + fence stamp — NOTE: interactive daily-driver needs home/config ACCESS unlike clean-room attempts; --hermetic flips to the clean posture) with session-host binding the interactive attempt.
`oathe claim|ls|note|yield` — thin CLI over the substrate verbs (the play loop, productized; yield uses a DECLARED cause registered by init: `oathe.yield_operator`).
**There is NO resume verb (FOUNDER RULING 2026-08-24): resuming is what launching means.** `oathe claude` / `oathe codex` at start renders the folder's open work — any claims/tasks scoped to this workspace flagged in the SessionStart payload (yours: lease state; offered: claimable) — harness-agnostic, same render both harnesses. Picking work up happens IN-SESSION: the user says "continue task-x" → the agent calls the `pickup_claim` MCP tool → which runs the verified three-call successor sequence (buildProductionDeps → readPriorAttemptStep → reallocateStep → RECOMPILE) and returns the compiled frame as the tool result. Native transcript resume (`claude --resume`) is the user's own business — oathe never touches it; the obligation, not the conversation, is what comes back.
**Workspace scoping (required for the flagging):** every claim minted through oathe tools records the workspace identity (git-root realpath + origin-remote hash; plain dir realpath if no git) — wave 1 carries it in the claim's `contract_ref` convention (`workspace:<hash>;contract:<...>`) or a claim-time statement, since adding DDL is out of scope for this package (firia-cell-domain owns schema numbering — an additive `workspace_ref` column is flagged as a post-episode upstream ask). The SessionStart render filters to the cwd's workspace; `oathe ls --all` shows everything.
`oathe up|status` — wave 1 minimal: status = doctor's DB/manifest half; the daemon set (readers) is explicitly OUT of wave 1 (no standing service yet; lease expiry visible in `ls`, unenforced).
`oathe doctor` / `oathe uninstall` — per manifest contract above.

## Reusable entry points (verified, with pin-status)

- `firia-runtime/execution-scope` (pinned, import-only): spawnContained/enumerateScope/terminateScope — but PREFER the cage wrapper:
- `falsifiers/acp-probe/acp-cage.mjs` (UNPINNED): `spawnCaged({unit, env, cmd, args, cwd, stdio})` → child/enumerate()/teardownProvenEmpty() — standalone, env-replaces, fence-stamps via shipped stamper. file: dep exposes only src/* via exports map → the cage must be imported by PATH (document: `import from '<monorepo>/packages/firia-runtime/falsifiers/acp-probe/acp-cage.mjs'` via paths.mjs constant) — acceptable pre-extraction; flagged as extraction-time move (cage → package export).
- `attempt-fence` stampAttemptEnv; `pg-statement-writer` PgStatementWriter({connectionString}); `agent-statement` buildAgentStatement/statementIdFor; `context-compiler` ContextCompiler + buildLifecycleRender + makeArtifactStore(FIRIA_RT_ARTIFACT_DIR→~/.oathe/artifacts); `composition-root` buildProductionDeps (needs ONLY pool+config+runtimeIdentity+contextCompiler; CLOCK_REFUSED discipline inherited); `thin-path` makeThinPathSteps + SeamContextCompiler (pinned, import-only).
- DDL source of truth: `<monorepo>/packages/firia-cell-domain/firia_cell_domain/ddl/*.sql` (26 files; own additive apply loop — the two existing helpers both DROP and must not be used for a persistent DB).
- MCP server: copy governed-effect-mcp-server.mjs's SHAPE (unpinned): PROTOCOL_VERSION '2025-06-18', makeToolDefs(), pure dispatch(), readline stdio main(), run-as-main guard.
- CLI convention divergence (deliberate, documented): monorepo bins use env-only interfaces; oathe is a USER tool → node:util parseArgs subcommands. Keep the machine-parseable ready/summary line convention.

## Plugin + harness config shapes (verified on this machine, 2026-08-24)

**One plugin tree serves BOTH harnesses** (verified: Codex 0.149.0 resolves `.codex-plugin/plugin.json` with **fallback to `.claude-plugin/plugin.json`**, and exports `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` alongside its own — the superpowers plugin's `scripts/sync-to-codex-plugin.sh` is the multi-harness precedent):

```
plugin/
  .claude-plugin/plugin.json     name/version/description/author + mcpServers embedded:
                                 { "oathe": { "command": "node",
                                   "args": ["${CLAUDE_PLUGIN_ROOT}/../src/mcp/oathe-tools.mjs"],
                                   "env": { "OATHE_DB": "oathe_local" } } }
  .codex-plugin/plugin.json      same + Codex-only keys ("skills": "./skills/", "interface": {...}) — wave 2 polish; wave 1 relies on the .claude-plugin fallback
  hooks/hooks.json               {"hooks": {"SessionStart": [{"matcher": "startup|resume|clear",
                                   "hooks": [{"type":"command","command":"node ${CLAUDE_PLUGIN_ROOT}/hooks/render-board.mjs","timeout":8}]}],
                                   "Stop": [heartbeat hook], "PreCompact": [frame-note hook]}}
                                 — exact shapes copied from DARWIN/ultramemory plugins on disk.
                                 Codex hook events: SessionStart/SessionEnd/PreToolUse/PostToolUse/UserPromptSubmit/TurnStart/TurnEnd —
                                 NO Stop/PreCompact → Codex heartbeat rides TurnEnd + cage-side liveness (wave 2).
  skills/oathe-work/SKILL.md     frontmatter: name, description, allowed-tools (per installed examples)
```

**Registration (what `oathe init` writes, all via managed markers):**
- **Claude, user scope — two keys in `~/.claude/settings.json`** (this is the whole install; no marketplace clone needed):
  `"extraKnownMarketplaces": { "oathe": { "source": { "source": "directory", "path": "<pkg>/plugin-marketplace" } } }` +
  `"enabledPlugins": { "oathe@oathe": true }` — Claude Code resolves and caches from there. JSON has no comments → dedupe via the manifest (we own these exact keys) + a `"__oathe_version"` sibling marker key. Package ships `plugin-marketplace/.claude-plugin/marketplace.json` listing the one plugin (shape verified from `~/claude-plugins`).
- **Codex** — `[marketplaces.oathe] source_type="local" source="<abs>"` + `[plugins."oathe@oathe"] enabled = true` stanzas in `~/.codex/config.toml` inside `# >>> oathe >>>` TOML-comment fences; MCP server via the **sanctioned CLI**: `codex mcp add oathe -- node <abs>/src/mcp/oathe-tools.mjs` (preferred over hand-editing; verify then record in manifest). Trust stanza NOT touched (user's own).
- **Project scope, `oathe claude` pre-flight — CLAUDE.md/AGENTS.md managed section**, the estate-convention hybrid: an H2 heading inside HTML-comment fences —
  `<!-- >>> oathe v0.1.0 >>> -->` / `## Oathe` / one line: board pointer + "run `oathe` tools for claims" + `<!-- <<< oathe <<< -->`.
  Measured basis: the CLI's claudeMd walk-up provably places cwd CLAUDE.md verbatim in the request (ctx prereg finding), and **AGENTS.md is *trusted* content in Codex's own guardian policy** (binary verbatim). If no CLAUDE.md exists: create one containing only the fence (recorded as a project-scope manifest row). AGENTS.md fence: only when Codex detected.
- **Ordering caveat (measured)**: supervised runs overwrite project `.claude/settings.json` (`writeSourceRouter`) but never CLAUDE.md/.mcp.json — so `oathe claude` puts NOTHING load-bearing in project settings.json; hooks come from the plugin at user scope, the project owns only its CLAUDE.md fence.

**Corrections vs earlier drafts** (explorer-verified): there is no `seedEndpointHome` to reuse — the probe asserts a pre-made 0700 home; init writes its own Codex stanzas. The spike brief's "auth.json ~3 months stale" note is superseded (measured fresh at the S2 run). The `zprofile` `>>> <<<` fence is the estate's one managed-block precedent — reuse its exact style.

## Amendments — docs pass 2026-08-25 (Claude Code docs, Codex 0.149.1 source, agentskills.io, MCP spec; supersede conflicting lines above)

1. **Claude marketplace source type**: `extraKnownMarketplaces.oathe.source` = `{"source": "local", "path": "<abs>"}` — `"directory"` is NOT a valid source type (docs: plugin-marketplaces). §Registration's snippet is corrected accordingly.
2. **One marketplace file serves BOTH harnesses, at the package root**: ship `<pkg>/.claude-plugin/marketplace.json` (name `oathe`, owner, `plugins: [{name: "oathe", source: "./plugin", ...}]`) instead of a `plugin-marketplace/` dir. Claude points `extraKnownMarketplaces` at `<pkg>`; Codex reads the same file natively (source-verified legacy-compatible path `.claude-plugin/marketplace.json`, alongside `.agents/plugins/marketplace.json`). Relative-path local-marketplace plugins get LIVE EDITS in Claude (no reinstall loop during dev).
3. **Codex hook events (source-verified, corrects §Plugin shapes)**: Codex has 12 events — `SessionStart, SessionEnd, SubagentStart, SubagentStop, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, Stop, Interrupt`. `TurnStart`/`TurnEnd` DO NOT EXIST. So the ONE `hooks/hooks.json` (SessionStart · Stop · PreCompact) serves both harnesses verbatim; the W2 "heartbeat rides TurnEnd" workaround is void. `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` are confirmed Codex compatibility aliases (no `CODEX_PLUGIN_ROOT` exists); hook `timeout` is seconds in both.
4. **Codex registration is CLI-first**: `[marketplaces.*]`/`[plugins."oathe@oathe"]` stanzas are Codex-managed bookkeeping (`source_type` enum is exactly `git|local`) — init runs the sanctioned CLIs (`codex plugin marketplace add <pkg>`, `codex plugin add oathe@oathe`, `codex mcp add oathe -- node <abs>/src/mcp/oathe-tools.mjs`), then VERIFIES the resulting config.toml state and records manifest rows of kind `cli-managed` (uninstall runs the inverse CLIs). No hand-written TOML fences for plugin/marketplace registration; the TOML fence style stays only for anything we must write ourselves.
5. **Skills follow the Agent Skills open standard** (agentskills.io, adopted by both harnesses): skill `name` MUST equal its directory name (lowercase/digits/hyphens, ≤64); `description` ≤1024 chars; body <500 lines; `allowed-tools` is experimental — use it, but nothing load-bearing depends on it. Codex discovers plugin skills via the manifest `"skills"` key.
6. **Open plugin manifest spec**: Agent Plugins v1 (`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`) is recognized by Codex source as a root-level `plugin.json`. W1 ships `.claude-plugin/plugin.json` (both harnesses resolve it — fallback order source-verified) and stamps `$schema` future-proofing on a root `plugin.json` only if zero-cost; not load-bearing.
7. **MCP posture confirmed**: hand-rolled ndjson stdio + legacy `initialize` handshake advertising `2025-06-18` remains the maximally compatible target (2026-07-28 "modern" era clients probe `server/discover` and FALL BACK to legacy on `-32601` — which our dispatch shape already returns). stdio framing (newline-delimited, no embedded newlines, stderr for logs) is normative and matches the copied server shape.
8. **DDL apply order**: the DDL README binds "applied in `DDL_FILES` order from `apply.py`, never by glob". substrate.mjs carries its own ORDERED 26-file list; a unit test cross-checks that list against both the ddl directory contents and `apply.py`'s `DDL_FILES` (parsed as text) so drift fails loudly.
9. **Session-host ground truth (explorer-verified)**: the successor sequence is `buildProductionDeps({pool, config, runtimeIdentity, contextCompiler: SeamContextCompiler, …})` → `makeThinPathSteps(deps)` → `readPriorAttemptStep(input)` → `reallocateStep(input, prior)`; RECOMPILE is decided INSIDE `allocate()` (no fourth call). `buildProductionDeps` REFUSES an injected `clock` (CLOCK_REFUSED — DB time only) and requires the `FIRIA_RUNTIME_*` config env (PG_URL, POOLER='direct', APP_VERSION, MODEL, MAX_BUDGET_USD, EGRESS_CLASS, + secret keys) — `oathe claude` synthesizes this env for the local cell. firia-runtime has NO lease-renewal API (that lives in the dispatcher, out of scope): the session-host owns W1 lease renewal itself — extend `work_claim.ownership_valid_until` by SQL while the cage's `enumerate()` shows live pids, stop on empty/exit; the born-red test targets exactly this.
10. **Yield cause registration (verified)**: insert into `cell.claim_yield_cause (cause, basis_prefix)`; the cause must be a real plpgsql function on the call stack (`cell.written_by`), so init creates `cell.oathe_yield_operator(work_claim_id, note, at, event_id)` wrapping `cell.record_claim_yield` with basis prefix `operator_decision` — the play script's exact pattern, productized.
11. **Verification additions**: `claude plugin validate <pkg>/plugin` joins the test loop; skills validated against the Agent Skills constraints (name==dir etc.).

## Waves

- W1 (this plan): everything above. Exit: `npm test` green; `oathe init` twice = idempotent (byte-diff test); full loop demo'd in a real terminal: init → claude (board renders at SessionStart) → claim → note → exit → resume (successor + RECOMPILE render) → yield; doctor clean; uninstall restores.
- W2: `oathe codex` launcher (AGENTS.md delivery + cage-side heartbeat), delegate/offers, suggest-hook, up/daemons.
- W3 (Stage-3-aligned): checkpointing, deploy, A2A.

## Verification

- Unit: blocks engine (fence create/replace/idempotent/user-edit-detection), manifest round-trip, census against fake homes, substrate apply on scratch db (reuse monorepo PG conventions), dispatch() of the MCP server with fake tools.
- Integration (scripted, no falsifier ceremony — this is product code): fresh $HOME sandbox (HOME=tmpdir) → init → assert configs/fences/manifest → init again → byte-identical → uninstall → byte-restored. Real-terminal manual pass by founder for the interactive feel.
- The session-host lease-liveness rule gets a born-red test (kill the caged child → lease stops renewing → `ls` shows expiry) — the one semantic worth the ceremony.
- House rules carried: red-first for the session-host; review gate per task (separate session's discipline); nothing pushed anywhere public.
