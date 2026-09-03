// Claude's transcript-row roster — pure data, zero imports (the adapter and the projector
// both consume it). Every line type the projector handles, or has seen and consciously
// ignores (each with its reason). Measured on live transcripts 2026-08-31 (Claude Code
// 2.1.x); docs/traces.md carries the pinned contract. A type outside both lists quarantines
// visibly at projection and fails the census lane as DRIFT.

export const CLAUDE_ROSTER = Object.freeze({
  line: Object.freeze({
    handled: Object.freeze(['user', 'assistant', 'system', 'ai-title', 'file-history-snapshot']),
    ignored: Object.freeze({
      'last-prompt': 'editor bookkeeping, not conversation',
      mode: 'UI mode marker',
      'permission-mode': 'UI mode marker',
      'atis-latch': 'harness-internal latch',
      'bridge-session': 'harness-internal session bridging',
      attachment: 'attachment bookkeeping — the message rows carry the content',
      'queue-operation': 'queue bookkeeping',
      'agent-name': 'agent naming bookkeeping, not conversation',
      'agent-setting': 'agent settings bookkeeping',
      'artifact-autoreact-ledger': 'artifact auto-reply bookkeeping',
      'artifact-comment-monitor': 'artifact comment-watch bookkeeping',
      'cost-state': 'usage accounting snapshot',
      'custom-title': 'user-set display title (ai-title is the handled title row)',
      'file-history-delta': 'incremental sibling of file-history-snapshot — inter-snapshot bookkeeping',
      'frame-link': 'session frame linkage bookkeeping',
      'pr-link': 'PR linkage bookkeeping',
    }),
  }),
});

/**
 * Which user rows are the PERSON's and which the HARNESS's — `origin.kind`, measured over the
 * 40 newest transcripts (2026-09-01: human 417, task-notification 262, auto-continuation 1,
 * peer 1; absent = tool-result rows and older rows, the person's). A task-notification is the
 * harness reporting a background task (an Agent's completion, a backgrounded command) as
 * `<task-notification><task-id>…<tool-use-id>…`; a peer is another session's message. An
 * unknown kind projects as the person's row AND quarantines visibly (`origin.<kind>`).
 */
export const ORIGIN_KINDS = Object.freeze({
  human: 'user',
  'task-notification': 'system',
  peer: 'system',
  'auto-continuation': 'system',
});

/** One parsed transcript row → its roster coordinate (the census classifier). */
export function claudeKindOf(row) {
  return { channel: 'line', type: row?.type };
}
