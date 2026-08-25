// SessionStart — the folder's open work, rendered into the session's opening context.
// Yours (leased) first, then what this workspace offers (claimable). Harness-agnostic:
// the same stdout reaches Claude Code and Codex as session context.

import { failSoft } from './lib.mjs';
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
  process.stdout.write(`${lines.join('\n')}\n`);
}, { quietNote: '## Oathe board unavailable — substrate not initialized; run `oathe init`' });
