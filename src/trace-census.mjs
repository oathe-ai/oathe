// oathe — the trace census: the ONE engine behind `oathe doctor`'s store sweep, the
// scripts/trace-census.mjs lane, and the unit tests (one implementation per concept). Two
// questions, both born 2026-08-31: does the store contain row types outside the adapter's
// declared roster (an addition the roster review has not seen — DRIFT), and does the
// projection CARRY what the raw record carries (fidelity — a projector that "didn't throw"
// rendered every codex action as exec({}) for days).

export class TraceCensusError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TraceCensusError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Classify every row of every file against the adapter's declared roster.
 * @returns {{swept: number, counts: object, undeclared: Array<{channel, type, count, example}>,
 *            unusedHandled: Array<{channel, type}>}}
 */
export function censusOf({ store, roster, kindOf, files }) {
  if (!roster || typeof kindOf !== 'function') {
    throw new TraceCensusError('OATHE_TRACE_CENSUS_ROSTER_MISSING',
      `the '${store?.harness}' traces capability declares no ${!roster ? 'roster' : 'kindOf classifier'} — `
      + 'a store without its declared contract can never census green', { harness: store?.harness });
  }
  const counts = {};
  const undeclared = new Map();
  for (const file of files) {
    for (const row of store.entries(file)) {
      const { channel, type } = kindOf(row);
      counts[channel] ??= {};
      counts[channel][type] = (counts[channel][type] ?? 0) + 1;
      const lane = roster[channel];
      if (lane && (lane.handled.includes(type) || lane.ignored[type] !== undefined)) continue;
      const key = `${channel}.${type}`;
      const entry = undeclared.get(key) ?? { channel, type, count: 0, example: file };
      entry.count += 1;
      undeclared.set(key, entry);
    }
  }
  const unusedHandled = [];
  for (const [channel, lane] of Object.entries(roster)) {
    for (const type of lane.handled) {
      if (!counts[channel]?.[type]) unusedHandled.push({ channel, type });
    }
  }
  return {
    swept: files.length,
    counts,
    undeclared: [...undeclared.values()].sort((a, b) => `${a.channel}.${a.type}`.localeCompare(`${b.channel}.${b.type}`)),
    unusedHandled,
  };
}

/**
 * Project every file and run the adapter's fidelity probes against raw + projection.
 * `project(file)` is the one read the consumers perform — the converter, then the annotation
 * (a probe judges the annotated trajectory; claim events are the annotator's). `traceStatus`
 * is injected (the RUNTIME/DRIFT split is the doctor's concept) — a projection or probe
 * error is classified, never lost.
 * @returns {Promise<{probes: Array<{probe, applicable, failed: Array<{file, detail}>}>,
 *                    projectionErrors: Array<{file, status, detail}>}>}
 */
export async function fidelityOf({ store, project, fidelity, files, traceStatus }) {
  const probes = Object.keys(fidelity ?? {}).map((name) => ({ probe: name, applicable: 0, failed: [] }));
  if (probes.length === 0) {
    throw new TraceCensusError('OATHE_TRACE_CENSUS_ROSTER_MISSING',
      `the '${store?.harness}' traces capability declares no fidelity probes`, { harness: store?.harness });
  }
  const projectionErrors = [];
  for (const file of files) {
    let trajectory;
    try {
      trajectory = await project(file);
    } catch (e) {
      // An empty session (opened, nothing said) is a real store state, not drift.
      const status = e?.code === 'ATIF_NO_STEPS' ? 'empty' : traceStatus(e);
      projectionErrors.push({ file, status, detail: String(e?.message || e) });
      continue;
    }
    const entries = store.entries(file);
    for (const row of probes) {
      try {
        const seen = await fidelity[row.probe](entries, trajectory, { store, file });
        if (!seen.applicable) continue;
        row.applicable += 1;
        if (!seen.ok) row.failed.push({ file, detail: seen.detail });
      } catch (e) {
        row.failed.push({ file, detail: `${traceStatus(e)}: ${String(e?.message || e)}` });
      }
    }
  }
  return { probes, projectionErrors };
}
