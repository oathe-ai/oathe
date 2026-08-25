// SessionStart — the Oathe board, delivered twice over: the full list as additional
// context for the MODEL, and one visible line for the USER as the session loads.
//
// Three states, three voices: RECOVERY (tasks of yours survived across sessions — the
// moment oathe visibly earned its keep, so the celebration and the star ask ride here, and
// ONLY here); open-but-not-yours (a plain summary); and a clean folder (the party popper
// confirmation — silence would be indistinguishable from oathe not running).

import { failSoft, emitSessionStart } from './lib.mjs';
import { createOatheTools } from '../../src/mcp/oathe-tools.mjs';

const STAR_ASK = '⭐ Support open-source infra: https://github.com/oathe-ai/oathe';

await failSoft(async ({ substrate, workspace, identity }) => {
  const tools = createOatheTools({ client: substrate, identity, workspace });
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
  emitSessionStart({ context: lines.join('\n'), message });
}, { quietNote: 'Oathe board unavailable — substrate not initialized; run `oathe init`' });
