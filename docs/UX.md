# The UX contract

Every prompt `oathe` shows and every line it prints follows these rules. Each rule names the
test that holds it; a rule nobody tests is not a rule (`tests/ux-contract.test.mjs` refuses one
without a pointer to an existing test file). Ruling R-UX (`PLAN.md`, 2026-08-29) is the
founder's word: "type numbers is a no go"; a setup that "doesn't really explain anything" is
not done. The fresh-user trial (pack → uninstall → install the tarball → `oathe init` at the
keyboard) is the last gate before a public flip — never the first place a rule is checked.

## Questions

1. **No numbered menus, no question-by-question conversation.** Setup is ONE screen: every
   detected harness listed and pre-selected, ↑↓ to move, space to toggle, the verifier as a radio
   row (← →), Enter installs the selection — one keypress for the common case. (founder, 2026-08-29:
   "why do i have to click so many buttons?") — held by `tests/setup.test.mjs`
2. **A row states what the wiring covers; the highlight shows what it writes.** Each harness row
   is `[x] Name (CLI/Desktop App)` — the surfaces served, an adapter fact. The highlighted row
   shows the adapter's full `describe()` below, dimmed — the same data its `onboard()` writes —
   so the screen cannot promise what the write does not do. Nobody has to read anything to press
   Enter. — held by `tests/setup.test.mjs, tests/harness-contract.test.mjs`
3. **Presence is stated as facts.** "found: CLI on PATH, config at ~/.claude"; "found: config
   at ~/.cursor (no cursor-agent/cursor on PATH)"; "not found (no codex on PATH, no ~/.codex)"
   — what was found, or what was looked for; never a bare "installed". — held by
   `tests/setup.test.mjs`
4. **The default is visible and Enter takes it.** Detected harnesses start `[x]`; the verifier
   radio starts on the recorded machine-wide choice when one exists, else its default — and
   moving it and pressing Enter IS how the choice is changed; re-running `oathe init` is the
   switch. Enter with no other key installs exactly what is shown. — held by
   `tests/setup.test.mjs`
5. **Unknown keys do nothing; leaving is a typed refusal.** A key the screen does not use is
   ignored — never coerced into a choice, never fatal; Esc, `q`, or ctrl-c is
   `OATHE_INIT_ABORTED` ("nothing was written"). — held by `tests/setup.test.mjs`
6. **What cannot be chosen is a dim, fixed row.** A harness that is not here ("not found (no
   codex on PATH, no ~/.codex)"), a step decided by `--harness`, a verifier with a single
   candidate, a detect-only surface (Cowork, ChatGPT web) — each is shown with its reason and
   cannot be toggled. — held by `tests/setup.test.mjs`
7. **A pasted or piped chunk is taken key by key** (a piped newline is Enter), and a stdin that
   closes before Enter is a typed refusal (`OATHE_INIT_INPUT_CLOSED`) naming `--yes` — never a
   hang. — held by `tests/setup.test.mjs`

## Order

8. **Ask everything, then do everything.** The substrate's reachability is checked before the
   first question (nobody answers a setup that cannot come up); nothing is written before the
   last answer. — held by `tests/init.test.mjs`
9. **`--yes` and no-TTY apply the plan's defaults and announce what they applied** — "init:
   --yes — applying defaults: wire: claude, cursor; skip: codex (not installed); verifier:
   claude" on stdout for `--yes`, on stderr for a pipe. A skipped question says why. — held by
   `tests/init.test.mjs`
10. **`--harness a,b` refuses what it cannot do.** An unknown name is
    `OATHE_INIT_HARNESS_UNKNOWN`; a harness that is not on this machine is
    `OATHE_INIT_HARNESS_ABSENT` — never silently dropped. — held by
    `tests/setup.test.mjs, tests/init.test.mjs`

## Output

11. **The summary is one word per row.** Every path was disclosed on the screen before Enter
    (and `--yes` announces what it applies); `oathe doctor` is the standing per-path audit. So
    the summary says only what happened: wired, unwired, or skipped with the reason as a
    sentence ("not installed", "you said no", "not named by --harness") — never a machine
    token, never a path dump. Then the verifier and where it is
    recorded, the substrate, the principal, the surfaces, and the `Next:` line. — held by
    `tests/setup.test.mjs, tests/init.test.mjs, tests/cli.test.mjs`
12. **Paths are shown under `~`.** — held by `tests/setup.test.mjs`
13. **Refusals are typed and name the fix.** `[OATHE_INIT_HARNESS_ABSENT] … install it first
    or drop it from --harness`; `[OATHE_SUBSTRATE_UNREACHABLE] … brew services start
    postgresql@17`. — held by `tests/setup.test.mjs, tests/init.test.mjs`
14. **Every CLI run ends with the trailer** `oathe: <verb> ok|refused|error|attention|exit N`
    (stderr for `trace` and `notch`, whose stdout is pure JSON). — held by `tests/cli.test.mjs`

## Held to the world

15. **A real pty `oathe init`, pressing Enter, passes the same rules** in the
    install-contract lane (`scripts/harness-install-contract.mjs`, check `init-tty`), on every
    PR, for every installable harness. — held by `tests/harness-install-contract.test.mjs`
16. **Public copy promises only what tests prove.** `docs/PRODUCT.md` §3 names every file a
    wiring adapter says init writes; the README's "What init touches" is the founder's copy and
    is compared by hand against the same list. — held by `tests/ux-contract.test.mjs`

## Words

- Harnesses are named by their display names in prompts (Claude Code, Codex, Cursor)
  and by their catalog names on the command line (`claude`, `codex`, `cursor`).
- "wire" is the verb for installing oathe into a harness; "verifier" is the harness whose
  headless run judges finished work; "skipped — <why>" is the only shape a non-action takes.
