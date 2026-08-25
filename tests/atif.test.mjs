import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  projectorFor, ClaudeAtifProjector, CodexAtifProjector, AtifValidator, AtifError,
  renderEvidenceView, ATIF_SCHEMA_VERSION, OATHE_CONVENTION_VERSION,
} from '../src/atif.mjs';
import { ClaudeTraceStore, CodexTraceStore } from '../src/traces.mjs';

// ------------------------------------------------------------------ fixtures

/** A rich Claude transcript: text + thinking + tool pair + oathe claim event + noise + subagent. */
function claudeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-atif-c-'));
  const dir = path.join(home, '.claude/projects/-work-proj');
  fs.mkdirSync(dir, { recursive: true });
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const file = path.join(dir, `${sessionId}.jsonl`);
  const rows = [
    { type: 'last-prompt', sessionId, leafUuid: 'x' },                        // noise
    { type: 'ai-title', sessionId, aiTitle: 'Fixture run' },                  // noise → extra.oathe
    {
      type: 'user', uuid: 'u1', sessionId, cwd: '/work/proj', gitBranch: 'main',
      timestamp: '2026-08-25T10:00:00Z', version: '2.1.241',
      message: { role: 'user', content: 'run the tests then claim done' },
    },
    {
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId, cwd: '/work/proj',
      timestamp: '2026-08-25T10:00:05Z',
      message: {
        role: 'assistant', model: 'claude-fable-5',
        content: [
          { type: 'thinking', thinking: 'I should run npm test first.' },
          { type: 'text', text: 'Running the tests now.' },
          { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'npm test' } },
        ],
        usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 10 },
      },
    },
    {
      type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId, cwd: '/work/proj',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'FAIL: 3 tests failed\nExit code 1' }],
      },
    },
    {
      type: 'assistant', uuid: 'a2', parentUuid: 'u2', sessionId, cwd: '/work/proj',
      timestamp: '2026-08-25T10:00:30Z',
      message: {
        role: 'assistant', model: 'claude-fable-5',
        content: [
          { type: 'text', text: 'All tests pass. Fixing a file and asserting done.' },
          { type: 'tool_use', id: 'toolu_02', name: 'Write', input: { file_path: '/work/proj/fix.js', content: 'x' } },
          {
            type: 'tool_use', id: 'toolu_03',
            name: 'mcp__plugin_oathe_oathe__oathe_done',
            input: { task_id: 'task-x', proposition: 'tests green' },
          },
        ],
        usage: { input_tokens: 200, output_tokens: 50 },
      },
    },
    {
      type: 'user', uuid: 'u3', parentUuid: 'a2', sessionId,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_02', content: 'File created successfully' },
          { type: 'tool_result', tool_use_id: 'toolu_03', content: '{"done":true}' },
        ],
      },
    },
    { type: 'file-history-snapshot', messageId: 'm', snapshot: { trackedFileBackups: { '/work/proj/fix.js': 'b1' } } }, // noise → extra.oathe
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  // fan-out
  const subDir = path.join(dir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-sub1.jsonl'), [
    JSON.stringify({ type: 'user', uuid: 's1', sessionId, agentId: 'sub1', message: { role: 'user', content: 'subtask' } }),
    JSON.stringify({
      type: 'assistant', uuid: 's2', sessionId, agentId: 'sub1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'sub done' }] },
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(subDir, 'agent-sub1.meta.json'),
    JSON.stringify({ agentType: 'Explore', description: 'look around', toolUseId: 'toolu_04', spawnDepth: 1 }));
  return { home, file, sessionId };
}

function codexFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-atif-x-'));
  const dir = path.join(home, '.codex/sessions/2026/08/25');
  fs.mkdirSync(dir, { recursive: true });
  const threadId = '01a00000-0000-7000-8000-00000000cafe';
  const file = path.join(dir, `rollout-2026-08-25T10-00-00-${threadId}.jsonl`);
  const rows = [
    {
      timestamp: 't0', type: 'session_meta',
      payload: { id: threadId, session_id: threadId, cwd: '/work/proj', source: 'cli', cli_version: '0.149.1', model_provider: 'openai' },
    },
    { timestamp: 't1', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do the thing' }] } },
    { timestamp: 't2', type: 'response_item', payload: { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'thinking about it' }] } },
    { timestamp: 't3', type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'call_1', arguments: '{"command":["bash","-lc","ls"]}' } },
    { timestamp: 't4', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'file-a\nfile-b' } },
    { timestamp: 't5', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Listed the files.' }] } },
    { timestamp: 't6', type: 'event_msg', payload: { type: 'token_count', input_tokens: 500, output_tokens: 80, cached_tokens: 100 } },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  return { home, file, threadId };
}

// ------------------------------------------------------------------ Claude projection

test('Claude projection: steps carry the SAID/THOUGHT/DID/GOT split, noise rows are filtered', () => {
  const { home, file, sessionId } = claudeFixture();
  const projector = new ClaudeAtifProjector({ store: new ClaudeTraceStore({ home }) });
  const t = projector.project(file);

  assert.equal(t.schema_version, ATIF_SCHEMA_VERSION);
  assert.equal(t.session_id, sessionId);
  assert.equal(t.agent.name, 'claude');
  assert.equal(t.agent.model_name, 'claude-fable-5');
  assert.equal(t.agent.version, '2.1.241');

  // steps: user, agent(with obs), agent(with obs) — noise rows contribute NO steps
  assert.equal(t.steps.length, 3);
  assert.deepEqual(t.steps.map((s) => s.step_id), [1, 2, 3]);
  assert.deepEqual(t.steps.map((s) => s.source), ['user', 'agent', 'agent']);

  const a1 = t.steps[1];
  assert.equal(a1.message, 'Running the tests now.');
  assert.equal(a1.reasoning_content, 'I should run npm test first.');
  assert.equal(a1.tool_calls[0].function_name, 'Bash');
  assert.deepEqual(a1.tool_calls[0].arguments, { command: 'npm test' });
  assert.equal(a1.observation.results[0].source_call_id, 'toolu_01');
  assert.match(a1.observation.results[0].content, /3 tests failed/);
  // conservative exit-code parse from the result text
  assert.equal(a1.observation.results[0].extra.oathe.observed.exit_code, 1);
  assert.equal(a1.metrics.prompt_tokens, 170); // input + cache_read + cache_creation
  assert.equal(a1.metrics.cached_tokens, 60);
  assert.equal(a1.metrics.extra.cache_creation_input_tokens, 10);

  const a2 = t.steps[2];
  // the oathe speech act is structurally marked
  assert.equal(a2.extra.oathe.claim_events[0].verb, 'oathe_done');
  assert.equal(a2.extra.oathe.claim_events[0].task_id, 'task-x');
  // file-touching tool call carries its files
  const writeCall = a2.tool_calls.find((c) => c.function_name === 'Write');
  assert.deepEqual(writeCall.extra.oathe.files, ['/work/proj/fix.js']);
  // no exit code stated in these results → observed is ABSENT, never fabricated
  const writeResult = a2.observation.results.find((r) => r.source_call_id === 'toolu_02');
  assert.equal(writeResult.extra?.oathe?.observed?.exit_code, undefined);

  // root extra.oathe: convention version + provenance + noise promoted to metadata
  assert.equal(t.extra.oathe.oathe_convention, OATHE_CONVENTION_VERSION);
  assert.equal(t.extra.oathe.harness, 'claude');
  assert.equal(t.extra.oathe.source_path, file);
  assert.equal(t.extra.oathe.session_title, 'Fixture run');
  assert.deepEqual(t.extra.oathe.files_touched, ['/work/proj/fix.js']);

  // fan-out embedded with unique trajectory ids
  assert.equal(t.subagent_trajectories.length, 1);
  assert.equal(t.subagent_trajectories[0].trajectory_id, 'sub1');
  assert.equal(t.subagent_trajectories[0].steps.length, 2);

  // metrics accumulate
  assert.equal(t.final_metrics.total_prompt_tokens, 370);
  assert.equal(t.final_metrics.total_completion_tokens, 90);
  assert.equal(t.final_metrics.total_steps, 3);
});

test('Codex projection: rollout items map to steps with the same structural split', () => {
  const { home, file, threadId } = codexFixture();
  const projector = new CodexAtifProjector({ store: new CodexTraceStore({ home }) });
  const t = projector.project(file);

  assert.equal(t.session_id, threadId);
  assert.equal(t.agent.name, 'codex');
  assert.equal(t.agent.version, '0.149.1');
  assert.equal(t.steps.length, 2); // user message, agent turn (reasoning+call+obs+text)
  assert.equal(t.steps[0].source, 'user');
  assert.equal(t.steps[0].message, 'do the thing');
  const agent = t.steps[1];
  assert.equal(agent.source, 'agent');
  assert.equal(agent.reasoning_content, 'thinking about it');
  assert.equal(agent.tool_calls[0].function_name, 'shell');
  assert.equal(agent.tool_calls[0].tool_call_id, 'call_1');
  assert.equal(agent.observation.results[0].source_call_id, 'call_1');
  assert.match(agent.observation.results[0].content, /file-a/);
  assert.equal(agent.message, 'Listed the files.');
  assert.equal(t.final_metrics.total_prompt_tokens, 500);
  assert.equal(t.extra.oathe.harness, 'codex');
});

test('projectorFor picks the projector by store path', () => {
  const { home: ch, file: cf } = claudeFixture();
  const { home: xh, file: xf } = codexFixture();
  assert.ok(projectorFor(cf, { claudeHome: ch, codexHome: xh }) instanceof ClaudeAtifProjector);
  assert.ok(projectorFor(xf, { claudeHome: ch, codexHome: xh }) instanceof CodexAtifProjector);
});

// ------------------------------------------------------------------ validator

function validTrajectory() {
  const { home, file } = claudeFixture();
  return new ClaudeAtifProjector({ store: new ClaudeTraceStore({ home }) }).project(file);
}

test('the validator accepts every projector output (finalize() already ran it once)', () => {
  const v = new AtifValidator();
  assert.equal(v.validate(validTrajectory()).ok, true);
});

test('each broken invariant refuses with its OWN typed code', () => {
  const v = new AtifValidator();
  const cases = [
    [(t) => { t.steps[1].step_id = 7; }, /step_id/],
    [(t) => { t.steps[1].observation.results[0].source_call_id = 'nope'; }, /source_call_id/],
    [(t) => { t.made_up_field = 1; }, /unknown field/i],
    [(t) => { t.steps[0].tool_calls = []; }, /agent-only/i],
    [(t) => { t.schema_version = 'ATIF-v9.9'; }, /schema_version/],
    [(t) => { t.subagent_trajectories[0].trajectory_id = null; }, /trajectory_id/],
    [(t) => { t.steps = []; }, /steps/],
  ];
  for (const [mutate, pattern] of cases) {
    const t = validTrajectory();
    mutate(t);
    const seen = v.validate(t);
    assert.equal(seen.ok, false, `expected refusal for ${pattern}`);
    assert.match(seen.detail, pattern);
    assert.throws(() => v.assert(t), (e) => e instanceof AtifError && e.code === 'ATIF_INVALID');
  }
});

// ------------------------------------------------------------------ evidence view

test('renderEvidenceView aligns SAID/DID/GOT per step and marks the speech acts', () => {
  const { home, file } = claudeFixture();
  const t = new ClaudeAtifProjector({ store: new ClaudeTraceStore({ home }) }).project(file);
  const view = renderEvidenceView(t, { budget: 100000 });
  assert.match(view, /SAID: Running the tests now\./);
  assert.match(view, /DID: Bash\(/);
  assert.match(view, /GOT \[exit 1\]: FAIL: 3 tests failed/);
  assert.match(view, /CLAIM\(oathe_done task-x\)/);
  assert.match(view, /USER: run the tests then claim done/);
  assert.match(view, /SUBAGENT sub1 \(Explore\)/);
  assert.match(view, /files touched: \/work\/proj\/fix\.js/);
});

test('renderEvidenceView under budget pressure elides the HEAD, announces it, keeps the tail whole', () => {
  const { home, file } = claudeFixture();
  const t = new ClaudeAtifProjector({ store: new ClaudeTraceStore({ home }) }).project(file);
  const view = renderEvidenceView(t, { budget: 420 });
  assert.ok(view.length <= 1000, 'bounded output');
  assert.match(view, /\[\d+ earlier steps? elided: \d+ tool calls?, \d+ claims?\]/);
  assert.match(view, /CLAIM\(oathe_done task-x\)/, 'the tail (most recent steps) survives');
  assert.doesNotMatch(view, /SAID: Running the tests now/, 'the head was elided');
});

// ------------------------------------------------------------------ golden cross-check

test("GOLDEN: Harbor's own reference trajectory passes OUR validator — we implement their rules, not our misreading", () => {
  // Vendored 2026-08-25 from harbor-framework/harbor tests/golden/terminus_2 (Apache-2.0).
  const golden = JSON.parse(fs.readFileSync(
    path.join(import.meta.dirname, 'fixtures/harbor-golden-terminus2.trajectory.json'), 'utf8'));
  const seen = new AtifValidator().validate(golden);
  assert.equal(seen.ok, true, `golden refused: ${seen.detail}`);
});

// ------------------------------------------------------------------ live contract (fail loud on drift)

test('LIVE: the newest real Claude transcript projects to valid ATIF end to end', (t) => {
  const store = new ClaudeTraceStore({});
  const newest = store.newestTranscript();
  if (!newest) return t.skip('no local Claude store');
  const trajectory = new ClaudeAtifProjector({ store }).project(newest);
  assert.equal(new AtifValidator().validate(trajectory).ok, true,
    `CLAUDE ATIF DRIFT on ${newest}`);
  assert.ok(trajectory.steps.length >= 1);
});

test('LIVE: the newest real Codex rollout projects to valid ATIF end to end', (t) => {
  const store = new CodexTraceStore({});
  const newest = store.newestRollout();
  if (!newest) return t.skip('no local Codex store');
  const trajectory = new CodexAtifProjector({ store }).project(newest);
  assert.equal(new AtifValidator().validate(trajectory).ok, true,
    `CODEX ATIF DRIFT on ${newest}`);
  assert.ok(trajectory.steps.length >= 1);
});
