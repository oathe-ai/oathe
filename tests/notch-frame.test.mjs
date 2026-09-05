// The glass plays the frame (UX rule 20): every word the notch shows — kind words, act
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
import { BreachDigest, DIGEST_ROW_CAP, KINDS, CONTINUE_ACT, BUSY, JUDGMENT } from '../src/breach-digest.mjs';

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
      breach('stalled', 'b1', { busy: true, at: stamp(NOW - 30_000) }), // a retry in flight
      ...[0, 1, 2].map((i) => breach('stalled', `c${i}`, { parent: 'P', parent_objective: 'fan out', at: stamp(NOW - (3 - i) * 3_600_000) })),
      ...[0, 1].map((i) => breach('reopened', `d${i}`, { parent: 'Q', parent_objective: 'fan again' })),
      ...[0, 1, 2, 3, 4, 5].map((i) => breach('quiet', `x${i}`)),
    ],
  });
  const sections = {
    mine: [work('m1', { trace_session_id: 'sess-1' }), work('m2', { last_word_at: stamp(NOW - 86_400_000) })],
    open: [{ task_id: 'open-1', objective: 'claimable', state: 'yielded', principal_id: null }],
    asserted: [
      work('a1', { state: 'completion_asserted', judgment: 'verifying' }), // a judge holds it
      work('a2', { state: 'completion_asserted', judgment: 'awaiting', last_word_at: stamp(NOW - 86_400_000) }), // nobody has taken the verify task yet
      work('r1', { state: 'completion_asserted', judgment: 'awaiting' }), // breached (rejected) — the breach row is its one row
      work('verify:a9', { state: 'completion_asserted', judgment: 'awaiting', principal_id: 'oathe-verifier' }), // the judge's own assertion — never a row
    ],
    held: [work('h1', { principal_id: 'athena' }), work('verify:h1', { principal_id: 'oathe-verifier' })], // the judge's own claim — never a row
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
    assert.equal(typeof b.objective, 'string');
    if (b.busy) { assert.equal(b.act, null, `${b.task_id}: verifying — the glass offers no act it would refuse`); continue; }
    assert.equal(b.act.word, KINDS[b.kind].act, `${b.task_id}: the act word is the one table's`);
  }
});

test('acts: never-judged and engine-failed DISPATCH the judgment headless — no terminal; judged-rejected and quiet continue in one — a group targets its parent, or its oldest idle child for a verify', () => {
  const { frame } = facts();
  const by = Object.fromEntries(frame.breaches.map((b) => [b.task_id, b]));
  assert.equal(by.b1.busy, true, 'a retry in flight rides the frame as busy');
  assert.equal(by.b1.kind_word, 'verifying');
  assert.equal(by.b1.act, null);
  // A judgment needs no terminal (ruling 2026-09-04): the act names the task; the feed
  // dispatches it through the one dispatcher and answers with the busy frame. The command
  // rides for the clipboard — the terminal form of the same act, for a person who wants it.
  assert.deepEqual([by.o1.act.kind, by.o1.act.task_id, by.o1.act.command, by.o1.act.cwd],
    ['dispatch', 'o1', `"/Users/someone/.oathe/bin/oathe" verify --detach 'o1'`, '/srv/app']);
  assert.deepEqual([by.s1.act.kind, by.s1.act.task_id], ['dispatch', 's1']);
  assert.equal(by.s1.act.terminal_bundle, undefined, 'no terminal rides a dispatch');
  assert.deepEqual([by.r1.act.kind, by.r1.act.command, by.r1.act.cwd], ['spawn-terminal', `"/Users/someone/.oathe/bin/oathe" claude 'continue r1'`, '/srv/app']);
  assert.deepEqual([by.q1.act.kind, by.q1.act.command], ['spawn-terminal', `"/Users/someone/.oathe/bin/oathe" claude 'continue q1'`]);
  assert.deepEqual([by.P.act.kind, by.P.act.task_id], ['dispatch', 'c0'], 'a verify-led group dispatches its oldest idle child');
  assert.equal(by.Q.act.command, `"/Users/someone/.oathe/bin/oathe" claude 'continue Q'`, 'a rejected group continues at the parent');
  assert.equal(by.P.kind_word, '3 verify failed');
});

test('the glass can speak an act UP the feed: Feed.swift declares send, and the dispatch branch writes the one request line — {"act":"verify",task_id,cwd}', () => {
  const feed = swift('Feed.swift');
  assert.match(feed, /func send\(_ line: String\)/, 'FeedClient declares the upward line');
  const model = swift('NotchModel.swift');
  assert.match(model, /case "dispatch":/, 'the act switch executes a dispatch');
  assert.match(model, /"act": "verify"/, 'the request names the act');
  assert.match(model, /"task_id"/, 'and the task');
  assert.doesNotMatch(model.split('case "dispatch":')[1].split('case ')[0], /spawnTerminal|resume\.command/,
    'a dispatch opens no terminal and writes no resume.command');
});

test('work rows carry what the card says: the objective, the children line, and the resumption with its word', () => {
  const { frame } = facts();
  assert.deepEqual(frame.motion.map((r) => r.task_id), ['m1', 'h1'], 'motion = anyone\'s active claim with a recent word — never the judge\'s verify: claim (one row per task)');
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

test('no dead-end rows (ruling 2026-09-04): a homeless rejected task heard from a living app resumes INTO it; unheard, the clipboard is the act — an act either way, and the glass buttons every act', () => {
  const digest = new BreachDigest({ breaches: [breach('reopened', 'hz', { home: 'homeless', home_ref: null })] });
  const frame = new NotchFrame({ registry: { rootOf: () => null }, sessions: () => ({}), defaultAgent: 'claude', motionWindowMs: 600_000, operatorHome: '/Users/someone' });
  const sections = { mine: [], open: [], asserted: [], held: [] };
  const cold = frame.build({ digest, sections }).breaches.find((b) => b.task_id === 'hz');
  assert.deepEqual(cold.act, { kind: 'copy-only', word: CONTINUE_ACT }, 'homeless, unheard: the clipboard is the act — never nothing');
  frame.hear('hz', { at: Date.now(), via: 'codex', app: { pid: process.pid, bundle: '/Applications/ChatGPT.app' } });
  const warm = frame.build({ digest, sections }).breaches.find((b) => b.task_id === 'hz');
  assert.deepEqual(warm.act, { kind: 'activate', app_pid: process.pid, bundle: '/Applications/ChatGPT.app', word: CONTINUE_ACT },
    'heard from a living app (ChatGPT\'s embedded codex — no hooks, no registry row): continue switches to it, the ladder a moving row already climbs');
  // The glass buttons every act the package decides — hiding one kind was the dead end.
  assert.match(swift('NotchView.swift'), /actFor: breach\.act != nil \? breach\.task_id : nil/, 'NotchView gates the button on the act\'s presence, never its kind');
  assert.doesNotMatch(swift('NotchView.swift'), /\["spawn-terminal", "dispatch"\]\.contains/, 'no kind list in the glass');
});

test('UX rule 22 on WORK rows: an asserted claim is never invisible — `judged` carries it with the judgment it awaits (verifying + busy while a judge holds it; awaiting otherwise), no act, uncounted; a breached task keeps its one breach row', () => {
  const { frame } = facts();
  assert.deepEqual(frame.judged.map((r) => [r.task_id, r.judgment, r.busy]),
    [['a1', BUSY.word, true], ['a2', JUDGMENT.awaiting.word, false]],
    'the words are the one table\'s (JUDGMENT beside BUSY); the spinner rides `busy`, the same key a breach spins on');
  assert.equal(JUDGMENT.verifying.word, BUSY.word, 'verifying is spelled ONCE — a breach in flight and a claim under judgment read the same word');
  for (const row of frame.judged) {
    assert.equal(row.state, 'completion_asserted');
    assert.equal(row.holder, 'founder', 'the asserter stays the holder on the card');
    assert.equal(row.resume, null, 'no act: nothing a person does moves a judgment (the fork lands in the asserter\'s session)');
    assert.equal(typeof row.objective, 'string');
  }
  assert.ok(!frame.judged.some((r) => r.task_id === 'r1'), 'R-GROUP-ROWS: a breached task is its breach row, never a second row');
  assert.ok(!frame.judged.some((r) => r.task_id.startsWith('verify:')), 'the judge\'s own assertion is never a row');
  assert.ok(!frame.motion.some((r) => r.judgment) && !frame.idle.some((r) => r.judgment), 'judgment rows live in their own key — motion and idle stay active claims');
  // The glass decodes the two fields on the same row type and spins a WORK row on `busy`.
  const structs = decodables(swift('Feed.swift'));
  const motionRow = Object.fromEntries(structs.MotionRow.map((f) => [f.field, f]));
  assert.deepEqual([motionRow.judgment?.type, motionRow.judgment?.optional], ['String', true], 'MotionRow.judgment: String?');
  assert.deepEqual([motionRow.busy?.type, motionRow.busy?.optional], ['Bool', true], 'MotionRow.busy: Bool?');
  assert.ok(structs.Frame.some((f) => f.field === 'judged' && f.type === '[MotionRow]'), 'Frame.judged: [MotionRow]');
  assert.match(swift('NotchModel.swift'), /frame\.judged/, 'the model lists judged rows in the sheet');
  assert.match(swift('NotchView.swift'), /case \.work\(let row\):[\s\S]{0,400}busy: row\.busy/, 'a work row spins on busy exactly as a breach row does');
});

test('the glass and the digest agree on the budget, and the README names every frame key', () => {
  assert.match(swift('Theme.swift'), new RegExp(`static let rowCap = ${DIGEST_ROW_CAP}\\b`), 'Theme.swift rowCap is the digest\'s cap');
  const readme = fs.readFileSync(path.join(root, 'notch/README.md'), 'utf8');
  for (const key of ['breaches', 'more', 'motion', 'judged', 'idle', 'sections', 'default_agent', 'notice', 'welcome']) {
    assert.ok(readme.includes(`${key}`), `README names frame key ${key}`);
  }
  assert.doesNotMatch(readme, /\*\*event\*\*|receipt\?|\bpush\b/, 'no dead state, no dead key');
  assert.equal((readme.match(/^## License/gm) ?? []).length, 1, 'one License section');
});
