// The on-disk trace fixture corpus: SANITIZED real records (scripts/derive-trace-fixtures.mjs,
// marker-scan-gated, human-reviewed diffs), each carrying its own expected projection —
// directory-swept, so dropping a fixture in adds a case (the hooks-fixture discipline,
// harness-contract.test.mjs). This is why `arguments: {}` can never again be green in
// `npm test` on a storeless CI runner: the real shapes ride the repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { byName } from '../src/harnesses/catalog.mjs';
import { OatheAnnotator } from '../src/oathe-annotator.mjs';
import { fixtureDirs, materialize } from '../scripts/trace-fixtures.mjs';
import { requireSqlite } from './helpers.mjs';

// A below-floor runtime fails these lanes LOUDLY with the floor named — never a silent skip.
requireSqlite();

const projected = { codex: [], claude: [] };

for (const harness of ['codex', 'claude']) {
  for (const dir of fixtureDirs(harness)) {
    test(`trace fixture ${harness}/${path.basename(dir)} projects EXACTLY its expected trajectory`, async () => {
      const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
      const scratch = materialize(dir);
      const capability = byName(harness).traces;
      const store = await capability.store({ home: scratch });
      const projector = await capability.projector({ store });
      const record = path.join(scratch, expected.record);
      const trajectory = projector.project(record);
      // normalize the scratch prefix so the expected stays machine-independent
      const normalized = JSON.parse(JSON.stringify(trajectory).replaceAll(scratch, '<home>'));
      assert.deepEqual(normalized, expected.trajectory,
        `${path.basename(dir)} drifted from its expected projection`);
      projected[harness].push({ dir, expected, raw: fs.readFileSync(record, 'utf8') });
    });
  }
}

test('the corpus floor and coverage — a golden table; growing the corpus is a reviewed diff of this table', () => {
  // An expectation is PURE ATIF (the converter's); claim events are the annotator's, so the
  // coverage counts them on the annotated projection — and every expectation must annotate.
  const annotator = new OatheAnnotator();
  const stepsOf = (t) => [t, ...(t.subagent_trajectories ?? [])].flatMap((x) => x.steps ?? []);
  for (const harness of ['codex', 'claude']) {
    for (const { expected } of projected[harness]) {
      assert.ok(!JSON.stringify(expected.trajectory).includes('"oathe"'), `${expected.record}: an expectation is the converter's pure output`);
      expected.trajectory = annotator.annotate(expected.trajectory);
    }
  }
  const coverage = Object.fromEntries(['codex', 'claude'].map((harness) => {
    const rows = projected[harness];
    const kindOf = byName(harness).traces.kindOf;
    const callTypes = new Set();
    for (const { raw } of rows) {
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        const { channel, type } = kindOf(row);
        if (channel === 'response_item' && /(_call$|^tool_use$)/.test(type ?? '')) callTypes.add(type);
        if (channel === 'line' && row.type === 'assistant') {
          for (const part of row.message?.content ?? []) if (part.type === 'tool_use') callTypes.add('tool_use');
        }
      }
    }
    const trajectoriesOf = (t) => [t, ...(t.subagent_trajectories ?? [])];
    return [harness, {
      fixtures: rows.length,
      with_claim_events: rows.filter(({ expected }) => stepsOf(expected.trajectory)
        .some((s) => (s.extra?.oathe?.claim_events ?? []).length > 0)).length,
      with_subagents: rows.filter(({ expected }) => (expected.trajectory.subagent_trajectories ?? []).length > 0).length,
      with_nonzero_metrics: rows.filter(({ expected }) => (expected.trajectory.final_metrics?.total_prompt_tokens ?? 0) > 0).length,
      // The item stream in the corpus: records whose items enriched a call, and — the honesty
      // count — trajectories with an item that completed no call (a join the census would flag).
      with_item_enrichment: rows.filter(({ expected }) => stepsOf(expected.trajectory)
        .some((s) => (s.observation?.results ?? []).some((r) => r.extra?.record !== undefined))).length,
      trajectories_with_uncorrelated_items: rows.flatMap(({ expected }) => trajectoriesOf(expected.trajectory))
        .filter((t) => t.extra?.record?.uncorrelated_items !== undefined).length,
      // Delegation, end to end: a message another agent sent (the bus), a ref on a receipt, a
      // forked child's inherited rows — each a fixture the lanes hold, at any depth.
      with_inbound: rows.filter(({ expected }) => trajectoriesOf(expected.trajectory)
        .some((t) => t.steps.some((s) => s.extra?.record?.inbound !== undefined))).length,
      with_refs: rows.filter(({ expected }) => trajectoriesOf(expected.trajectory)
        .some((t) => t.steps.some((s) => (s.observation?.results ?? []).some((r) => (r.subagent_trajectory_ref ?? []).length > 0)))).length,
      with_copied_context: rows.filter(({ expected }) => trajectoriesOf(expected.trajectory)
        .some((t) => t.steps.some((s) => s.is_copied_context === true))).length,
      tool_call_payload_types: [...callTypes].sort(),
    }];
  }));
  assert.deepEqual(coverage, {
    codex: {
      fixtures: 6,
      with_claim_events: 2,
      with_subagents: 2,
      with_nonzero_metrics: 6,
      with_item_enrichment: 4, // plain-exec-command and nested-token-count carry no exec call or item inside their cap
      trajectories_with_uncorrelated_items: 0,
      with_inbound: 3, // exec-wrapped IS a child (its brief); spawn-fanout's child and fork-parent-child's carry theirs
      with_refs: 1, // spawn-fanout embeds its child from the index — its window holds no spawn call to carry a ref
      with_copied_context: 1, // fork-parent-child: the child begins with the parent's rows
      tool_call_payload_types: ['custom_tool_call', 'function_call'],
    },
    claude: {
      fixtures: 4,
      with_claim_events: 2,
      with_subagents: 2,
      with_nonzero_metrics: 4,
      with_item_enrichment: 0,
      trajectories_with_uncorrelated_items: 0,
      with_inbound: 2, // the task-notification is the harness's message to the session
      with_refs: 2,
      with_copied_context: 0,
      tool_call_payload_types: ['tool_use'],
    },
  });
});
