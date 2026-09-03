// The codex rollout roster — pure data, zero imports (both the adapter and the projector
// consume it; a data-only module keeps the static import graph acyclic). Codex publishes no
// rollout-format documentation, so this roster IS the pinned contract (docs/traces.md carries
// it verbatim): every row type the projector handles, or has SEEN and consciously ignores
// (each with its reason). Rows measured over the 40 most recent real rollouts, 2026-08-31,
// codex CLI 0.149–0.150; the item stream measured 2026-09-01. A type outside both lists
// quarantines visibly at projection (extra.record.unrecognized_rows) and fails the census
// lane as DRIFT — additions tolerate visibly, only missing EXPECTED shapes refuse (founder
// ruling 2026-08-31).

const deepFreeze = (obj) => {
  for (const v of Object.values(obj)) {
    if (v !== null && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(obj);
};

export const CODEX_ROLLOUT_ROSTER = deepFreeze({
  line: {
    handled: ['session_meta', 'response_item', 'event_msg', 'turn_context', 'compacted'],
    ignored: {
      world_state: 'environment snapshot — context machinery, not agent actions',
      inter_agent_communication_metadata: 'fan-out routing metadata ({trigger_turn} only) — the sqlite spawn edges and the SubAgentActivity items carry the fact',
    },
  },
  response_item: {
    handled: ['message', 'agent_message', 'reasoning', 'function_call', 'local_shell_call',
      'custom_tool_call', 'function_call_output', 'custom_tool_call_output',
      'tool_search_call', 'tool_search_output', 'compaction'],
    ignored: {},
  },
  event_msg: {
    handled: ['token_count', 'item_completed'],
    ignored: {
      task_started: 'turn lifecycle marker — response_item is ground truth (docs/traces.md)',
      task_complete: 'turn lifecycle marker — response_item is ground truth',
      thread_settings_applied: 'settings bookkeeping, not agent action',
      user_message: 'nudge-channel duplicate of the response_item user message',
      agent_message: 'nudge-channel duplicate of the response_item agent message',
      agent_reasoning: 'nudge-channel duplicate of the response_item reasoning row',
      turn_aborted: 'turn lifecycle marker — the absence of further items already shows it',
    },
  },
  // The typed item stream (item_completed.item.type): the vendor's own decode of what the exec
  // source wraps (CommandExecution, McpToolCall, FileChange), lifecycle facts that exist
  // nowhere else (SubAgentActivity — its id IS the spawn call's), and one action with no
  // response_item counterpart at all (Extension: web.search). Measured 2026-09-01: 100% of
  // cli/exec/child rollouts carry it, 8/14 vscode — enrichment of the calls, never the spine.
  item: {
    handled: ['CommandExecution', 'McpToolCall', 'FileChange', 'SubAgentActivity', 'Extension'],
    ignored: {
      Reasoning: 'the response_item reasoning row is the fact (encrypted either way)',
      AgentMessage: 'the response_item message row is the fact',
      UserMessage: 'the response_item user message row is the fact',
      CollabAgentToolCall: 'the collaboration function_call and its output are the fact; the item repeats them',
      ContextCompaction: 'the compacted line row is the fact',
      DynamicToolCall: 'a dynamic tool call rides its own function_call/output pair',
      Plan: 'a plan update is the agent\'s own words, carried by the message row',
      ImageView: 'an image view is a read, not an action the record claims',
    },
  },
});

/** The response_item types that ARE tool calls — the fidelity extractors' view of actions. */
export const CODEX_CALL_TYPES = Object.freeze(
  new Set(['function_call', 'local_shell_call', 'custom_tool_call', 'tool_search_call']));

/** The item types that complete a call — the second source of the same action, cross-checked. */
export const CORRELATABLE_ITEMS = Object.freeze(new Set(['CommandExecution', 'McpToolCall', 'FileChange']));

// The inter-agent bus (measured 2026-09-01): an ADDRESSED agent_message carries `author` and
// `recipient` as agent paths — the root thread is `/root`, a child `/root/<nickname>` — and a
// typed first line (`Message Type: FINAL_ANSWER | NEW_TASK | MESSAGE`), then headers and the
// payload. An unaddressed agent_message (35 of 45 across the 40 newest rollouts) is the
// agent's own words.
export const CODEX_ROOT_AGENT_PATH = '/root';
export const INTER_AGENT_MESSAGE_TYPE = /^Message Type:\s*(\S+)/;

/** One parsed rollout row → its roster coordinate (the census classifier). */
export function codexKindOf(row) {
  if (row?.type === 'event_msg' && row.payload?.type === 'item_completed') {
    return { channel: 'item', type: row.payload.item?.type };
  }
  if (row?.type === 'response_item' || row?.type === 'event_msg') {
    return { channel: row.type, type: row.payload?.type };
  }
  return { channel: 'line', type: row?.type };
}
