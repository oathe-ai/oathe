import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { renderSplash } from '../src/board-render.mjs';
import { waitForLaunch } from '../src/launch.mjs';

const SECTIONS = {
  mine: [{ task_id: 'mine-1', objective: 'A task of mine', lease_until: '2026-08-25 05:34', state: 'active', principal_id: 'founder' }],
  open: [
    { task_id: 'beer-check', objective: 'See all three lines', state: 'yielded' },
    { task_id: 'demo-smoke', objective: 'Prove the real loop end to end with a very long objective that must be truncated for the terminal', state: 'yielded' },
  ],
  asserted: [{ task_id: 'asserted-1', objective: 'Done, awaiting a verdict', state: 'completion_asserted' }],
  held: [{ task_id: 'held-1', objective: 'Someone else is on it', state: 'active', principal_id: 'athena' }],
};

test('renderSplash is ANSI, aligned, and carries NO markdown syntax', () => {
  const splash = renderSplash({
    message: '🔒 Oathe: 2 open tasks · 1 held',
    sections: SECTIONS,
    workspace: 'ws-0d0a0b0c0d0e',
  });
  assert.match(splash, /\x1b\[1m/, 'bold ANSI present');
  assert.match(splash, /\x1b\[2m/, 'dim ANSI present');
  assert.match(splash, /\x1b\[0m/, 'reset present');
  assert.doesNotMatch(splash, /\*\*|##|^- /m, 'no markdown tokens');
  assert.match(splash, /🔒 Oathe: 2 open tasks · 1 held/);
  assert.match(splash, /ws-0d0a0b0c0d0e/);
  for (const header of ['YOURS', 'OPEN', 'ASSERTED', 'HELD']) assert.match(splash, new RegExp(header));
  assert.match(splash, /beer-check/);
  // Task-id column is padded to one width: both offered ids are followed by
  // enough spaces to align (beer-check is 10 chars, demo-smoke is 10 — same pad).
  const plain = splash.replaceAll(/\x1b\[[0-9]+m/g, '');
  const offeredLines = plain.split('\n').filter((l) => /beer-check|demo-smoke/.test(l));
  const objectiveColumns = offeredLines.map((l) => l.indexOf('See') !== -1 ? l.indexOf('See') : l.indexOf('Prove'));
  assert.equal(objectiveColumns[0], objectiveColumns[1], 'objective column aligned');
  assert.ok(plain.split('\n').every((l) => l.length <= 100), 'long objectives truncated');
});

test('renderSplash on an empty board is the single state line', () => {
  const splash = renderSplash({
    message: '🍺 No open tasks in this folder — Oathe is keeping track.',
    sections: { mine: [], open: [], asserted: [], held: [] },
    workspace: 'ws-000000000000',
  });
  const plain = splash.replaceAll(/\x1b\[[0-9]+m/g, '');
  assert.match(plain, /🍺 No open tasks/);
  assert.doesNotMatch(plain, /YOURS|OPEN|ASSERTED|HELD/);
});

test('waitForLaunch resolves early on stdin data and cleans up its listener', async () => {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.pause = () => { stdin.paused = true; };
  const writes = [];
  const out = { isTTY: true, write: (t) => writes.push(t) };
  const started = Date.now();
  const wait = waitForLaunch({ harness: 'codex', pauseMs: 5000, stdin, out });
  setTimeout(() => stdin.emit('data', '\n'), 30);
  await wait;
  assert.ok(Date.now() - started < 4000, 'Enter skipped the countdown');
  assert.equal(stdin.listenerCount('data'), 0, 'listener removed');
  assert.equal(stdin.paused, true, 'stdin handed back paused');
  assert.ok(writes.some((w) => /Enter to go now/.test(w)));
});

test('waitForLaunch resolves by timer with no keypress', async () => {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.pause = () => {};
  const out = { isTTY: true, write: () => {} };
  const started = Date.now();
  await waitForLaunch({ harness: 'codex', pauseMs: 80, stdin, out });
  assert.ok(Date.now() - started >= 75);
});

test('waitForLaunch is a no-op off-TTY', async () => {
  const writes = [];
  await waitForLaunch({
    harness: 'codex', pauseMs: 5000,
    stdin: Object.assign(new EventEmitter(), { isTTY: false, pause: () => {} }),
    out: { isTTY: false, write: (t) => writes.push(t) },
  });
  assert.equal(writes.length, 0);
});

test('R2 (§1.2): the board states durable facts — not-asserted phrasing, last progress, reopened honesty', () => {
  const splash = renderSplash({
    message: 'x',
    sections: {
      mine: [{ task_id: 'm1', objective: 'obj', lease_until: '2026-08-26 10:00', state: 'active', principal_id: 'founder', last_progress: 'idempotency guard implemented in capturePayment.ts' }],
      open: [{ task_id: 'r1', objective: 'rejected once', state: 'reopened' }],
      asserted: [], held: [],
    },
    workspace: 'ws-0d0a0b0c0d0e',
  });
  assert.match(splash, /not asserted/, 'a held claim is presented as completion-not-asserted');
  assert.match(splash, /last: idempotency guard/, 'durable progress rides the board');
  assert.match(splash, /back — incomplete, actionable/, 'reopened work is named honestly');
  assert.doesNotMatch(splash, /running|resuming|interrupted/i, 'no process-liveness implication');
});
