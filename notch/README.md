# Oathe Notch

The quiet glass. A macOS island that shows your durable work — and otherwise you
shouldn't know it's there.

Two geometries, nothing else:

- **rest** — literally nothing: dissolved into the MacBook's camera housing, or a
  small sliver on external displays. The lock wears the standing tone (amber while a
  promise is breached or the feed is broken, muted when all is well); an event pulses
  its tone once. Hover peeks the lock and how many tasks you hold.
- **open** — click: the sheet. Breached promises lead, sharpest first, then work in
  motion — one row per task or sibling group: a name, a state word, an age, and the one
  act that can change its truth (`continue ↗` / `verify ↗` / `retry ↗`). At most eight
  rows; everything past them is one `+N more` line. A row expands to the task card —
  what is owed, where it stands, the last word (whole), where it lives, the act. The
  sheet is Liquid Glass on macOS 26, the island's own black before that.

Drag it anywhere; it snaps to the nearest edge of any display and remembers its seat
(side docks lie vertical). Right-click: Reset Position, Start at Login, Quit.

## Architecture

The package computes, the notch renders. This app contains **zero business logic** and
composes **no sentence**: every word on the glass — kind words, act words, the children
line, the `+N more` count — rides in the frame from Node (`src/notch-frame.mjs`), and a
Node test (`tests/notch-frame.test.mjs`) holds the frame to this app's own decoder
(`Feed.swift`), field by field.

```
speech acts (claim · statement · done · yield · pickup · verify)
      │  one pg_notify per successful write ("the wire")
      ▼
  Postgres (oathe's local substrate)
      ▲  LISTEN
      │
  `oathe notch --serve`        ← the feed: recomputes a frame per event + heartbeat
      │  ndjson frames on stdout
      ▼
  OatheNotch.app               ← this directory: supervises the feed child, renders frames
```

A frame carries:

| Key | What it is |
|---|---|
| `breaches` | the breach digest's rows — sharpest first, at most the sheet's row cap, each with `kind_word`, `objective`, `home`, `detail`, `at`, `busy` (a judgment in flight: the word is `verifying`, the failure is gone, no act — the glass adds a spinner), and its `act` (`kind`, `word`, and what to run) |
| `more` | how many breaches the budget left out |
| `motion` | anyone's active claim with a recent word, or one heard live on the wire — each with `objective`, `holder`, `surface`, `session`, `children_line`, and its `resume` |
| `judged` | asserted claims awaiting their verdict (never invisible between done and verdict) — the same row shape, with `judgment` (the word: `verifying` while a judge holds it, `awaiting verdict` until one does), `busy` (the spinner, the key a breach spins on), and no `resume` — nothing a person does moves a judgment |
| `idle` | your held claims gone quiet, after motion and judgment |
| `sections` | the one board classification (`mine` · `open` · `asserted` · `held`) |
| `default_agent` | the machine's chosen agent, or null — the glass reads no config |
| `notice` | optional: the words of the event that caused this frame, with a tone |
| `welcome` | optional: the one-time welcome's lines, on the first frame after the database is created |

One file per concern:

| File | Owns |
|---|---|
| `OatheNotchApp.swift` | bootstrap; launchd owns the process, the app owns its feed child |
| `Feed.swift` | frame decoding + feed supervision (restart with backoff; failures are typed amber lines, never silence) |
| `NotchModel.swift` | the state machine (motion-free): the frame, the budgeted entries, the acts |
| `NotchView.swift` | the glass (geometry hugs content): the bar, the sheet, the task card |
| `NotchPanel.swift` | the window: seat, pointer arming, drag + snap — the only frame owner |
| `DockAnchor.swift` | where the island lives; persists; `clear()` goes home |
| `Theme.swift` | every token, named once — read its taxonomy header before adding a constant (`rowCap` equals the digest's cap, pinned by the Node test) |

## The two scars (read before touching motion)

1. **The freeze** — never animate window frames from state changes; overlapping
   animator groups wedge the panel. Content animates; the window holds still.
2. **The oscillation** — hover must never change window geometry; a frame that flees
   the pointer flickers forever and can't be clicked.

## Install

The notch ships with `@oathe/oathe` — the npm tarball carries the built app (prepack
builds it), and on macOS `oathe init` writes + bootstraps its LaunchAgent for everyone;
`oathe uninstall` boots it out and removes exactly what init recorded. No opt-in, no
extra step. `oathe config notchApp <path> --global` overrides the packaged app (a source
checkout that hasn't run `./make-app.sh` gets an honest `notch-binary-missing` row).

## Build from source

```sh
./make-app.sh                       # swift build + assemble "Oathe Notch.app" (ad-hoc signed)
oathe init                          # re-seats the LaunchAgent on the fresh build
```

Requires macOS 14+, Swift toolchain, and [oathe](https://github.com/oathe-ai/oathe)
with its local substrate (`oathe init`).

## Platforms

macOS 14+ only, Apple Silicon and Intel (the shipped app is a universal binary). The
glass is native AppKit; everything beneath it is platform-neutral — `oathe notch
--serve` streams plain ndjson frames, so a Windows or Linux notch is a renderer plus
its own startup wiring, no substrate or wire changes. On other platforms `oathe init`
wires nothing and says nothing: there is nothing for the user to do.

## License

Apache-2.0, as the rest of the oathe repository.
