// oathe init as data: the SetupPlan derives what is asked from the census and each adapter's own
// description of its writes; the SetupPrompter renders it as one explained yes/no per harness and
// the verifier by name. These tests are the UX contract for the questions (docs/UX.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { SetupPlan, SetupPrompter, OatheInitError } from '../src/setup.mjs';
import { buildContext } from '../src/context.mjs';
import { census, detectOnlySurfaces } from '../src/harnesses/catalog.mjs';
import { OatheConfig } from '../src/config.mjs';

/** A machine: which config homes exist and which CLIs are on PATH — nothing from the real PATH. */
function machine({ homes = ['.claude', '.codex', '.cursor'], bins = ['claude', 'codex', 'cursor-agent'] } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-setup-')));
  for (const d of homes) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.mkdirSync(path.join(home, 'bin'));
  for (const b of [...bins, 'oathe']) { fs.writeFileSync(path.join(home, 'bin', b), '#!/bin/sh\n'); fs.chmodSync(path.join(home, 'bin', b), 0o755); }
  const env = { HOME: home, OATHE_HOME: path.join(home, '.oathe'), PATH: `${path.join(home, 'bin')}:${path.dirname(process.execPath)}` };
  return { home, env };
}

async function planFor({ home, env }, { fallbackVerifier = 'claude', wiredNow = new Set() } = {}) {
  const ctx = buildContext({ env });
  await ctx.substrate.close();
  const adapters = ctx.harnesses.filter((h) => h.constructor.wiring !== null);
  const seen = census(adapters);
  const machineConfig = OatheConfig.global({ env });
  return { plan: SetupPlan.from({ adapters, census: seen, surfaces: detectOnlySurfaces({ home }), machine: machineConfig, home, paths: ctx.paths, fallbackVerifier, wiredNow }), adapters, seen };
}

test('SetupPlan.from: one step per wiring adapter, writes from describe(), not-installed steps already answered, verifier candidates need the CLI, surfaces detected only', async () => {
  const m = machine({ homes: ['.claude', '.cursor'], bins: ['claude', 'cursor-agent'] }); // no Codex at all
  const { plan, adapters } = await planFor(m);
  assert.deepEqual(plan.steps.map((s) => s.name), adapters.map((a) => a.name));
  for (const step of plan.steps) {
    const adapter = adapters.find((a) => a.name === step.name);
    assert.deepEqual(step.writes, adapter.describe(), `${step.name}: what yes writes comes from the adapter`);
    assert.equal(step.displayName, adapter.constructor.displayName);
  }
  const codex = plan.steps.find((s) => s.name === 'codex');
  assert.equal(codex.installed, false);
  assert.equal(codex.selected, false, 'a harness that is not here is not a question');
  assert.equal(codex.reason, 'not-installed');
  assert.equal(plan.steps.find((s) => s.name === 'claude').selected, null, 'an installed harness is unanswered until asked');
  assert.deepEqual(plan.verifier.candidates, ['claude', 'cursor'], 'headless-capable AND the CLI is present');
  assert.equal(plan.verifier.default, 'claude');
  assert.equal(plan.verifier.alreadyChosen, null);
  assert.equal(plan.verifier.chosen, null);
  assert.deepEqual(plan.agent.candidates, ['claude', 'cursor'], 'launchable AND installed — codex is not here, cursor IS');
  assert.equal(plan.agent.default, 'claude');
  assert.equal(plan.agent.alreadyChosen, null);
  assert.equal(plan.agent.chosen, null, 'the default agent is a real question, asked before the verifier');
  assert.ok(plan.surfaces.every((s) => s.detected === true && typeof s.note === 'string' && s.note.length > 0));
  assert.equal(plan.answered, false);
});

test('narrow(--harness): unknown names refuse (OATHE_INIT_HARNESS_UNKNOWN), a named harness that is not here refuses (OATHE_INIT_HARNESS_ABSENT) — nothing is silently dropped', async () => {
  const m = machine({ homes: ['.claude', '.cursor'], bins: ['claude', 'cursor-agent'] });
  const { plan } = await planFor(m);
  assert.throws(() => plan.narrow(['vscode']), (e) => e instanceof OatheInitError && e.code === 'OATHE_INIT_HARNESS_UNKNOWN' && /vscode/.test(e.message));
  assert.throws(() => plan.narrow(['cowork']), (e) => e.code === 'OATHE_INIT_HARNESS_UNKNOWN', 'a detect-only surface is not something init wires');
  assert.throws(() => plan.narrow(['codex']), (e) => e.code === 'OATHE_INIT_HARNESS_ABSENT' && /codex/.test(e.message) && /not (found|installed)/.test(e.message));
  plan.narrow(['cursor']);
  assert.deepEqual(plan.wired, ['cursor']);
  assert.equal(plan.steps.find((s) => s.name === 'claude').reason, 'harness-filter');
});

test('applyDefaults: every installed harness yes, the verifier its default, the reason kept — and announceLines say exactly what was applied', async () => {
  const m = machine();
  const { plan } = await planFor(m);
  plan.applyDefaults('no-tty');
  assert.deepEqual(plan.wired, ['claude', 'codex', 'cursor']);
  assert.equal(plan.verifier.chosen, 'claude');
  assert.equal(plan.verifier.asked, false);
  assert.equal(plan.agent.chosen, 'claude', 'defaults answer the agent question too');
  assert.equal(plan.defaultsReason, 'no-tty');
  assert.equal(plan.answered, true);
  const lines = plan.announceLines().join('\n');
  assert.match(lines, /wire: claude, codex, cursor/);
  assert.match(lines, /default agent: claude/);
  assert.match(lines, /verifier: claude/);
  const m2 = machine({ homes: ['.claude'], bins: ['claude'] });
  const { plan: p2 } = await planFor(m2);
  p2.applyDefaults('assume-yes');
  assert.match(p2.announceLines().join('\n'), /skip: codex, cursor \(not installed\)/);
});

test('outcomes: the plan plus what landed — a wired step lists the files its actions touched, a skipped step says why, no machine tokens', async () => {
  const m = machine({ homes: ['.claude', '.cursor'], bins: ['claude', 'cursor-agent'] });
  const { plan } = await planFor(m);
  plan.narrow(['cursor']);
  plan.applyDefaults('harness-filter');
  const actions = [
    { harness: 'cursor', action: 'mcp-entry', file: path.join(m.home, '.cursor/mcp.json'), changed: true },
    { harness: 'cursor', action: 'hooks-entry', file: path.join(m.home, '.cursor/hooks.json'), changed: true },
  ];
  const outcomes = plan.outcomes(actions);
  assert.deepEqual(outcomes.map((o) => [o.name, o.outcome]), [['claude', 'skipped'], ['codex', 'skipped'], ['cursor', 'wired']]);
  assert.deepEqual(outcomes.find((o) => o.name === 'cursor').landed, ['~/.cursor/mcp.json', '~/.cursor/hooks.json']);
  assert.match(outcomes.find((o) => o.name === 'claude').reason, /--harness/);
  assert.match(outcomes.find((o) => o.name === 'codex').reason, /not installed/);
  assert.ok(outcomes.every((o) => !/skipped-not|assume-yes|no-tty|harness-filter/.test(o.reason)), 'reasons are sentences, not tokens');
});

// ---------------------------------------------------------------- the checklist screen
const KEY = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', space: ' ', enter: '\r', ctrlC: '\x03', esc: '\x1b' };
const plain = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** A fake raw-mode TTY: keys arrive as 'data' chunks; the screen is everything written, ANSI stripped. */
function screenTty() {
  const writes = [];
  const out = Object.assign(new EventEmitter(), { isTTY: true, columns: 400, write: (t) => { writes.push(t); return true; } }); // wide: long describe() lines truncate legitimately on narrow terminals
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, raw: null, setRawMode(v) { this.raw = v; }, pause: () => {}, resume: () => {} });
  const shown = () => plain(writes.join(''));
  const whenLegend = () => new Promise((resolve) => { const t = setInterval(() => { if (/enter install/.test(shown())) { clearInterval(t); resolve(); } }, 5); });
  return { stdin, out, shown, whenLegend, press: (...keys) => { for (const k of keys) stdin.emit('data', k); } };
}

async function askWithKeys(plan, keys, { chunked = false } = {}) {
  const tty = screenTty();
  const asking = new SetupPrompter({ stdin: tty.stdin, out: tty.out }).ask(plan);
  await tty.whenLegend();
  if (chunked) tty.stdin.emit('data', keys.join('')); else tty.press(...keys);
  await asking;
  return tty;
}

test('ONE screen: every detected harness pre-selected with its presence and writes on the row, the verifier as a radio row, Enter installs the selection', async () => {
  const m = machine();
  const { plan } = await planFor(m);
  const tty = await askWithKeys(plan, [KEY.enter]);
  const text = tty.shown();
  assert.equal(tty.stdin.raw, false, 'raw mode was turned on for the keys and off again');
  for (const step of plan.steps) assert.match(text, new RegExp(`\\[x\\] ${step.displayName}`), `${step.name} is listed and pre-selected`);
  assert.match(text, /\[x\] Claude Code\s+\(CLI\)/, 'the row states what the wiring covers, nothing else');
  assert.match(text, /\[x\] Codex\s+\(CLI\/Desktop App\)/);
  assert.match(text, /\[x\] Cursor\s+\(CLI\/Desktop App\)/);
  assert.ok(!/\[x\] Codex[^\n]*→/.test(text), 'no write-paths on the row — they live under the highlight');
  assert.match(text, /~\/\.claude\/settings\.json/, "the highlighted row's writes appear below it");
  assert.match(text, /↑↓ move · space toggle · enter install/);
  assert.match(text, /oathe init — reversible \(oathe uninstall\)/, 'the opening is one short line');
  assert.ok(!/recorded and reversible|machine setup/.test(text), 'the long opening sentence is gone');
  assert.match(text, /verifier.*\(•\) claude.*\( \) codex.*\( \) cursor/, 'the verifier is a radio row with the default marked');
  assert.match(text, /default agent.*\(•\) claude.*\( \) codex.*\( \) cursor/, 'ALL harnesses ride the same primitive — the agent radio lists every installed one');
  assert.ok(text.indexOf('default agent') < text.indexOf('verifier'), 'the agent question comes ABOVE the verifier (founder ruling)');
  assert.equal(plan.agent.chosen, 'claude');
  assert.equal(plan.agent.asked, true);
  assert.doesNotMatch(text, /\[\d+\]/, 'no numbered menu');
  assert.doesNotMatch(text, /\[Y\/n\]/, 'no question-by-question conversation');
  assert.doesNotMatch(text, /\/Users\/|\/private\/|\/tmp\//, 'paths under ~');
  assert.deepEqual(plan.wired, ['claude', 'codex', 'cursor']);
  assert.equal(plan.verifier.chosen, 'claude');
  assert.equal(plan.verifier.asked, true);
  assert.equal(plan.answered, true);
});

test('space toggles the highlighted harness, ← → choose the verifier; the highlighted row shows its full write list', async () => {
  const m = machine();
  const { plan } = await planFor(m);
  // down → codex; space → off; down → cursor; down → agent row; down → verifier row; right, right → cursor; enter
  const tty = await askWithKeys(plan, [KEY.down, KEY.space, KEY.down, KEY.down, KEY.down, KEY.right, KEY.right, KEY.enter]);
  assert.deepEqual(plan.wired, ['claude', 'cursor']);
  assert.equal(plan.step('codex').selected, false);
  assert.equal(plan.step('codex').reason, 'answered');
  assert.equal(plan.verifier.chosen, 'cursor');
  const text = tty.shown();
  assert.match(text, /\[ \] Codex/, 'the toggled row renders unselected');
  for (const line of plan.step('codex').writes) assert.ok(text.includes(line.replaceAll(m.home, '~')), `the highlighted row explained its writes: ${line.slice(0, 40)}`);
});

test('no rendered line exceeds the terminal width — a wrapped line would break the redraw and stack duplicate screens', async () => {
  const m = machine();
  const { plan } = await planFor(m);
  const writes = [];
  const out = Object.assign(new EventEmitter(), { isTTY: true, columns: 60, write: (x) => { writes.push(x); return true; } });
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, raw: null, setRawMode(v) { this.raw = v; }, pause: () => {}, resume: () => {} });
  const asking = new SetupPrompter({ stdin, out }).ask(plan);
  await new Promise((r) => setTimeout(r, 30));
  stdin.emit('data', '\x1b[B'); // one redraw too
  stdin.emit('data', '\r');
  await asking;
  for (const line of plain(writes.join('')).split('\n')) {
    assert.ok(line.length <= 60, `line wider than the terminal (${line.length}): ${line.slice(0, 70)}`);
  }
});

test('a chunk of several keys is taken key by key — a pasted sequence works', async () => {
  const m = machine();
  const { plan } = await planFor(m);
  await askWithKeys(plan, [KEY.down, KEY.space, KEY.enter], { chunked: true });
  assert.deepEqual(plan.wired, ['claude', 'cursor']);
});

test('a harness that is not here, a --harness-decided step, and a detect-only surface are dim fixed rows — never toggleable', async () => {
  const m = machine({ homes: ['.claude', '.cursor'], bins: ['claude', 'cursor-agent'] });
  const { plan } = await planFor(m);
  const tty = await askWithKeys(plan, [KEY.down, KEY.space, KEY.enter]); // down lands on cursor (codex is not a row you can reach)
  const text = tty.shown();
  assert.match(text, /Codex.*not found \(no codex on PATH, no ~\/\.codex\)/);
  assert.doesNotMatch(text, /\[[x ]\] Codex/, 'no checkbox for a harness that is not here');
  for (const s of plan.surfaces) assert.match(text, new RegExp(`${s.displayName}.*detected — nothing to wire`));
  assert.deepEqual(plan.wired, ['claude'], 'space toggled cursor, the next reachable row');
  const { plan: narrowed } = await planFor(m);
  narrowed.narrow(['cursor']);
  const tty2 = await askWithKeys(narrowed, [KEY.space, KEY.enter]);
  assert.deepEqual(narrowed.wired, ['cursor'], '--harness decided the rows; space changes nothing');
  assert.match(tty2.shown(), /--harness/);
});

test('← → on the AGENT row cycle the AGENT — the verifier does not move (live bug 2026-08-30)', async () => {
  const m = machine();
  const { plan } = await planFor(m);
  // down ×3 past the steps → the agent row; right → codex; enter
  await askWithKeys(plan, [KEY.down, KEY.down, KEY.down, KEY.right, KEY.enter]);
  assert.equal(plan.agent.chosen, 'codex', 'the arrows landed on the agent row');
  assert.equal(plan.verifier.chosen, 'claude', 'the verifier held its default');
});

test('a recorded machine-wide verifier PRESETS the radio — re-running init is how you change it; one candidate stays a plain row', async () => {
  const m = machine();
  fs.mkdirSync(m.env.OATHE_HOME, { recursive: true });
  fs.writeFileSync(path.join(m.env.OATHE_HOME, 'config.json'), '{ "verifier": "codex", "defaultAgent": "codex" }\n');
  const { plan } = await planFor(m);
  const tty = await askWithKeys(plan, [KEY.enter]);
  assert.equal(plan.verifier.chosen, 'codex', 'Enter keeps the recorded choice');
  assert.equal(plan.agent.chosen, 'codex', 'a recorded default agent presets its radio the same way');
  assert.match(tty.shown(), /\( \) claude\s+\(•\) codex\s+\( \) cursor/, 'the radio is preset to the recorded choice');
  assert.doesNotMatch(tty.shown(), /already chosen|switch later|oathe config verifier/);
  const m3 = machine();
  fs.mkdirSync(m3.env.OATHE_HOME, { recursive: true });
  fs.writeFileSync(path.join(m3.env.OATHE_HOME, 'config.json'), '{ "verifier": "codex" }\n');
  const { plan: p3 } = await planFor(m3);
  await askWithKeys(p3, [KEY.up, KEY.right, KEY.enter]); // up wraps to the verifier row; → moves codex → cursor
  assert.equal(p3.verifier.chosen, 'cursor', 'the recorded choice is changeable right here');
  const one = machine({ homes: ['.claude', '.cursor'], bins: ['claude'] });
  const { plan: p1 } = await planFor(one);
  const tty1 = await askWithKeys(p1, [KEY.enter]);
  assert.equal(p1.verifier.chosen, 'claude');
  assert.match(tty1.shown(), /verifier\s+claude\s*$/m, 'one candidate: a plain row, no radio, no prose');
});

test('Esc, q, or ctrl-c is a typed refusal (OATHE_INIT_ABORTED) that says nothing was written; a closed stdin is OATHE_INIT_INPUT_CLOSED naming --yes', async () => {
  for (const [key, code] of [[KEY.ctrlC, 'OATHE_INIT_ABORTED'], [KEY.esc, 'OATHE_INIT_ABORTED'], ['q', 'OATHE_INIT_ABORTED']]) {
    const { plan } = await planFor(machine());
    const tty = screenTty();
    const asking = new SetupPrompter({ stdin: tty.stdin, out: tty.out }).ask(plan);
    await tty.whenLegend();
    tty.press(key);
    await assert.rejects(asking, (e) => e instanceof OatheInitError && e.code === code && /nothing was written/.test(e.message));
    assert.equal(tty.stdin.raw, false, 'raw mode restored after the refusal');
  }
  const { plan } = await planFor(machine());
  const tty = screenTty();
  const asking = new SetupPrompter({ stdin: tty.stdin, out: tty.out }).ask(plan);
  await tty.whenLegend();
  tty.stdin.emit('end');
  await assert.rejects(asking, (e) => e.code === 'OATHE_INIT_INPUT_CLOSED' && /--yes/.test(e.message));
});

test('after Enter the chosen state stays in scrollback as plain lines — the record of what was picked', async () => {
  const { plan } = await planFor(machine());
  const tty = await askWithKeys(plan, [KEY.down, KEY.space, KEY.enter]);
  const tail = tty.shown().split('\n').slice(-8).join('\n');
  assert.match(tail, /\[x\] Claude Code/);
  assert.match(tail, /\[ \] Codex/);
  assert.match(tail, /verifier.*claude/);
  assert.doesNotMatch(tail, /enter install/, 'the legend is gone once the choice is made');
});

test('DECLARATIVE: checkboxes preselect from the wiring state — wired [x], unwired [ ]; a fresh machine defaults all on; unchecking a wired harness is an unwire', async () => {
  const m = machine();
  const { plan } = await planFor(m, { wiredNow: new Set(['claude', 'codex']) });
  const tty = await askWithKeys(plan, [KEY.enter]);
  assert.match(tty.shown(), /\[x\] Claude Code/);
  assert.match(tty.shown(), /\[x\] Codex/);
  assert.match(tty.shown(), /\[ \] Cursor/, 'an unwired harness on an initialized machine starts unchecked');
  assert.deepEqual(plan.wired, ['claude', 'codex'], 'Enter keeps the current state');
  assert.deepEqual(plan.toUnwire, [], 'nothing was unchecked — nothing unwires');
  const { plan: p2 } = await planFor(machine(), { wiredNow: new Set(['claude', 'codex', 'cursor']) });
  await askWithKeys(p2, [KEY.down, KEY.down, KEY.space, KEY.enter]); // uncheck cursor
  assert.deepEqual(p2.wired, ['claude', 'codex']);
  assert.deepEqual(p2.toUnwire, ['cursor'], 'an explicit uncheck of a WIRED harness unwires it');
  const outcomes = p2.outcomes([{ harness: 'cursor', action: 'entry-removed', file: path.join(m.home, '.cursor/mcp.json') }]);
  assert.equal(outcomes.find((o) => o.name === 'cursor').outcome, 'unwired');
});

test('DECLARATIVE: --yes and --harness NEVER unwire — defaults keep the current state; only the screen unchecks', async () => {
  const { plan } = await planFor(machine(), { wiredNow: new Set(['claude']) });
  plan.applyDefaults('assume-yes');
  assert.deepEqual(plan.wired, ['claude'], '--yes on an initialized machine keeps exactly what is wired');
  assert.deepEqual(plan.toUnwire, []);
  assert.match(plan.announceLines().join('; '), /skip: codex, cursor \(not wired\)/);
  const { plan: fresh } = await planFor(machine());
  fresh.applyDefaults('assume-yes');
  assert.deepEqual(fresh.wired, ['claude', 'codex', 'cursor'], 'a fresh machine defaults all detected on');
  const { plan: narrowed } = await planFor(machine(), { wiredNow: new Set(['claude', 'cursor']) });
  narrowed.narrow(['claude']);
  narrowed.applyDefaults('harness-filter');
  assert.deepEqual(narrowed.toUnwire, [], '--harness names what to wire; it never unwires the rest');
});
