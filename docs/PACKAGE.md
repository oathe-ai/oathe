# oathe

The Oathe interface, D0: an npm package whose `oathe init` onboards **both** installed
harnesses (Claude Code and Codex) onto the local cell substrate, and whose `oathe claude` /
`oathe codex` launch normal interactive sessions inside the cage with this folder's board
attached. The session changed; the unfinished obligation did not disappear.

Claims are speech acts. The substrate refuses dishonesty by construction — a claim never
mints its work as done, a task without a plan says `plan_status: "unknown"`, a second
claimant is refused, a yield needs a declared cause, and a killed session leaves an absence,
not a fabricated goodbye.

## Verbs

    oathe init                    # substrate up (createdb oathe_local + 26 DDL files, additive,
                                  # never DROP) + Claude/Codex onboarding + install manifest
    oathe claude [--hermetic]     # interactive Claude Code in the cage; the board renders at
                                  # SessionStart — presentation only: launching binds nothing
    oathe codex  [--hermetic]     # interactive Codex, same cage, same board, same rules
    oathe claim <id> [objective]  # claim a task (minting it honestly when new)
    oathe ls [--all]              # this workspace's board (--all: every workspace)
    oathe note <id> <text> [ref]  # a progress statement — a statement, not truth
    oathe done <id> <what> [ref]  # assert completion; binds the policy-standard plan (G2-b)
                                  # and mints verify:<id> on the board — a different principal verifies
    oathe verify [task|--all]     # the verification lane: a fresh headless engine (claude|codex,
                                  # assigned at claim) judges the completion against the claim's
                                  # recorded trace INTERVALS; a DETERMINISTIC acceptance lane
                                  # settles under the non-author seat (accepted → settled;
                                  # rejected → reopened)
    oathe trace <id> [--out dir]  # export the claim's linked session traces as ATIF trajectories
    oathe config <key> [value]    # read/write tunables (workspace .oathe.json or --global)
    oathe yield <id> <note>       # the task goes back on the board, unowned
    oathe doctor                  # verify every managed surface against the manifest
    oathe status                  # the substrate half of doctor
    oathe uninstall [--purge-db]  # remove exactly what init recorded; the database stays

There is **no resume verb** (founder ruling 2026-08-24): launching presents the board and
binds NOTHING — a session becomes attributable to a claim only when you or the agent act on
it explicitly (claim it, continue it, record progress). Ownership horizons are set at claim
time and are never extended by session liveness (D0 correction, 2026-08-26). Full automatic
pickup — recompiled frame, successor allocation — ships with the runtime package; until
then `oathe_pickup` refuses typed rather than pretending. In D0, "continue task-x" means:
the durable claim, its objective, and its recorded progress are on the board in either
harness, and the agent inspects the actual workspace and carries on.

## Upgrading

    npm i -g @oathe/oathe@latest && oathe init

That is the whole upgrade. Hooks and the MCP server run the `oathe` bin on PATH, so the new
code is live the moment npm replaces it; `oathe init` is idempotent and re-materializes the
harness plugin caches (version-keyed) and re-registers the marketplaces if the install moved
(an nvm node switch). `oathe version` says what is on PATH; `oathe doctor` shows it beside
each harness's cached plugin version.

## What init touches (all reversible, all recorded)

- `~/.claude/settings.json` — two owned keys (`extraKnownMarketplaces.oathe`,
  `enabledPlugins."oathe@oathe"`), backed up first, removed exactly by `oathe uninstall`.
- `~/.codex/config.toml` — via the sanctioned CLIs (`codex plugin marketplace add`,
  `codex plugin add`, `codex mcp add`), verified after each call, undone by the inverse CLIs.
- Project `CLAUDE.md`/`AGENTS.md` (at `oathe claude` pre-flight) — one tiny managed section
  inside `<!-- >>> oathe … >>> -->` fences; content outside the fence is never touched.
- `~/.oathe/` — install manifest, pre-edit backups, artifact store.

The monorepo is consumed **read-only** (a `file:` dependency plus one sanctioned path import
for the cage); nothing here edits it, and nothing here is published anywhere.

## Verification, honestly bounded

Completion is a statement; settlement needs a verdict from a principal that did not author
the work (FC010 — and your own sub-agents count as you). `oathe done` binds the
policy-standard plan and mints a verification task; `oathe verify` allocates one fresh
engine run per obligation (never a standing grader), records its verdict as durable
evidence, and the deterministic acceptance lane signs and settles through the substrate's
own verbs. The deterministic bar checks the verdict's presence and provenance — the judgment
quality is the engine's, and the linked traces (`docs/traces.md`) exist precisely so that
judgment stays auditable. A rejection reopens the work (R8): the same task, the prior
principal, visibly back on the board.

## Privacy and preview scope

What Oathe reads, stores, and sends: [docs/PRIVACY.md](PRIVACY.md). This is a D0
preview: the README and ROADMAP promise only what tests prove, and the amended launch
gates stay in force for everything else.

## Handoff

`docs/PRODUCT.md` is the complete technical handoff — architecture, contracts, refusal
vocabulary, live-proven results, and the roadmap. An agent reading nothing else can work on
this codebase from it.

## Tests

    npm test        # the suite: unit (fences, manifest, harnesses, workspace, host) +
                    # real-Postgres substrate/tools/successor + the scripted exit loop

### Machines with the runtime monorepo checkout

After `npm install` (or `npm ci`), run `npm run link-runtime` — npm treats
`node_modules/oathe-runtime` as extraneous and prunes it once `oathe-runtime` is not a
declared dependency, so this repairs the symlink at the correct relative depth for wherever
the checkout lives. Standalone machines (no monorepo checkout) skip this step entirely.
