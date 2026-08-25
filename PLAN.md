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
`oathe resume [claim]` — the three-call sequence verified in exploration: buildProductionDeps({pool, config, runtimeIdentity, contextCompiler:SeamContextCompiler…}) → makeThinPathSteps → readPriorAttemptStep → reallocateStep → RECOMPILE package → render via buildLifecycleRender → launch `oathe claude` with the render injected as the SessionStart payload.
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

## Waves

- W1 (this plan): everything above. Exit: `npm test` green; `oathe init` twice = idempotent (byte-diff test); full loop demo'd in a real terminal: init → claude (board renders at SessionStart) → claim → note → exit → resume (successor + RECOMPILE render) → yield; doctor clean; uninstall restores.
- W2: `oathe codex` launcher (AGENTS.md delivery + cage-side heartbeat), delegate/offers, suggest-hook, up/daemons.
- W3 (Stage-3-aligned): checkpointing, deploy, A2A.

## Verification

- Unit: blocks engine (fence create/replace/idempotent/user-edit-detection), manifest round-trip, census against fake homes, substrate apply on scratch db (reuse monorepo PG conventions), dispatch() of the MCP server with fake tools.
- Integration (scripted, no falsifier ceremony — this is product code): fresh $HOME sandbox (HOME=tmpdir) → init → assert configs/fences/manifest → init again → byte-identical → uninstall → byte-restored. Real-terminal manual pass by founder for the interactive feel.
- The session-host lease-liveness rule gets a born-red test (kill the caged child → lease stops renewing → `ls` shows expiry) — the one semantic worth the ceremony.
- House rules carried: red-first for the session-host; review gate per task (separate session's discipline); nothing pushed anywhere public.
