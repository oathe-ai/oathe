// oathe — hook payload dialects. Two wire shapes exist across the supported harnesses: the
// cwd shape (Claude Code and Codex: `cwd` + camelCase SessionStart output envelope) and the
// workspace-roots shape (Cursor: `workspace_roots[]` + snake_case fire-and-forget output).
// Each dialect owns its sniff, its normalization, and its output format — pinned by the
// fixtures in tests/fixtures/hooks/ against the .harness-docs snapshot.

/** @typedef {{cwd: string|null, sessionId: string|null, transcriptPath: string|null}} HookSession */

export const cwdDialect = Object.freeze({
  name: 'cwd',
  matches(input) {
    return typeof input?.cwd === 'string';
  },
  /** @returns {HookSession} */
  normalizePayload(input) {
    return {
      cwd: input.cwd ?? null,
      sessionId: input.session_id ?? null,
      transcriptPath: input.transcript_path ?? null,
    };
  },
  formatSessionStart({ context, message }) {
    // R-QUIET: a null message is SILENCE — the key is omitted, or the harness renders "null".
    return `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
      ...(message ? { systemMessage: message } : {}),
    })}\n`;
  },
});

export const workspaceRootsDialect = Object.freeze({
  name: 'workspace-roots',
  matches(input) {
    return Array.isArray(input?.workspace_roots);
  },
  /** @returns {HookSession} first root scopes the board — multiroot workspaces carry several */
  normalizePayload(input) {
    return {
      cwd: input.workspace_roots[0] ?? null,
      sessionId: input.session_id ?? input.conversation_id ?? null,
      transcriptPath: input.transcript_path ?? null,
    };
  },
  // Fire-and-forget: no user-visible message channel exists in this dialect, so `message`
  // rides nowhere — context is the whole payload.
  formatSessionStart({ context }) {
    return `${JSON.stringify({ additional_context: context })}\n`;
  },
});

/** Sniff order: the more specific roots shape first — a cwd field is the common fallback. */
export const DIALECTS = Object.freeze([workspaceRootsDialect, cwdDialect]);
