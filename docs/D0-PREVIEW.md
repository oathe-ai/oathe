# Amendment: D0 early public preview (recorded 2026-08-26)

**Amends:** the staging ruling that gated the public flip of `oathe-ai/oathe` on the
enforcement phase's exit (staging record of 2026-08-22, §3.6; product-record decisions
17–19). That gate is superseded for a NARROW scope, by founder ruling as amended on
2026-08-26.

## What D0 promises (present tense, test-proven on a clean machine)

- One setup flow (`oathe init` — a picker over the harnesses actually detected, the verifier
  question asked once), a durable local task board, claims that outlive sessions.
- Claude, Codex, and Cursor sessions in the same workspace see the same open work; surfaces
  the installer cannot wire (Cowork, ChatGPT web) get printed manual steps, never writes.
- The MCP server never dies on a harness's environment: workspace discovery is the server's
  own resolution ladder (explicit binding → harness project-dir vars → MCP roots → guarded
  cwd → a typed per-call refusal), proven against an unexpanded `${CLAUDE_PROJECT_DIR}` and
  an empty allowlisted env.
- Opening a session on a folder activates it — registry row + fenced board pointer, disclosed
  in the banner; `autoActivate false` registers only; `oathe uninstall` reverses every write.
- Interactive launch presents durable state and never auto-resumes, auto-binds, or renews
  ownership; planning-only sessions stay unbound.
- Claim evidence is task-specific and interval-specific; pre-claim discussion is context.
- Completion requires non-author verification; rejected work reopens.

## What D0 does NOT claim (the amended gates remain in force for these)

- Automatically compiled pickup / safe successor allocation (typed refusal:
  `OATHE_PICKUP_UNAVAILABLE` until the runtime package lands publicly).
- Cross-machine or cloud continuation; attempt fencing; workspace checkpoint restoration.
- Stale statement/effect refusal, act-time authority enforcement, remote/A2A gateway
  fencing, effect reservation/receipt coverage (the enforcement phase's earned claims).

## Also recorded

- **Repository visibility history**: public as a placeholder (Aug 23–25), private during
  staging (Aug 25 → release), public again at this release. Objects pushed to working
  branches during the private window persist in the repository network as dangling commits
  after branch deletion; their SHAs were never publicly listed; the residual is accepted
  and no such object may be treated as unpublished.
- **Root principal role**: the substrate's schema makes `(role='ceo') ⇔ (answers to
  nobody)` and terminates escalation at that seat — 'ceo' is schema vocabulary, not an
  organizational assumption of this package. Renaming the root role generically is an open
  substrate/DDL decision for the runtime port. The package's own defaults are generic
  (department `operator`; principal from `OATHE_PRINCIPAL` or the OS user).
- **Verifier execution posture** (uncaged, ambient environment, argv-visible prompt) is
  disclosed in `docs/PRIVACY.md`; curation is a tracked limit.
- **DDL provenance**: the public drop is exported born-clean (comment-level private markers
  and internal wording transformed to generic language; executable SQL byte-exact) with
  two-sided provenance in `vendor/ddl/manifest.json` — source commit, per-file source and
  public sha256, transform version, application order. No marker exceptions conceal content.
- **Accepted marker-scan exceptions (0.3.1 sweep, recorded 2026-08-30)** — the pre-flip
  scan's remaining hits, each judged and kept on purpose:
  - vendored DDL comments cite ruling labels of the form `R-A35-NN` (six files) — internal
    decision numbering, cross-references between the DDL files themselves; no identity.
    Disposition: generalize via the export transform at a future re-vendor, with the
    manifest re-pinned; published sha-pinned bytes never change in place.
  - vendored DDL comments also retain the wider internal decision-trail vocabulary, kept
    by founder ruling (2026-08-31 — the ruling transformed one internal codename and kept
    the rest): "the Mac" — the predecessor system whose measured failures these files
    answer; citations of the form
    `PRD §N` / `FOUNDER RULING RN` / `STF-1` / migration numbers — the design record the
    rationale comments quote; and "bake-off" — the recorded design-comparison runs. None
    carry a name, path, or identity; all share the R-A35 disposition above.
  - the package's own convention vocabulary — refusal codes (`FC010`, `R8`), the `G2-b`
    policy-binder label, and ruling ids (`R-OSS-7`, `R-E`) — appears in `README.md`,
    `docs/PRODUCT.md`, and source comments by design: it is the product's public refusal
    and decision-trail language, not private jargon.
  - `.codex` / `chatgpt-projects` in `src/harnesses/codex.mjs`, `src/traces.mjs`,
    `README.md`, `docs/PRIVACY.md` are the Codex integration's real file locations —
    functional paths, disclosed in PRIVACY.
  - the scan vocabulary's only matches inside the notch binary are AppKit selector
    substrings (`RestorableState`), and `restate*` matches in DDL are plain English; the binary is
    stripped at assembly and `make-app.sh` refuses to assemble one embedding `/Users/` paths.
  - `CLAUDE.md`/`AGENTS.md` ship with the development workspace's board id in the oathe
    fence (`ws-` + 12 hex) — accepted by founder ruling (2026-08-31): the id is a truncated
    hash of a local checkout path, recovers no name or path, and a fresh clone's activation
    replaces it with that machine's own.
  - `ws-` ids in `tests/` are synthetic fixtures minted by the tests themselves; the
    scanner — its source's own pattern list and its test's planted files — carries the
    hunted vocabulary deliberately (internal docs-directory names, the session-link
    header), as does the `.gitignore` line keeping one such directory out of git. A
    scanner must name what it hunts; none of it references real sessions or documents.
- **0.4.1 (recorded 2026-09-03).** The clean-machine loop and the marker sweep, re-run by the
  release's final review on each of the four 0.4.1 cuts; the last cut is the one PR #32 carries.
  - **Leg 1, the container** (`node:24-bookworm`, Debian Postgres, the packed tarball): install →
    `oathe init` (ddl 28/28 from `vendor/ddl`) → status → claim → note → ls → done → `oathe verify`
    refusing typed with no engine present → `oathe uninstall --purge-db` — `FRESH-MACHINE-LOOP-OK`
    on every cut. One attempt never reached the tarball (the Debian mirror inside the container
    did not answer); its retry passed.
  - **The install door**, both sides, on every cut: `npm install -g` under node 22.3.0 exits 1 with
    `ERROR_NODE_VERSION` and lands nothing but an empty `lib/`; under 24.14.0 it installs and
    `oathe version` answers.
  - **Leg 2, the founder's machine, from a fresh-user state** (every earlier install, wiring,
    `~/.oathe`, the database and its role removed first): a fresh terminal, the tarball installed
    under node 24.14.0, `oathe init` at the keyboard wiring Claude Code, Codex, Cursor and the
    notch, `oathe doctor` clean on all ten manifest rows. Then the `/clear` check, the reason the
    fourth cut exists: in one Claude Code process, served by one `oathe mcp` process that was never
    restarted or reconnected, a claim spoken before a `/clear` was attributed to the first session
    and linked its transcript; a claim spoken after the `/clear` was attributed to the session the
    hook registered a minute later and linked that transcript; the verifier judged the second claim
    against the second transcript and accepted, citing it. The speaker's session is a per-act fact.
  - **Accepted marker-scan exceptions (0.4.1 sweep)**, beyond the 0.3.1 classes above, each judged
    and kept on purpose: the in-tree scan now hunts any real user's home-directory path and the
    founder's bare user name, so the sanitizer's synthetic users (`/Users/dev`, `/Users/x`,
    `/Users/someone`) are exempt by name and appear throughout `tests/fixtures/` and the tests
    that read them; `scripts/derive-trace-fixtures.mjs` and `scripts/marker-scan.mjs` carry the
    patterns they hunt, and `tests/vendor-scripts.test.mjs` plants one hit per pattern; `.codex`
    (the Codex integration's real file locations and the sanitized fixture layout) appears in the
    docs, the tests, the fixtures, the corpus tools and, as `secrets.CODEX_API_KEY`, in the
    live-contract workflow; `notch/make-app.sh` names `/Users/` in its own self-check. Build
    intermediates (`notch/.build`) are skipped by both scans: every Mac build writes the
    toolchain's home-relative paths into them, they are gitignored, and the shipped binary is
    stripped and self-checked. Nothing in the tarball or the committed tree names a person, a
    real home path, or a session.
