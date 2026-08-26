# What Oathe reads, stores, and sends

Measured against the code at this commit — if behavior and this document disagree, that is a
bug; open an issue.

## Reads (declared integration surfaces)

Oathe does not crawl arbitrary files. It reads exactly these declared surfaces:

- **Session transcripts** for sessions in workspaces it manages: the turn-end hook projects
  the current session's own transcript to learn which tasks the session acted on
  (`plugin/hooks/heartbeat.mjs`), and `oathe verify` / `oathe trace` read the transcript
  files linked to a claim. Codex thread indexes are read through `node:sqlite` where the
  Node version provides it.
- **Harness configuration it manages**: `~/.claude/settings.json` (two owned keys) and
  `~/.codex/config.toml` (via the codex CLI), plus the project's `CLAUDE.md`/`AGENTS.md`
  fenced sections.
- **Its own state**: the install manifest, backups, and artifact store under `~/.oathe/`,
  and the workspace config (`.oathe.json`).
- **Git metadata** of the working directory (root, origin) to derive the workspace identity.

## Stores (locally, in YOUR Postgres)

Task ids, objectives, claims, statements, verdicts, and transcript file **paths**.
Transcript contents are not copied into the database.

## Sends

Exactly one path sends anything anywhere: **`oathe verify`**. It projects the linked
transcripts into structured trajectories, slices them to the claim's recorded focus
intervals where intervals exist (whole-session evidence otherwise), renders a
character-budgeted evidence view (SAID/CLAIM/DID/GOT lines — not raw transcript bytes),
and passes that rendering to the verification engine you configured (`claude` or `codex`)
as a command-line prompt. That content therefore reaches the engine's model provider
(Anthropic or OpenAI) under YOUR account and their terms. If you never run `verify`,
nothing leaves your machine. Oathe has no telemetry, no server, and phones home to no one.

Two disclosed sharp edges:

- **The verifier engine runs OUTSIDE the cage, with your ambient environment**
  (`src/verifier.mjs` spawns the engine CLI with the invoking process's environment). A
  curated environment and bounded execution posture for the verifier is designed, not yet
  shipped — it is a tracked limit in the roadmap, not a silent gap.
- **The evidence prompt is passed as a process argument**, which is visible to local
  process listings on your machine while the engine runs.
