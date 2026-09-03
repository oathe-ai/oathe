// The Harbor conformance lane (founder ruling 4, 2026-09-01): a tracked lock pins the Harbor
// version, the public entry points we drive, and a reviewed BASELINE of how Harbor's own
// converters diverge from ours on the corpus; a run drives Harbor on every fixture home,
// compares the structure both ways, and fails LOUD on any divergence the baseline does not
// carry — or one it carries that is gone. Condition-based: nothing is remembered between
// runs; `--lock` re-pins after a human reviewed the change. Driven here with an injected
// Python runner — the suite never needs Harbor installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LaneReport, HarborConformanceError, shapeOf, compareStructure, layoutFor, runLane, writeLock, readLock,
  pythonRunner, HARBOR_ENTRYPOINT, EXIT_DIVERGED, EXIT_REFUSED, LOCK_FORMAT,
} from '../scripts/harbor-conformance.mjs';
import { fixtureDirs, projectFixture, harnessOf } from '../scripts/trace-fixtures.mjs';
import { byName } from '../src/harnesses/catalog.mjs';

const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-harbor-')));
const step = (source, extra = {}) => ({ step_id: 0, source, message: '', ...extra });
const call = (name, id) => ({ tool_call_id: id, function_name: name, arguments: {} });
const result = (id, refs = null) => ({ source_call_id: id, content: '', ...(refs ? { subagent_trajectory_ref: refs } : {}) });

/** A small ATIF trajectory in OUR convention: root steps, an embedded child, a ref on the receipt. */
function ours() {
  return {
    schema_version: 'ATIF-v1.7', session_id: 'sess-1', agent: { name: 'claude', version: '2.1.0', model_name: 'claude-fable-5' },
    steps: [
      step('user'),
      step('agent', { llm_call_count: 1, tool_calls: [call('Agent', 'toolu_1')], observation: { results: [result('toolu_1', [{ trajectory_id: 'sub1' }])] } }),
      step('system', { llm_call_count: 0 }),
      step('agent', { llm_call_count: 1 }),
    ],
    final_metrics: { total_prompt_tokens: 100, total_completion_tokens: 20, total_cached_tokens: 5, total_steps: 4 },
    subagent_trajectories: [{ trajectory_id: 'sub1', steps: [step('user'), step('agent'), step('agent')] }],
  };
}
/** The same record in HARBOR's convention: the child flattened into sidechain steps, no refs, cost estimated. */
function theirs() {
  return {
    schema_version: 'ATIF-v1.7', session_id: 'sess-1', agent: { name: 'claude-code', version: '2.1.0', model_name: 'claude-fable-5' },
    steps: [
      step('user'),
      step('agent', { llm_call_count: 1, tool_calls: [call('Agent', 'toolu_1')], observation: { results: [result('toolu_1')] } }),
      step('user', { extra: { is_sidechain: true } }),
      step('agent', { extra: { is_sidechain: true } }),
      step('agent', { extra: { is_sidechain: true } }),
      step('user'),
      step('agent', { llm_call_count: 1 }),
    ],
    final_metrics: { total_prompt_tokens: 100, total_completion_tokens: 20, total_cached_tokens: 5, total_cost_usd: 0.5, total_steps: 7 },
  };
}

test('shapeOf projects both conventions onto ONE comparable shape: root steps apart from delegated ones, calls and results as ids, the token totals without cost', () => {
  assert.deepEqual(shapeOf(ours()), {
    session_id: 'sess-1', agent: { version: '2.1.0', model_name: 'claude-fable-5' },
    steps: 'uasa', llm_call_count: [1, 1],
    tool_calls: ['Agent:toolu_1'], results: ['toolu_1'], refs: 1,
    final_metrics: { total_prompt_tokens: 100, total_completion_tokens: 20, total_cached_tokens: 5 },
    delegated_steps: 3,
  });
  const t = shapeOf(theirs());
  assert.equal(t.steps, 'uaua', 'sidechain steps are delegated, not the root\'s');
  assert.equal(t.delegated_steps, 3);
  assert.equal(t.refs, 0);
  assert.equal('total_cost_usd' in t.final_metrics, false, 'a litellm estimate is not a fact of the record');
});

test('compareStructure names every divergence in BOTH directions, deterministically sorted — a known relation is a list of lines', () => {
  const lines = compareStructure(shapeOf(ours()), shapeOf(theirs()));
  assert.deepEqual(lines, ['refs: ours 1 theirs 0', 'steps: ours "uasa" theirs "uaua"']);
  const same = compareStructure(shapeOf(ours()), shapeOf(ours()));
  assert.deepEqual(same, []);
  const mine = shapeOf(ours());
  const other = { ...mine, tool_calls: ['exec:call_1', 'Agent:toolu_1'], results: ['call_1', 'toolu_1'], llm_call_count: [1, null] };
  assert.deepEqual(compareStructure(mine, other), [
    'llm_call_count: ours [1,1] theirs [1,null]',
    'results theirs-only: call_1',
    'tool_calls theirs-only: exec:call_1',
  ]);
  assert.deepEqual(compareStructure(other, mine), [
    'llm_call_count: ours [1,null] theirs [1,1]',
    'results ours-only: call_1',
    'tool_calls ours-only: exec:call_1',
  ]);
});

test('layoutFor lays a fixture home out the way Harbor reads a trial\'s logs_dir — the adapter says where its sessions live — with the source file and its sidecar only', () => {
  const [codexDir] = fixtureDirs('codex');
  const codex = layoutFor(codexDir, { harness: byName('codex'), scratch: scratch() });
  assert.equal(codex.agent, 'codex');
  const codexFiles = fs.readdirSync(codex.logsDir, { recursive: true }).map(String).filter((f) => f.endsWith('.jsonl'));
  assert.equal(codexFiles.length, 1, 'one rollout: the root — Harbor converts the newest file it finds, never a child');
  assert.match(codexFiles[0], /^sessions\//);
  const [claudeDir] = fixtureDirs('claude').filter((d) => d.includes('subagent-fanout'));
  const claude = layoutFor(claudeDir, { harness: byName('claude'), scratch: scratch() });
  assert.equal(claude.agent, 'claude-code');
  const claudeFiles = fs.readdirSync(claude.logsDir, { recursive: true }).map(String).filter((f) => f.endsWith('.jsonl'));
  assert.equal(claudeFiles.length, 2, 'the session and its subagent file (the sidecar dir rides along)');
  assert.ok(claudeFiles.every((f) => f.startsWith('sessions/projects/')));
});

/** A Python runner that answers the driver's three operations from canned data. */
function stubPython({ version = '0.22.0', python = '3.12.0', convert = null, entrypointOk = true } = {}) {
  const calls = [];
  const run = async (spec) => {
    calls.push(spec);
    if (spec.op === 'version') return { ok: true, harbor: version, python };
    if (spec.op === 'entrypoint') return entrypointOk ? { ok: true } : { ok: false, error: `cannot import ${spec.entrypoint.agent_factory}`, where: 'agent_factory' };
    if (spec.op === 'convert') return convert ? convert(spec) : { ok: false, error: 'no trajectory.json written', log: 'Failed to convert' };
    throw new Error(`unknown op ${spec.op}`);
  };
  return { run, calls };
}
const lockFor = (baseline, extra = {}) => ({ format: LOCK_FORMAT, harbor: { version: '0.22.0', python: '3.12.0' }, entrypoint: HARBOR_ENTRYPOINT, baseline, ...extra });
const corpus = () => [...fixtureDirs('codex'), ...fixtureDirs('claude')].map((dir) => ({ key: `${harnessOf(dir)}/${path.basename(dir)}`, dir }));
/** Harbor "answers" with our own projection — zero divergence — so the baseline is the empty relation. */
const echoConvert = () => {
  const projected = new Map();
  return {
    convert: (spec) => ({ ok: true, trajectory: projected.get(spec.logs_dir) }),
    remember: (logsDir, trajectory) => projected.set(logsDir, trajectory),
  };
};

async function laneWith({ baseline, stub, fixtures = corpus(), mutate = (t) => t }) {
  const echo = echoConvert();
  const runner = stub ?? stubPython({ convert: echo.convert });
  const report = await runLane({
    lock: lockFor(baseline),
    fixtures,
    runPython: runner.run,
    scratch: scratch(),
    projectFixture,
    // the layout hook lets the stub see what Harbor would: our projection, mutated per test
    onLayout: async ({ logsDir, dir }) => echo.remember(logsDir, mutate(structuredClone(await projectFixture(dir)), dir)),
  });
  return { report, calls: runner.calls };
}

test('a run whose divergences equal the baseline is ok: every check passes, exit 0, the report names the pin', async () => {
  const baseline = Object.fromEntries(corpus().map(({ key }) => [key, []]));
  const { report, calls } = await laneWith({ baseline });
  assert.ok(report instanceof LaneReport);
  assert.equal(report.exitCode, 0);
  assert.equal(report.diverged, false);
  assert.deepEqual(report.checks.filter((c) => !c.ok), []);
  assert.deepEqual(report.checks.slice(0, 3).map((c) => c.name), ['python-present', 'harbor-pinned', 'harbor-entrypoint']);
  assert.equal(report.checks.filter((c) => c.name.startsWith('convert/')).length, corpus().length);
  assert.equal(report.checks.filter((c) => c.name.startsWith('structure/')).length, corpus().length);
  assert.equal(calls.filter((c) => c.op === 'convert').length, corpus().length);
  const text = report.render();
  assert.match(text, new RegExp(`harbor-conformance: ok \\(${corpus().length} fixtures against harbor 0\\.22\\.0 on python 3\\.12\\.0\\)`));
});

test('a divergence the baseline does not carry is DRIFT: named with the fixture, the field, both sides — exit 3', async () => {
  const baseline = Object.fromEntries(corpus().map(({ key }) => [key, []]));
  const { report } = await laneWith({
    baseline,
    mutate: (t, dir) => {
      if (dir.includes('tool-pair-claim')) t.steps.push(step('user'));
      return t;
    },
  });
  assert.equal(report.diverged, true);
  assert.equal(report.exitCode, EXIT_DIVERGED);
  const [key] = Object.keys(report.divergences).filter((k) => report.divergences[k].new.length > 0);
  assert.equal(key, 'claude/2026-09-01-tool-pair-claim');
  assert.deepEqual(report.divergences[key].new, ['steps: ours "uauaau" theirs "uauaauu"']);
  const text = report.render();
  assert.match(text, /new +claude\/2026-09-01-tool-pair-claim/);
  assert.match(text, /steps: ours "uauaau" theirs "uauaauu"/);
  assert.match(text, /harbor-conformance: divergence/);
});

test('a baseline line the run does not show is DRIFT too — the pin and reality must agree — and so are an unpinned fixture and a pinned fixture that is gone', async () => {
  const fixtures = corpus();
  const baseline = Object.fromEntries(fixtures.map(({ key }) => [key, []]));
  baseline[fixtures[0].key] = ['refs: ours 1 theirs 0'];
  const { report } = await laneWith({ baseline });
  assert.deepEqual(report.divergences[fixtures[0].key].resolved, ['refs: ours 1 theirs 0']);
  assert.equal(report.diverged, true);
  assert.match(report.render(), /resolved +codex\//);

  const partial = { ...baseline };
  delete partial[fixtures[1].key];
  partial['codex/2026-01-01-gone'] = [];
  const { report: r2 } = await laneWith({ baseline: partial });
  assert.deepEqual(r2.unlocked, [fixtures[1].key]);
  assert.deepEqual(r2.stale, ['codex/2026-01-01-gone']);
  assert.equal(r2.diverged, true);
});

test('a fixture Harbor cannot convert is a failed convert check — DRIFT with the driver\'s log, never a silent skip', async () => {
  const baseline = Object.fromEntries(corpus().map(({ key }) => [key, []]));
  const { report } = await laneWith({ baseline, stub: stubPython({ convert: () => ({ ok: false, error: 'no trajectory.json written', log: 'Failed to convert Codex events' }) }) });
  const failed = report.checks.filter((c) => c.name.startsWith('convert/') && !c.ok);
  assert.equal(failed.length, corpus().length);
  assert.match(failed[0].detail, /Failed to convert Codex events/);
  assert.equal(report.checks.filter((c) => c.name.startsWith('structure/')).length, 0, 'nothing to compare when nothing converted');
  assert.equal(report.exitCode, EXIT_DIVERGED);
});

test('no Python, a Harbor other than the pin, or a moved entry point is a typed REFUSAL naming the pin — the lane cannot run, and says so', async () => {
  const baseline = Object.fromEntries(corpus().map(({ key }) => [key, []]));
  const absent = { run: async () => { const e = new Error('spawn python3 ENOENT'); e.code = 'ENOENT'; throw e; }, calls: [] };
  await assert.rejects(laneWith({ baseline, stub: absent }), (e) => e instanceof HarborConformanceError && e.code === 'OATHE_HARBOR_CONFORMANCE_PYTHON_ABSENT' && /harbor 0\.22\.0/.test(e.message));
  await assert.rejects(laneWith({ baseline, stub: stubPython({ version: '0.23.0' }) }),
    (e) => e.code === 'OATHE_HARBOR_CONFORMANCE_PIN_ABSENT' && /0\.23\.0/.test(e.message) && /0\.22\.0/.test(e.message));
  const noHarbor = { run: async (spec) => (spec.op === 'version' ? { ok: false, error: "No module named 'harbor'" } : { ok: true }), calls: [] };
  await assert.rejects(laneWith({ baseline, stub: noHarbor }), (e) => e.code === 'OATHE_HARBOR_CONFORMANCE_PIN_ABSENT' && /No module named/.test(e.message));
  await assert.rejects(laneWith({ baseline, stub: stubPython({ entrypointOk: false }) }),
    (e) => e.code === 'OATHE_HARBOR_CONFORMANCE_ENTRYPOINT' && /agent_factory/.test(e.message));
  assert.equal(EXIT_REFUSED, 2);
});

test('the real runner: a missing interpreter surfaces as ENOENT for the lane to refuse on; the driver is one Python program fed one JSON spec', async () => {
  const run = pythonRunner({ python: path.join(scratch(), 'no-such-python3') });
  await assert.rejects(run({ op: 'version' }), (e) => e.code === 'ENOENT');
});

test('--lock pins the Harbor in use and the baseline from a run — re-pinned only from a run that could compare every fixture', async () => {
  const baseline = Object.fromEntries(corpus().map(({ key }) => [key, []]));
  const { report } = await laneWith({ baseline, mutate: (t, dir) => { if (dir.includes('metadata-noise')) t.steps.push(step('user')); return t; } });
  const lockPath = path.join(scratch(), 'harbor-conformance.lock.json');
  const lock = writeLock({ lockPath, report, entrypoint: HARBOR_ENTRYPOINT, clock: () => '2026-09-01T00:00:00.000Z' });
  assert.equal(lock.format, LOCK_FORMAT);
  assert.deepEqual(lock.harbor, { version: '0.22.0', python: '3.12.0' });
  assert.deepEqual(lock.entrypoint, HARBOR_ENTRYPOINT);
  assert.equal(lock.pinned_at, '2026-09-01T00:00:00.000Z');
  assert.deepEqual(Object.keys(lock.baseline), corpus().map((f) => f.key).sort());
  assert.deepEqual(lock.baseline['claude/2026-09-01-metadata-noise'], ['steps: ours "ua" theirs "uau"']);
  assert.deepEqual(readLock(lockPath), lock);

  const { report: broken } = await laneWith({ baseline, stub: stubPython({ convert: () => ({ ok: false, error: 'x' }) }) });
  assert.throws(() => writeLock({ lockPath, report: broken, entrypoint: HARBOR_ENTRYPOINT }), (e) => e.code === 'OATHE_HARBOR_CONFORMANCE_UNCOMPARED');
});

test('the tracked lock exists, pins a Harbor version, and its baseline keys ARE the corpus — the suite holds the pin and the fixtures closed without Harbor installed', () => {
  const lockPath = new URL('../harbor-conformance.lock.json', import.meta.url).pathname;
  assert.ok(fs.existsSync(lockPath), 'harbor-conformance.lock.json is tracked at the package root');
  const lock = readLock(lockPath);
  assert.equal(lock.format, LOCK_FORMAT);
  assert.match(lock.harbor.version, /^\d+\.\d+\.\d+$/);
  assert.match(lock.harbor.python, /^\d+\.\d+/);
  assert.deepEqual(lock.entrypoint, HARBOR_ENTRYPOINT, 'the entry points the driver imports are the pinned ones');
  assert.deepEqual(Object.keys(lock.baseline).sort(), corpus().map((f) => f.key).sort());
  for (const [key, lines] of Object.entries(lock.baseline)) {
    assert.ok(Array.isArray(lines) && lines.every((l) => typeof l === 'string'), `${key}: a list of divergence lines`);
    assert.deepEqual(lines, [...lines].sort(), `${key}: sorted, so a diff is a review`);
  }
});

test('every harness with traces declares its Harbor converter and where that converter reads sessions — or null when Harbor has none', () => {
  assert.deepEqual(byName('codex').traces.harbor, { agent: 'codex', sessions: { home: '.codex/sessions', logs: 'sessions' } });
  assert.deepEqual(byName('claude').traces.harbor, { agent: 'claude-code', sessions: { home: '.claude/projects', logs: 'sessions/projects' } });
  assert.ok(Object.isFrozen(byName('codex').traces.harbor));
});
