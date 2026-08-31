// The one-time welcome: init plants a marker when it CREATES the database; the serve
// feed consumes it once and rides the lines on a frame. Presence is the fact — consume
// never parses the marker, so a corrupt file has no failure mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { buildPaths } from '../src/paths.mjs';
import { WELCOME_LINES, plantWelcome, consumeWelcome } from '../src/welcome.mjs';

const tmpPaths = () => buildPaths({ OATHE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-welcome-')) });

test('WELCOME_LINES is the founder copy — four lines, verbatim', () => {
  assert.deepEqual(WELCOME_LINES, [
    'welcome to oathe',
    "I'll list your session statuses here.",
    'you can click to expand in the future.',
    "let's build something great today",
  ]);
  assert.ok(Object.isFrozen(WELCOME_LINES), 'the copy is one frozen source of truth');
});

test('plantWelcome writes the pending marker under the oathe home; consumeWelcome returns the lines ONCE and clears it', () => {
  const paths = tmpPaths();
  const planted = plantWelcome({ paths });
  assert.equal(planted.file, paths.welcomePath);
  assert.ok(fs.existsSync(paths.welcomePath), 'the marker is the pending fact');
  const first = consumeWelcome({ paths });
  assert.deepEqual(first, { lines: [...WELCOME_LINES] });
  assert.ok(!fs.existsSync(paths.welcomePath), 'consume clears the marker — one shot');
  assert.equal(consumeWelcome({ paths }), null, 'a second consume finds nothing');
});

test('plantWelcome is idempotent — planting over a pending marker is still one welcome', () => {
  const paths = tmpPaths();
  plantWelcome({ paths });
  plantWelcome({ paths, by: 'cli' });
  assert.deepEqual(consumeWelcome({ paths }), { lines: [...WELCOME_LINES] });
  assert.equal(consumeWelcome({ paths }), null);
});

test('a corrupt marker still plays — presence is the fact, the content is forensics', () => {
  const paths = tmpPaths();
  fs.mkdirSync(path.dirname(paths.welcomePath), { recursive: true });
  fs.writeFileSync(paths.welcomePath, 'not json at all');
  assert.deepEqual(consumeWelcome({ paths }), { lines: [...WELCOME_LINES] });
  assert.ok(!fs.existsSync(paths.welcomePath));
});
