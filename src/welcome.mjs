// oathe — the one-time welcome. Init plants the marker when it CREATES the database;
// the serve feed consumes it after a successful frame build and rides the lines on that
// frame. Consume-on-emit is a ruling: the glass has no ack channel (its stdin to the feed
// is write-never), so a play lost to a dying app is accepted one-shot loss — the
// alternative, replay-on-every-KeepAlive-restart, would lie louder. `oathe notch
// --welcome` is the free replay. Presence is the fact: consume never parses the marker,
// so a corrupt file has no failure mode.

import fs from 'node:fs';
import path from 'node:path';

/** The founder copy, verbatim (2026-08-31) — product code, not a tunable. */
export const WELCOME_LINES = Object.freeze([
  'welcome to oathe',
  "I'll list your session statuses here.",
  'you can click to expand in the future.',
  "let's build something great today",
]);

/** Plant the pending marker. Idempotent — planting over a pending marker is still one welcome. */
export function plantWelcome({ paths, by = 'init' }) {
  fs.mkdirSync(path.dirname(paths.welcomePath), { recursive: true });
  fs.writeFileSync(paths.welcomePath, `${JSON.stringify({ planted_at: new Date().toISOString(), by })}\n`);
  return { file: paths.welcomePath };
}

/** Take the one shot: the lines if a marker was pending (clearing it), else null. */
export function consumeWelcome({ paths }) {
  if (!fs.existsSync(paths.welcomePath)) return null;
  fs.rmSync(paths.welcomePath, { force: true });
  return { lines: [...WELCOME_LINES] };
}
