// oathe — the annotator: oathe's claims-vs-actions layer, applied over ANY valid ATIF
// trajectory. The converters (src/atif.mjs, src/harnesses/codex-rollout.mjs) emit pure ATIF —
// what a Harbor converter could also emit — and this module adds what oathe knows, in the
// spec's one sanctioned slot, namespaced `extra.oathe` (docs/atif-oathe.md, convention 2):
//
//   root              oathe_convention, and on export the OBLIGATION this trajectory is
//                     evidence for (org_id, task_id, work_claim_id, contract_ref, workspace,
//                     verdict)
//   step              claim_events — the oathe speech acts among the step's tool calls
//   tool call         files — the paths the call's arguments aim at
//   observation       observed — facts the output text STATES (an exit code), never inferred
//
// The annotation is a copy: annotated − extra.oathe deep-equals the input. Invalid input is
// a typed refusal (the annotator judges nothing it cannot validate). projectAnnotated is the
// one read every oathe consumer performs — the verifier, the heartbeat, the census, the
// export — so no consumer ever reads a converter output and finds the layer missing.

import { AtifValidator, AtifError } from './atif.mjs';
import { makeToolDefs } from './mcp/oathe-tools.mjs';
import { projectorFor } from './harnesses/catalog.mjs';

export const OATHE_CONVENTION_VERSION = 2;

/** The oathe speech-act verbs — derived from the server's own tool defs, never retyped. */
export const OATHE_VERBS = Object.freeze(makeToolDefs().map((t) => t.name));

// The output's OWN final status line — never a mention inside content. Measured 2026-09-01
// on four real records (25 occurrences): every "Exit code N" was inside a printed file or
// log; a match anywhere in the text was a false observation, so only the last line counts.
const EXIT_CODE_PATTERN = /[Ee]xit code:?\s+(\d+)\s*$/;

/** oathe verb name for a tool call, when the call IS an oathe speech act (MCP-prefixed), else null. */
export function oatheVerbFor(functionName) {
  const name = String(functionName ?? '');
  return OATHE_VERBS.find((verb) => name === verb || name.endsWith(`__${verb}`)) ?? null;
}

/** The exit code an output TEXT states as its own last line ("Exit code N"), else null — never inferred. */
export function statedExitCode(text) {
  const match = String(text ?? '').trimEnd().split('\n').at(-1).match(EXIT_CODE_PATTERN);
  return match ? Number(match[1]) : null;
}

/**
 * The conservative observed facts of an observation result: what the RECORD states
 * structurally (a converter's extra.record.exit_code, decoded by the harness itself) outranks
 * what the output text says; the text parse is the fallback, and only what it actually states.
 */
export function observedFacts(result) {
  const structural = result?.extra?.record?.exit_code;
  if (Number.isInteger(structural)) return { exit_code: structural };
  const stated = statedExitCode(result?.content);
  return stated === null ? null : { exit_code: stated };
}

const withOathe = (node, fields) => ({ ...(node.extra ?? {}), oathe: { ...(node.extra?.oathe ?? {}), ...fields } });

export class OatheAnnotator {
  /**
   * @param {object} trajectory  a valid ATIF trajectory (a converter's output)
   * @param {{obligation?: object|null}} o  the obligation stamped on the ROOT on export
   * @returns {object} an annotated copy — the input is untouched
   */
  annotate(trajectory, { obligation = null } = {}) {
    const seen = new AtifValidator().validate(trajectory);
    if (!seen.ok) {
      throw new AtifError('ATIF_ANNOTATE_INVALID_INPUT',
        `the annotator takes a valid ATIF trajectory — ${seen.detail}`, { detail: seen.detail });
    }
    const out = structuredClone(trajectory);
    this.#trajectory(out, obligation);
    return out;
  }

  #trajectory(t, obligation) {
    t.extra = withOathe(t, { oathe_convention: OATHE_CONVENTION_VERSION, ...(obligation ?? {}) });
    for (const step of t.steps) this.#step(step);
    for (const child of t.subagent_trajectories ?? []) this.#trajectory(child, null);
  }

  #step(step) {
    // A speech act is a tool call by an oathe verb — or, on codex, an act the record decoded
    // INSIDE an exec source that ran several things (extra.record.executions[].tool): the
    // exec stays one call, the act stays on the record. A step this trajectory INHERITED
    // (is_copied_context — a forked child's copy of the parent's turn) carries the parent's
    // acts, never this agent's claim events.
    const acts = step.is_copied_context === true ? [] : [
      ...(step.tool_calls ?? []).map((call) => ({ name: call.function_name, args: call.arguments })),
      ...(step.observation?.results ?? []).flatMap((result) => (result.extra?.record?.executions ?? [])
        .filter((ran) => ran.tool).map((ran) => ({ name: ran.tool, args: ran.arguments }))),
    ];
    const events = acts
      .map(({ name, args }) => {
        const verb = oatheVerbFor(name);
        return verb ? { verb, task_id: args?.task_id } : null;
      })
      .filter(Boolean);
    if (events.length > 0) step.extra = withOathe(step, { claim_events: events });
    for (const call of step.tool_calls ?? []) {
      if (typeof call.arguments?.file_path === 'string') call.extra = withOathe(call, { files: [call.arguments.file_path] });
    }
    for (const result of step.observation?.results ?? []) {
      const observed = observedFacts(result);
      if (observed) result.extra = withOathe(result, { observed });
    }
  }
}

/** The one read every oathe consumer performs: the owning store's converter, then the annotation. */
export async function projectAnnotated(file, { home, obligation = null } = {}) {
  const trajectory = (await projectorFor(file, { home })).project(file);
  return new OatheAnnotator().annotate(trajectory, { obligation });
}
