// oathe — the ONE board renderer. Two consumers, one voice: the SessionStart hook (context
// for the model + the visible line) and the launcher (printed into terminal scrollback before
// the harness TUI starts, because TUIs bury hook output in transcript overlays).
//
// R-QUIET (2026-08-29): the human channel is breaches-or-silence. A line oathe prints must
// change what the person does next or it gets deleted — so breaches PUSH (a broken promise is
// this operator's to answer for), status PULLS (`oathe ls`), and the restored-state banner
// rides the actual pickup (oathe_pickup), never ambient session start. The model's context
// channel still carries the full board; only the human channel keeps quiet.
//
// The breaches arrive as the BreachDigest (src/breach-digest.mjs): the push line, the rows
// under the budget, the count beyond it. This module words them and computes nothing —
// UX rules 17 and 18.

import { createOatheTools } from './mcp/oathe-tools.mjs';
import { SPEECH_ACT_RULE } from './fence.mjs';
import { BreachDigest, JUDGMENT, clip, rowLine, pullPointer } from './breach-digest.mjs';

/** The board's scope, spoken once: the folder lens, or the whole machine (R-BOARD-SCOPE). */
export const MACHINE_SCOPE_LABEL = 'all workspaces';

const nothingBreached = () => new BreachDigest({ breaches: [] });

/**
 * @param {{client: {query: Function}, identity: object, workspace: string|null, config?: object,
 *          synthetic?: boolean, all?: boolean, digest?: BreachDigest|null}} o  synthetic — the
 *          session sits on a harness staging dir (R-BOARD-SCOPE): the tools serve the full board
 *          and the render says so. all — an honest machine lens (the notch feed): the folder
 *          filter is dropped without borrowing synthetic's staging-dir semantics. digest — the
 *          Pager's digest (R-PAGER), machine-wide, rendered below the board; null (the hook's
 *          fail-soft path) renders the board alone and stays silent.
 * @returns {Promise<{context: string, message: string|null, sections: object, lens: string|null}>}
 *          context = the full board (model / scrollback); message = the one visible push line
 *          (the digest's — null is silence); lens = the workspace the board was scoped to,
 *          null for the whole machine
 */
export async function renderBoard({ client, identity, workspace, config, synthetic = false, all = false, digest = null }) {
  digest ??= nothingBreached();
  // A read-only composition: the digest arrives from the caller, so the tools read no breach.
  const tools = createOatheTools({ client, identity, workspace, config, synthetic, attention: false });
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
  // UX rule 21: a root's spawned work is one counts line under it, never child bullets.
  const spawned = (r) => (r.children ? [`  ↳ ${r.children.line}`] : []);
  if (mine.length > 0) {
    lines.push('**Yours (still claimed by you — completion not asserted; say `continue <task>` to pick one up):**');
    for (const r of mine) {
      lines.push(`- [${r.task_id}] ${r.objective} — lease until ${r.lease_until}`);
      if (r.last_progress) lines.push(`  ↳ last recorded progress${r.last_progress_at ? ` (${r.last_progress_at})` : ''}: ${r.last_progress}`);
      lines.push(...spawned(r));
    }
    lines.push('');
  }
  if (open.length > 0) {
    lines.push('**Open (claimable):**');
    for (const r of open) {
      const note = r.state === 'reopened' ? ' (came back incomplete — actionable again)' : (r.state ? ` (${r.state})` : '');
      lines.push(`- [${r.task_id}] ${r.objective}${note}`, ...spawned(r));
    }
    lines.push('');
  }
  if (asserted.length > 0) {
    lines.push('**Asserted (completion claimed — a non-author verdict settles or reopens it; `oathe verify` runs it):**');
    for (const r of asserted) lines.push(`- [${r.task_id}] ${r.objective} — ${judgmentWord(r)}`, ...spawned(r));
    lines.push('');
  }
  if (held.length > 0) {
    lines.push('**Held:**');
    for (const r of held) lines.push(`- [${r.task_id}] ${r.objective} (${r.principal_id})`, ...spawned(r));
  }
  if (digest.total > 0) {
    // R-PAGER: promises breached ANYWHERE on this machine — the one place a folder lens does
    // not apply, because a breach elsewhere is still this operator's to answer for.
    lines.push('', `## Breached promises (${MACHINE_SCOPE_LABEL})`, '');
    for (const b of digest.rows) lines.push(`- [${b.task_id}] ${b.objective} — ${b.kind_word}: ${rowLine(b)} (home: ${b.home})`);
    const more = pullPointer('context', digest.more);
    if (more) lines.push(`_${more}_`);
  }
  // R-QUIET: breaches-or-silence. The visible line is the digest's push — PERSON words, the
  // count by bucket, composed once (BreachDigest.push); the hook message and the notch bar
  // render it verbatim.
  return { context: lines.join('\n'), message: digest.push, sections, lens };
}

/** The judgment an asserted row awaits, in the one table's words (UX rule 22). */
const judgmentWord = (r) => JUDGMENT[r.judgment]?.word ?? JUDGMENT.awaiting.word;

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const OBJECTIVE_WIDTH = 48;

/**
 * The board as an ANSI terminal splash — the launcher's human-facing render. No markdown:
 * bold ids, aligned columns, dim detail. An empty board is just the state line.
 */
export function renderSplash({ digest = null, sections, workspace }) {
  digest ??= nothingBreached();
  const { mine, open, asserted, held } = sections;
  const all = [...mine, ...open, ...asserted, ...held, ...digest.rows];
  const scope = `${DIM}${workspace ?? MACHINE_SCOPE_LABEL}${RESET}`;
  // R-QUIET: a silent push leaves just the scope line — the board below speaks for itself.
  const out = ['', digest.push ? `  ${digest.push}   ${scope}` : `  ${scope}`, ''];
  if (all.length === 0) return `${out.join('\n')}\n`;

  const idWidth = Math.max(...all.map((r) => r.task_id.length));
  const row = (r, detail) => `    ${BOLD}${r.task_id.padEnd(idWidth)}${RESET}  `
    + `${clip(r.objective, OBJECTIVE_WIDTH).padEnd(OBJECTIVE_WIDTH)}  ${DIM}${detail}${RESET}`;

  const section = (header, rows, detailFor, tail = null) => {
    if (rows.length === 0) return;
    out.push(`  ${BOLD}${DIM}${header}${RESET}`);
    for (const r of rows) {
      out.push(row(r, detailFor(r)));
      if (r.children) out.push(`      ${DIM}↳ ${r.children.line}${RESET}`); // UX rule 21: one counts line
    }
    if (tail) out.push(`    ${DIM}${tail}${RESET}`);
    out.push('');
  };
  section('YOURS (completion not asserted)', mine, (r) => (r.last_progress
    ? `last: ${r.last_progress.slice(0, 26)}`
    : `lease until ${r.lease_until}`));
  section('OPEN', open, (r) => (r.state === 'reopened' ? 'back — incomplete, actionable' : (r.state ?? 'unclaimed')));
  section('ASSERTED', asserted, judgmentWord);
  section('HELD', held, (r) => r.principal_id);
  section(`BREACHED PROMISES (${MACHINE_SCOPE_LABEL})`, digest.rows,
    (b) => `${b.kind_word}: ${rowLine(b)} · ${b.home}`, pullPointer('splash', digest.more));
  return `${out.join('\n')}\n`;
}
