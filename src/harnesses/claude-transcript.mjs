// The Claude transcript projection — ALL Claude trace-format knowledge lives here, beside its
// adapter (R-HARNESS-TOUCHPOINTS), routed by the declared roster in claude-roster.mjs.
// Format facts, measured on live transcripts (Claude Code 2.1.x, 2026-08-31/09-01):
//   - consecutive assistant rows are one TURN (streamed content blocks); any user row — a
//     tool result included — ends it. Usage repeats per API response id.
//   - a user row is the PERSON's unless origin.kind says otherwise (ORIGIN_KINDS): a
//     task-notification is the harness reporting a background task — an Agent's completion
//     (its task-id IS the embedded subagent's id) or a backgrounded command (its tool-use-id
//     names the call) — never the person's words; a peer is another session's message.
//   - subagents live in <session>/subagents/agent-<id>.jsonl (+ .meta.json with the Agent
//     tool_use id), never inline; an Agent tool_use's result is an ASYNC launch receipt.

import { AtifProjector, textOf } from '../atif.mjs';
import { CLAUDE_ROSTER, ORIGIN_KINDS } from './claude-roster.mjs';

const TASK_ID = /<task-id>([^<]+)<\/task-id>/;
const TOOL_USE_ID = /<tool-use-id>([^<]+)<\/tool-use-id>/;

export class ClaudeAtifProjector extends AtifProjector {
  #responses = new WeakMap(); // step → Map(message id → its usage): the API responses behind the step
  #messageOf = new WeakMap(); // step → the message id that opened it (null: a row with no id)

  map(rows, file) {
    this.turnBroken = false;
    this.callIds = new Set(); // every tool call this record made — a notification can name one
    const filesTouched = new Set();
    const subagents = this.store.subagentsFor(file);
    this.subagentIds = new Set(subagents.map((s) => s.agent_id));
    const { handled, ignored } = CLAUDE_ROSTER.line;
    for (const row of rows) {
      if (row.type === 'ai-title') {
        this.record.session_title = row.aiTitle;
        continue;
      }
      if (row.type === 'file-history-snapshot') {
        for (const touched of Object.keys(row.snapshot?.trackedFileBackups ?? {})) filesTouched.add(touched);
        continue;
      }
      if (ignored[row.type] !== undefined) continue; // seen, judged non-evidence — the roster says why
      if (!handled.includes(row.type)) {
        this.noteUnrecognized(row.type);
        continue;
      }
      if (row.sessionId && !this.sessionId) this.sessionId = row.sessionId;
      if (row.version && !this.agentInfo.version) this.agentInfo.version = row.version;

      if (row.type === 'assistant') {
        this.#mapAssistant(row);
      } else if (row.type === 'user') {
        this.#mapUser(row, file);
      } else if (row.type === 'system') {
        this.pushStep({ source: 'system', message: textOf(row.message?.content ?? row.content ?? '') });
      }
    }
    if (filesTouched.size > 0) this.record.files_touched = [...filesTouched];

    for (const sub of subagents) {
      const child = new ClaudeAtifProjector({ store: this.store }).project(sub.path);
      child.trajectory_id = sub.agent_id;
      if (sub.meta) child.extra.record.subagent_meta = sub.meta;
      this.addSubagent(child);
      // The ref on the Agent call's receipt: meta.toolUseId IS the tool_use id (measured 2026-09-01).
      if (sub.meta?.toolUseId && this.callIds.has(sub.meta.toolUseId)) {
        this.attachRef(sub.meta.toolUseId, { trajectory_id: sub.agent_id, ...(sub.meta.agentType ? { extra: { agent_type: sub.meta.agentType } } : {}) }, { file });
      }
    }
  }

  #mapAssistant(row) {
    const parts = Array.isArray(row.message?.content) ? row.message.content : [];
    const texts = parts.filter((p) => p.type === 'text').map((p) => p.text);
    const thinking = parts.filter((p) => p.type === 'thinking').map((p) => p.thinking);
    const calls = parts.filter((p) => p.type === 'tool_use')
      .map((p) => this.buildToolCall({ id: p.id, name: p.name, args: p.input }));
    for (const call of calls) this.callIds.add(call.tool_call_id);
    if (row.message?.model && !this.agentInfo.model_name) this.agentInfo.model_name = row.message.model;

    // One API response is ONE step (the RFC's step is one inference; Harbor claude_code.py
    // bundles by message id too): its streamed blocks arrive as consecutive rows, and a
    // receipt the harness wrote between two of them — an async launch's, measured 2026-09-01:
    // three Agent rows of one message, each followed by its receipt — does not end it. The
    // message id says which response a row belongs to; a different id is a new step; a row
    // with no id merges with the open step unless a user row ended the turn.
    const messageId = row.message?.id ?? null;
    const open = this.currentAgentStep();
    const sameResponse = open !== null && messageId !== null && this.#messageOf.get(open) === messageId;
    let step = sameResponse || (messageId === null && !this.turnBroken) ? open : null;
    this.turnBroken = false;
    if (!step) {
      step = this.pushStep({ source: 'agent', message: '' });
      this.#messageOf.set(step, messageId);
      if (row.timestamp) step.timestamp = row.timestamp;
    }
    if (texts.length > 0) step.message = [step.message, ...texts].filter((t) => t !== '').join('\n');
    if (thinking.length > 0) {
      step.reasoning_content = [step.reasoning_content, ...thinking].filter(Boolean).join('\n');
    }
    if (calls.length > 0) step.tool_calls = [...(step.tool_calls ?? []), ...calls];

    if (row.message?.usage) this.#addUsage(step, messageId, row.message.usage);
  }

  /**
   * One API response is one entry, keyed by message id. A response streams as several rows
   * whose usage ACCUMULATES (Claude Code's own semantics — measured 2026-09-01 on a subagent
   * file: the first row of a message says output_tokens 1, its last 281; Harbor claude_code.py
   * reads the last row too), so the last row wins; a row with no id never collides. The step's
   * metrics are the sum over its responses and llm_call_count is how many there were — a step
   * with no usage-bearing row gets neither (nothing invented).
   */
  #addUsage(step, messageId, usage) {
    const responses = this.#responses.get(step) ?? new Map();
    responses.set(messageId ?? Symbol('no message id'), usage);
    this.#responses.set(step, responses);
    const sum = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, creation: 0 };
    for (const u of responses.values()) {
      const cached = u.cache_read_input_tokens ?? 0;
      const creation = u.cache_creation_input_tokens ?? 0;
      sum.prompt_tokens += (u.input_tokens ?? 0) + cached + creation;
      sum.completion_tokens += u.output_tokens ?? 0;
      sum.cached_tokens += cached;
      sum.creation += creation;
    }
    const { creation, ...metrics } = sum;
    step.metrics = { ...metrics, ...(creation > 0 ? { extra: { cache_creation_input_tokens: creation } } : {}) };
    step.llm_call_count = responses.size;
  }

  #mapUser(row, file) {
    this.turnBroken = true;
    const content = row.message?.content;
    if (Array.isArray(content)) {
      const results = content.filter((p) => p.type === 'tool_result');
      const texts = content.filter((p) => p.type === 'text').map((p) => p.text);
      for (const result of results) this.attachResult(result.tool_use_id, result.content, { file });
      if (texts.length > 0) this.#userText(row, texts.join('\n'));
    } else {
      this.#userText(row, textOf(content));
    }
  }

  /**
   * A user row's text, by who is speaking (ORIGIN_KINDS). The person's rows are user steps.
   * The harness's are system steps (llm_call_count 0) with the kind on the record: a
   * task-notification carries its text as an observation — with a ref when its task-id is an
   * embedded subagent; a notification naming neither a subagent nor a call this record made
   * is counted unresolved. A kind we have not reviewed still projects as the person's row
   * (dropping it would fabricate absence) and quarantines visibly as `origin.<kind>`.
   */
  #userText(row, text) {
    const kind = row.origin?.kind;
    const source = kind === undefined ? 'user' : ORIGIN_KINDS[kind];
    if (source === undefined) this.noteUnrecognized(`origin.${kind}`);
    if (source !== 'system') {
      this.pushStep({ source: 'user', message: text });
      return;
    }
    const inbound = { kind };
    const step = { source: 'system', message: text, ...(row.timestamp ? { timestamp: row.timestamp } : {}), llm_call_count: 0, extra: { record: { inbound } } };
    if (kind === 'task-notification') {
      const taskId = TASK_ID.exec(text)?.[1];
      const toolUseId = TOOL_USE_ID.exec(text)?.[1];
      if (taskId) inbound.task_id = taskId;
      if (toolUseId) inbound.tool_use_id = toolUseId;
      const ref = taskId && this.subagentIds.has(taskId) ? [{ trajectory_id: taskId }] : null;
      step.message = `[inbound task-notification${taskId ? ` ${taskId}` : ''}]`;
      step.observation = { results: [{ content: text, ...(ref ? { subagent_trajectory_ref: ref } : {}) }] };
      if (!ref && !(toolUseId && this.callIds.has(toolUseId))) {
        this.record.unresolved_inbound = (this.record.unresolved_inbound ?? 0) + 1;
      }
    }
    this.pushStep(step);
  }
}
