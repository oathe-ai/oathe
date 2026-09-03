#!/usr/bin/env node
// oathe — the Harbor conformance lane (founder ruling 4, 2026-09-01). Our converters promise
// to emit what a Harbor converter could also emit; this lane makes that claim MEASURED: it
// drives Harbor's own converters (the pinned version, through the public entry points a
// trial uses) on every corpus fixture home, projects both outputs onto one comparable shape,
// and compares the structure both ways. A tracked lock (harbor-conformance.lock.json) pins
// the Harbor version, the entry points, and a reviewed BASELINE of the known divergences per
// fixture — the run fails LOUD (exit 3) on a divergence the baseline does not carry, or one
// it carries that is gone; it REFUSES (exit 2) when it cannot run at all: no python3, a Harbor
// other than the pin, a moved entry point. Condition-based: nothing is remembered between
// runs; `--lock` re-pins from a run AFTER a human reviewed the change. Never a PR gate.
//
// Harbor is driven from `python3` on PATH — activate an environment that has the pin. The
// driver is ONE Python program fed ONE JSON spec on argv; there is no Python file in the tree.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { fixtureDirs, harnessOf, projectFixture as projectCorpusFixture } from './trace-fixtures.mjs';
import { HARNESS_CLASSES, byName } from '../src/harnesses/catalog.mjs';

export const EXIT_DIVERGED = 3;
export const EXIT_REFUSED = 2;
export const LOCK_FORMAT = 1;

/**
 * The public names the driver imports and calls — what a Harbor trial itself runs after an
 * agent finishes: the factory makes the agent by name, `populate_context_post_run` converts
 * the session it finds under logs_dir and writes `trajectory.json` beside it. Pinned in the
 * lock so a rename upstream is a reviewed change, not a mystery.
 */
export const HARBOR_ENTRYPOINT = Object.freeze({
  agent_factory: 'harbor.agents.factory:AgentFactory',
  agent_name: 'harbor.models.agent.name:AgentName',
  agent_context: 'harbor.models.agent.context:AgentContext',
  create: 'create_agent_from_name',
  post_run: 'populate_context_post_run',
  output: 'trajectory.json',
});

export class HarborConformanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HarborConformanceError';
    this.code = code;
  }
}

/** The driver: one JSON spec in (argv[1]), one JSON line out. Every failure is a line too. */
export const DRIVER = String.raw`
import importlib, io, json, logging, sys
spec = json.loads(sys.argv[1])

def load(ref):
    module, _, attr = ref.partition(":")
    return getattr(importlib.import_module(module), attr)

try:
    op = spec["op"]
    if op == "version":
        import importlib.metadata as meta, platform
        print(json.dumps({"ok": True, "harbor": meta.version("harbor"), "python": platform.python_version()}))
    elif op == "entrypoint":
        ep = spec["entrypoint"]
        for key in ("agent_factory", "agent_name", "agent_context"):
            try:
                target = load(ep[key])
            except Exception as e:
                print(json.dumps({"ok": False, "where": key, "error": f"{type(e).__name__}: {e}"})); sys.exit(0)
            if key == "agent_factory" and not hasattr(target, ep["create"]):
                print(json.dumps({"ok": False, "where": "create", "error": f"{ep[key]} has no {ep['create']}"})); sys.exit(0)
        print(json.dumps({"ok": True}))
    elif op == "convert":
        from pathlib import Path
        ep = spec["entrypoint"]
        log = io.StringIO()
        logging.basicConfig(stream=log, level=logging.DEBUG, force=True)
        factory, name, context = load(ep["agent_factory"]), load(ep["agent_name"]), load(ep["agent_context"])
        logs_dir = Path(spec["logs_dir"])
        agent = getattr(factory, ep["create"])(name(spec["agent"]), logs_dir=logs_dir)
        getattr(agent, ep["post_run"])(context())
        out = logs_dir / ep["output"]
        if out.exists():
            print(json.dumps({"ok": True, "trajectory": json.loads(out.read_text())}))
        else:
            print(json.dumps({"ok": False, "error": f"no {ep['output']} written", "log": log.getvalue()[-4000:]}))
    else:
        print(json.dumps({"ok": False, "error": f"unknown op {op!r}"}))
except SystemExit:
    raise
except Exception as e:
    print(json.dumps({"ok": False, "where": spec.get("op"), "error": f"{type(e).__name__}: {e}"}))
`;

/** Runs the driver under `python3` (or the interpreter given). ENOENT is the caller's to refuse on. */
export function pythonRunner({ python = 'python3' } = {}) {
  const run = promisify(execFile);
  return async (spec) => {
    const { stdout, stderr } = await run(python, ['-c', DRIVER, JSON.stringify(spec)], { maxBuffer: 256 * 1024 * 1024 })
      .catch((e) => {
        if (e.code === 'ENOENT') throw e;
        throw new HarborConformanceError('OATHE_HARBOR_CONFORMANCE_DRIVER',
          `the driver died under ${python} (exit ${e.code}): ${String(e.stderr ?? e.message).trim().split('\n').slice(-3).join(' | ')}`);
      });
    const line = stdout.trim().split('\n').at(-1) ?? '';
    try {
      return JSON.parse(line);
    } catch {
      throw new HarborConformanceError('OATHE_HARBOR_CONFORMANCE_DRIVER',
        `the driver printed no JSON line under ${python}: ${(line || stderr).slice(0, 300)}`);
    }
  };
}

/** The fixtures of every harness that has a Harbor converter: `{key: '<harness>/<fixture>', dir}`. */
export function corpusFixtures() {
  return HARNESS_CLASSES.filter((C) => C.traces?.harbor)
    .flatMap((C) => fixtureDirs(C.harnessName).map((dir) => ({ key: `${harnessOf(dir)}/${path.basename(dir)}`, dir })));
}

/**
 * Lay a fixture's record out the way Harbor reads a trial's logs_dir: the adapter says where
 * its sessions live on both sides. Only the source file and its sidecar dir (Claude keeps a
 * session's subagents in `<session>/`) are copied — Harbor converts the newest file it finds,
 * and a sibling child rollout would be it.
 */
export function layoutFor(dir, { harness, scratch }) {
  const { agent, sessions } = harness.traces.harbor;
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')).record;
  if (!record.startsWith(`${sessions.home}/`)) {
    throw new HarborConformanceError('OATHE_HARBOR_CONFORMANCE_LAYOUT',
      `${dir}: the record ${record} is not under ${sessions.home}, where ${agent} reads its sessions`);
  }
  const logsDir = fs.mkdtempSync(path.join(scratch, 'logs-'));
  const source = path.join(dir, 'home', record);
  const dest = path.join(logsDir, sessions.logs, record.slice(sessions.home.length + 1));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  const sidecar = source.replace(/\.jsonl$/, '');
  if (fs.existsSync(sidecar) && fs.statSync(sidecar).isDirectory()) fs.cpSync(sidecar, dest.replace(/\.jsonl$/, ''), { recursive: true });
  return { agent, logsDir, record };
}

/**
 * Both conventions on ONE shape. Harbor flattens a Claude subagent into the root as
 * `extra.is_sidechain` steps where we embed it; either way those are the delegated steps and
 * the rest are the root's. Ids for calls and results, the token totals the record states (a
 * cost estimate is not one), the ref count, the identity the converter derived.
 */
export function shapeOf(t) {
  const main = t.steps.filter((s) => !s.extra?.is_sidechain);
  const results = main.flatMap((s) => s.observation?.results ?? []);
  const fm = t.final_metrics ?? {};
  return {
    session_id: t.session_id ?? null,
    agent: { version: t.agent?.version ?? null, model_name: t.agent?.model_name ?? null },
    steps: main.map((s) => s.source[0]).join(''),
    llm_call_count: main.filter((s) => s.source === 'agent').map((s) => s.llm_call_count ?? null),
    tool_calls: main.flatMap((s) => (s.tool_calls ?? []).map((c) => `${c.function_name}:${c.tool_call_id}`)),
    results: results.map((r) => r.source_call_id ?? '(no call)'),
    refs: results.reduce((n, r) => n + (r.subagent_trajectory_ref?.length ?? 0), 0),
    final_metrics: {
      total_prompt_tokens: fm.total_prompt_tokens ?? null,
      total_completion_tokens: fm.total_completion_tokens ?? null,
      total_cached_tokens: fm.total_cached_tokens ?? null,
    },
    delegated_steps: (t.steps.length - main.length) + (t.subagent_trajectories ?? []).reduce((n, c) => n + c.steps.length, 0),
  };
}

const ID_LISTS = new Set(['tool_calls', 'results']);
const NESTED = new Set(['agent', 'final_metrics']);

/** Every divergence between two shapes, both directions, as sorted lines — a relation a human can review. */
export function compareStructure(ours, theirs) {
  const lines = [];
  const show = (v) => JSON.stringify(v ?? null);
  for (const field of Object.keys(ours)) {
    if (ID_LISTS.has(field)) {
      const mine = new Set(ours[field]);
      const other = new Set(theirs[field] ?? []);
      const onlyMine = [...mine].filter((x) => !other.has(x));
      const onlyOther = [...other].filter((x) => !mine.has(x));
      if (onlyMine.length > 0) lines.push(`${field} ours-only: ${onlyMine.join(', ')}`);
      if (onlyOther.length > 0) lines.push(`${field} theirs-only: ${onlyOther.join(', ')}`);
    } else if (NESTED.has(field)) {
      for (const k of Object.keys(ours[field])) {
        if (show(ours[field][k]) !== show(theirs[field]?.[k])) lines.push(`${field}.${k}: ours ${show(ours[field][k])} theirs ${show(theirs[field]?.[k])}`);
      }
    } else if (show(ours[field]) !== show(theirs[field])) {
      lines.push(`${field}: ours ${show(ours[field])} theirs ${show(theirs[field])}`);
    }
  }
  return lines.sort();
}

/** The outcome of one run — data first, one render, one exit code. */
export class LaneReport {
  constructor({ harbor, checks, divergences, unlocked = [], stale = [], fixtures = 0 }) {
    this.harbor = harbor;
    this.checks = checks;
    this.divergences = divergences;
    this.unlocked = unlocked;
    this.stale = stale;
    this.fixtures = fixtures;
  }

  get failed() {
    return this.checks.filter((c) => !c.ok);
  }

  get diverged() {
    return this.failed.length + this.unlocked.length + this.stale.length > 0;
  }

  get exitCode() {
    return this.diverged ? EXIT_DIVERGED : 0;
  }

  /** Every fixture converted and compared — the only run a baseline may be pinned from. */
  get compared() {
    return Object.keys(this.divergences).length === this.fixtures;
  }

  toJSON() {
    const { harbor, checks, divergences, unlocked, stale, fixtures } = this;
    return { harbor, checks, divergences, unlocked, stale, fixtures };
  }

  render() {
    const lines = [];
    const counts = { new: 0, resolved: 0, failed: 0 };
    for (const [key, d] of Object.entries(this.divergences)) {
      for (const l of d.new) { lines.push(`new          ${key}  ${l}`); counts.new += 1; }
      for (const l of d.resolved) { lines.push(`resolved     ${key}  ${l}`); counts.resolved += 1; }
    }
    for (const c of this.failed.filter((c) => !c.name.startsWith('structure/'))) {
      const [head, ...rest] = String(c.detail).split('\n');
      lines.push(`failed       ${c.name}  ${head}`);
      for (const r of rest) lines.push(`             ${r}`);
      counts.failed += 1;
    }
    for (const k of this.unlocked) lines.push(`unlocked     ${k}  (a fixture with no baseline entry — run harbor-conformance-lock after review)`);
    for (const k of this.stale) lines.push(`stale        ${k}  (a baseline entry with no fixture — run harbor-conformance-lock)`);
    const pin = `harbor ${this.harbor.version} on python ${this.harbor.python}`;
    lines.push(this.diverged
      ? `harbor-conformance: divergence (${counts.new} new, ${counts.resolved} resolved, ${counts.failed} failed, `
        + `${this.unlocked.length} unlocked, ${this.stale.length} stale) against ${pin}`
      : `harbor-conformance: ok (${this.fixtures} fixtures against ${pin})`);
    return `${lines.join('\n')}\n`;
  }
}

export function readLock(lockPath) {
  return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
}

/** Pin the Harbor a run used and its divergences as the baseline — from a run that compared everything. */
export function writeLock({ lockPath, report, entrypoint, clock = () => new Date().toISOString() }) {
  if (!report.compared) {
    throw new HarborConformanceError('OATHE_HARBOR_CONFORMANCE_UNCOMPARED',
      `${report.failed.filter((c) => c.name.startsWith('convert/')).map((c) => c.name).join(', ') || 'a fixture'} did not convert — a baseline pinned from a partial run would hide it`);
  }
  const baseline = Object.fromEntries(Object.keys(report.divergences).sort().map((k) => [k, report.divergences[k].lines]));
  const lock = { format: LOCK_FORMAT, harbor: report.harbor, entrypoint, baseline, pinned_at: clock() };
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

/**
 * The lane: refuse when Harbor cannot be driven, else convert every fixture on both sides and
 * compare against the baseline. `onLayout` sees each laid-out fixture before Harbor does.
 * @returns {Promise<LaneReport>}
 */
export async function runLane({
  lock, fixtures = corpusFixtures(), runPython = pythonRunner(), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-harbor-')),
  projectFixture = projectCorpusFixture, onLayout = async () => {},
}) {
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    return ok;
  };
  const pin = `harbor ${lock.harbor.version}`;
  let version;
  try {
    version = await runPython({ op: 'version' });
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new HarborConformanceError('OATHE_HARBOR_CONFORMANCE_PYTHON_ABSENT',
        `no python3 on PATH — the lane drives ${pin} from python3; activate an environment that has it`);
    }
    throw e;
  }
  check('python-present', true, `python ${version.python ?? '(unknown)'}`);
  if (!version.ok) {
    throw new HarborConformanceError('OATHE_HARBOR_CONFORMANCE_PIN_ABSENT', `${pin} is not importable from python3: ${version.error}`);
  }
  if (version.harbor !== lock.harbor.version) {
    throw new HarborConformanceError('OATHE_HARBOR_CONFORMANCE_PIN_ABSENT',
      `harbor ${version.harbor} is installed; the lock pins ${lock.harbor.version} — install the pin, or re-lock after review`);
  }
  check('harbor-pinned', true, `${pin} on python ${version.python}`);
  const entry = await runPython({ op: 'entrypoint', entrypoint: lock.entrypoint });
  if (!entry.ok) {
    throw new HarborConformanceError('OATHE_HARBOR_CONFORMANCE_ENTRYPOINT',
      `entry point ${entry.where} (${lock.entrypoint[entry.where] ?? '?'}) cannot be resolved in harbor ${version.harbor}: ${entry.error}`);
  }
  check('harbor-entrypoint', true);

  const divergences = {};
  for (const { key, dir } of fixtures) {
    const layout = layoutFor(dir, { harness: byName(harnessOf(dir)), scratch });
    await onLayout({ ...layout, dir, key });
    const converted = await runPython({ op: 'convert', agent: layout.agent, logs_dir: layout.logsDir, entrypoint: lock.entrypoint });
    const detail = converted.ok ? '' : `${converted.error}${converted.log ? `\n${converted.log.trim()}` : ''}`;
    if (!check(`convert/${key}`, converted.ok === true, detail)) continue;
    const lines = compareStructure(shapeOf(await projectFixture(dir)), shapeOf(converted.trajectory));
    const baseline = lock.baseline[key] ?? null;
    const d = {
      lines,
      baseline,
      new: baseline ? lines.filter((l) => !baseline.includes(l)) : [],
      resolved: baseline ? baseline.filter((l) => !lines.includes(l)) : [],
    };
    divergences[key] = d;
    check(`structure/${key}`, d.new.length === 0 && d.resolved.length === 0,
      [...d.new.map((l) => `new: ${l}`), ...d.resolved.map((l) => `resolved: ${l}`)].join('\n'));
  }
  const keys = fixtures.map((f) => f.key);
  return new LaneReport({
    harbor: { version: version.harbor, python: version.python },
    checks,
    divergences,
    unlocked: keys.filter((k) => !(k in lock.baseline)),
    stale: Object.keys(lock.baseline).filter((k) => !keys.includes(k)),
    fixtures: keys.length,
  });
}

async function main(argv) {
  const packageRoot = path.dirname(path.dirname(fs.realpathSync(process.argv[1])));
  const lockPath = path.join(packageRoot, 'harbor-conformance.lock.json');
  const lockExists = fs.existsSync(lockPath);
  try {
    if (argv.includes('--lock')) {
      // Re-pin from a live run: the pin becomes whatever python3 has, the baseline whatever the
      // run measured. The entry points carry over from the existing lock (the default on first pin).
      const current = lockExists ? readLock(lockPath) : null;
      const probe = await pythonRunner()({ op: 'version' }).catch((e) => {
        if (e.code === 'ENOENT') throw new HarborConformanceError('OATHE_HARBOR_CONFORMANCE_PYTHON_ABSENT', 'no python3 on PATH — activate an environment that has harbor');
        throw e;
      });
      if (!probe.ok) throw new HarborConformanceError('OATHE_HARBOR_CONFORMANCE_PIN_ABSENT', `harbor is not importable from python3: ${probe.error}`);
      const entrypoint = current?.entrypoint ?? HARBOR_ENTRYPOINT;
      const report = await runLane({ lock: { harbor: { version: probe.harbor }, entrypoint, baseline: current?.baseline ?? {} } });
      const lock = writeLock({ lockPath, report, entrypoint });
      process.stdout.write(report.render());
      process.stdout.write(`harbor-conformance-lock: ${Object.keys(lock.baseline).length} fixture(s) pinned against harbor ${lock.harbor.version} into ${lockPath}\n`);
      return 0;
    }
    if (!lockExists) {
      throw new HarborConformanceError('OATHE_HARBOR_CONFORMANCE_LOCK_ABSENT',
        `no lock at ${lockPath}; run \`npm run harbor-conformance-lock\` with harbor importable, then review the baseline`);
    }
    const report = await runLane({ lock: readLock(lockPath) });
    process.stdout.write(report.render());
    return report.exitCode;
  } catch (e) {
    if (e instanceof HarborConformanceError) {
      process.stderr.write(`harbor-conformance: refused — [${e.code}] ${e.message}\n`);
      return EXIT_REFUSED;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
