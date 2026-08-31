# Oathe Notch

The quiet glass. A macOS island that shows your durable work — and otherwise you
shouldn't know it's there.

Three states, nothing else:

- **rest** — literally nothing: dissolved into the MacBook's camera housing, or a
  small sliver on external displays. Hover peeks a lock and how many tasks you hold.
- **event** — one pushed line, only when something happened (`🔒 1 unclaimed task
  expiring`). Amber persists until seen; receipts show once and fade.
- **open** — click: work in motion. One row per live claim — task, the surface
  speaking on it, the age of its last word. A row expands to its last progress and
  home, with one act: `continue ↗` (copies `continue <task>`, opens the folder).
  The sheet is Liquid Glass on macOS 26, the island's own black before that.

Drag it anywhere; it snaps to the nearest edge of any display and remembers its seat
(side docks lie vertical). Right-click: Reset Position, Start at Login, Quit.

## Architecture

The package computes, the notch renders. This app contains **zero business logic**.

```
speech acts (claim · statement · done · yield · pickup · verify)
      │  one pg_notify per successful write ("the wire")
      ▼
  Postgres (oathe's local substrate)
      ▲  LISTEN
      │
  `oathe notch --serve`        ← the feed: recomputes a frame per event + heartbeat
      │  ndjson frames on stdout {push, breaches, motion, idle, sections, receipt?}
      ▼
  OatheNotch.app               ← this repo: supervises the feed child, renders frames
```

One file per concern:

| File | Owns |
|---|---|
| `OatheNotchApp.swift` | bootstrap; launchd owns the process, the app owns its feed child |
| `Feed.swift` | frame decoding + feed supervision (restart with backoff; failures are typed amber lines, never silence) |
| `NotchModel.swift` | the state machine (motion-free) |
| `NotchView.swift` | the glass (geometry hugs content) |
| `NotchPanel.swift` | the window: seat, pointer arming, drag + snap — the only frame owner |
| `DockAnchor.swift` | where the island lives; persists; `clear()` goes home |
| `Theme.swift` | every token, named once — read its taxonomy header before adding a constant |

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

## License

TBD — follows the oathe project's licensing decision.
