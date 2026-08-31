// oathe — the ONE board renderer. Two consumers, one voice: the SessionStart hook (context
// for the model + the visible line) and the launcher (printed into terminal scrollback before
// the harness TUI starts, because TUIs bury hook output in transcript overlays).
//
// R-QUIET (2026-08-29): the human channel is breaches-or-silence. A line oathe prints must
// change what the person does next or it gets deleted — so breaches PUSH (a broken promise is
// this operator's to answer for), status PULLS (`oathe ls`), and the restored-state banner
// rides the actual pickup (oathe_pickup), never ambient session start. The model's context
// channel still carries the full board; only the human channel keeps quiet.

import { createOatheTools } from './mcp/oathe-tools.mjs';
import { SPEECH_ACT_RULE } from './fence.mjs';



/** The board's scope, spoken once: the folder lens, or the whole machine (R-BOARD-SCOPE). */
export const MACHINE_SCOPE_LABEL = 'all workspaces';

/**
 * @param {{client: {query: Function}, identity: object, workspace: string|null, config?: object,
 *          synthetic?: boolean, all?: boolean, breaches?: object[]}} o  synthetic — the session
 *          sits on a harness staging dir (R-BOARD-SCOPE): the tools serve the full board and the
 *          render says so. all — an honest machine lens (the notch feed): the folder filter is
 *          dropped without borrowing synthetic's staging-dir semantics. breaches — the Pager's
 *          digest (R-PAGER), rendered machine-wide below the board.
 * @returns {Promise<{context: string, message: string|null, sections: object, lens: string|null}>}
 *          context = the full board (model / scrollback); message = the one visible push line
 *          (breaches only — null is silence); lens = the workspace the board was scoped to,
 *          null for the whole machine
 */
export async function renderBoard({ client, identity, workspace, config, synthetic = false, all = false, breaches = [] }) {
  const tools = createOatheTools({ client, identity, workspace, config, synthetic });
  const { sections, workspace: lens } = await tools.oathe_board({ all });
  const { mine, open, asserted, held } = sections;
  const total = mine.length + open.length + asserted.length + held.length;
  const scope = lens ?? MACHINE_SCOPE_LABEL;
  const where = lens ? 'in this folder' : 'anywhere';

  // The rule rides every render: a session with no fence (a staging dir, a folder whose
  // activation is off) still opens knowing how the board is meant to be used.
  const lines = [`## Oathe board (${scope})`, '', `_${SPEECH_ACT_RULE}_`, ''];
  if (total === 0) {
    lines.push(`_No open tasks ${where}._`);
  }
  if (mine.length > 0) {
    lines.push('**Yours (still claimed by you — completion not asserted; say `continue <task>` to pick one up):**');
    for (const r of mine) {
      lines.push(`- [${r.task_id}] ${r.objective} — lease until ${r.lease_until}`);
      if (r.last_progress) lines.push(`  ↳ last recorded progress${r.last_progress_at ? ` (${r.last_progress_at})` : ''}: ${r.last_progress}`);
    }
    lines.push('');
  }
  if (open.length > 0) {
    lines.push('**Open (claimable):**');
    for (const r of open) {
      const note = r.state === 'reopened' ? ' (came back incomplete — actionable again)' : (r.state ? ` (${r.state})` : '');
      lines.push(`- [${r.task_id}] ${r.objective}${note}`);
    }
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
  if (breaches.length > 0) {
    // R-PAGER: promises breached ANYWHERE on this machine — the one place a folder lens does
    // not apply, because a breach elsewhere is still this operator's to answer for.
    lines.push('', `## Breached promises (${MACHINE_SCOPE_LABEL})`, '');
    for (const b of breaches) lines.push(`- [${b.task_id}] ${b.objective} — ${b.detail} (home: ${b.home})`);
  }

  // R-QUIET: breaches-or-silence. Wording is the founder's bar (2026-08-31): PERSON
  // words, not board words — what needs you, in two buckets. "to fix" = a verdict came
  // back or the verifier itself failed (a person acts); "to verify" = asserted and never
  // judged (the system drains these itself; the count is the queue, not a chore). Composed
  // HERE and only here; the hook message and the notch bar render this string verbatim.
  let message = null;
  if (breaches.length > 0) {
    const byKind = {};
    for (const b of breaches) byKind[b.kind] = (byKind[b.kind] ?? 0) + 1;
    const fix = (byKind.reopened ?? 0) + (byKind.stalled ?? 0);
    const parts = [];
    if (fix > 0) parts.push(`${fix} to fix`);
    if (byKind.overdue) parts.push(`${byKind.overdue} to verify`);
    if (byKind.quiet) parts.push(`${byKind.quiet} gone quiet`);
    message = parts.join(' · ');
  }
  return { context: lines.join('\n'), message, sections, lens };
}

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const OBJECTIVE_WIDTH = 48;

/**
 * The board as an ANSI terminal splash — the launcher's human-facing render. No markdown:
 * bold ids, aligned columns, dim detail. An empty board is just the state line.
 */
export function renderSplash({ message, sections, workspace, breaches = [] }) {
  const { mine, open, asserted, held } = sections;
  const all = [...mine, ...open, ...asserted, ...held, ...breaches];
  const scope = `${DIM}${workspace ?? MACHINE_SCOPE_LABEL}${RESET}`;
  // R-QUIET: a silent message leaves just the scope line — the board below speaks for itself.
  const out = ['', message ? `  ${message}   ${scope}` : `  ${scope}`, ''];
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
  section('YOURS (completion not asserted)', mine, (r) => (r.last_progress
    ? `last: ${r.last_progress.slice(0, 26)}`
    : `lease until ${r.lease_until}`));
  section('OPEN', open, (r) => (r.state === 'reopened' ? 'back — incomplete, actionable' : (r.state ?? 'unclaimed')));
  section('ASSERTED', asserted, () => 'awaiting verdict');
  section('HELD', held, (r) => r.principal_id);
  section(`BREACHED PROMISES (${MACHINE_SCOPE_LABEL})`, breaches, (b) => `${b.detail} · ${b.home}`);
  return `${out.join('\n')}\n`;
}
