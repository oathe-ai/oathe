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
  const { sections } = await tools.oathe_board({});
  const { mine, open, asserted, held } = sections;
  const total = mine.length + open.length + asserted.length + held.length;

  const lines = [`## Oathe board (${workspace})`, ''];
  if (total === 0) {
    lines.push('_No open tasks in this workspace. Claim before you build: `oathe_claim`._');
  }
  if (mine.length > 0) {
    lines.push('**Yours (lease running — say `continue <task>` to pick one up):**');
    for (const r of mine) lines.push(`- [${r.task_id}] ${r.objective} — lease until ${r.lease_until}`);
    lines.push('');
  }
  if (open.length > 0) {
    lines.push('**Open (claimable):**');
    for (const r of open) lines.push(`- [${r.task_id}] ${r.objective}${r.state ? ` (${r.state})` : ''}`);
    lines.push('');
  }
  if (asserted.length > 0) {
    lines.push('**Asserted (completion claimed — awaiting a non-author verdict; `oathe verify` runs it):**');
    for (const r of asserted) lines.push(`- [${r.task_id}] ${r.objective}`);
    lines.push('');
  }
  if (held.length > 0) {
    lines.push('**Held:**');
    for (const r of held) lines.push(`- [${r.task_id}] ${r.objective} (${r.principal_id})`);
  }

  let message;
  if (mine.length > 0) {
    const n = mine.length === 1 ? '1 task' : `${mine.length} tasks`;
    message = `🎉 Oathe just saved your session state — ${n} still yours! ${starAsk}`;
  } else if (total > 0) {
    const parts = [];
    parts.push(open.length === 1 ? '1 open task' : `${open.length} open tasks`);
    if (asserted.length > 0) parts.push(`${asserted.length} asserted`);
    if (held.length > 0) parts.push(`${held.length} held`);
    message = `🔒 Oathe: ${parts.join(' · ')}`;
  } else {
    message = '🍺 No open tasks in this folder — Oathe is keeping track.';
  }
  return { context: lines.join('\n'), message, sections };
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
  const { mine, open, asserted, held } = sections;
  const all = [...mine, ...open, ...asserted, ...held];
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
  section('OPEN', open, (r) => r.state ?? 'unclaimed');
  section('ASSERTED', asserted, () => 'awaiting verdict');
  section('HELD', held, (r) => r.principal_id);
  return `${out.join('\n')}\n`;
}
