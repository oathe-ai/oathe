// oathe — the ONE board renderer. Two consumers, one voice: the SessionStart hook (context
// for the model + the visible line) and the launcher (printed into terminal scrollback before
// the harness TUI starts, because TUIs bury hook output in transcript overlays).
//
// Three states, three voices: RECOVERY (tasks of yours survived across sessions — the moment
// oathe visibly earned its keep, so the celebration and the star ask ride here, and ONLY
// here); open-but-not-yours (the lock summary); and a clean folder (the beer — silence would
// be indistinguishable from oathe not running).

import { createOatheTools } from './mcp/oathe-tools.mjs';



/**
 * @param {{client: {query: Function}, identity: object, workspace: string}} o
 * @returns {Promise<{context: string, message: string}>} context = the full board (model /
 *          scrollback); message = the one visible state line
 */
export async function renderBoard({ client, identity, workspace, config }) {
  const starUrl = config?.get('starUrl') ?? 'https://github.com/oathe-ai/oathe';
  const starAsk = `⭐ Support open-source infra: ${starUrl}`;
  const tools = createOatheTools({ client, identity, workspace, config });
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
    message = `🎉 Oathe just saved your session state — ${n} still yours! ${starAsk}`;
  } else if (offered.length + theirs.length > 0) {
    const open = offered.length === 1 ? '1 open task' : `${offered.length} open tasks`;
    message = `🔒 Oathe: ${open}${theirs.length > 0 ? ` · ${theirs.length} held` : ''}`;
  } else {
    message = '🍺 No open tasks in this folder — Oathe is keeping track.';
  }
  return { context: lines.join('\n'), message, sections: { mine, offered, theirs } };
}

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const OBJECTIVE_WIDTH = 48;

/**
 * The board as an ANSI terminal splash — the launcher's human-facing render. No markdown:
 * bold ids, aligned columns, dim detail. An empty board is just the state line.
 */
export function renderSplash({ message, sections, workspace }) {
  const { mine, offered, theirs } = sections;
  const all = [...mine, ...offered, ...theirs];
  const out = ['', `  ${message}   ${DIM}${workspace}${RESET}`, ''];
  if (all.length === 0) return `${out.join('\n')}\n`;

  const idWidth = Math.max(...all.map((r) => r.task_id.length));
  const clip = (text) => (text.length > OBJECTIVE_WIDTH ? `${text.slice(0, OBJECTIVE_WIDTH - 1)}…` : text);
  const row = (r, detail) => `    ${BOLD}${r.task_id.padEnd(idWidth)}${RESET}  `
    + `${clip(r.objective).padEnd(OBJECTIVE_WIDTH)}  ${DIM}${detail}${RESET}`;

  const section = (header, rows, detailFor) => {
    if (rows.length === 0) return;
    out.push(`  ${BOLD}${DIM}${header}${RESET}`);
    for (const r of rows) out.push(row(r, detailFor(r)));
    out.push('');
  };
  section('YOURS', mine, (r) => `lease until ${r.lease_until}`);
  section('OPEN', offered, (r) => r.state ?? 'unclaimed');
  section('HELD', theirs, (r) => r.principal_id);
  return `${out.join('\n')}\n`;
}
