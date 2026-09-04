// The codex rollout projection — ALL codex trace-format knowledge lives here, beside its
// adapter (R-HARNESS-TOUCHPOINTS), routed by the declared roster in codex-roster.mjs.
// Format facts, measured on live rollouts (codex CLI 0.149–0.150, 2026-08-31/09-01):
//   - custom_tool_call carries the command as a STRING OF JS SOURCE in payload.input
//     (`const r = await tools.exec_command({cmd:"…"})`, bare object keys) — the raw source
//     is ground truth; projection recovers the inner tool and its arguments, and falls back
//     to the raw source itself, never to `{}` and never to a refusal on readable content.
//   - token_count nests under payload.info.last_token_usage (the per-turn delta;
//     total_token_usage is cumulative and summing it would double-count). A token_count
//     CLOSES one model API call — the reference converter's partition (Harbor codex.py,
//     finish_api_call) — so it is the step boundary wherever the file carries one with
//     usage; `info: null` is a documented vendor state (Harbor #970): the call happened,
//     its usage is unknown — counted, never zeros, never a refusal.
//   - reasoning rows are encrypted — no readable text. In a file with no usage-bearing
//     token_count they mark an LLM response and stay the boundary (a user-message-only
//     boundary would merge 18 calls into one step). ONE boundary per file, chosen
//     by the file's own evidence and declared in extra.record.step_boundary.
//   - the item stream (event_msg item_completed, row order call → item → output →
//     token_count) is the vendor's own decode of what the exec source wraps: an item's id is
//     its own (exec-<uuid>), so a CommandExecution/McpToolCall/FileChange completes the call
//     in the current turn still awaiting its output whose arguments agree; SubAgentActivity's
//     id IS the spawn call's; Extension (web.search) has no response_item counterpart at all.
//     Items ENRICH — a structural exit code, a recovered MCP call, the files a patch changed,
//     the thread a spawn started — and never make a step of their own except Extension.
//   - role 'developer' rows are INJECTED instructions (permissions, board text) — system
//     voice, never the agent's own words.
//   - the inter-agent bus: an ADDRESSED agent_message (author/recipient agent paths, a typed
//     first line) is never this agent's SAID. From an ancestor (the delegated brief — its
//     payload encrypted; the plaintext brief is the child's own first user row) it is a USER
//     step, the harness converters' shape for a delegated prompt; otherwise (a child's answer)
//     a SYSTEM step, llm_call_count 0, whose observation carries the message and a ref to the
//     embedded child — resolved by the author's agent_path through the spawn items or the
//     thread index; unresolvable → counted in extra.record.unresolved_inbound, never invented.
//   - function_call may carry a namespace (`collaboration` + `spawn_agent`, MCP forms with a
//     leading-underscore name) that composes into the function name.

import { AtifProjector, AtifError, textOf } from '../atif.mjs';
import { TraceContractError } from '../traces.mjs';
import { CODEX_ROLLOUT_ROSTER, CODEX_ROOT_AGENT_PATH, INTER_AGENT_MESSAGE_TYPE, codexKindOf } from './codex-roster.mjs';

/**
 * Reads the inner `tools.<name>(…)` calls out of a custom_tool_call's JS source. A balanced
 * scanner (string-aware), never a bare regex over the argument text — real commands contain
 * quotes, parens, and escapes. Argument literals use bare object keys; parsing quotes them
 * outside strings and falls back to null (the caller keeps the raw source) when the literal
 * is not data.
 */
export class ExecCallReader {
  /** @returns {Array<{tool: string, args: object|null}>} */
  read(source) {
    const src = String(source);
    const calls = [];
    const opener = /tools\.([A-Za-z_$][\w$]*)\s*\(/g;
    let match;
    while ((match = opener.exec(src))) {
      const argText = this.#balanced(src, opener.lastIndex - 1);
      if (argText === null) continue;
      const args = this.#parseArgs(argText);
      // A literal that is not pure data (a variable, a template) still STATES its string
      // fields — task_id, proposition — and the record names them, never the rest.
      calls.push({ tool: match[1], args, ...(args === null ? { literals: this.#literalFields(argText) } : {}) });
    }
    return calls;
  }

  /**
   * The top-level `key: "string"` fields of an object literal that is not pure data — the
   * fields the source states outright. Nothing is invented: a value that is not a string
   * literal (a variable, a call, a nested literal) is left out.
   * @returns {object|null} the fields, or null when none are stated
   */
  #literalFields(argText) {
    const text = this.#quoteBareKeys(argText.trim());
    const body = text.startsWith('{') && text.endsWith('}') ? text.slice(1, -1) : text;
    const fields = {};
    const pair = /"([^"\\]+)"\s*:\s*("(?:[^"\\]|\\.)*")/g;
    let depth = 0;
    let inString = null;
    let from = 0;
    const takePair = (chunk) => {
      pair.lastIndex = 0;
      const m = pair.exec(chunk.trim());
      if (m && m.index === 0) {
        try { fields[m[1]] = JSON.parse(m[2]); } catch { /* not a string literal after all */ }
      }
    };
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (inString) { if (ch === '\\') i += 1; else if (ch === inString) inString = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
      if (ch === '{' || ch === '[' || ch === '(') depth += 1;
      else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
      else if (ch === ',' && depth === 0) { takePair(body.slice(from, i)); from = i + 1; }
    }
    takePair(body.slice(from));
    return Object.keys(fields).length > 0 ? fields : null;
  }

  /** The text between the paren at `openAt` and its balanced closer — string-aware. */
  #balanced(src, openAt) {
    let depth = 0;
    let inString = null;
    for (let i = openAt; i < src.length; i += 1) {
      const ch = src[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') inString = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) return src.slice(openAt + 1, i);
      }
    }
    return null;
  }

  #parseArgs(argText) {
    const text = argText.trim();
    if (text === '') return null;
    try { return JSON.parse(text); } catch { /* bare-keyed object literal next */ }
    try { return JSON.parse(this.#quoteBareKeys(text)); } catch { return null; }
  }

  /** Quote bare identifier keys outside string literals — the live literals use them. */
  #quoteBareKeys(text) {
    let out = '';
    let inString = null;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        out += ch;
        if (ch === '\\') { out += text[i + 1] ?? ''; i += 1; } else if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") { inString = ch; out += ch; continue; }
      if (/[A-Za-z_$]/.test(ch)) {
        let end = i;
        while (end < text.length && /[\w$]/.test(text[end])) end += 1;
        let after = end;
        while (after < text.length && /\s/.test(text[after])) after += 1;
        if (text[after] === ':') {
          out += `"${text.slice(i, end)}"`;
          i = end - 1;
          continue;
        }
      }
      out += ch;
    }
    return out;
  }
}

/** The inner tools whose item is a CommandExecution — what a ledger entry named `exec_command` completes to. */
const COMMAND_TOOLS = new Set(['exec_command', 'write_stdin']);
/** Code mode names an MCP act `mcp__<server>__<tool>` — the McpToolCall item completes it. */
const MCP_PREFIX = 'mcp__';

export class CodexAtifProjector extends AtifProjector {
  #execReader = new ExecCallReader();

  map(rows, file) {
    const head = rows[0];
    if (head?.type !== 'session_meta') {
      throw new AtifError('ATIF_UNMAPPABLE',
        `${file}: first rollout line is '${head?.type}', expected session_meta`, { file });
    }
    const meta = head.payload ?? {};
    this.sessionId = meta.id ?? meta.session_id;
    this.agentInfo.version = meta.cli_version ?? null;
    // The model is the turn's, not the session's: session_meta names only the provider
    // (measured 2026-09-01: no rollout carries a model there), and "openai" is not a model.
    // The first turn_context's model is the agent's — Harbor codex.py reads the same; none
    // means null, never something invented.
    this.agentInfo.model_name = rows.find((r) => r.type === 'turn_context' && typeof r.payload?.model === 'string')?.payload.model ?? null;
    // Who this thread is on the inter-agent bus: a child knows its path from its spawn; the root is /root.
    this.selfPath = meta.source?.subagent?.thread_spawn?.agent_path ?? CODEX_ROOT_AGENT_PATH;
    this.agentThreads = new Map(); // agent_path → agent_thread_id, from the spawn items (the index is the fallback)
    this.indexedThreads = null; // the thread index's children, read once when an author needs resolving
    this.breakAgent = false;
    this.callOpen = false; // an agent row landed since the last token_count — a call a count can close
    this.turnId = null;
    this.awaiting = []; // calls pushed and not yet answered — what an item can complete
    this.completed = []; // calls answered, with their result — a command can outlive its call
    this.callsById = new Map(); // every call, for the items whose id IS a call id
    this.spawnThreads = new Map(); // agent_thread_id → the call that started it (completed items key by thread)
    this.filesTouched = new Set();
    // Every response_item id this record holds — what a forked child (fork_turns:"all")
    // begins with under the same ids, and therefore inherited rather than did.
    this.rowIds = new Set(rows.filter((r) => r.type === 'response_item' && r.payload?.id).map((r) => r.payload.id));
    // ONE boundary per file, from the file's own evidence (measured row order: call → item →
    // output → token_count): a usage-bearing token_count anywhere means the model's API calls
    // partition the steps; none means the reasoning rows do.
    this.record.step_boundary = rows.some((r) => r.type === 'event_msg' && r.payload?.type === 'token_count' && r.payload.info?.last_token_usage)
      ? 'token_count' : 'reasoning';

    for (const row of rows.slice(1)) {
      const { channel, type } = codexKindOf(row);
      if (channel === 'item' && type === undefined) {
        throw new AtifError('ATIF_CODEX_ITEM_SHAPE',
          `${file}: item_completed carries no item — the typed stream this projector relies on is unreadable, not empty`, { file });
      }
      const lane = CODEX_ROLLOUT_ROSTER[channel];
      if (lane.ignored[type] !== undefined) continue; // seen, judged non-evidence — the roster says why
      if (!lane.handled.includes(type)) {
        // An addition codex made that we have not reviewed: quarantine VISIBLY (counted here,
        // announced in the evidence view, DRIFT in the census lane) — never a refusal, never silence.
        this.noteUnrecognized(channel === 'line' ? type : `${channel}.${type}`);
        continue;
      }
      if (channel === 'response_item') this.#mapResponseItem(row, file);
      else if (channel === 'item') this.#mapItem(row, file);
      else if (channel === 'event_msg' && type === 'token_count') this.#mapTokenCount(row.payload ?? {}, file);
      else if (type === 'turn_context') {
        this.breakAgent = true; // turns are step boundaries
        this.turnId = row.payload?.turn_id ?? null;
      } else if (type === 'compacted') {
        // A synthetic step: no model was called to produce it (llm_call_count 0, the RFC's
        // deterministic-dispatch reading), stamped with the row's own clock.
        this.pushStep({ source: 'system', message: '[context compacted]', ...(row.timestamp ? { timestamp: row.timestamp } : {}), llm_call_count: 0 });
      }
      // a resume-appended mid-file session_meta changes nothing — identity is the head's
    }
    if (this.filesTouched.size > 0) this.record.files_touched = [...this.filesTouched];

    for (const child of this.#children()) this.addSubagent(child);
  }

  /** The thread index's children of this thread — none when this machine keeps no index. */
  #childThreads() {
    if (this.indexedThreads === null) {
      try {
        this.indexedThreads = this.store.childThreads(this.sessionId);
      } catch (e) {
        if (!(e instanceof TraceContractError && e.code === 'TRACE_CODEX_STATE_ABSENT')) throw e;
        this.indexedThreads = [];
      }
    }
    return this.indexedThreads;
  }

  #children() {
    const projected = [];
    const children = this.#childThreads();
    for (const child of children) {
      if (!child.rollout_path) {
        throw new AtifError('ATIF_UNMAPPABLE',
          `codex child thread ${child.thread_id} has no rollout path — a fan-out member cannot `
          + 'be silently dropped from the evidence', { child });
      }
      const projectedChild = new CodexAtifProjector({ store: this.store, copiedIds: this.rowIds }).project(child.rollout_path);
      projectedChild.trajectory_id = child.thread_id;
      // Who this child was and how its spawn ended, in the record's own words — parity with
      // Claude's subagent_meta. parent_thread_id is redundant (the embedding IS the parent).
      const spawnMeta = { ...(child.spawn ?? {}) };
      delete spawnMeta.parent_thread_id;
      projectedChild.extra.record.subagent_meta = { kind: 'thread_spawn', status: child.status ?? null, ...spawnMeta };
      projected.push(projectedChild);
      // The ref on the spawn call's receipt: the call SubAgentActivity(started) tied to this
      // thread, else the spawn call whose task_name is the child's nickname (the index's).
      const call = this.spawnThreads.get(child.thread_id) ?? this.#spawnCallFor(child.spawn);
      if (call) {
        const agentPath = call.extra?.record?.agent_path ?? child.spawn?.agent_path ?? null;
        this.attachRef(call.tool_call_id, { trajectory_id: child.thread_id, ...(agentPath ? { extra: { agent_path: agentPath } } : {}) }, { file: child.rollout_path });
      }
    }
    return projected;
  }

  /** The spawn call that named this child by task_name, when no item tied the thread to a call. */
  #spawnCallFor(spawn) {
    const nickname = spawn?.agent_nickname ?? spawn?.agent_path?.split('/').at(-1);
    if (!nickname) return null;
    return [...this.callsById.values()].find((call) => /spawn_agent$/.test(call.function_name)
      && call.arguments?.task_name === nickname && !call.extra?.record?.agent_thread_id) ?? null;
  }

  /**
   * The open agent step — or a fresh one when a boundary (a turn, a closed API call, a
   * reasoning row under that boundary) closed the last; a fresh step wears the clock of the
   * row that opened it.
   */
  #agentStep(row) {
    this.callOpen = true;
    const open = this.breakAgent ? null : this.currentAgentStep();
    this.breakAgent = false;
    if (open) return open;
    const step = this.pushStep({ source: 'agent', message: '' });
    if (row?.timestamp) step.timestamp = row.timestamp;
    return step;
  }

  /** The last agent step in the record — where a model API call's accounting lands. */
  #lastAgentStep() {
    return [...this.steps].reverse().find((s) => s.source === 'agent') ?? null;
  }

  /**
   * A model API call ended: count it on its step (llm_call_count) and, under the token_count
   * boundary, close the step. A count with no call to close — no agent row since the last
   * count: nothing at all yet, or a compaction's turn-start re-emission (measured 2026-09-02:
   * the same last_token_usage again, right after turn_context) — is an orphan: counted in the
   * record, never attributed to anyone, never a second call on a step already closed.
   */
  #closeCall(step) {
    this.callOpen = false;
    if (!step) {
      this.record.orphan_token_counts = (this.record.orphan_token_counts ?? 0) + 1;
      return;
    }
    step.llm_call_count = (step.llm_call_count ?? 0) + 1;
    if (this.record.step_boundary === 'token_count') this.breakAgent = true;
  }

  /** The per-call delta, accumulated — a missing shape refuses, zeros would be a lie. */
  #mapTokenCount(payload, file) {
    const open = this.callOpen ? this.#lastAgentStep() : null;
    if (payload.info === null) {
      // A documented vendor state (Harbor #970; 2 local occurrences): the call happened,
      // its usage is unknown — the call counts and closes, the metrics stay absent.
      this.#closeCall(open);
      return;
    }
    const last = payload.info?.last_token_usage;
    if (!last || typeof last !== 'object') {
      throw new AtifError('ATIF_CODEX_TOKEN_SHAPE',
        `${file}: token_count carries no info.last_token_usage — the shape this projector `
        + `relies on is gone (saw keys: ${Object.keys(payload).join(', ')}); metrics must `
        + 'never silently become zeros', { file, payload_keys: Object.keys(payload) });
    }
    // A count whose last usage is all zero closed no call either: a context-size report
    // (measured 2026-09-02, after a compaction: input 0, output 0, total = the new window).
    const step = (last.input_tokens || last.output_tokens) ? open : null;
    if (step) {
      this.addMetrics(step, {
        prompt_tokens: last.input_tokens ?? 0,
        completion_tokens: last.output_tokens ?? 0,
        cached_tokens: last.cached_input_tokens ?? 0,
      });
    }
    this.#closeCall(step);
  }

  /**
   * A call lands on a step and waits for its output — and for the items that decode it.
   * `inner` is how many calls an exec source names (the reader's count): one may be recovered
   * from its item, several stay one exec whose record lists what ran inside.
   */
  #pushCall(step, call, { inner = 1, executions = [] } = {}) {
    step.tool_calls = [...(step.tool_calls ?? []), call];
    const entry = { call, turn: this.turnId, inner, enrich: null, executions };
    if (executions.length > 0) this.#ledger(entry);
    this.awaiting.push(entry);
    this.callsById.set(call.tool_call_id, call);
  }

  /**
   * What ran INSIDE a call belongs to the call and is on the record the moment it is known
   * (ruling 2026-09-04): the source names the inner calls at call-start; the items complete
   * them. One array, shared by the entry and the call — a completion is visible at once, and
   * a call whose cell is still running (a blocking done inside it) already shows its acts.
   */
  #ledger(entry) {
    entry.call.extra = { ...(entry.call.extra ?? {}), record: { ...(entry.call.extra?.record ?? {}), executions: entry.executions } };
    return entry.executions;
  }

  /**
   * The output answers the call; whatever the items decoded meanwhile rides the result
   * (extra.record), and the call stays reachable for a command that outlives it.
   */
  attachResult(callId, content, { file, rowId = null }) {
    const result = super.attachResult(callId, content, { file });
    this.landed(this.ownerOf.get(result), rowId);
    const at = this.awaiting.findIndex((e) => e.call.tool_call_id === callId);
    if (at >= 0) {
      const [entry] = this.awaiting.splice(at, 1);
      entry.result = result;
      this.completed.push(entry);
      this.#stampResult(entry);
    }
    return result;
  }

  /**
   * What the items decoded for a call, on its result: exactly one command → its exit_code;
   * several (one exec source can run many — measured up to 9) → the executions, each with
   * its command and exit code; plus whatever else an item enriched (files_changed).
   * Rebuilt whole each time, so a late completion never leaves a stale single exit code.
   */
  #stampResult(entry) {
    // Outcomes on the result: exactly one command → its exit_code, plus whatever an item
    // enriched (files_changed). The ledger of what ran is the CALL's (#ledger).
    const record = { ...(entry.enrich ?? {}) };
    const [only] = entry.executions;
    if (entry.executions.length === 1 && only && 'command' in only && Number.isInteger(only.exit_code)) {
      record.exit_code = only.exit_code;
    }
    if (Object.keys(record).length > 0) entry.result.extra = { ...(entry.result.extra ?? {}), record };
  }

  /** The next ledger entry still awaiting its item that `accepts`, else null. */
  #pending(entry, accepts) {
    return entry.executions.find((ran) => ran.pending === true && accepts(ran)) ?? null;
  }

  /** Whether an item will complete an inner call's ledger entry: commands (CommandExecution) and MCP acts (McpToolCall). */
  #expectsItem(tool) {
    return COMMAND_TOOLS.has(tool) || tool.startsWith(MCP_PREFIX);
  }

  /**
   * An item completes the entry the source named for it — or, when the source named none, is
   * appended. The ledger rides the call only when there is genuinely more than one thing inside
   * it (the source names several, or the items reveal several): one command IS the call, and
   * its exit code is the result's.
   */
  #complete(entry, accepts, fields) {
    const slot = this.#pending(entry, accepts);
    const done = slot ? Object.assign(slot, fields) : { ...fields };
    if (slot) delete slot.pending; else entry.executions.push(done);
    if (entry.inner > 1 || entry.executions.length > 1) this.#ledger(entry);
    return done;
  }

  /** The most recent call in the current turn still awaiting its output that `matches`. */
  #completing(matches) {
    for (let i = this.awaiting.length - 1; i >= 0; i -= 1) {
      const entry = this.awaiting[i];
      if (entry.turn === this.turnId && matches(entry.call)) return entry;
    }
    return null;
  }

  /**
   * The call a decoded command belongs to. A parsed call names its command — match it
   * exactly, awaiting first. A raw exec source (a variable, a template, several calls in one
   * Promise.all) is the OLDEST such call still running: commands run in dispatch order. A
   * command can outlive its call (exec_command yields after yield_time_ms; write_stdin
   * continues it; the CommandExecution completes after the output row): then it is the
   * completed call in this turn that named it, else the most recent completed raw exec that
   * has no command yet, else the most recent completed raw exec. Nothing → null.
   */
  #commandHome(tail) {
    const parsed = (e) => tail !== undefined && e.call.arguments?.cmd === tail;
    const raw = (e) => typeof e.call.arguments?.input === 'string';
    const awaiting = this.awaiting.filter((e) => e.turn === this.turnId);
    const completed = this.completed.filter((e) => e.turn === this.turnId);
    return [...awaiting].reverse().find(parsed)
      ?? awaiting.find(raw)
      ?? [...completed].reverse().find(parsed)
      ?? [...completed].reverse().find((e) => raw(e) && e.executions.length === 0)
      ?? [...completed].reverse().find(raw)
      ?? null;
  }

  /** An item that completes no call is counted in the record — visible, never lost, never invented onto a call. */
  #uncorrelated(item) {
    this.record.uncorrelated_items ??= {};
    this.record.uncorrelated_items[item.type] = (this.record.uncorrelated_items[item.type] ?? 0) + 1;
  }

  #mapItem(row, file) {
    const item = row.payload.item;
    switch (item.type) {
      case 'CommandExecution': {
        const tail = Array.isArray(item.command) ? item.command.at(-1) : undefined;
        const entry = this.#commandHome(tail);
        if (!entry) return this.#uncorrelated(item);
        this.#complete(entry, (ran) => COMMAND_TOOLS.has(ran.tool),
          { command: tail, ...(Number.isInteger(item.exit_code) ? { exit_code: item.exit_code } : {}) });
        if (entry.result) this.#stampResult(entry); // a late completion lands on the answered call
        return;
      }
      case 'McpToolCall': {
        const name = `${MCP_PREFIX}${item.server}__${item.tool}`;
        const names = (call) => call.function_name === name
          || (typeof call.arguments?.input === 'string' && call.arguments.input.includes(`tools.${name}`));
        // Awaiting first; an item can also complete after the output row (measured) — then it
        // belongs to the most recent answered call in this turn that names the act.
        const entry = this.#completing(names)
          ?? [...this.completed].reverse().find((e) => e.turn === this.turnId && names(e.call))
          ?? null;
        if (!entry) return this.#uncorrelated(item);
        if (entry.inner === 1) {
          // One inner call: the exec IS this act. The source named it at call-start (with the
          // literal fields it stated); the item knows the whole argument set — the record ends
          // complete, never {input: raw} when it knows better.
          entry.call.function_name = name;
          entry.call.arguments = item.arguments ?? {};
          return;
        }
        // Several inner calls: the exec stays one call; the item completes the ledger entry
        // the source named for it (or appends, when the source named none).
        this.#complete(entry, (ran) => ran.tool === name, { tool: name, arguments: item.arguments ?? {}, status: item.status ?? 'completed' });
        return;
      }
      case 'FileChange': {
        const files = Object.keys(item.changes ?? {});
        for (const changed of files) this.filesTouched.add(changed);
        const entry = this.#completing(() => true);
        if (!entry) return this.#uncorrelated(item);
        entry.enrich = { ...(entry.enrich ?? {}), files_changed: files };
        return;
      }
      case 'SubAgentActivity': {
        // Measured: started and interacted carry the CALL's id (spawn_agent, send_message);
        // completed carries its own and keys by the thread the spawn started.
        if (item.kind === 'completed') {
          if (!this.spawnThreads.has(item.agent_thread_id)) this.#uncorrelated(item);
          return;
        }
        const call = this.callsById.get(item.id);
        if (!call) return this.#uncorrelated(item);
        if (item.kind === 'started') {
          if (!item.agent_thread_id) {
            throw new AtifError('ATIF_CODEX_ITEM_SHAPE',
              `${file}: SubAgentActivity(started) for '${item.id}' names no agent_thread_id — the spawn `
              + 'linkage this projector relies on is unreadable', { file, call_id: item.id });
          }
          call.extra = { ...(call.extra ?? {}), record: { agent_thread_id: item.agent_thread_id, ...(item.agent_path ? { agent_path: item.agent_path } : {}) } };
          this.spawnThreads.set(item.agent_thread_id, call);
          if (item.agent_path) this.agentThreads.set(item.agent_path, item.agent_thread_id);
        }
        return;
      }
      case 'Extension': {
        // An action with no response_item counterpart (web.search): the item is the call and
        // its results are the observation.
        const step = this.#agentStep(row);
        const call = this.buildToolCall({ id: item.id, name: item.kind, args: { query: item.query, action: item.action } });
        this.#pushCall(step, call);
        this.attachResult(item.id, JSON.stringify(item.results ?? []), { file });
        return;
      }
      default:
        throw new AtifError('ATIF_UNMAPPABLE',
          `${file}: roster-handled item '${item.type}' has no mapping — the roster and the projector drifted apart`, { file });
    }
  }

  /** The thread an agent path names — the spawn item's word first, else the index's. */
  #threadFor(agentPath) {
    return this.agentThreads.get(agentPath)
      ?? this.#childThreads().find((child) => child.spawn?.agent_path === agentPath)?.thread_id
      ?? null;
  }

  /**
   * An addressed agent_message — the inter-agent bus. Never this agent's SAID: from an ancestor
   * it is the delegated brief (a USER step, the address on the record); otherwise a child's
   * answer (a SYSTEM step, llm_call_count 0, the message as an observation with a ref to the
   * embedded child). An encrypted payload is said so; an author no spawn names is counted.
   */
  #inbound(row) {
    const { author, recipient, content } = row.payload;
    const parts = Array.isArray(content) ? content : [];
    const text = textOf(parts) + (parts.some((p) => p?.type === 'encrypted_content') ? '\n[payload encrypted]' : '');
    const messageType = INTER_AGENT_MESSAGE_TYPE.exec(text)?.[1] ?? null;
    const inbound = { author, recipient, ...(messageType ? { message_type: messageType } : {}) };
    const stamp = row.timestamp ? { timestamp: row.timestamp } : {};
    if (recipient === this.selfPath && this.selfPath.startsWith(`${author}/`)) {
      this.landed(this.pushStep({ source: 'user', message: text, ...stamp, extra: { record: { inbound } } }), row.payload.id);
      return;
    }
    // A ref must RESOLVE (the RFC's rule): only a child this record embeds — one the thread
    // index carries — gets one. A thread the spawn item names but the index does not carry
    // (no state db, a child written elsewhere) rides the record as agent_thread_id, counted
    // unresolved: nothing is lost, nothing is pointed at that is not there.
    const threadId = recipient === this.selfPath ? this.#threadFor(author) : null;
    const embedded = threadId !== null && this.#childThreads().some((child) => child.thread_id === threadId);
    if (threadId !== null && !embedded) inbound.agent_thread_id = threadId;
    if (!embedded) this.record.unresolved_inbound = (this.record.unresolved_inbound ?? 0) + 1;
    this.landed(this.pushStep({
      source: 'system',
      message: `[inbound ${messageType ?? 'message'} from ${author}]`,
      ...stamp,
      llm_call_count: 0,
      observation: { results: [{ content: text, ...(embedded ? { subagent_trajectory_ref: [{ trajectory_id: threadId }] } : {}) }] },
      extra: { record: { inbound } },
    }), row.payload.id);
  }

  #mapResponseItem(row, file) {
    const payload = row.payload ?? {};
    switch (payload.type) {
      case 'message':
      case 'agent_message': {
        if (payload.type === 'agent_message' && payload.recipient) {
          this.#inbound(row);
          break;
        }
        const text = textOf(payload.content);
        if (payload.role === 'user') {
          this.landed(this.pushStep({ source: 'user', message: text }), payload.id);
        } else if (payload.role === 'developer') {
          // Injected instructions (permissions, board text) — never the agent's own words.
          this.landed(this.pushStep({ source: 'system', message: text }), payload.id);
        } else {
          const step = this.#agentStep(row);
          step.message = [step.message, text].filter((t) => t !== '').join('\n');
          this.landed(step, payload.id);
        }
        break;
      }
      case 'reasoning': {
        // Under the reasoning boundary (no usage-bearing token_count in this file) a reasoning
        // row marks an LLM response: if the open step already carries content, this is the
        // NEXT response — close it. Under the token_count boundary the count closes the call.
        // The content itself is usually encrypted; the boundary is the evidence even then.
        const open = this.currentAgentStep();
        if (this.record.step_boundary === 'reasoning' && open
          && (open.tool_calls?.length || open.message !== '' || open.reasoning_content)) {
          this.breakAgent = true;
        }
        const text = textOf(payload.content ?? payload.summary);
        if (text) {
          const step = this.#agentStep(row);
          step.reasoning_content = [step.reasoning_content, text].filter(Boolean).join('\n');
          this.landed(step, payload.id);
        }
        break;
      }
      case 'custom_tool_call': {
        if (typeof payload.input !== 'string' || !payload.name) {
          throw new AtifError('ATIF_CODEX_CALL_SHAPE',
            `${file}: custom_tool_call '${payload.call_id}' carries no input source — the `
            + 'action this projector relies on is unreadable, not empty', { file, call_id: payload.call_id });
        }
        const inner = this.#execReader.read(payload.input);
        // Exactly one inner call → that call IS the action, named the moment the cell is
        // written (oathe speech acts surface by their real names): data arguments ride whole;
        // a literal that is not pure data rides the fields it states beside the raw source, and
        // the item completes it. Several inner calls → the exec stays one call and its ledger
        // names every inner call from the source, in dispatch order, for the items to complete.
        const single = inner.length === 1 ? inner[0] : null;
        const execStep = this.#agentStep(row);
        this.#pushCall(execStep, this.buildToolCall({
          id: payload.call_id,
          name: single ? single.tool : (payload.name ?? payload.type),
          args: single
            ? (single.args ?? { ...(single.literals ?? {}), input: payload.input })
            : { input: payload.input },
        }), {
          inner: inner.length,
          executions: inner.length > 1
            ? inner.map(({ tool, args, literals }) => ({ tool, ...((args ?? literals) ? { arguments: args ?? literals } : {}), ...(this.#expectsItem(tool) ? { pending: true } : {}) }))
            : [],
        });
        this.landed(execStep, payload.id);
        break;
      }
      case 'function_call':
      case 'local_shell_call': {
        let args = payload.arguments ?? payload.action ?? {};
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            throw new AtifError('ATIF_UNMAPPABLE',
              `${file}: tool call '${payload.call_id}' carries arguments that are not JSON`, { file });
          }
        }
        const name = payload.namespace
          ? `${payload.namespace}__${String(payload.name ?? '').replace(/^_/, '')}`
          : (payload.name ?? payload.type);
        const callStep = this.#agentStep(row);
        this.#pushCall(callStep, this.buildToolCall({ id: payload.call_id, name, args }));
        this.landed(callStep, payload.id);
        break;
      }
      case 'tool_search_call': {
        const searchStep = this.#agentStep(row);
        this.#pushCall(searchStep, this.buildToolCall({ id: payload.call_id, name: 'tool_search', args: payload.arguments ?? {} }));
        this.landed(searchStep, payload.id);
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
        this.attachResult(payload.call_id, payload.output ?? payload.content, { file, rowId: payload.id });
        break;
      case 'tool_search_output':
        this.attachResult(payload.call_id,
          payload.tools !== undefined ? JSON.stringify(payload.tools) : (payload.output ?? payload.content), { file, rowId: payload.id });
        break;
      case 'compaction':
        // codex 0.150-alpha writes the compaction summary as an (encrypted) response item with
        // no `compacted` line row beside it — the same synthetic system step, the same clock.
        this.pushStep({ source: 'system', message: '[context compacted]', ...(row.timestamp ? { timestamp: row.timestamp } : {}), llm_call_count: 0 });
        break;
      default:
        // unreachable: the roster routed here — a handled type without a case is a bug
        throw new AtifError('ATIF_UNMAPPABLE',
          `${file}: roster-handled response_item '${payload.type}' has no mapping — the roster and the projector drifted apart`, { file });
    }
  }
}
