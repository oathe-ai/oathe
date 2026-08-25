// oathe — ATIF projection: both harnesses' raw traces, derived at read time into Harbor's
// Agent Trajectory Interchange Format (v1.7), with oathe's claims-vs-actions layer riding the
// spec's ONE sanctioned extension point (`extra`) as the documented `extra.oathe` convention
// (docs/atif-oathe.md). Raw stores stay ground truth; a projector never emits an invalid
// trajectory (finalize() validates); anything unmappable is a typed refusal, never a silent
// drop. The reference models forbid unknown fields outside `extra` — so does our validator.

import path from 'node:path';

import { ClaudeTraceStore, CodexTraceStore, TraceContractError, harnessForTracePath } from './traces.mjs';
import { makeToolDefs } from './mcp/oathe-tools.mjs';

export const ATIF_SCHEMA_VERSION = 'ATIF-v1.7';
export const OATHE_CONVENTION_VERSION = 1;

/** Accepted by the reference models (Literal v1.0..v1.7). */
const KNOWN_SCHEMA_VERSIONS = Object.freeze(
  Array.from({ length: 8 }, (_, i) => `ATIF-v1.${i}`),
);

/** The oathe speech-act verbs — derived from the server's own tool defs, never retyped. */
const OATHE_VERBS = Object.freeze(makeToolDefs().map((t) => t.name));

const EXIT_CODE_PATTERN = /[Ee]xit code:?\s+(\d+)/;

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
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content
    .map((part) => part?.text ?? part?.thinking ?? '')
    .filter((t) => t !== '')
    .join('\n');
}

/** The conservative observed-facts parse: only what the output text actually states. */
function observedFacts(resultText) {
  const match = String(resultText).match(EXIT_CODE_PATTERN);
  return match ? { exit_code: Number(match[1]) } : null;
}

/** oathe verb name for a tool call, when the call IS an oathe speech act (MCP-prefixed). */
function oatheVerbFor(functionName) {
  return OATHE_VERBS.find((verb) => functionName === verb || functionName.endsWith(`__${verb}`)) ?? null;
}

/**
 * The projector family's shared trajectory assembly. Subclasses implement `map(rows, file)`
 * by driving the step/observation helpers; the base owns numbering, metrics accumulation,
 * the extra.oathe stamp, and validation-before-return.
 */
export class AtifProjector {
  constructor({ store }) {
    if (!store) throw new AtifError('ATIF_STORE_REQUIRED', 'a projector needs its trace store');
    this.store = store;
  }

  /** @returns {object} a VALID ATIF trajectory (validator-asserted) */
  project(file) {
    this.steps = [];
    this.agentInfo = { name: this.harness, version: null, model_name: null };
    this.oatheRoot = {
      oathe_convention: OATHE_CONVENTION_VERSION,
      harness: this.harness,
      source_path: file,
    };
    this.subagents = [];
    this.map(this.store.entries(file), file);
    if (this.steps.length === 0) {
      throw new AtifError('ATIF_UNMAPPABLE',
        `${file}: no mappable steps — a trajectory with nothing in it is not evidence`, { file });
    }
    return this.#finalize(file);
  }

  // ---- step helpers for subclasses

  pushStep(step) {
    this.steps.push({ step_id: this.steps.length + 1, ...step });
    return this.steps.at(-1);
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
    const text = textOf(content);
    const result = { source_call_id: callId, content: text };
    const observed = observedFacts(text);
    if (observed) result.extra = { oathe: { observed } };
    owner.observation.results.push(result);
    return result;
  }

  /** A tool_call object with the oathe extras (files touched, speech-act marking). */
  buildToolCall({ id, name, args }) {
    const call = { tool_call_id: id, function_name: name, arguments: args ?? {} };
    if (typeof call.arguments?.file_path === 'string') {
      call.extra = { oathe: { files: [call.arguments.file_path] } };
    }
    return call;
  }

  /** Mark a step's oathe speech acts (claim/statement/done/…) from its tool calls. */
  markClaimEvents(step) {
    const events = (step.tool_calls ?? [])
      .map((call) => {
        const verb = oatheVerbFor(call.function_name);
        return verb ? { verb, task_id: call.arguments?.task_id } : null;
      })
      .filter(Boolean);
    if (events.length > 0) {
      step.extra = { ...(step.extra ?? {}), oathe: { ...(step.extra?.oathe ?? {}), claim_events: events } };
    }
  }

  addSubagent(trajectory) {
    this.subagents.push(trajectory);
  }

  #finalize(file) {
    const totals = { total_prompt_tokens: 0, total_completion_tokens: 0, total_cached_tokens: 0, total_steps: this.steps.length };
    for (const step of this.steps) {
      if (!step.metrics) continue;
      totals.total_prompt_tokens += step.metrics.prompt_tokens ?? 0;
      totals.total_completion_tokens += step.metrics.completion_tokens ?? 0;
      totals.total_cached_tokens += step.metrics.cached_tokens ?? 0;
    }
    const trajectory = {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: this.oatheRoot.session_id ?? null,
      agent: this.agentInfo,
      steps: this.steps,
      final_metrics: totals,
      extra: { oathe: this.oatheRoot },
      ...(this.subagents.length > 0 ? { subagent_trajectories: this.subagents } : {}),
    };
    new AtifValidator().assert(trajectory, { file });
    return trajectory;
  }
}

// --------------------------------------------------------------------------- Claude

const CLAUDE_NOISE_TYPES = new Set([
  'last-prompt', 'mode', 'permission-mode', 'atis-latch', 'bridge-session', 'attachment',
  'queue-operation', 'file-history-snapshot', 'ai-title',
]);

export class ClaudeAtifProjector extends AtifProjector {
  harness = 'claude';

  map(rows, file) {
    let lastMessageId = null;
    this.turnBroken = false;
    const filesTouched = new Set();
    for (const row of rows) {
      if (row.type === 'ai-title') {
        this.oatheRoot.session_title = row.aiTitle;
        continue;
      }
      if (row.type === 'file-history-snapshot') {
        for (const touched of Object.keys(row.snapshot?.trackedFileBackups ?? {})) filesTouched.add(touched);
        continue;
      }
      if (CLAUDE_NOISE_TYPES.has(row.type)) continue;
      if (row.sessionId && !this.oatheRoot.session_id) this.oatheRoot.session_id = row.sessionId;
      if (row.version && !this.agentInfo.version) this.agentInfo.version = row.version;

      if (row.type === 'assistant') {
        this.#mapAssistant(row, lastMessageId);
        lastMessageId = row.message?.id ?? null;
      } else if (row.type === 'user') {
        this.#mapUser(row, file);
      } else if (row.type === 'system') {
        this.pushStep({ source: 'system', message: textOf(row.message?.content ?? row.content ?? '') });
      }
    }
    if (filesTouched.size > 0) this.oatheRoot.files_touched = [...filesTouched];

    for (const sub of this.store.subagentsFor(file)) {
      const child = new ClaudeAtifProjector({ store: this.store }).project(sub.path);
      child.trajectory_id = sub.agent_id;
      if (sub.meta) child.extra.oathe.subagent_meta = sub.meta;
      this.addSubagent(child);
    }
  }

  #mapAssistant(row, lastMessageId) {
    const parts = Array.isArray(row.message?.content) ? row.message.content : [];
    const texts = parts.filter((p) => p.type === 'text').map((p) => p.text);
    const thinking = parts.filter((p) => p.type === 'thinking').map((p) => p.thinking);
    const calls = parts.filter((p) => p.type === 'tool_use')
      .map((p) => this.buildToolCall({ id: p.id, name: p.name, args: p.input }));
    if (row.message?.model && !this.agentInfo.model_name) this.agentInfo.model_name = row.message.model;

    // Consecutive assistant rows are one TURN (streamed content blocks): merge into the open
    // agent step — but any intervening user row (a tool result included) ENDS the turn.
    // Usage repeats per API response id, so it is added once per message id.
    let step = this.turnBroken ? null : this.currentAgentStep();
    this.turnBroken = false;
    if (!step) {
      step = this.pushStep({ source: 'agent', message: '' });
      if (row.timestamp) step.timestamp = row.timestamp;
    }
    if (texts.length > 0) step.message = [step.message, ...texts].filter((t) => t !== '').join('\n');
    if (thinking.length > 0) {
      step.reasoning_content = [step.reasoning_content, ...thinking].filter(Boolean).join('\n');
    }
    if (calls.length > 0) step.tool_calls = [...(step.tool_calls ?? []), ...calls];

    const usage = row.message?.usage;
    const messageId = row.message?.id ?? null;
    // Dedupe usage only when an API response id actually REPEATS — absent ids never match.
    if (usage && (messageId === null || messageId !== lastMessageId)) {
      const cached = usage.cache_read_input_tokens ?? 0;
      const creation = usage.cache_creation_input_tokens ?? 0;
      const prior = step.metrics ?? { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 };
      step.metrics = {
        prompt_tokens: prior.prompt_tokens + (usage.input_tokens ?? 0) + cached + creation,
        completion_tokens: prior.completion_tokens + (usage.output_tokens ?? 0),
        cached_tokens: prior.cached_tokens + cached,
        ...(creation > 0 ? { extra: { cache_creation_input_tokens: creation } } : {}),
      };
    }
    this.markClaimEvents(step);
  }

  #mapUser(row, file) {
    this.turnBroken = true;
    const content = row.message?.content;
    if (Array.isArray(content)) {
      const results = content.filter((p) => p.type === 'tool_result');
      const texts = content.filter((p) => p.type === 'text').map((p) => p.text);
      for (const result of results) this.attachResult(result.tool_use_id, result.content, { file });
      if (texts.length > 0) this.pushStep({ source: 'user', message: texts.join('\n') });
    } else {
      this.pushStep({ source: 'user', message: textOf(content) });
    }
  }
}

// --------------------------------------------------------------------------- Codex

export class CodexAtifProjector extends AtifProjector {
  harness = 'codex';

  map(rows, file) {
    const head = rows[0];
    if (head?.type !== 'session_meta') {
      throw new AtifError('ATIF_UNMAPPABLE',
        `${file}: first rollout line is '${head?.type}', expected session_meta`, { file });
    }
    const meta = head.payload ?? {};
    this.oatheRoot.session_id = meta.id ?? meta.session_id;
    this.agentInfo.version = meta.cli_version ?? null;
    const modelName = meta.model ?? meta.model_provider;
    if (!modelName) {
      throw new AtifError('ATIF_UNMAPPABLE',
        `${file}: session_meta names neither model nor model_provider — the agent identity `
        + 'cannot be stated without being invented', { file });
    }
    this.agentInfo.model_name = modelName;

    for (const row of rows.slice(1)) {
      if (row.type === 'response_item') this.#mapResponseItem(row.payload ?? {}, file);
      else if (row.type === 'event_msg' && row.payload?.type === 'token_count') {
        const step = this.currentAgentStep() ?? this.steps.at(-1);
        if (step && step.source === 'agent') {
          step.metrics = {
            prompt_tokens: row.payload.input_tokens ?? 0,
            completion_tokens: row.payload.output_tokens ?? 0,
            cached_tokens: row.payload.cached_tokens ?? 0,
          };
        }
      }
    }

    for (const child of this.#children()) this.addSubagent(child);
  }

  #children() {
    const projected = [];
    let children = [];
    try {
      children = this.store.childThreads(this.oatheRoot.session_id);
    } catch (e) {
      if (e instanceof TraceContractError && e.code === 'TRACE_CODEX_STATE_ABSENT') return projected;
      throw e;
    }
    for (const child of children) {
      if (!child.rollout_path) {
        throw new AtifError('ATIF_UNMAPPABLE',
          `codex child thread ${child.thread_id} has no rollout path — a fan-out member cannot `
          + 'be silently dropped from the evidence', { child });
      }
      const projectedChild = new CodexAtifProjector({ store: this.store }).project(child.rollout_path);
      projectedChild.trajectory_id = child.thread_id;
      projected.push(projectedChild);
    }
    return projected;
  }

  #agentStep() {
    return this.currentAgentStep() ?? this.pushStep({ source: 'agent', message: '' });
  }

  #mapResponseItem(payload, file) {
    switch (payload.type) {
      case 'message':
      case 'agent_message': {
        const text = textOf(payload.content);
        if (payload.role === 'user') {
          this.pushStep({ source: 'user', message: text });
        } else {
          const step = this.#agentStep();
          step.message = [step.message, text].filter((t) => t !== '').join('\n');
        }
        break;
      }
      case 'reasoning': {
        const step = this.#agentStep();
        const text = textOf(payload.content ?? payload.summary);
        if (text) step.reasoning_content = [step.reasoning_content, text].filter(Boolean).join('\n');
        break;
      }
      case 'function_call':
      case 'local_shell_call':
      case 'custom_tool_call': {
        const step = this.#agentStep();
        let args = payload.arguments ?? payload.action ?? {};
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            throw new AtifError('ATIF_UNMAPPABLE',
              `${file}: tool call '${payload.call_id}' carries arguments that are not JSON`, { file });
          }
        }
        step.tool_calls = [...(step.tool_calls ?? []),
          this.buildToolCall({ id: payload.call_id, name: payload.name ?? payload.type, args })];
        this.markClaimEvents(step);
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
        this.attachResult(payload.call_id, payload.output ?? payload.content, { file });
        break;
      default:
        break; // compaction/additional_tools/… — context machinery, not evidence steps
    }
  }
}

// --------------------------------------------------------------------------- factory

export function projectorFor(file, { claudeHome, codexHome } = {}) {
  return harnessForTracePath(file) === 'codex'
    ? new CodexAtifProjector({ store: new CodexTraceStore({ home: codexHome }) })
    : new ClaudeAtifProjector({ store: new ClaudeTraceStore({ home: claudeHome }) });
}

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
    t.steps.forEach((step, at) => this.#step(step, at, `${where}.steps[${at}]`));
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

  #step(step, at, where) {
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
        if (!callIds.has(result.source_call_id)) {
          this.#fail(`${where}.observation.results[${ri}]: source_call_id '${result.source_call_id}' `
            + 'matches no tool call on its step');
        }
      }
    }
    if (step.metrics !== undefined) this.#knownFields(step.metrics, 'metrics', `${where}.metrics`);
  }
}
