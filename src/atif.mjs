// oathe — ATIF projection: the raw traces of both trace stores (Claude Code, Codex), derived at read time into Harbor's
// Agent Trajectory Interchange Format (v1.7). A projector is a CONVERTER: its output is pure
// ATIF — what a Harbor converter could also emit — with the raw-record facts ATIF has no field
// for under the converter's one namespace, `extra.record` (docs/atif-oathe.md). oathe's
// claims-vs-actions layer is the annotator's (src/oathe-annotator.mjs, `extra.oathe`), applied
// over any valid trajectory. Raw stores stay ground truth; a projector never emits an invalid
// trajectory (finalize() validates); anything unmappable is a typed refusal, never a silent
// drop. The reference models forbid unknown fields outside `extra` — so does our validator.

/** What the converters emit — what the reference converters emit (Harbor codex.py, claude_code.py). */
export const ATIF_SCHEMA_VERSION = 'ATIF-v1.7';

/** Accepted inbound: the reference models' Literal v1.0..v1.8 (v1.8 added audio content parts). */
const KNOWN_SCHEMA_VERSIONS = Object.freeze(
  Array.from({ length: 9 }, (_, i) => `ATIF-v1.${i}`),
);

export class AtifError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AtifError';
    this.code = code;
    this.details = details;
  }
}

// --------------------------------------------------------------------------- shared assembly

/** Text of a content part list (Claude tool_result content may itself be a part array). */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content
    .map((part) => part?.text ?? part?.thinking ?? '')
    .filter((t) => t !== '')
    .join('\n');
}

/**
 * The projector family's shared trajectory assembly. Subclasses implement `map(rows, file)`
 * by driving the step/observation helpers; the base owns numbering, metrics accumulation,
 * the record namespace, and validation-before-return.
 */
export class AtifProjector {
  /**
   * @param {{store: object, copiedIds?: Set<string>|null}} o  copiedIds — the row ids a PARENT
   *   already holds: a forked child begins with the parent's rows under the same ids, and a
   *   step built entirely from them is context it inherited, not work it did
   *   (is_copied_context — the RFC excludes such steps from SFT).
   */
  constructor({ store, copiedIds = null }) {
    if (!store) throw new AtifError('ATIF_STORE_REQUIRED', 'a projector needs its trace store');
    this.store = store;
    this.harness = store.harness; // the store was named by its adapter; the projector labels ATIF with the same name
    this.copiedIds = copiedIds;
  }

  /** @returns {object} a VALID ATIF trajectory (validator-asserted) */
  project(file) {
    this.steps = [];
    this.agentInfo = { name: this.harness, version: null, model_name: null };
    this.sessionId = null;
    // Raw-record facts ATIF has no field for — the converter's one namespace (extra.record).
    this.record = { source_path: file };
    this.subagents = [];
    this.rowsOf = new Map(); // step → the ids of the raw rows that built it
    this.ownerOf = new WeakMap(); // observation result → the step it sits on
    this.map(this.store.entries(file), file);
    if (this.steps.length === 0) {
      throw new AtifError('ATIF_NO_STEPS',
        `${file}: no mappable steps — a trajectory with nothing in it is not evidence`, { file });
    }
    return this.#finalize(file);
  }

  // ---- step helpers for subclasses

  pushStep(step) {
    this.steps.push({ step_id: this.steps.length + 1, ...step });
    return this.steps.at(-1);
  }

  /** A raw row (by its id) landed on `step` — what decides whether the step was inherited. */
  landed(step, rowId) {
    if (!step || rowId === undefined || rowId === null) return;
    if (!this.rowsOf.has(step)) this.rowsOf.set(step, new Set());
    this.rowsOf.get(step).add(rowId);
  }

  /** The open agent step to attach observations/content to — or null. */
  currentAgentStep() {
    const last = this.steps.at(-1);
    return last?.source === 'agent' ? last : null;
  }

  /** Attach a tool result to the step owning `callId`; refuses when nobody owns it. */
  attachResult(callId, content, { file }) {
    const owner = [...this.steps].reverse()
      .find((s) => s.tool_calls?.some((c) => c.tool_call_id === callId));
    if (!owner) {
      throw new AtifError('ATIF_UNMAPPABLE',
        `${file}: tool result for '${callId}' has no matching tool call — the trace is not `
        + 'internally consistent and the projection will not paper over it', { file, callId });
    }
    owner.observation ??= { results: [] };
    const result = { source_call_id: callId, content: textOf(content) };
    owner.observation.results.push(result);
    this.ownerOf.set(result, owner);
    return result;
  }

  buildToolCall({ id, name, args }) {
    return { tool_call_id: id, function_name: name, arguments: args ?? {} };
  }

  addSubagent(trajectory) {
    this.subagents.push(trajectory);
  }

  /**
   * The ref to a delegated child sits on the observation result of the call that delegated
   * (the reference converters' placement — Harbor qwen_code.py): found on the step owning
   * `callId`, or created there without content when the call never got an output row.
   * Refuses when nobody owns the call — a ref pointing from nowhere is not evidence.
   */
  attachRef(callId, ref, { file }) {
    const owner = [...this.steps].reverse()
      .find((s) => s.tool_calls?.some((c) => c.tool_call_id === callId));
    if (!owner) {
      throw new AtifError('ATIF_UNMAPPABLE',
        `${file}: subagent ref for call '${callId}' has no owning tool call`, { file, callId });
    }
    owner.observation ??= { results: [] };
    let result = owner.observation.results.find((r) => r.source_call_id === callId);
    if (!result) {
      result = { source_call_id: callId };
      owner.observation.results.push(result);
    }
    result.subagent_trajectory_ref = [...(result.subagent_trajectory_ref ?? []), ref];
    return result;
  }

  /** Accumulate per-turn token deltas onto a step — never overwrite what a turn already cost. */
  addMetrics(step, { prompt_tokens = 0, completion_tokens = 0, cached_tokens = 0 }) {
    const prior = step.metrics ?? { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 };
    step.metrics = {
      ...prior,
      prompt_tokens: prior.prompt_tokens + prompt_tokens,
      completion_tokens: prior.completion_tokens + completion_tokens,
      cached_tokens: prior.cached_tokens + cached_tokens,
    };
  }

  /**
   * A row type outside the harness's declared roster: quarantine VISIBLY — counted here,
   * announced in the evidence view, DRIFT in the census lane. Additions tolerate visibly;
   * only missing EXPECTED shapes refuse (founder ruling 2026-08-31).
   */
  noteUnrecognized(key) {
    this.record.unrecognized_rows ??= {};
    this.record.unrecognized_rows[key] = (this.record.unrecognized_rows[key] ?? 0) + 1;
  }

  #finalize(file) {
    if (this.copiedIds) {
      // Inherited context: a step every one of whose rows the parent already holds.
      for (const step of this.steps) {
        const rows = this.rowsOf.get(step);
        if (rows && rows.size > 0 && [...rows].every((id) => this.copiedIds.has(id))) step.is_copied_context = true;
      }
    }
    const totals = { total_prompt_tokens: 0, total_completion_tokens: 0, total_cached_tokens: 0, total_steps: this.steps.length };
    for (const step of this.steps) {
      if (!step.metrics) continue;
      totals.total_prompt_tokens += step.metrics.prompt_tokens ?? 0;
      totals.total_completion_tokens += step.metrics.completion_tokens ?? 0;
      totals.total_cached_tokens += step.metrics.cached_tokens ?? 0;
    }
    // A run that delegates is not under-counted (the reference converters' fold — Harbor
    // qwen_code.py): each child's totals already hold its own children's, so the direct
    // children's totals fold into the root's. total_steps stays this trajectory's own.
    for (const child of this.subagents) {
      totals.total_prompt_tokens += child.final_metrics?.total_prompt_tokens ?? 0;
      totals.total_completion_tokens += child.final_metrics?.total_completion_tokens ?? 0;
      totals.total_cached_tokens += child.final_metrics?.total_cached_tokens ?? 0;
    }
    const trajectory = {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: this.sessionId,
      agent: this.agentInfo,
      steps: this.steps,
      final_metrics: totals,
      extra: { record: this.record },
      ...(this.subagents.length > 0 ? { subagent_trajectories: this.subagents } : {}),
    };
    new AtifValidator().assert(trajectory, { file });
    return trajectory;
  }
}

// --------------------------------------------------------------------------- Claude

// ClaudeAtifProjector lives in src/harnesses/claude-transcript.mjs — Claude format knowledge is
// the adapter's (R-HARNESS-TOUCHPOINTS); this module stays harness-agnostic assembly.

// --------------------------------------------------------------------------- Codex

// CodexAtifProjector lives in src/harnesses/codex-rollout.mjs — codex format knowledge is
// the adapter's (R-HARNESS-TOUCHPOINTS); this module stays harness-agnostic assembly.

// --------------------------------------------------------------------------- factory

// projectorFor lives in src/harnesses/catalog.mjs — the store that owns a record projects it.

// --------------------------------------------------------------------------- claim intervals

const FOCUS_CLOSERS = new Set(['oathe_done', 'oathe_yield']);

/**
 * Claim-focused intervals of an ANNOTATED trajectory (ruling R3 §5.4): a session becomes
 * attributable to a task only from the step where it ACTS on that task through an oathe
 * speech act (claim, pickup, statement, done, yield — the annotator's claim_events), and
 * stops being attributable when the act names a different task (a switch), when done/yield
 * closes the work, or when the session ends. Steps before the first act — planning, board
 * reading, repository discussion — belong to no interval and are context, not evidence.
 *
 * @returns {Array<{task_id: string, start_index: number, end_index: number}>}
 */
export function claimIntervals(trajectory) {
  const intervals = [];
  let open = null;
  const close = (endIndex) => {
    if (open && endIndex >= open.start_index) intervals.push({ ...open, end_index: endIndex });
    open = null;
  };
  (trajectory.steps ?? []).forEach((step, index) => {
    for (const event of step.extra?.oathe?.claim_events ?? []) {
      const task = event.task_id;
      if (!task) continue; // board reads and other task-less acts focus nothing
      if (open && open.task_id !== task) close(index - 1); // explicit switch
      if (!open) open = { task_id: task, start_index: index };
      if (FOCUS_CLOSERS.has(event.verb)) close(index); // done/yield include their own step
    }
  });
  close((trajectory.steps ?? []).length - 1); // session end closes what remains open
  return intervals;
}

/**
 * The trajectory reduced to what is attributable to ONE task — what a verifier may treat as
 * that task's execution evidence. Steps: interval-scoped; no interval for the task means the
 * WHOLE step record stays (a pre-interval trace, or CLI-only work — slicing to nothing would
 * fabricate absence). Children: partitioned by their OWN claim intervals — a child naming
 * the task is kept (recursively sliced), a child positively naming only OTHER tasks is never
 * this task's evidence (the 22-sibling dilution, 2026-08-31), and a child naming nothing is
 * kept only while no sibling positively names the task. A slice that changed anything
 * renumbers step_ids (validator-safe) and announces itself in extra.oathe.sliced; an
 * untouched trajectory is returned as-is, unmarked.
 */
export function sliceForTask(trajectory, taskId) {
  const mine = claimIntervals(trajectory).filter((i) => i.task_id === taskId);
  const children = trajectory.subagent_trajectories ?? [];
  let keptChildren = children;
  if (children.length > 0) {
    const judged = children.map((child) => {
      const tasks = new Set(claimIntervals(child).map((i) => i.task_id));
      return { child, names: tasks.has(taskId), othersOnly: tasks.size > 0 && !tasks.has(taskId) };
    });
    const anyNames = judged.some((j) => j.names);
    keptChildren = judged
      .filter((j) => j.names || (!j.othersOnly && !anyNames))
      .map((j) => (j.names ? sliceForTask(j.child, taskId) : j.child));
  }
  if (mine.length === 0 && keptChildren.length === children.length) return trajectory;

  const keepIndex = new Set();
  for (const { start_index, end_index } of mine) {
    for (let i = start_index; i <= end_index; i++) keepIndex.add(i);
  }
  const keptIndices = mine.length > 0
    ? trajectory.steps.map((_, i) => i).filter((i) => keepIndex.has(i))
    : trajectory.steps.map((_, i) => i);
  const sliced = {
    ...trajectory,
    steps: keptIndices.map((i, at) => ({ ...trajectory.steps[i], step_id: at + 1 })),
    extra: {
      ...(trajectory.extra ?? {}),
      oathe: {
        ...(trajectory.extra?.oathe ?? {}),
        sliced: {
          task_id: taskId,
          original_step_ids: keptIndices.map((i) => trajectory.steps[i].step_id ?? i + 1),
          subagents_elided: children.length - keptChildren.length,
        },
      },
    },
  };
  if (children.length > 0) {
    if (keptChildren.length > 0) sliced.subagent_trajectories = keptChildren;
    else delete sliced.subagent_trajectories;
  }
  return sliced;
}

// --------------------------------------------------------------------------- evidence view

// The rendering lives in src/evidence.mjs (EvidenceRenderer — the one budget-true
// implementation); the export stays here for its consumers' stable import path.
export { renderEvidenceView } from './evidence.mjs';

// --------------------------------------------------------------------------- validator

/** Known fields per object — the reference models' extra:'forbid' posture, re-implemented. */
const KNOWN_FIELDS = Object.freeze({
  trajectory: ['schema_version', 'session_id', 'trajectory_id', 'agent', 'steps', 'notes',
    'final_metrics', 'continued_trajectory_ref', 'extra', 'subagent_trajectories'],
  agent: ['name', 'version', 'model_name', 'tool_definitions', 'extra'],
  step: ['step_id', 'timestamp', 'source', 'model_name', 'reasoning_effort', 'message',
    'reasoning_content', 'tool_calls', 'observation', 'metrics', 'is_copied_context',
    'llm_call_count', 'extra'],
  tool_call: ['tool_call_id', 'function_name', 'arguments', 'extra'],
  observation: ['results', 'extra'],
  observation_result: ['source_call_id', 'content', 'subagent_trajectory_ref', 'extra'],
  // The reference SubagentTrajectoryRef: resolvable by trajectory_id (embedded) or
  // trajectory_path (external); session_id is informational, never a key; extra forbidden.
  subagent_trajectory_ref: ['trajectory_id', 'trajectory_path', 'session_id', 'extra'],
  metrics: ['prompt_tokens', 'completion_tokens', 'cached_tokens', 'cost_usd',
    'prompt_token_ids', 'completion_token_ids', 'logprobs', 'extra'],
  final_metrics: ['total_prompt_tokens', 'total_completion_tokens', 'total_cached_tokens',
    'total_cost_usd', 'total_steps', 'extra'],
});

const STEP_SOURCES = new Set(['system', 'user', 'agent']);
const AGENT_ONLY_STEP_FIELDS = ['tool_calls', 'metrics', 'reasoning_content'];

export class AtifValidator {
  /** @returns {{ok: boolean, detail: string|null}} */
  validate(trajectory) {
    try {
      this.#trajectory(trajectory, 'trajectory');
      return { ok: true, detail: null };
    } catch (e) {
      if (e instanceof AtifError) return { ok: false, detail: e.message };
      throw e;
    }
  }

  assert(trajectory, { file } = {}) {
    const seen = this.validate(trajectory);
    if (!seen.ok) {
      throw new AtifError('ATIF_INVALID', `${file ? `${file}: ` : ''}${seen.detail}`, { file });
    }
  }

  #fail(message) {
    throw new AtifError('ATIF_INVALID', message);
  }

  #knownFields(obj, kind, where) {
    for (const key of Object.keys(obj)) {
      if (!KNOWN_FIELDS[kind].includes(key)) {
        this.#fail(`${where}: unknown field '${key}' on ${kind} — the reference models forbid `
          + "fields outside 'extra'");
      }
    }
  }

  #trajectory(t, where) {
    if (t === null || typeof t !== 'object') this.#fail(`${where}: not an object`);
    this.#knownFields(t, 'trajectory', where);
    if (!KNOWN_SCHEMA_VERSIONS.includes(t.schema_version)) {
      this.#fail(`${where}: schema_version '${t.schema_version}' is not an accepted ATIF version`);
    }
    if (!t.agent || typeof t.agent !== 'object') this.#fail(`${where}: agent required`);
    this.#knownFields(t.agent, 'agent', `${where}.agent`);
    if (!t.agent.name) this.#fail(`${where}.agent: name required`);
    if (!Array.isArray(t.steps) || t.steps.length === 0) this.#fail(`${where}: steps must be a non-empty array`);
    // The ids a ref can resolve against — the embedded children's — are known before the steps
    // are read, so a dangling trajectory_id is refused where it sits.
    const embedded = new Set((t.subagent_trajectories ?? []).map((child) => child?.trajectory_id).filter(Boolean));
    t.steps.forEach((step, at) => this.#step(step, at, `${where}.steps[${at}]`, embedded));
    if (t.final_metrics) this.#knownFields(t.final_metrics, 'final_metrics', `${where}.final_metrics`);
    if (t.subagent_trajectories !== undefined) {
      const ids = new Set();
      for (const [at, child] of t.subagent_trajectories.entries()) {
        if (!child.trajectory_id) {
          this.#fail(`${where}.subagent_trajectories[${at}]: embedded trajectories require a non-null trajectory_id`);
        }
        if (ids.has(child.trajectory_id)) {
          this.#fail(`${where}.subagent_trajectories[${at}]: duplicate trajectory_id '${child.trajectory_id}'`);
        }
        ids.add(child.trajectory_id);
        this.#trajectory(child, `${where}.subagent_trajectories[${at}]`);
      }
    }
  }

  #step(step, at, where, embedded) {
    this.#knownFields(step, 'step', where);
    if (step.step_id !== at + 1) {
      this.#fail(`${where}: step_id ${step.step_id} breaks the sequential-from-1 rule (expected ${at + 1})`);
    }
    if (!STEP_SOURCES.has(step.source)) this.#fail(`${where}: source '${step.source}' invalid`);
    if (typeof step.message !== 'string' && !Array.isArray(step.message)) {
      this.#fail(`${where}: message is required (string or content parts)`);
    }
    if (step.source !== 'agent') {
      for (const field of AGENT_ONLY_STEP_FIELDS) {
        if (step[field] !== undefined) this.#fail(`${where}: '${field}' is agent-only`);
      }
    }
    const callIds = new Set();
    for (const [ci, call] of (step.tool_calls ?? []).entries()) {
      this.#knownFields(call, 'tool_call', `${where}.tool_calls[${ci}]`);
      if (!call.tool_call_id || !call.function_name || call.arguments === undefined) {
        this.#fail(`${where}.tool_calls[${ci}]: tool_call_id, function_name and arguments are required`);
      }
      callIds.add(call.tool_call_id);
    }
    if (step.observation !== undefined) {
      this.#knownFields(step.observation, 'observation', `${where}.observation`);
      for (const [ri, result] of (step.observation.results ?? []).entries()) {
        this.#knownFields(result, 'observation_result', `${where}.observation.results[${ri}]`);
        // source_call_id is OPTIONAL (free-form environment observations — proven by Harbor's
        // own golden fixture); when present it must resolve.
        if (result.source_call_id !== undefined && result.source_call_id !== null
          && !callIds.has(result.source_call_id)) {
          this.#fail(`${where}.observation.results[${ri}]: source_call_id '${result.source_call_id}' `
            + 'matches no tool call on its step');
        }
        if (result.subagent_trajectory_ref !== undefined && result.subagent_trajectory_ref !== null) {
          this.#refs(result.subagent_trajectory_ref, `${where}.observation.results[${ri}].subagent_trajectory_ref`, embedded);
        }
      }
    }
    if (step.metrics !== undefined) this.#knownFields(step.metrics, 'metrics', `${where}.metrics`);
  }

  /**
   * A result's subagent refs (RFC 0001, v1.7): an ARRAY of SubagentTrajectoryRef — each
   * resolvable by trajectory_id (which must name an embedded child — the RFC's resolution
   * rule, held here though the reference model checks only the one-of) or by
   * trajectory_path (an external file, taken on trust); session_id rides informationally.
   */
  #refs(refs, where, embedded) {
    if (!Array.isArray(refs)) this.#fail(`${where}: subagent_trajectory_ref must be an array of refs`);
    for (const [at, ref] of refs.entries()) {
      if (ref === null || typeof ref !== 'object') this.#fail(`${where}[${at}]: not an object`);
      this.#knownFields(ref, 'subagent_trajectory_ref', `${where}[${at}]`);
      if (!ref.trajectory_id && !ref.trajectory_path) {
        this.#fail(`${where}[${at}]: a ref must be resolvable — set trajectory_id (embedded) or trajectory_path (external); session_id alone is not a key`);
      }
      if (ref.trajectory_id && !embedded.has(ref.trajectory_id)) {
        this.#fail(`${where}[${at}]: trajectory_id '${ref.trajectory_id}' names no embedded subagent trajectory`);
      }
    }
  }
}
