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
