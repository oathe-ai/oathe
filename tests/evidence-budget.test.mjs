// The evidence-budget invariants: renderEvidenceView NEVER exceeds its budget — measured
// ×4.05 over at 20 subagents before the EvidenceRenderer (the 2026-08-31 dilution rode this:
// a 24,000 budget rendered 105,127 chars, drowning the one relevant child) — and the claim
// intervals obey R3 §5.4 under EXHAUSTIVE enumeration of act sequences, not hand-picked ones.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderEvidenceView, claimIntervals, sliceForTask } from '../src/atif.mjs';

function makeSteps(n, tag, textLen) {
  return Array.from({ length: n }, (_, i) => {
    const base = { step_id: i + 1, message: `${tag}-s${i} ${'x'.repeat(textLen)}` };
    if (i % 4 === 0) return { ...base, source: 'user' };
    if (i % 4 === 2) {
      return {
        ...base,
        source: 'agent',
        tool_calls: [{ tool_call_id: `${tag}c${i}`, function_name: 'exec_command', arguments: { cmd: `run ${i} ${'y'.repeat(80)}` } }],
        observation: { results: [{ source_call_id: `${tag}c${i}`, content: `out ${'z'.repeat(120)}\nExit code 0` }] },
      };
    }
    if (i % 8 === 5) {
      // A copied-context step (a forked child's inherited turn): elided and announced — the
      // announcement is a line the budget must account for too.
      return { ...base, source: 'agent', is_copied_context: true, tool_calls: [{ tool_call_id: `${tag}k${i}`, function_name: 'exec_command', arguments: { cmd: 'inherited' } }] };
    }
    if (i % 8 === 7) {
      // An inbound message (a child's answer): the FROM line, with its ref — every line kind
      // the renderer emits is in the matrix, or a miss would hide from the budget.
      return {
        ...base,
        source: 'system',
        llm_call_count: 0,
        extra: { record: { inbound: { author: `/root/${tag}-child`, recipient: '/root', message_type: 'FINAL_ANSWER' } } },
        observation: { results: [{ content: `Message Type: FINAL_ANSWER\nPayload:\n${'w'.repeat(textLen)}`, subagent_trajectory_ref: [{ trajectory_id: `child-${i}` }] }] },
      };
    }
    return { ...base, source: 'agent' };
  });
}

function makeTrajectory({ steps = 8, subagents = 0, subagentSteps = 4, textLen = 220 } = {}) {
  return {
    schema_version: 'ATIF-v1.7',
    session_id: 'sess-main',
    agent: { name: 'codex' },
    steps: makeSteps(steps, 'p', textLen),
    extra: { record: { source_path: '/x' } },
    ...(subagents > 0 ? {
      subagent_trajectories: Array.from({ length: subagents }, (_, k) => ({
        trajectory_id: `child-${k}`,
        agent: { name: 'codex' },
        steps: makeSteps(subagentSteps, `c${k}`, textLen),
        extra: { record: { subagent_meta: { kind: 'thread_spawn', agent_nickname: `child-${k}` } } },
      })),
    } : {}),
  };
}

test('the render NEVER exceeds its budget — the full subagent-count × budget matrix, no slack', () => {
  for (const subagents of [0, 1, 3, 8, 20]) {
    const t = makeTrajectory({ subagents });
    for (const budget of [420, 1000, 4000, 24000]) {
      const view = renderEvidenceView(t, { budget });
      assert.ok(view.length <= budget,
        `rendered ${view.length} chars against a ${budget} budget at ${subagents} subagents`);
    }
  }
});

test('a generous budget renders everything whole and announces nothing', () => {
  const t = makeTrajectory({ steps: 3, subagents: 1, subagentSteps: 2, textLen: 20 });
  const view = renderEvidenceView(t, { budget: 100000 });
  assert.match(view, /p-s0/);
  assert.match(view, /c0-s1/);
  assert.match(view, /SUBAGENT child-0 \(child-0\)/);
  assert.doesNotMatch(view, /elided|clipped/);
});

test('budget pressure elides the head ANNOUNCED and keeps the freshest steps whole', () => {
  const t = makeTrajectory({ steps: 12, subagents: 0, textLen: 200 });
  const view = renderEvidenceView(t, { budget: 1200 });
  assert.ok(view.length <= 1200);
  assert.match(view, /\[\d+ earlier steps? elided: \d+ tool calls?, \d+ claims?\]/);
  assert.match(view, /p-s11/, 'the newest step survives');
  assert.doesNotMatch(view, /p-s0 /, 'the head was elided');
});

// ---------------------------------------------------------------- R3 §5.4, exhaustively

// Every act sequence over this alphabet, to length 4 — ~2.8k trajectories. The invariants
// hold for ALL of them, not for hand-picked examples.
const ACTS = [
  null,
  ['oathe_claim', 'a'], ['oathe_claim', 'b'],
  ['oathe_statement', 'a'], ['oathe_statement', 'b'],
  ['oathe_done', 'a'], ['oathe_yield', 'a'],
];

function* sequences(length) {
  if (length === 0) { yield []; return; }
  for (const rest of sequences(length - 1)) {
    for (const act of ACTS) yield [...rest, act];
  }
}

function trajectoryOf(seq) {
  return {
    steps: seq.map((act, i) => ({
      source: 'agent',
      message: `m${i}`,
      ...(act ? { extra: { oathe: { claim_events: [{ verb: act[0], task_id: act[1] }] } } } : {}),
    })),
  };
}

test('claimIntervals invariants hold over EVERY act sequence to length 4', () => {
  const closers = new Set(['oathe_done', 'oathe_yield']);
  let swept = 0;
  for (const len of [1, 2, 3, 4]) {
    for (const seq of sequences(len)) {
      const t = trajectoryOf(seq);
      const intervals = claimIntervals(t);
      let cursor = -1;
      for (const iv of intervals) {
        assert.ok(iv.start_index > cursor, 'intervals are ordered and non-overlapping');
        assert.ok(iv.end_index >= iv.start_index && iv.end_index < seq.length, 'in bounds');
        const opener = seq[iv.start_index];
        assert.ok(opener && opener[1] === iv.task_id, 'an interval opens AT an act naming its task');
        cursor = iv.end_index;
      }
      const firstAct = seq.findIndex((a) => a !== null);
      for (const iv of intervals) {
        assert.ok(firstAct === -1 || iv.start_index >= firstAct, 'nothing before the first act is attributed');
      }
      for (let i = 0; i < seq.length; i += 1) {
        const act = seq[i];
        if (act && closers.has(act[0])) {
          const owner = intervals.find((iv) => iv.start_index <= i && i <= iv.end_index && iv.task_id === act[1]);
          if (owner) assert.equal(owner.end_index, i, 'done/yield closes its interval AT its own step');
        }
      }
      // slicing: for the task under judgment, the slice is exactly the interval steps, in order
      const sliced = sliceForTask(t, 'a');
      const mine = intervals.filter((iv) => iv.task_id === 'a');
      const expected = mine.length === 0
        ? t.steps.map((s) => s.message)
        : t.steps.filter((_, i) => mine.some((iv) => iv.start_index <= i && i <= iv.end_index)).map((s) => s.message);
      assert.deepEqual(sliced.steps.map((s) => s.message), expected, `slice mismatch for ${JSON.stringify(seq)}`);
      swept += 1;
    }
  }
  assert.ok(swept >= 2800, `the sweep actually swept (${swept})`);
});
