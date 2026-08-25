// oathe — the ONE board renderer. Two consumers, one voice: the SessionStart hook (context
// for the model + the visible line) and the launcher (printed into terminal scrollback before
// the harness TUI starts, because TUIs bury hook output in transcript overlays).
//
// Three states, three voices: RECOVERY (tasks of yours survived across sessions — the moment
// oathe visibly earned its keep, so the celebration and the star ask ride here, and ONLY
// here); open-but-not-yours (the lock summary); and a clean folder (the beer — silence would
// be indistinguishable from oathe not running).

import { createOatheTools } from './mcp/oathe-tools.mjs';

const STAR_ASK = '⭐ Support open-source infra: https://github.com/oathe-ai/oathe';

/**
 * @param {{client: {query: Function}, identity: object, workspace: string}} o
 * @returns {Promise<{context: string, message: string}>} context = the full board (model /
 *          scrollback); message = the one visible state line
 */
export async function renderBoard({ client, identity, workspace }) {
  const tools = createOatheTools({ client, identity, workspace });
  const { board } = await tools.oathe_board({});
  const mine = board.filter((r) => r.state === 'active' && r.principal_id === identity.principalId);
  const offered = board.filter((r) => r.state !== 'active');
  const theirs = board.filter((r) => r.state === 'active' && r.principal_id !== identity.principalId);

  const lines = [`## Oathe board (${workspace})`, ''];
  if (mine.length === 0 && offered.length === 0 && theirs.length === 0) {
    lines.push('_No open tasks in this workspace. Claim before you build: `oathe_claim`._');
  }
  if (mine.length > 0) {
    lines.push('**Yours (lease running — say `continue <task>` to pick one up):**');
    for (const r of mine) lines.push(`- [${r.task_id}] ${r.objective} — lease until ${r.lease_until}`);
    lines.push('');
  }
  if (offered.length > 0) {
    lines.push('**Open (claimable):**');
    for (const r of offered) lines.push(`- [${r.task_id}] ${r.objective}${r.state ? ` (${r.state})` : ''}`);
    lines.push('');
  }
  if (theirs.length > 0) {
    lines.push('**Held:**');
    for (const r of theirs) lines.push(`- [${r.task_id}] ${r.objective} (${r.principal_id})`);
  }

  let message;
  if (mine.length > 0) {
    const n = mine.length === 1 ? '1 task' : `${mine.length} tasks`;
    message = `🎉 Oathe just saved your session state — ${n} still yours! ${STAR_ASK}`;
  } else if (offered.length + theirs.length > 0) {
    message = `🔒 Oathe: ${offered.length} open · ${theirs.length} held`;
  } else {
    message = '🍺 No open tasks in this folder — Oathe is keeping track.';
  }
  return { context: lines.join('\n'), message };
}
