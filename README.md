# oathe

The Oathe interface, D0.1: an npm package whose `oathe init` onboards **both** installed
harnesses (Claude Code and Codex) onto the local cell substrate, and whose `oathe claude`
launches a normal interactive session inside the cage with this folder's board attached.

Claims are speech acts. The substrate refuses dishonesty by construction — a claim never
mints its work as done, a task without a plan says `plan_status: "unknown"`, a second
claimant is refused, a yield needs a declared cause, and a killed session leaves an absence,
not a fabricated goodbye.

## Verbs

    oathe init                    # substrate up (createdb oathe_local + 26 DDL files, additive,
                                  # never DROP) + Claude/Codex onboarding + install manifest
    oathe claude [--hermetic]     # interactive Claude Code in the cage; the board renders at
                                  # SessionStart; leases renew while the cage shows life
    oathe claim <id> [objective]  # claim a task (minting it honestly when new)
    oathe ls [--all]              # this workspace's board (--all: every workspace)
    oathe note <id> <text> [ref]  # a progress statement — a statement, not truth
    oathe done <id> <what> [ref]  # assert completion; binds the policy-standard plan (G2-b)
                                  # and mints verify:<id> on the board — a different principal verifies
    oathe verify [task|--all]     # the verification lane: a fresh headless engine (claude|codex,
                                  # assigned at claim) judges the completion against its recorded
                                  # session traces; a DETERMINISTIC acceptance lane settles under
                                  # the non-author seat (accepted → settled; rejected → reopened)
    oathe config <key> [value]    # read/write tunables (workspace .oathe.json or --global)
    oathe yield <id> <note>       # the task goes back on the board, unowned
    oathe doctor                  # verify every managed surface against the manifest
    oathe status                  # the substrate half of doctor
    oathe uninstall [--purge-db]  # remove exactly what init recorded; the database stays

There is **no resume verb** (founder ruling 2026-08-24): resuming is what launching means.
Launching renders the folder's board; *picking up* happens in-session — "continue
task-x" runs the `oathe_pickup` MCP tool, which drives the verified successor sequence
(read prior attempt → reallocate → recompiled frame) against the real runtime.

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

## Handoff

`docs/PRODUCT.md` is the complete technical handoff — architecture, contracts, refusal
vocabulary, live-proven results, and the roadmap. An agent reading nothing else can work on
this codebase from it.

## Tests

    npm test        # the suite: unit (fences, manifest, harnesses, workspace, host) +
                    # real-Postgres substrate/tools/successor + the scripted W1 exit loop

### Estate machines

After `npm install` (or `npm ci`), run `npm run link-firia` — npm treats
`node_modules/firia-runtime` as extraneous and prunes it once `firia-runtime` is not a
declared dependency, so this repairs the symlink at the correct relative depth for wherever
the checkout lives. Standalone machines (no monorepo checkout) skip this step entirely.
