import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { renderBoard, renderSplash } from '../src/board-render.mjs';
import { BreachDigest, DIGEST_ROW_CAP, DETAIL_CLIP, JUDGMENT } from '../src/breach-digest.mjs';
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

const EMPTY = { mine: [], open: [], asserted: [], held: [] };
const digestOf = (breaches) => new BreachDigest({ breaches });
const breach = (kind, task_id, extra = {}) => ({
  kind, task_id, objective: `objective of ${task_id}`, home: '/srv/app', home_ref: 'ws-000000000000',
  detail: `detail of ${task_id}`, at: '2026-08-27T10:00Z', ...extra,
});
const plain = (text) => text.replaceAll(/\x1b\[[0-9]+m/g, '');
// A board with nothing on it — the breach section is the subject.
const emptyClient = { query: async () => ({ rows: [] }) };
const IDENTITY = { orgId: 'oathe', principalId: 'founder', department: 'founder' };

test('UX rule 22 on the board: an ASSERTED row names the judgment it awaits — the JUDGMENT table\'s words, on the splash and in the model\'s context alike', async () => {
  const asserted = [
    { task_id: 'a-judged', objective: 'a judge holds it', state: 'completion_asserted', judgment: 'verifying' },
    { task_id: 'a-waiting', objective: 'nobody has taken it', state: 'completion_asserted', judgment: 'awaiting' },
  ];
  const splash = plain(renderSplash({ digest: digestOf([]), sections: { ...EMPTY, asserted }, workspace: 'ws-0d0a0b0c0d0e' }));
  assert.match(splash, new RegExp(`a-judged .*${JUDGMENT.verifying.word}`), 'the splash says verifying');
  assert.match(splash, new RegExp(`a-waiting .*${JUDGMENT.awaiting.word}`), 'the splash says awaiting verdict');
  // The model's context: the board query answers with the classification's inputs (the
  // `verifying` fact rides the row), and the renderer speaks the same table.
  const client = {
    query: async () => ({
      rows: [
        { task_id: 'a-judged', objective: 'a judge holds it', state: 'completion_asserted', verifying: true, rejected_after: false, settled_at: null, origin: 'minted_at_claim', principal_id: 'founder', home: null, parent: null },
        { task_id: 'a-waiting', objective: 'nobody has taken it', state: 'completion_asserted', verifying: false, rejected_after: false, settled_at: null, origin: 'minted_at_claim', principal_id: 'founder', home: null, parent: null },
      ],
    }),
  };
  const { context } = await renderBoard({ client, identity: IDENTITY, workspace: 'ws-0d0a0b0c0d0e', all: true });
  assert.match(context, new RegExp(`- \\[a-judged\\] a judge holds it — ${JUDGMENT.verifying.word}`));
  assert.match(context, new RegExp(`- \\[a-waiting\\] nobody has taken it — ${JUDGMENT.awaiting.word}`));
});

test('renderSplash is ANSI, aligned, and carries NO markdown syntax', () => {
  const splash = renderSplash({
    digest: digestOf([breach('quiet', 'quiet-1')]),
    sections: SECTIONS,
    workspace: 'ws-0d0a0b0c0d0e',
  });
  assert.match(splash, /\x1b\[1m/, 'bold ANSI present');
  assert.match(splash, /\x1b\[2m/, 'dim ANSI present');
  assert.match(splash, /\x1b\[0m/, 'reset present');
  assert.doesNotMatch(splash, /\*\*|##|^- /m, 'no markdown tokens');
  assert.match(splash, /1 gone quiet/, 'the headline is the digest\'s push, worded once');
  assert.match(splash, /ws-0d0a0b0c0d0e/);
  for (const header of ['YOURS', 'OPEN', 'ASSERTED', 'HELD']) assert.match(splash, new RegExp(header));
  assert.match(splash, /beer-check/);
  // Task-id column is padded to one width: both offered ids are followed by
  // enough spaces to align (beer-check is 10 chars, demo-smoke is 10 — same pad).
  const offeredLines = plain(splash).split('\n').filter((l) => /beer-check|demo-smoke/.test(l));
  const objectiveColumns = offeredLines.map((l) => l.indexOf('See') !== -1 ? l.indexOf('See') : l.indexOf('Prove'));
  assert.equal(objectiveColumns[0], objectiveColumns[1], 'objective column aligned');
  assert.ok(!plain(splash).includes('must be truncated for the terminal'), 'long objectives truncated');
  assert.match(plain(splash), /Prove the real loop end to end with a very long…/);
});

test('renderBoard all:true serves the MACHINE board — lens null, workspace filter dropped, the push is the digest\'s', async () => {
  const calls = [];
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  const out = await renderBoard({
    client, identity: IDENTITY, workspace: 'ws-000000000000', all: true,
    digest: digestOf([breach('quiet', 'gone-quiet')]),
  });
  assert.equal(out.lens, null, 'machine scope renders as all workspaces');
  assert.equal(calls[0].params.length, 1, 'no workspace parameter — the folder filter is dropped');
  assert.equal(out.message, '1 gone quiet', 'the founder-worded push (by kind, 2026-08-31) is untouched by scope');
});

test('renderBoard with no digest at all renders the board and stays silent — the hook\'s fail-soft path', async () => {
  const out = await renderBoard({ client: emptyClient, identity: IDENTITY, workspace: 'ws-000000000000' });
  assert.equal(out.message, null);
  assert.doesNotMatch(out.context, /Breached/);
});

test('renderSplash with a SILENT digest is just the scope line — never the word null', () => {
  const splash = renderSplash({ digest: digestOf([]), sections: EMPTY, workspace: 'ws-000000000000' });
  assert.doesNotMatch(plain(splash), /null|undefined/);
  assert.match(plain(splash), /ws-000000000000/);
  assert.doesNotMatch(plain(splash), /YOURS|OPEN|ASSERTED|HELD|BREACHED/);
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
    digest: digestOf([]),
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

test('UX rule 21: a root with spawned work carries ONE counts line on the splash — the board\'s own words', () => {
  const splash = plain(renderSplash({
    digest: digestOf([]),
    sections: {
      mine: [{ task_id: 'root-1', objective: 'fan out', lease_until: '2026-09-02T10:00Z', state: 'active', principal_id: 'founder',
        children: { n: 3, by: { active: 2, settled: 1 }, line: 'spawned 3 — 2 active · 1 settled' } }],
      open: [], asserted: [], held: [],
    },
    workspace: 'ws-0d0a0b0c0d0e',
  }));
  assert.match(splash, /root-1/);
  assert.match(splash, /^\s+↳ spawned 3 — 2 active · 1 settled$/m);
});

test('R-PAGER: the splash carries a BREACHED PROMISES section when breaches exist, and nothing when none', () => {
  const digest = digestOf([
    breach('overdue', 'late-1', { objective: 'asserted, never verified', detail: 'verification overdue since 2026-08-27 10:00' }),
    breach('quiet', 'quiet-1', { objective: 'claimed and abandoned', home: 'homeless', home_ref: null, detail: 'founder holds it, quiet for 72h (last word 2026-08-25 10:00)' }),
  ]);
  const withBreaches = renderSplash({ digest, sections: EMPTY, workspace: 'ws-0d0a0b0c0d0e' });
  assert.match(withBreaches, /BREACHED PROMISES \(all workspaces\)/);
  assert.match(withBreaches, /late-1/);
  assert.match(withBreaches, /quiet-1/);
  assert.match(withBreaches, /never verified: verification overdue since 2026-08-27 10:00/, 'the kind word leads the detail');
  assert.match(withBreaches, /homeless/);
  const without = renderSplash({ digest: digestOf([]), sections: EMPTY, workspace: 'ws-0d0a0b0c0d0e' });
  assert.doesNotMatch(without, /BREACHED/);
});

test('UX rule 18: a digest is a budget, not a wall — 40 breaches are 8 rows and one +32 more naming the pull, on the model channel and the splash alike', async () => {
  const digest = digestOf(Array.from({ length: 40 }, (_, i) => breach('stalled', `verify-${String(i).padStart(2, '0')}`, {
    detail: `engine codex failed: usage limit reached (${i}); retry: /oathe:verify verify-${i} claude`,
    at: `2026-08-27T${String(i % 24).padStart(2, '0')}:00Z`,
  })));
  const { context, message } = await renderBoard({ client: emptyClient, identity: IDENTITY, workspace: 'ws-000000000000', digest });
  assert.equal(message, '40 to fix', 'the push counts the whole machine — the budget is the rows, never the count');
  const section = context.slice(context.indexOf('## Breached promises'));
  assert.equal(section.split('\n').filter((l) => l.startsWith('- [')).length, DIGEST_ROW_CAP, 'eight rows');
  assert.match(section, /^_\+32 more — oathe_board lists every breach on this board; `oathe ls` every one on this machine_$/m);
  assert.ok(Buffer.byteLength(section) < 4096, `the section is a budget: ${Buffer.byteLength(section)} bytes`);
  assert.match(section, /- \[verify-00\] objective of verify-00 — verify failed: engine codex failed/, 'a row reads kind word, then the detail');

  const splash = plain(renderSplash({ digest, sections: EMPTY, workspace: 'ws-000000000000' }));
  const rows = splash.split('\n').filter((l) => /^\s+verify-\d\d\s/.test(l));
  assert.equal(rows.length, DIGEST_ROW_CAP);
  assert.match(splash, /^\s+\+32 more — oathe ls$/m, 'the splash points at the CLI pull');
});

test('UX rule 18: a sibling group is ONE line — the parent, its counts, its spawn count; no child bullets', async () => {
  const digest = digestOf([
    ...Array.from({ length: 19 }, (_, i) => breach('reopened', `draft-${i}`, { parent: 'A', parent_objective: 'fan out' })),
    breach('stalled', 'draft-19', { parent: 'A', parent_objective: 'fan out' }),
  ]);
  const { context } = await renderBoard({ client: emptyClient, identity: IDENTITY, workspace: 'ws-000000000000', digest });
  assert.match(context, /^- \[A\] fan out — 19 rejected · 1 verify failed: 20 spawned \(home: \/srv\/app\)$/m);
  assert.doesNotMatch(context, /draft-/, 'no child has its own row while its parent is in view');
  const splash = plain(renderSplash({ digest, sections: EMPTY, workspace: 'ws-000000000000' }));
  assert.match(splash, /A\s+fan out\s+19 rejected · 1 verify failed: 20 spawned · \/srv\/app/);
});

test('UX rule 18: detail is clipped by the renderer — a 400-character verdict ends at DETAIL_CLIP with an ellipsis; the data stays whole', async () => {
  const verdict = 'x'.repeat(400);
  const digest = digestOf([breach('reopened', 'long-1', { detail: `${verdict} — nobody has reclaimed it (last held by founder)` })]);
  assert.ok(digest.rows[0].detail.includes(verdict), 'the row carries the whole verdict');
  const { context } = await renderBoard({ client: emptyClient, identity: IDENTITY, workspace: 'ws-000000000000', digest });
  const line = context.split('\n').find((l) => l.startsWith('- [long-1]'));
  assert.ok(line.includes(`${'x'.repeat(DETAIL_CLIP - 1)}…`), 'clipped at DETAIL_CLIP');
  assert.ok(!line.includes(verdict), 'never the whole 400');
  const splash = plain(renderSplash({ digest, sections: EMPTY, workspace: 'ws-000000000000' }));
  assert.ok(!splash.includes(verdict));
  assert.match(splash, /…/);
});
