// SessionStart — the folder's open work, delivered twice over: the full board as additional
// context for the MODEL, and one visible line for the USER as the session loads. A workspace
// with nothing open still confirms, party popper and all, that oathe is keeping track —
// silence would be indistinguishable from oathe not running.

import { failSoft, emitSessionStart } from './lib.mjs';
import { createOatheTools } from '../../src/mcp/oathe-tools.mjs';

await failSoft(async ({ substrate, workspace, identity }) => {
  const tools = createOatheTools({ client: substrate, identity, workspace });
  const { board } = await tools.oathe_board({});
  const mine = board.filter((r) => r.state === 'active' && r.principal_id === identity.principalId);
  const offered = board.filter((r) => r.state !== 'active');
  const theirs = board.filter((r) => r.state === 'active' && r.principal_id !== identity.principalId);

  const lines = [`## Oathe board (${workspace})`, ''];
  if (mine.length === 0 && offered.length === 0 && theirs.length === 0) {
    lines.push('_No open work in this workspace. Claim before you build: `oathe_claim`._');
  }
  if (mine.length > 0) {
    lines.push('**Yours (lease running — say `continue <task>` to pick one up):**');
    for (const r of mine) lines.push(`- [${r.task_id}] ${r.objective} — lease until ${r.lease_until}`);
    lines.push('');
  }
  if (offered.length > 0) {
    lines.push('**Offered (claimable):**');
    for (const r of offered) lines.push(`- [${r.task_id}] ${r.objective}${r.state ? ` (${r.state})` : ''}`);
    lines.push('');
  }
  if (theirs.length > 0) {
    lines.push('**Held elsewhere:**');
    for (const r of theirs) lines.push(`- [${r.task_id}] ${r.objective} (${r.principal_id})`);
  }

  const open = mine.length + offered.length + theirs.length;
  const message = open === 0
    ? '\u{1F389} Oathe is keeping track — no open work in this workspace.'
    : `Oathe board: ${mine.length} yours · ${offered.length} offered · ${theirs.length} held elsewhere`;
  emitSessionStart({ context: lines.join('\n'), message });
}, { quietNote: 'Oathe board unavailable — substrate not initialized; run `oathe init`' });
