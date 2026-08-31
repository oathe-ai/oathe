<!-- >>> oathe v0.1.2 >>> -->
## Oathe

This folder has an Oathe board (workspace `ws-63d60b8f9275`). Claims are speech acts:
claim before you build, record progress as statements, yield what you cannot finish —
via the `oathe_*` MCP tools. The board renders at SessionStart; `continue <task>`
picks work back up.
<!-- <<< oathe <<< -->

## Working on this package (outside the oathe fence — contributors' rules)

- **Supported means every touchpoint is on the adapter.** A harness is supported when its
  adapter in `src/harnesses/` declares every touchpoint — detect, install, wiring (with its
  own `describe()` of what it writes), hooks, context files, global files, synthetic
  workspaces, headless/verify, traces, launch, docs — each fully supported or declared
  `null`, never half-done and never hardcoded elsewhere. The golden capability table in
  `tests/harness-contract.test.mjs` is the spec: adding a harness or a capability is a
  visible row change. No `'claude'`/`'codex'`/`'cursor'` literal and no `if (name === 'x')`
  outside `src/harnesses/`; consumers ask the catalog by capability.
- **Every prompt and output follows `docs/UX.md`.** No numbered menus and no
  question-by-question conversations: setup is one screen, everything detected pre-selected,
  space toggles, Enter installs; a row says what selecting it writes, from the write's own
  data; unknown keys do nothing and leaving is a typed refusal; ask everything before doing
  anything; `--yes` announces what it applies; every CLI run ends with the trailer. A change to a
  prompt is a change to `tests/setup.test.mjs` first.
- The house rules (no hardcoding — every tunable through `OatheConfig`; fail loud with typed
  refusals; OOP core, thin functional edges, one implementation per concept; TDD red-first)
  and the full technical handoff are in `docs/PRODUCT.md`; the decision trail is the git history.
