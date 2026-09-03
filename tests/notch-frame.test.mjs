// The glass plays the frame (UX rule 21): every word the notch shows — kind words, act
// words, the children line, the +N more number — rides from Node; the glass reads no config
// and composes no sentence. This test reads the Swift decoder's own source (Feed.swift) and
// holds a frame built from literal facts to it: every field the glass requires is present
// with the type it decodes, at every nesting. A Swift field renamed without the frame, or a
// frame key the glass never decodes, fails here — not on a person's screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NotchFrame } from '../src/notch-frame.mjs';
import { BreachDigest, DIGEST_ROW_CAP, KINDS } from '../src/breach-digest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swift = (file) => fs.readFileSync(path.join(root, 'notch/Sources/OatheNotch', file), 'utf8');

/** Feed.swift's Decodable structs: name → [{field, type, optional}] — the contract, from the source. */
function decodables(source) {
  const structs = {};
  let current = null;
  for (const line of source.split('\n')) {
    const open = line.match(/^struct (\w+): Decodable \{/);
    if (open) { current = open[1]; structs[current] = []; continue; }
    if (line === '}') { current = null; continue; }
    const field = current && line.match(/^\s+let (\w+): ([[\]\w]+?)(\?)?(?:\s|$)/);
    if (field) structs[current].push({ field: field[1], type: field[2], optional: field[3] === '?' });
  }
  return structs;
}

function check(structs, type, value, where) {
  const array = type.match(/^\[(\w+)\]$/);
  if (array) {
    assert.ok(Array.isArray(value), `${where}: the glass decodes an array`);
    value.forEach((item, i) => check(structs, array[1], item, `${where}[${i}]`));
  } else if (type === 'String') assert.equal(typeof value, 'string', `${where}: a string`);
  else if (type === 'Bool') assert.equal(typeof value, 'boolean', `${where}: a boolean`);
  else if (type === 'Int' || type === 'Int32') assert.ok(Number.isInteger(value), `${where}: an integer`);
  else conforms(structs, type, value, where);
}

function conforms(structs, name, value, where) {
  assert.ok(structs[name], `${where}: Feed.swift declares ${name}`);
  assert.ok(value && typeof value === 'object', `${where}: an object`);
  for (const { field, type, optional } of structs[name]) {
    if (value[field] === undefined || value[field] === null) {
      assert.ok(optional, `${where}.${field}: the glass requires it, the frame lacks it`);
      continue;
    }
    check(structs, type, value[field], `${where}.${field}`);
  }
}

const NOW = Date.now();
const stamp = (ms) => new Date(ms).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z');
const breach = (kind, task_id, extra = {}) => ({
  kind, task_id, objective: `objective of ${task_id}`, home: '/srv/app', home_ref: 'ws-a',
  detail: `detail of ${task_id}`, at: stamp(NOW - 3_600_000), ...extra,
});
const work = (task_id, extra = {}) => ({
  task_id, objective: `objective of ${task_id}`, state: 'active', principal_id: 'founder', home: 'ws-a',
  lease_until: '2026-09-02T10:00Z', last_progress: null, last_progress_at: null,
  last_word_at: stamp(NOW - 30_000), trace_path: null, trace_session_id: null, ...extra,
});

function facts() {
  const digest = new BreachDigest({
    breaches: [
      breach('reopened', 'r1'), breach('stalled', 's1'), breach('overdue', 'o1'), breach('quiet', 'q1'),
      ...[0, 1, 2].map((i) => breach('stalled', `c${i}`, { parent: 'P', parent_objective: 'fan out', at: stamp(NOW - (3 - i) * 3_600_000) })),
      ...[0, 1].map((i) => breach('reopened', `d${i}`, { parent: 'Q', parent_objective: 'fan again' })),
      ...[0, 1, 2, 3, 4, 5].map((i) => breach('quiet', `x${i}`)),
    ],
  });
  const sections = {
    mine: [work('m1', { trace_session_id: 'sess-1' }), work('m2', { last_word_at: stamp(NOW - 86_400_000) })],
    open: [{ task_id: 'open-1', objective: 'claimable', state: 'yielded', principal_id: null }],
    asserted: [],
    held: [work('h1', { principal_id: 'athena' })],
  };
  const frame = new NotchFrame({
    registry: { rootOf: (ref) => (ref === 'ws-a' ? '/srv/app' : null) },
    sessions: () => ({ 'sess-1': { pid: process.pid, ancestry: [], app: { pid: process.pid, bundle: '/Applications/iTerm.app' }, transcript_path: null } }),
    defaultAgent: 'claude',
    motionWindowMs: 600_000, // the board stamps last words to the minute — a 30s-old word can read 89s old
    operatorHome: '/Users/someone',
  });
  return { digest, sections, frame: frame.build({ digest, sections }) };
}

test('the frame conforms to Feed.swift: every field the glass requires is present with the type it decodes, at every nesting', () => {
  const structs = decodables(swift('Feed.swift'));
  assert.ok(Object.keys(structs).length >= 8, `Feed.swift declares its decoders (${Object.keys(structs).join(', ')})`);
  const { frame } = facts();
  conforms(structs, 'Frame', frame, 'frame');
  const declared = new Set(structs.Frame.map((f) => f.field));
  for (const key of Object.keys(frame)) assert.ok(declared.has(key), `frame.${key}: the glass decodes it (a key nobody reads is a wall)`);
  assert.ok(!declared.has('push'), 'the bar is color and a count — no push line rides the frame');
  assert.ok(declared.has('more'), 'the glass decodes the count beyond the budget');
});

test('the frame is the digest\'s budget: the rows, the more count, no push — every breach carries its kind word and its act word', () => {
  const { digest, frame } = facts();
  assert.ok(!('push' in frame));
  assert.equal(frame.more, digest.more);
  assert.equal(frame.breaches.length, DIGEST_ROW_CAP);
  assert.deepEqual(frame.breaches.map((b) => b.task_id), digest.rows.map((r) => r.task_id), 'the digest\'s order, never re-derived');
  for (const b of frame.breaches) {
    assert.equal(b.kind_word, digest.rows.find((r) => r.task_id === b.task_id).kind_word);
    assert.equal(b.act.word, KINDS[b.kind].act, `${b.task_id}: the act word is the one table's`);
    assert.equal(typeof b.objective, 'string');
  }
});

test('acts: never-judged and engine-failed verify, detached; judged-rejected and quiet continue — a group targets its parent, or its oldest child for a verify', () => {
  const { frame } = facts();
  const by = Object.fromEntries(frame.breaches.map((b) => [b.task_id, b]));
  assert.deepEqual([by.o1.act.kind, by.o1.act.command], ['spawn-terminal', "oathe verify --detach 'o1'"]);
  assert.deepEqual([by.s1.act.kind, by.s1.act.command], ['spawn-terminal', "oathe verify --detach 's1'"]);
  assert.deepEqual([by.r1.act.kind, by.r1.act.command, by.r1.act.cwd], ['spawn-terminal', "oathe claude 'continue r1'", '/srv/app']);
  assert.deepEqual([by.q1.act.kind, by.q1.act.command], ['spawn-terminal', "oathe claude 'continue q1'"]);
  assert.equal(by.P.act.command, "oathe verify --detach 'c0'", 'a verify-led group retries its oldest child');
  assert.equal(by.Q.act.command, "oathe claude 'continue Q'", 'a rejected group continues at the parent');
  assert.equal(by.P.kind_word, '3 verify failed');
});

test('work rows carry what the card says: the objective, the children line, and the resumption with its word', () => {
  const { frame } = facts();
  assert.deepEqual(frame.motion.map((r) => r.task_id), ['m1', 'h1'], 'motion = anyone\'s active claim with a recent word');
  assert.deepEqual(frame.idle.map((r) => r.task_id), ['m2'], 'idle = your held claims gone quiet');
  for (const row of [...frame.motion, ...frame.idle]) {
    assert.equal(row.objective, `objective of ${row.task_id}`);
    assert.ok('children_line' in row, 'the children line rides (null until the claim spawns)');
    assert.equal(row.resume.word, KINDS.quiet.act, 'the resumption\'s word is the continue word, from Node');
  }
  const live = frame.motion.find((r) => r.task_id === 'm1');
  assert.equal(live.resume.kind, 'activate', 'a living session is switched to');
  assert.equal(live.session.alive, true);
});

test('the wire\'s word is liveness: a task heard on the wire is in motion until the window passes', () => {
  const { digest, sections } = facts();
  const frame = new NotchFrame({ registry: { rootOf: () => null }, sessions: () => ({}), defaultAgent: null, motionWindowMs: 60_000, operatorHome: '/Users/someone' });
  assert.ok(!frame.build({ digest, sections }).motion.some((r) => r.task_id === 'm2'));
  frame.hear('m2', { at: Date.now(), via: 'codex', app: null });
  const heard = frame.build({ digest, sections }).motion.find((r) => r.task_id === 'm2');
  assert.ok(heard, 'heard → moving');
  assert.equal(heard.surface, 'codex', 'the wire\'s live word names the surface');
});

test('the glass and the digest agree on the budget, and the README names every frame key', () => {
  assert.match(swift('Theme.swift'), new RegExp(`static let rowCap = ${DIGEST_ROW_CAP}\\b`), 'Theme.swift rowCap is the digest\'s cap');
  const readme = fs.readFileSync(path.join(root, 'notch/README.md'), 'utf8');
  for (const key of ['breaches', 'more', 'motion', 'idle', 'sections', 'default_agent', 'notice', 'welcome']) {
    assert.ok(readme.includes(`${key}`), `README names frame key ${key}`);
  }
  assert.doesNotMatch(readme, /\*\*event\*\*|receipt\?|\bpush\b/, 'no dead state, no dead key');
  assert.equal((readme.match(/^## License/gm) ?? []).length, 1, 'one License section');
});
