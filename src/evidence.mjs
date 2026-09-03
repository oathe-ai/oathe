// oathe — the evidence renderer: ONE budget-true rendering of a trajectory for a judge's
// eyes. Every emitted character is accounted — header, elision lines, subagent headers, the
// join newlines — so `render(t, {budget}).length <= budget` is a hard invariant, not a hope.
// Truncation is TAIL-PRIORITIZED (the most recent steps survive whole) and ANNOUNCED — an
// elision the reader cannot see is evidence silently lost.

import { AtifError } from './atif.mjs';

// Design constants, not tunables — no consumer has a story for turning them (founder
// ruling 2026-09-01: no speculative config).
const CLIP = { message: 300, args: 140, result: 200, user: 200 };
const SUBAGENT_BUDGET_SHARE = 0.3;

function clip(text, max) {
  const flat = String(text).replaceAll('\n', ' ⏎ ');
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** Hard cap for whole strings (multi-line allowed) — the last resort, still announced by '…'. */
function clipTo(text, max) {
  if (text.length <= max) return text;
  return max <= 1 ? '…'.slice(0, max) : `${text.slice(0, max - 1)}…`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * One step → its aligned lines: SAID (the claims), CLAIM (speech acts), DID (actions), GOT
 * (outcomes) — and FROM (a message another agent sent this one: a delegated brief, a child's
 * answer), which is never SAID.
 */
function stepLines(step) {
  const lines = [];
  const inbound = step.extra?.record?.inbound;
  if (inbound) {
    // Codex names an author and a message type; Claude a kind and, for a notification, the task.
    const ref = step.observation?.results?.[0]?.subagent_trajectory_ref?.[0]?.trajectory_id;
    const text = step.observation?.results?.[0]?.content ?? step.message;
    const detail = inbound.message_type ?? inbound.task_id;
    return [`FROM ${inbound.author ?? inbound.kind}${detail ? ` (${detail})` : ''}${ref ? ` → subagent ${ref}` : ''}: ${clip(text, CLIP.user)}`];
  }
  if (step.source === 'user') return [`USER: ${clip(step.message, CLIP.user)}`];
  if (step.source === 'system') return [`SYSTEM: ${clip(step.message, CLIP.user)}`];
  if (step.message) lines.push(`SAID: ${clip(step.message, CLIP.message)}`);
  for (const event of step.extra?.oathe?.claim_events ?? []) {
    lines.push(`CLAIM(${event.verb}${event.task_id ? ` ${event.task_id}` : ''})`);
  }
  for (const call of step.tool_calls ?? []) {
    lines.push(`DID: ${call.function_name}(${clip(JSON.stringify(call.arguments), CLIP.args)})`);
  }
  for (const result of step.observation?.results ?? []) {
    const exit = result.extra?.oathe?.observed?.exit_code;
    lines.push(`GOT${exit !== undefined ? ` [exit ${exit}]` : ''}: ${clip(result.content, CLIP.result)}`);
  }
  return lines;
}

export class EvidenceRenderer {
  /** @returns {string} guaranteed `length <= budget` (a violation is an accounting bug and throws) */
  render(trajectory, { budget }) {
    const subagents = trajectory.subagent_trajectories ?? [];
    const joins = subagents.length; // '\n' between the main section and each child section
    const usable = Math.max(0, budget - joins);
    const mainBudget = subagents.length > 0 ? Math.floor(usable * (1 - SUBAGENT_BUDGET_SHARE)) : usable;
    const childAllocation = subagents.length > 0 ? Math.floor((usable - mainBudget) / subagents.length) : 0;

    const parts = [this.#section(trajectory, mainBudget)];
    for (const child of subagents) parts.push(this.#childSection(child, childAllocation));
    const out = parts.join('\n');
    if (out.length > budget) {
      throw new AtifError('ATIF_EVIDENCE_BUDGET_EXCEEDED',
        `rendered ${out.length} chars against a ${budget} budget — the renderer's accounting broke`,
        { rendered: out.length, budget });
    }
    return out;
  }

  #childSection(child, allocation) {
    const meta = child.extra?.record?.subagent_meta;
    const label = meta?.agentType ?? meta?.agent_nickname;
    const head = `SUBAGENT ${child.trajectory_id}${label ? ` (${label})` : ''}`;
    if (head.length + 1 >= allocation) return clipTo(head, allocation);
    return `${head}\n${this.render(child, { budget: allocation - head.length - 1 })}`;
  }

  /** The header + step body of ONE trajectory, within exactly sectionBudget characters. */
  #section(trajectory, sectionBudget) {
    // Record facts are the converter's (extra.record); the slice marker is the annotator's.
    const record = trajectory.extra?.record ?? {};
    const oathe = trajectory.extra?.oathe ?? {};
    const headerLines = [
      `TRACE ${trajectory.session_id} (${trajectory.agent?.name}`
        + `${record.session_title ? ` — "${record.session_title}"` : ''})`,
      ...(record.files_touched?.length ? [`files touched: ${record.files_touched.join(', ')}`] : []),
    ];
    // What the converter could not place is announced, never hidden: rows outside the roster,
    // items that completed no call.
    for (const [key, noun] of [['unrecognized_rows', 'unrecognized row'], ['uncorrelated_items', 'uncorrelated item']]) {
      if (!record[key]) continue;
      const total = Object.values(record[key]).reduce((a, b) => a + b, 0);
      headerLines.push(`[${plural(total, noun)}: ${Object.keys(record[key]).sort().join(', ')}]`);
    }
    if (oathe.sliced) {
      headerLines.push(`[evidence sliced to task ${oathe.sliced.task_id}`
        + `${oathe.sliced.subagents_elided > 0 ? `; ${plural(oathe.sliced.subagents_elided, 'sibling subagent')} elided` : ''}]`);
    }
    // Inherited context (a forked child's copy of its parent's turns) is not this agent's
    // work: elided from the record it is judged on, and announced.
    const copied = (trajectory.steps ?? []).filter((s) => s.is_copied_context === true).length;
    if (copied > 0) headerLines.push(`[${plural(copied, 'copied-context step')} elided]`);
    const header = headerLines.join('\n');
    if (header.length >= sectionBudget) return clipTo(header, sectionBudget);

    const steps = (trajectory.steps ?? []).filter((s) => s.is_copied_context !== true);
    const blocks = steps.map((step) => stepLines(step).map((l) => `  ${l}`).join('\n'));
    const stepBudget = sectionBudget - header.length;

    // First pass: everything fits whole → no elision machinery at all.
    const totalCost = blocks.reduce((n, b) => n + b.length + 1, 0);
    if (totalCost <= stepBudget) return [header, ...blocks].join('\n');

    // Elision pass: reserve room for the announcement (an upper bound — computed over ALL
    // steps, so the real line, over fewer, always fits), then keep whole blocks tail-first.
    const elisionFor = (elided) => {
      const toolCalls = elided.reduce((n, s) => n + (s.tool_calls?.length ?? 0), 0);
      const claims = elided.reduce((n, s) => n + (s.extra?.oathe?.claim_events?.length ?? 0), 0);
      return `  [${plural(elided.length, 'earlier step')} elided: `
        + `${plural(toolCalls, 'tool call')}, ${plural(claims, 'claim')}]`;
    };
    const reserve = elisionFor(steps).length + 1;
    const kept = [];
    let spent = 0;
    for (let at = blocks.length - 1; at >= 0; at -= 1) {
      const cost = blocks[at].length + 1;
      if (spent + cost > stepBudget - reserve) break;
      kept.unshift(at);
      spent += cost;
    }
    const elisionLine = elisionFor(steps.slice(0, kept[0] ?? steps.length));
    const body = [clipTo(elisionLine, Math.max(0, stepBudget - spent - 1)), ...kept.map((at) => blocks[at])];
    return [header, ...body].join('\n');
  }
}

/**
 * The deterministic human/engine-facing rendering of a trajectory — the thin functional edge
 * over EvidenceRenderer (the one budget-true implementation).
 */
export function renderEvidenceView(trajectory, { budget }) {
  return new EvidenceRenderer().render(trajectory, { budget });
}
