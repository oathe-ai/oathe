// The BreachDigest: the ONE budget over the pager's facts — counts by kind, the push line,
// sibling grouping, the sharpest-first row cap, and the pull pointer — computed once and
// rendered by every surface (SessionStart context, splash, tool attention, oathe ls, the
// glass). Pure and synchronous: facts in, a budget out, nothing written. Every word about a
// breach kind lives in KINDS here; no renderer spells one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BreachDigest, DigestError, KINDS, BUCKET_WORDS, DIGEST_ROW_CAP, DETAIL_CLIP, clipDetail, pullPointer,
} from '../src/breach-digest.mjs';
import { BREACH_KINDS, breachOrder } from '../src/pager.mjs';

const at = (h) => `2026-09-01T${String(h).padStart(2, '0')}:00Z`;
const row = (kind, task_id, extra = {}) => ({
  kind, task_id, objective: `objective of ${task_id}`, home: '/x', home_ref: 'ws-a', detail: `detail of ${task_id}`, at: at(1), ...extra,
});
const digest = (breaches) => new BreachDigest({ breaches });

test('KINDS names every pager kind, in the pager\'s order, each with its word, its bucket, and its act — nothing about a kind is spelled twice', () => {
  assert.deepEqual(Object.keys(KINDS), [...BREACH_KINDS]);
  for (const [kind, spec] of Object.entries(KINDS)) {
    assert.ok(typeof spec.word === 'string' && spec.word, `${kind} has a word`);
    assert.ok(spec.bucket in BUCKET_WORDS, `${kind} buckets into a known push bucket`);
    assert.ok(typeof spec.act === 'string' && spec.act.endsWith('↗'), `${kind} names its one act`);
  }
  assert.deepEqual(KINDS.reopened, { word: 'rejected', bucket: 'fix', act: 'continue ↗' });
  assert.deepEqual(KINDS.stalled, { word: 'verify failed', bucket: 'fix', act: 'retry ↗' });
  assert.deepEqual(KINDS.overdue, { word: 'never verified', bucket: 'verify', act: 'verify ↗' });
  assert.deepEqual(KINDS.quiet, { word: 'quiet', bucket: 'quiet', act: 'continue ↗' });
  assert.deepEqual(BUCKET_WORDS, { fix: 'to fix', verify: 'to verify', quiet: 'gone quiet' });
});

test('a kind the pager never emits is a typed refusal — a digest cannot word what it does not know', () => {
  assert.throws(() => digest([row('lapsed', 'x')]), (e) => e instanceof DigestError && e.code === 'OATHE_DIGEST_KIND_UNKNOWN');
});

test('push: PERSON words, counts by bucket in a fixed order — null when nothing is breached', () => {
  assert.equal(digest([]).push, null);
  const d = digest([
    row('reopened', 'r1'), row('reopened', 'r2'), row('stalled', 's1'),
    row('overdue', 'o1'), row('overdue', 'o2'), row('overdue', 'o3'), row('quiet', 'q1'),
  ]);
  assert.equal(d.push, '3 to fix · 3 to verify · 1 gone quiet');
  assert.equal(digest([row('quiet', 'q1')]).push, '1 gone quiet', 'the lone-quiet wording every existing pin expects');
  assert.equal(digest([row('overdue', 'o1'), row('reopened', 'r1')]).push, '1 to fix · 1 to verify', 'bucket order is fixed, not arrival order');
});

test('counts are by kind and total counts TASKS — children count individually even when their rows fold', () => {
  const d = digest([row('reopened', 'c1', { parent: 'A', parent_objective: 'fan out' }), row('reopened', 'c2', { parent: 'A', parent_objective: 'fan out' }), row('quiet', 'q1')]);
  assert.deepEqual(d.counts, { reopened: 2, stalled: 0, overdue: 0, quiet: 1 });
  assert.equal(d.total, 3);
  assert.equal(d.push, '2 to fix · 1 gone quiet');
});

test('siblings are ONE row: children spawned under one claim fold into a group under their sharpest kind, capped children, the rest counted', () => {
  const children = [
    ...Array.from({ length: 19 }, (_, i) => row('reopened', `draft-${String(i + 1).padStart(2, '0')}`, { parent: 'A', parent_objective: 'fan out', at: at(i + 2) })),
    row('stalled', 'draft-20', { parent: 'A', parent_objective: 'fan out', at: at(1) }),
  ];
  const d = digest([row('quiet', 'lonely'), ...children]);
  assert.equal(d.groups.length, 2, 'one group + one single');
  const group = d.groups[0];
  assert.equal(group.task_id, 'A');
  assert.equal(group.objective, 'fan out');
  assert.equal(group.kind, 'reopened', 'the sharpest kind among the children');
  assert.equal(group.kind_word, '19 rejected · 1 verify failed');
  assert.equal(group.home, '/x');
  assert.equal(group.home_ref, 'ws-a');
  assert.equal(group.at, at(2), 'the oldest child of the group\'s kind — the age a person reads');
  assert.deepEqual(group.group.n, 20);
  assert.deepEqual(group.group.by_kind, { reopened: 19, stalled: 1 });
  assert.deepEqual(group.group.children, ['draft-01', 'draft-02', 'draft-03', 'draft-04', 'draft-05', 'draft-06', 'draft-07', 'draft-08'],
    'the first DIGEST_ROW_CAP children, in breach order');
  assert.equal(group.group.more, 12);
  const lines = group.detail.split('\n');
  assert.equal(lines.length, 9, 'eight child lines and the +N line');
  assert.match(lines[0], /^draft-01 · rejected · detail of draft-01$/);
  assert.equal(lines.at(-1), '+12 more');
  assert.ok(!d.groups.some((g) => g.task_id.startsWith('draft-')), 'no child has its own row while its parent is in view');
});

test('a breached parent with breached children is still one row: the parent\'s own facts lead, the children fold under the sharpest kind', () => {
  const d = digest([
    row('quiet', 'A', { detail: 'founder holds it, quiet for 30h' }),
    row('reopened', 'c1', { parent: 'A', parent_objective: 'fan out' }),
    row('reopened', 'c2', { parent: 'A', parent_objective: 'fan out' }),
  ]);
  assert.equal(d.groups.length, 1);
  const [g] = d.groups;
  assert.equal(g.task_id, 'A');
  assert.equal(g.objective, 'objective of A', 'the parent\'s own objective, not the children\'s copy of it');
  assert.equal(g.kind, 'reopened', 'sharper than the parent\'s own quiet');
  assert.equal(g.kind_word, 'quiet · 2 rejected', 'the parent\'s own state first, then the children');
  assert.equal(g.group.n, 2);
  assert.match(g.detail.split('\n')[0], /^founder holds it, quiet for 30h$/, 'the parent\'s own detail leads the card');
});

test('order after grouping is the pager\'s: a quiet-only group sorts after a single overdue; a stalled-led group after a single reopened', () => {
  const d = digest([
    row('overdue', 'o1', { at: at(5) }),
    row('quiet', 'g1c1', { parent: 'G1', parent_objective: 'g1', at: at(1) }),
    row('stalled', 'g2c1', { parent: 'G2', parent_objective: 'g2', at: at(1) }),
    row('reopened', 'r1', { at: at(9) }),
  ]);
  assert.deepEqual(d.groups.map((g) => g.task_id), ['r1', 'G2', 'o1', 'G1']);
  assert.deepEqual(d.groups, [...d.groups].sort(breachOrder), 'breachOrder is the order — the digest never re-derives it');
});

test('the row cap: rows are the first DIGEST_ROW_CAP groups, more is the rest — groups stay uncapped for the pull surfaces', () => {
  assert.equal(DIGEST_ROW_CAP, 8);
  const twelve = digest(Array.from({ length: 12 }, (_, i) => row('overdue', `o${i}`, { at: at(i + 1) })));
  assert.equal(twelve.rows.length, 8);
  assert.equal(twelve.more, 4);
  assert.equal(twelve.groups.length, 12);
  assert.deepEqual(twelve.rows.map((r) => r.task_id), twelve.groups.slice(0, 8).map((r) => r.task_id), 'the first eight in order');
  const eight = digest(Array.from({ length: 8 }, (_, i) => row('overdue', `o${i}`)));
  assert.equal(eight.more, 0);
  assert.equal(digest([]).more, 0);
});

test('scoped(homeRef) is a new digest over this board\'s facts only — push, counts, rows, more all recomputed; scoped(null) is the whole machine', () => {
  const d = digest([
    row('reopened', 'a1', { home_ref: 'ws-a' }), row('reopened', 'b1', { home_ref: 'ws-b' }), row('quiet', 'a2', { home_ref: 'ws-a' }),
    row('reopened', 'c1', { home_ref: 'ws-a', parent: 'P', parent_objective: 'p' }),
  ]);
  const a = d.scoped('ws-a');
  assert.deepEqual(a.groups.map((g) => g.task_id), ['a1', 'P', 'a2']);
  assert.equal(a.push, '2 to fix · 1 gone quiet');
  assert.equal(a.total, 3);
  assert.equal(d.scoped(null), d, 'the whole machine is the digest itself');
  assert.equal(d.total, 4, 'the original is untouched');
});

test('filter(fn) keeps the groups a surface wants — the attention channel takes the fix bucket only', () => {
  const d = digest([row('reopened', 'r1'), row('stalled', 's1'), row('overdue', 'o1'), row('quiet', 'q1')]);
  const fix = d.filter((g) => KINDS[g.kind].bucket === 'fix');
  assert.deepEqual(fix.groups.map((g) => g.task_id), ['r1', 's1']);
  assert.equal(fix.push, '2 to fix');
  assert.equal(fix.more, 0);
});

test('clipDetail is the renderer\'s clip: the data stays whole, a rendered detail ends at DETAIL_CLIP with an ellipsis', () => {
  assert.equal(DETAIL_CLIP, 160);
  const long = clipDetail('x'.repeat(400));
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('…'));
  assert.equal(clipDetail('y'.repeat(100)), 'y'.repeat(100));
});

test('singles carry their kind word — the glass and the board read it, never compose it', () => {
  const d = digest([row('reopened', 'r1'), row('stalled', 's1'), row('overdue', 'o1'), row('quiet', 'q1')]);
  assert.deepEqual(d.groups.map((g) => g.kind_word), ['rejected', 'verify failed', 'never verified', 'quiet']);
  assert.ok(d.groups.every((g) => g.group === null), 'a single is not a group');
});

test('pullPointer words the +N more line per channel — one site, three channels, null when nothing is beyond the budget', () => {
  assert.equal(pullPointer('context', 32), '+32 more — oathe_board lists every breach on this board; `oathe ls` every one on this machine');
  assert.equal(pullPointer('splash', 32), '+32 more — oathe ls');
  assert.equal(pullPointer('attention', 4), '+4 more — oathe_board lists every breach on this board');
  assert.equal(pullPointer('context', 0), null);
  assert.throws(() => pullPointer('glass', 1), (e) => e instanceof DigestError && e.code === 'OATHE_DIGEST_CHANNEL_UNKNOWN',
    'the glass gets a number, never a sentence — an unknown channel is a refusal, not a guess');
});
