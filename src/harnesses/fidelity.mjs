// The fidelity probes — ONE probe logic for every engine (DRY), parameterized by the
// adapter's raw-record extractors. A probe answers: does the projection CARRY what the raw
// record carries? `applicable` is the honesty valve — a record with no tool calls owes no
// tool-call fidelity; a probe applicable to nothing is n/a, never a stolen pass or a failure.

const PASS = Object.freeze({ applicable: true, ok: true, detail: null });
const NA = Object.freeze({ applicable: false, ok: true, detail: null });

/**
 * @param {{
 *   rawCalls: (entries) => Array<{id: string, hasSource: boolean}>|Promise<Array<{id, hasSource}>>,
 *   hasRawTokens: (entries) => boolean,
 *   hasOatheActs: (entries) => Promise<boolean>,
 *   childIds: (entries, trajectory, {store, file}) => Array<string>|Promise<Array<string>>,
 *   rawItems: (entries) => Array<{type: string, id: string}>,
 *   inboundTexts: (entries) => Array<string>,
 * }} extractors — the adapter's readers of its own raw format; the trajectory a probe sees is
 *    the ANNOTATED one (claim events are the annotator's), the file the record it came from.
 *    rawItems: the record's correlatable items (a second source for the same actions) — an
 *    engine with no item stream returns none and the cross-source probe is n/a for it.
 *    inboundTexts: the bodies of messages OTHER agents or the harness sent this thread —
 *    what must never surface as this agent's own SAID.
 */
export function makeFidelity({ rawCalls, hasRawTokens, hasOatheActs, childIds, rawItems, inboundTexts }) {
  return Object.freeze({
    'tool-call-args': async (entries, trajectory) => {
      const raw = await rawCalls(entries);
      if (raw.length === 0) return NA;
      const projected = new Map();
      for (const step of trajectory.steps ?? []) {
        for (const call of step.tool_calls ?? []) projected.set(call.tool_call_id, call);
      }
      for (const { id, hasSource } of raw) {
        const call = projected.get(id);
        if (!call) {
          return { applicable: true, ok: false, detail: `raw call '${id}' is missing from the projection [OATHE_TRACE_FIDELITY_EMPTY_ARGS]` };
        }
        if (hasSource && Object.keys(call.arguments ?? {}).length === 0) {
          return {
            applicable: true,
            ok: false,
            detail: `raw call '${id}' carries its command source; the projection carries arguments {} [OATHE_TRACE_FIDELITY_EMPTY_ARGS]`,
          };
        }
      }
      return PASS;
    },
    'token-metrics': async (entries, trajectory) => {
      if (!hasRawTokens(entries)) return NA;
      // The ROOT's own steps — final_metrics folds the children's usage in, which could mask
      // a root whose usage the projection lost.
      const own = (trajectory.steps ?? []).reduce((n, s) => n + (s.metrics?.prompt_tokens ?? 0) + (s.metrics?.completion_tokens ?? 0), 0);
      if (own > 0) return PASS;
      return { applicable: true, ok: false, detail: 'raw token accounting present; the projection\'s own steps carry none [OATHE_TRACE_FIDELITY_ZERO_METRICS]' };
    },
    'claim-events': async (entries, trajectory) => {
      if (!(await hasOatheActs(entries))) return NA;
      const survived = (trajectory.steps ?? []).some((s) => (s.extra?.oathe?.claim_events ?? []).length > 0);
      if (survived) return PASS;
      return { applicable: true, ok: false, detail: 'the raw record calls an oathe verb; the projection carries no claim_events [OATHE_TRACE_FIDELITY_CLAIMS_LOST]' };
    },
    'subagent-embedding': async (entries, trajectory, { store, file }) => {
      const ids = await childIds(entries, trajectory, { store, file });
      if (ids.length === 0) return NA;
      const embedded = new Set((trajectory.subagent_trajectories ?? []).map((c) => c.trajectory_id));
      const missing = ids.filter((id) => !embedded.has(id));
      if (missing.length === 0) return PASS;
      return { applicable: true, ok: false, detail: `children not embedded: ${missing.join(', ')} [OATHE_TRACE_FIDELITY_SUBAGENTS_LOST]` };
    },
    // Two sources for one action (the response_item rows and the item stream) must agree in
    // the projection: an item that completed no call is a join that failed, and a result whose
    // text states one exit code while the record states another landed on the wrong call.
    'cross-source': async (entries, trajectory) => {
      if (rawItems(entries).length === 0) return NA;
      const orphans = trajectory.extra?.record?.uncorrelated_items;
      if (orphans) {
        const names = Object.entries(orphans).map(([type, n]) => `${type}×${n}`).join(', ');
        return { applicable: true, ok: false, detail: `uncorrelated items completed no call: ${names} [OATHE_TRACE_FIDELITY_CROSS_SOURCE]` };
      }
      const { statedExitCode } = await import('../oathe-annotator.mjs');
      for (const step of trajectory.steps ?? []) {
        for (const result of step.observation?.results ?? []) {
          const structural = result.extra?.record?.exit_code;
          const stated = statedExitCode(result.content);
          if (Number.isInteger(structural) && stated !== null && stated !== structural) {
            return {
              applicable: true,
              ok: false,
              detail: `result of '${result.source_call_id}' states exit code ${stated} in its text while the record says ${structural} [OATHE_TRACE_FIDELITY_CROSS_SOURCE]`,
            };
          }
        }
      }
      return PASS;
    },
    // The 2026-08-31 misattribution, held closed: a message another agent sent this thread
    // (a child's answer, a task-notification) that surfaces as an AGENT step's own message is
    // the agent claiming words it never said. Bodies are compared on their first 200
    // whitespace-normalized characters — the way a body would be quoted, not the way it was stored.
    attribution: async (entries, trajectory) => {
      const bodies = inboundTexts(entries).map((text) => collapse(text).slice(0, 200)).filter((b) => b.length > 0);
      if (bodies.length === 0) return NA;
      for (const step of trajectory.steps ?? []) {
        if (step.source !== 'agent') continue;
        const said = collapse(step.message ?? ''); // whole — only the body is bounded
        const quoted = bodies.find((body) => said.includes(body));
        if (quoted !== undefined) {
          return {
            applicable: true,
            ok: false,
            detail: `step ${step.step_id} renders an inbound message as the agent's own words ("${quoted.slice(0, 60)}…") [OATHE_TRACE_FIDELITY_MISATTRIBUTED]`,
          };
        }
      }
      return PASS;
    },
  });
}

/** The comparable shape of a text: whitespace collapsed — the way a body is quoted, not stored. */
function collapse(text) {
  return String(text).replaceAll(/\s+/g, ' ').trim();
}
