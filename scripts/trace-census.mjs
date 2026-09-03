#!/usr/bin/env node
// The trace-census lane: sweep each engine's REAL store on this machine against its declared
// roster and fidelity probes (src/trace-census.mjs — the same engine the doctor runs). This
// is the ≤1-day alarm on a harness format update: a new payload type or a projection that
// stopped carrying the record fails here, loudly, naming the drifted field and both sides —
// before a verify mis-judges on starved evidence.
//
//   trace-census.mjs [claude|codex|all] [--home <dir>] [--json]
//
// A store this machine does not have, or a runtime that cannot read it, REFUSES (exit 2) —
// the environment is not drift, and neither is ever a silent green.

import { parseArgs } from 'node:util';

import { byName, traceStores } from '../src/harnesses/catalog.mjs';
import { censusOf, fidelityOf } from '../src/trace-census.mjs';
import { projectAnnotated } from '../src/oathe-annotator.mjs';
import { traceStatusOf } from '../src/doctor.mjs';
import { OatheConfig } from '../src/config.mjs';
import { LaneReport, EXIT_REFUSED } from './lane-report.mjs';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { home: { type: 'string' }, json: { type: 'boolean', default: false } },
  allowPositionals: true,
});
const which = positionals[0] ?? 'all';
const engines = which === 'all' ? traceStores() : [which];
const config = new OatheConfig({});
const sweep = { days: config.get('traceCensusDays'), maxFiles: config.get('traceCensusMaxFiles') };

let exitCode = 0;
const jsonOut = {};
for (const name of engines) {
  if (!traceStores().includes(name)) {
    process.stderr.write(`trace-census: '${name}' has no trace store — engines: ${traceStores().join(', ')}\n`);
    process.exit(EXIT_REFUSED);
  }
  const report = new LaneReport({ lane: 'trace-census', harness: name });
  const capability = byName(name).traces;
  const store = await capability.store({ home: values.home });
  const files = capability.recent(store, sweep);
  if (files.length === 0) {
    process.stderr.write(`[OATHE_TRACE_CENSUS_STORE_ABSENT] ${name}: no session records under `
      + `${store.home} — a store that is not here cannot census green\n`
      + `trace-census: ${name} refused\n`);
    process.exit(EXIT_REFUSED);
  }
  report.add('store-present', true, `${files.length} record${files.length === 1 ? '' : 's'} in the last ${sweep.days}d (cap ${sweep.maxFiles})`);

  const census = censusOf({ store, roster: capability.roster, kindOf: capability.kindOf, files });
  report.add('roster-census', census.undeclared.length === 0,
    census.undeclared.length === 0
      ? `every row type declared${census.unusedHandled.length > 0 ? `; handled-but-unseen this window: ${census.unusedHandled.map((u) => `${u.channel}.${u.type}`).join(', ')}` : ''}`
      : census.undeclared.map((u) => `[OATHE_TRACE_CENSUS_UNDECLARED] ${u.channel}.${u.type} seen ${u.count}× `
        + `(first: ${u.example}) — not in handled [${capability.roster[u.channel]?.handled.join(', ') ?? ''}] `
        + `nor ignored [${Object.keys(capability.roster[u.channel]?.ignored ?? {}).join(', ')}]`).join('; '));

  const fidelity = await fidelityOf({
    store, project: (file) => projectAnnotated(file, { home: values.home }), fidelity: capability.fidelity, files, traceStatus: traceStatusOf,
  });
  const runtime = fidelity.projectionErrors.find((p) => p.status === 'RUNTIME');
  if (runtime) {
    process.stderr.write(`[TRACE_CODEX_SQLITE_UNSUPPORTED] ${name}: ${runtime.detail}\n`
      + `RUNTIME is the environment, not drift — fix the runtime (node >= 22.13) and re-run\n`
      + `trace-census: ${name} refused\n`);
    process.exit(EXIT_REFUSED);
  }
  const drift = fidelity.projectionErrors.filter((p) => p.status === 'DRIFT');
  const empty = fidelity.projectionErrors.filter((p) => p.status === 'empty').length;
  report.add('projection-validates', drift.length === 0,
    drift.length === 0
      ? `${files.length - drift.length - empty} projected${empty > 0 ? `, ${empty} empty session${empty === 1 ? '' : 's'} skipped` : ''}`
      : drift.map((p) => `${p.file}: ${p.detail}`).join('; '));
  for (const probe of fidelity.probes) {
    report.add(`fidelity-${probe.probe}`, probe.failed.length === 0,
      probe.failed.length === 0
        ? (probe.applicable === 0 ? `n/a (0 applicable in ${files.length} records)` : `${probe.applicable} applicable, all faithful`)
        : probe.failed.map((f) => `${f.file}: ${f.detail}`).join('; '));
  }
  jsonOut[name] = { files: files.length, census, fidelity };
  process.stdout.write(report.render());
  if (!report.ok) exitCode = report.exitCode;
}
if (values.json) process.stdout.write(`${JSON.stringify(jsonOut, null, 2)}\n`);
process.exit(exitCode);
