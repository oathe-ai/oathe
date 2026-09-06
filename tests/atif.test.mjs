import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { projectorFor } from '../src/harnesses/catalog.mjs';
import {
  AtifValidator, AtifError,
  renderEvidenceView, ATIF_SCHEMA_VERSION,
  claimIntervals, sliceForTask,
} from '../src/atif.mjs';
import { OatheAnnotator, OATHE_CONVENTION_VERSION, projectAnnotated } from '../src/oathe-annotator.mjs';
import { ClaudeAtifProjector } from '../src/harnesses/claude-transcript.mjs';
import { CodexAtifProjector } from '../src/harnesses/codex-rollout.mjs';
import { ClaudeTraceStore, CodexTraceStore, TraceContractError } from '../src/traces.mjs';
import { requireSqlite } from './helpers.mjs';

// A below-floor runtime fails these lanes LOUDLY with the floor named — never a silent skip.
requireSqlite();

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
    // Fan-out the way the harness records it (measured 2026-09-01): an Agent tool_use, its
    // ASYNC launch receipt, and later a task-notification user row from the harness itself.
    {
      type: 'assistant', uuid: 'a3', parentUuid: 'u3', sessionId, cwd: '/work/proj', timestamp: '2026-08-25T10:01:00Z',
      message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id: 'toolu_04', name: 'Agent', input: { description: 'look around', subagent_type: 'Explore', prompt: 'subtask' } }] },
    },
    {
      type: 'user', uuid: 'u4', parentUuid: 'a3', sessionId,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_04', content: 'Async agent launched successfully.\nagentId: sub1' }] },
    },
    {
      type: 'user', uuid: 'u5', parentUuid: 'u4', sessionId, origin: { kind: 'task-notification' }, promptSource: 'system',
      message: { role: 'user', content: '<task-notification>\n<task-id>sub1</task-id>\n<tool-use-id>toolu_04</tool-use-id>\n<summary>Agent "look around" finished</summary>\n<result>sub done</result>\n</task-notification>' },
    },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  // fan-out
  const subDir = path.join(dir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-sub1.jsonl'), [
    JSON.stringify({ type: 'user', uuid: 's1', sessionId, agentId: 'sub1', message: { role: 'user', content: 'subtask' } }),
    JSON.stringify({
      type: 'assistant', uuid: 's2', sessionId, agentId: 'sub1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'sub done' }], usage: { input_tokens: 30, output_tokens: 5 } },
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(subDir, 'agent-sub1.meta.json'),
    JSON.stringify({ agentType: 'Explore', description: 'look around', toolUseId: 'toolu_04', spawnDepth: 1 }));
  return { home, file, sessionId };
}

/**
 * A codex rollout in the REAL current format (measured on live rollouts, codex CLI
 * 0.149–0.150, 2026-08-31): custom_tool_call carries the command as a JS-source string in
 * payload.input; token_count nests under info.last_token_usage; reasoning is encrypted (a
 * step boundary, not text); developer-role rows are injected instructions, not the agent;
 * function_call composes namespace into the name. `extraRows` appends rows after the base.
 */
function codexFixture({ extraRows = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-atif-x-'));
  const dir = path.join(home, '.codex/sessions/2026/08/25');
  fs.mkdirSync(dir, { recursive: true });
  const threadId = '01a00000-0000-7000-8000-00000000cafe';
  const file = path.join(dir, `rollout-2026-08-25T10-00-00-${threadId}.jsonl`);
  const tokenCount = (input, cached, output) => ({
    timestamp: 't', type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 5, total_tokens: input + output },
        last_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 5, total_tokens: input + output },
        model_context_window: 258400,
      },
      rate_limits: { limit_id: 'codex' },
    },
  });
  const rows = [
    {
      timestamp: 't0', type: 'session_meta',
      payload: { id: threadId, cwd: '/work/proj', source: 'cli', cli_version: '0.150.0', model_provider: 'openai' },
    },
    {
      timestamp: 't1', type: 'turn_context',
      payload: { turn_id: 'turn-1', cwd: '/work/proj', model: 'gpt-5.6-sol', workspace_roots: ['/work/proj'], approval_policy: 'never', sandbox_policy: { type: 'read-only' } },
    },
    { timestamp: 't2', type: 'response_item', payload: { type: 'message', id: 'msg_1', role: 'user', content: [{ type: 'input_text', text: 'do the thing' }] } },
    { timestamp: 't3', type: 'response_item', payload: { type: 'message', id: 'msg_2', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>' }] } },
    { timestamp: 't4', type: 'response_item', payload: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA-opaque-1' } },
    {
      timestamp: 't5', type: 'response_item',
      payload: {
        type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'call_1', name: 'exec',
        input: 'const r = await tools.exec_command({cmd:"npm test && echo \\"done (really)\\"",workdir:"/work/proj",yield_time_ms:10000});\nfor (const c of (r.content||[])) if (c.type==="text") text(c.text);\n',
      },
    },
    // The item stream decodes the call the exec source wraps — measured row order: call → item
    // → output → token_count.
    {
      timestamp: 't5b', type: 'event_msg',
      payload: {
        type: 'item_completed', thread_id: threadId, turn_id: 'turn-1', started_at_ms: 1, completed_at_ms: 2,
        item: { type: 'CommandExecution', id: 'exec-00000000-0000-7000-8000-000000000001', command: ['bash', '-lc', 'npm test && echo "done (really)"'], cwd: '/work/proj', status: 'completed', exit_code: 0, stdout: '42 passing', stderr: '', aggregated_output: '42 passing' },
      },
    },
    {
      timestamp: 't6', type: 'response_item',
      payload: {
        type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_1',
        output: [{ type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' }, { type: 'input_text', text: '42 passing\nExit code 0' }],
      },
    },
    tokenCount(500, 100, 80),
    { timestamp: 't8', type: 'response_item', payload: { type: 'reasoning', id: 'rs_2', summary: [], encrypted_content: 'gAAAA-opaque-2' } },
    {
      timestamp: 't9', type: 'response_item',
      payload: {
        type: 'custom_tool_call', id: 'ctc_2', status: 'completed', call_id: 'call_2', name: 'exec',
        input: 'const r = await tools.mcp__oathe__oathe_claim({task_id:"task-x", objective:"do the thing"});\nfor (const c of (r.content||[])) if (c.type==="text") text(c.text);\n',
      },
    },
    {
      timestamp: 't10', type: 'response_item',
      payload: {
        type: 'custom_tool_call_output', id: 'ctco_2', call_id: 'call_2',
        output: [{ type: 'input_text', text: '{"claimed":true,"task_id":"task-x","work_claim_id":"w-1"}' }],
      },
    },
    tokenCount(700, 100, 40),
    tokenCount(50, 0, 10),
    { timestamp: 't11', type: 'response_item', payload: { type: 'message', id: 'msg_3', role: 'assistant', content: [{ type: 'output_text', text: 'Claimed the task.' }] } },
    {
      timestamp: 't12', type: 'response_item',
      payload: { type: 'function_call', id: 'fc_1', name: 'spawn_agent', namespace: 'collaboration', call_id: 'call_3', arguments: '{"task_name":"draft-1","message":"opaque"}' },
    },
    { timestamp: 't13', type: 'response_item', payload: { type: 'function_call_output', id: 'fco_1', call_id: 'call_3', output: 'spawned' } },
    {
      timestamp: 't14', type: 'response_item',
      payload: {
        type: 'custom_tool_call', id: 'ctc_3', status: 'completed', call_id: 'call_4', name: 'exec',
        input: 'const xs = ALL_TOOLS.filter(x => /oathe/i.test(x.name)); text(xs);\n',
      },
    },
    {
      timestamp: 't15', type: 'response_item',
      payload: { type: 'custom_tool_call_output', id: 'ctco_3', call_id: 'call_4', output: [{ type: 'input_text', text: 'listed' }] },
    },
    { timestamp: 't16', type: 'response_item', payload: { type: 'message', id: 'msg_4', role: 'user', content: [{ type: 'input_text', text: 'looks good' }] } },
    // The legacy JSON function_call shape still occurs in live stores — it stays supported.
    { timestamp: 't17', type: 'response_item', payload: { type: 'function_call', id: 'fc_2', name: 'shell', call_id: 'call_5', arguments: '{"command":["bash","-lc","ls"]}' } },
    { timestamp: 't18', type: 'response_item', payload: { type: 'function_call_output', id: 'fco_2', call_id: 'call_5', output: 'file-a' } },
    ...extraRows,
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  return { home, file, threadId };
}

// ------------------------------------------------------------------ Claude projection

test('Claude projection: steps carry the SAID/THOUGHT/DID/GOT split, noise rows are filtered', () => {
  const { home, file, sessionId } = claudeFixture();
  const projector = new ClaudeAtifProjector({ store: new ClaudeTraceStore({ harness: 'claude', home }) });
  const t = projector.project(file);

  assert.equal(t.schema_version, ATIF_SCHEMA_VERSION);
  assert.equal(t.session_id, sessionId);
  assert.equal(t.agent.name, 'claude');
  assert.equal(t.agent.model_name, 'claude-fable-5');
  assert.equal(t.agent.version, '2.1.241');

  // steps: user, agent(with obs), agent(with obs), agent(the spawn + its receipt), system(the
  // notification) — noise rows contribute NO steps
  assert.equal(t.steps.length, 5);
  assert.deepEqual(t.steps.map((s) => s.step_id), [1, 2, 3, 4, 5]);
  assert.deepEqual(t.steps.map((s) => s.source), ['user', 'agent', 'agent', 'agent', 'system']);

  const a1 = t.steps[1];
  assert.equal(a1.message, 'Running the tests now.');
  assert.equal(a1.reasoning_content, 'I should run npm test first.');
  assert.equal(a1.tool_calls[0].function_name, 'Bash');
  assert.deepEqual(a1.tool_calls[0].arguments, { command: 'npm test' });
  assert.equal(a1.observation.results[0].source_call_id, 'toolu_01');
  assert.match(a1.observation.results[0].content, /3 tests failed/);
  assert.equal(a1.metrics.prompt_tokens, 170); // input + cache_read + cache_creation
  assert.equal(a1.metrics.cached_tokens, 60);
  assert.equal(a1.metrics.extra.cache_creation_input_tokens, 10);

  // The converter is PURE ATIF — what a Harbor converter could also emit. Nothing oathe rides
  // it: no claim events, no files, no observed facts, no convention (the annotator's).
  assert.ok(!JSON.stringify(t).includes('"oathe"'), 'no oathe key anywhere in a converter output');
  // Raw-record facts ATIF has no field for live in extra.record: provenance + the noise rows
  // promoted to metadata.
  assert.equal(t.extra.record.source_path, file);
  assert.equal(t.extra.record.session_title, 'Fixture run');
  assert.deepEqual(t.extra.record.files_touched, ['/work/proj/fix.js']);
  assert.equal(t.extra.record.harness, undefined, 'the harness is agent.name — a spec field, not a record fact');

  // fan-out embedded with unique trajectory ids, the meta a record fact on the child
  assert.equal(t.subagent_trajectories.length, 1);
  assert.equal(t.subagent_trajectories[0].trajectory_id, 'sub1');
  assert.equal(t.subagent_trajectories[0].steps.length, 2);
  assert.deepEqual(t.subagent_trajectories[0].extra.record.subagent_meta,
    { agentType: 'Explore', description: 'look around', toolUseId: 'toolu_04', spawnDepth: 1 });
  // The spawn call's receipt carries the ref to the child it started (qwen parity: the ref
  // sits on the observation result of the call that delegated) — meta.toolUseId IS the
  // Agent tool_use id (measured 2026-09-01: 267 joins over 16 fan-out transcripts).
  const receipt = t.steps[3].observation.results.find((r) => r.source_call_id === 'toolu_04');
  assert.deepEqual(receipt.subagent_trajectory_ref, [{ trajectory_id: 'sub1', extra: { agent_type: 'Explore' } }]);

  // metrics accumulate — and the child's usage FOLDS into the root's totals (qwen parity:
  // a run that delegates is not under-counted); total_steps stays this trajectory's own.
  assert.equal(t.final_metrics.total_prompt_tokens, 400);
  assert.equal(t.final_metrics.total_completion_tokens, 95);
  assert.equal(t.final_metrics.total_steps, 5);
  assert.deepEqual(t.subagent_trajectories[0].final_metrics, { total_prompt_tokens: 30, total_completion_tokens: 5, total_cached_tokens: 0, total_steps: 2 });
});

/** A Claude transcript from explicit rows — for the origin.kind cases. */
function claudeTranscript(rows, { subagents = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-atif-ct-'));
  const dir = path.join(home, '.claude/projects/-work-proj');
  fs.mkdirSync(dir, { recursive: true });
  const sessionId = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, rows.map((r, i) => JSON.stringify({ uuid: `r${i}`, sessionId, ...r })).join('\n'));
  for (const id of subagents) {
    const subDir = path.join(dir, sessionId, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, `agent-${id}.jsonl`), JSON.stringify({ type: 'user', uuid: `s-${id}`, sessionId, agentId: id, message: { role: 'user', content: 'sub work' } }));
  }
  return new ClaudeAtifProjector({ store: new ClaudeTraceStore({ harness: 'claude', home }) }).project(file);
}
const userRow = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const notification = (taskId, toolUseId, result = 'done') => userRow(
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<summary>finished</summary>\n<result>${result}</result>\n</task-notification>`,
  { origin: { kind: 'task-notification' }, promptSource: 'system' },
);

test('Claude inbound: a task-notification (origin.kind, measured 262 of 681 user rows) is a SYSTEM step — the harness speaking, never USER — with a ref to the subagent it names', () => {
  const t = claudeTranscript([
    userRow('run it'),
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { prompt: 'go' } }, { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'sleep 9', run_in_background: true } }] } },
    userRow([{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'Async agent launched' }, { type: 'tool_result', tool_use_id: 'toolu_b', content: 'running in the background' }]),
    notification('sub1', 'toolu_a', 'the subagent says done'),
    notification('bash-task-7', 'toolu_b', 'exit 0'),
    notification('ghost', 'toolu_zzz', 'from nowhere'),
  ], { subagents: ['sub1'] });
  assert.deepEqual(t.steps.map((s) => s.source), ['user', 'agent', 'system', 'system', 'system']);
  const [agent, bash, ghost] = t.steps.slice(2);
  assert.equal(agent.llm_call_count, 0);
  assert.equal(agent.message, '[inbound task-notification sub1]');
  assert.match(agent.observation.results[0].content, /the subagent says done/, 'the notification is an observation of the background task');
  assert.deepEqual(agent.extra.record.inbound, { kind: 'task-notification', task_id: 'sub1', tool_use_id: 'toolu_a' });
  assert.deepEqual(agent.observation.results[0].subagent_trajectory_ref, [{ trajectory_id: 'sub1' }], 'the task id IS the embedded subagent\'s id');
  assert.deepEqual(bash.extra.record.inbound, { kind: 'task-notification', task_id: 'bash-task-7', tool_use_id: 'toolu_b' });
  assert.equal(bash.observation.results[0].subagent_trajectory_ref, undefined, 'a background command is not a subagent');
  assert.equal(ghost.observation.results[0].subagent_trajectory_ref, undefined);
  assert.equal(t.extra.record.unresolved_inbound, 1, 'a notification naming neither a subagent nor a call this record made is counted');
  const view = renderEvidenceView(t, { budget: 100000 });
  assert.match(view, /FROM task-notification \(sub1\) → subagent sub1: <task-notification>/);
  assert.doesNotMatch(view, /USER: <task-notification>/);
});

test('Claude inbound: peer and auto-continuation rows are the harness\'s, not the person\'s — system steps; an absent kind is the person; an UNKNOWN kind is a user step counted as unrecognized, never silent', () => {
  const t = claudeTranscript([
    userRow('typed by a person', { origin: { kind: 'human' }, promptSource: 'typed' }),
    userRow('a message from another session', { origin: { kind: 'peer' }, promptSource: 'system' }),
    userRow('continue', { origin: { kind: 'auto-continuation' }, promptSource: 'system' }),
    userRow('no origin at all'),
    userRow('from the future', { origin: { kind: 'holo' } }),
  ]);
  assert.deepEqual(t.steps.map((s) => s.source), ['user', 'system', 'system', 'user', 'user']);
  assert.deepEqual(t.steps[1].extra.record.inbound, { kind: 'peer' });
  assert.deepEqual(t.steps[2].extra.record.inbound, { kind: 'auto-continuation' });
  assert.equal(t.steps[1].llm_call_count, 0);
  assert.equal(t.steps[3].extra, undefined);
  assert.equal(t.steps[4].source, 'user', 'a person\'s row under a kind we have not reviewed still projects — dropping it would fabricate absence');
  assert.deepEqual(t.extra.record.unrecognized_rows, { 'origin.holo': 1 }, 'and the unknown kind is DRIFT the census flags');
  assert.match(renderEvidenceView(t, { budget: 100000 }), /FROM peer: a message from another session/);
});

test('OatheAnnotator: the claims-vs-actions layer over a pure trajectory — a copy, extra.oathe only, and nothing else changes', () => {
  const { home, file } = claudeFixture();
  const pure = new ClaudeAtifProjector({ store: new ClaudeTraceStore({ harness: 'claude', home }) }).project(file);
  const before = JSON.stringify(pure);
  const t = new OatheAnnotator().annotate(pure);
  assert.equal(JSON.stringify(pure), before, 'the input is untouched — the annotation is a copy');

  assert.equal(t.extra.oathe.oathe_convention, OATHE_CONVENTION_VERSION);
  assert.equal(OATHE_CONVENTION_VERSION, 2, 'convention 2: record facts moved out of extra.oathe');
  const a1 = t.steps[1];
  // conservative exit-code parse from the result text
  assert.equal(a1.observation.results[0].extra.oathe.observed.exit_code, 1);
  const a2 = t.steps[2];
  // the oathe speech act is structurally marked
  assert.deepEqual(a2.extra.oathe.claim_events, [{ verb: 'oathe_done', task_id: 'task-x' }]);
  // file-touching tool call carries its files
  const writeCall = a2.tool_calls.find((c) => c.function_name === 'Write');
  assert.deepEqual(writeCall.extra.oathe.files, ['/work/proj/fix.js']);
  // no exit code stated in these results → observed is ABSENT, never fabricated
  const writeResult = a2.observation.results.find((r) => r.source_call_id === 'toolu_02');
  assert.equal(writeResult.extra?.oathe?.observed?.exit_code, undefined);
  // the record facts still ride beside the annotation
  assert.equal(t.extra.record.source_path, file);
  assert.equal(t.subagent_trajectories[0].extra.oathe.oathe_convention, OATHE_CONVENTION_VERSION, 'children are annotated too');

  // annotated − extra.oathe (at every level) deep-equals the pure input: the annotation ADDS
  // to the sanctioned slot and rewrites nothing.
  const stripped = JSON.parse(JSON.stringify(t, (key, value) => {
    if (key === 'extra' && value && typeof value === 'object' && 'oathe' in value) {
      const rest = { ...value };
      delete rest.oathe;
      return Object.keys(rest).length > 0 ? rest : undefined;
    }
    return value;
  }));
  assert.deepEqual(stripped, pure);
  assert.equal(new AtifValidator().validate(t).ok, true, 'an annotated trajectory is still valid ATIF');
  assert.deepEqual(claimIntervals(t), [{ task_id: 'task-x', start_index: 2, end_index: 2 }], 'intervals read the annotation');
});

test('observedFacts: an exit code is what the record states structurally, else what the output states as its OWN last line — a mention inside printed content is not an observation', async () => {
  const { statedExitCode, observedFacts } = await import('../src/oathe-annotator.mjs');
  assert.equal(statedExitCode('42 passing\nExit code 0'), 0);
  assert.equal(statedExitCode('FAIL\nExit code 1\n'), 1, 'trailing whitespace is still the last line');
  assert.equal(statedExitCode('the doc says: on failure the tool prints Exit code 1 and stops\nmore text'), null,
    'measured 2026-09-01: every real "Exit code N" was inside content — never the wrapper\'s own line');
  assert.equal(statedExitCode(''), null);
  assert.deepEqual(observedFacts({ content: 'printed: Exit code 1\nok', extra: { record: { exit_code: 0 } } }), { exit_code: 0 }, 'the record outranks the text');
  assert.equal(observedFacts({ content: 'printed: Exit code 1\nok' }), null);
});

test('OatheAnnotator: invalid input is a typed refusal; the obligation stamps the root on export', () => {
  const annotator = new OatheAnnotator();
  assert.throws(() => annotator.annotate({ schema_version: 'ATIF-v1.7', agent: { name: 'x' }, steps: [] }),
    (e) => e instanceof AtifError && e.code === 'ATIF_ANNOTATE_INVALID_INPUT');
  const { home, file } = claudeFixture();
  const pure = new ClaudeAtifProjector({ store: new ClaudeTraceStore({ harness: 'claude', home }) }).project(file);
  const obligation = { org_id: 'oathe', task_id: 'task-x', work_claim_id: 'w-1', contract_ref: 'c', workspace: 'ws-000000000000', verdict: { result: 'accepted' } };
  const stamped = annotator.annotate(pure, { obligation });
  assert.deepEqual(stamped.extra.oathe, { oathe_convention: OATHE_CONVENTION_VERSION, ...obligation });
  assert.equal(stamped.subagent_trajectories[0].extra.oathe.task_id, undefined, 'the obligation is the root\'s, not the children\'s');
});

test('projectAnnotated is the one read every oathe consumer performs: the owning converter, then the annotation', async () => {
  const { home, file } = claudeFixture();
  const t = await projectAnnotated(file, { home });
  assert.equal(t.extra.oathe.oathe_convention, OATHE_CONVENTION_VERSION);
  assert.equal(t.extra.record.source_path, file);
  assert.deepEqual(t.steps[2].extra.oathe.claim_events, [{ verb: 'oathe_done', task_id: 'task-x' }]);
});


test('Codex projection: the REAL current rollout format projects with full fidelity', () => {
  const { home, file, threadId } = codexFixture();
  const projector = new CodexAtifProjector({ store: new CodexTraceStore({ harness: 'codex', home }) });
  const pure = projector.project(file);
  assert.ok(!JSON.stringify(pure).includes('"oathe"'), 'the converter is pure ATIF');
  const t = new OatheAnnotator().annotate(pure);

  assert.equal(t.session_id, threadId);
  assert.equal(t.agent.name, 'codex');
  assert.equal(t.agent.version, '0.150.0');
  assert.equal(t.agent.model_name, 'gpt-5.6-sol'); // the first turn_context's model (Harbor codex.py: the same read)

  // Steps follow the model's API calls — the reference converter's partition: a token_count
  // closes one call (Harbor codex.py, finish_api_call). user / system(developer) /
  // agent(call_1) / agent(the claim) / agent(the answer + spawn + raw exec) / user /
  // agent(legacy). Developer rows are INJECTED instructions and never the agent's own
  // words; an encrypted reasoning row marks nothing under this boundary.
  assert.deepEqual(t.steps.map((s) => s.source), ['user', 'system', 'agent', 'agent', 'agent', 'user', 'agent']);
  assert.equal(t.extra.record.step_boundary, 'token_count', 'the boundary is declared per file, from the file\'s own evidence');
  assert.equal(t.steps[0].message, 'do the thing');
  assert.equal(t.steps[1].message, '<permissions instructions>');

  // exec-wrapped command: the inner tool and its REAL arguments survive projection
  const first = t.steps[2];
  assert.equal(first.tool_calls[0].function_name, 'exec_command');
  assert.deepEqual(first.tool_calls[0].arguments,
    { cmd: 'npm test && echo "done (really)"', workdir: '/work/proj', yield_time_ms: 10000 });
  const result = first.observation.results[0];
  assert.equal(result.source_call_id, 'call_1');
  assert.match(result.content, /42 passing/);
  assert.equal(result.extra.record.exit_code, 0, 'the item stream\'s structural exit code rides the result');
  assert.equal(result.extra.oathe.observed.exit_code, 0);
  assert.deepEqual(first.metrics, { prompt_tokens: 500, completion_tokens: 80, cached_tokens: 100 });
  assert.equal(first.llm_call_count, 1, 'one token_count landed on this step');
  assert.equal(first.timestamp, 't5', 'the first row that opened the step');

  // exec-wrapped oathe speech act: name surfaces, claim_events fire, intervals exist
  const second = t.steps[3];
  assert.equal(second.tool_calls[0].function_name, 'mcp__oathe__oathe_claim');
  assert.deepEqual(second.tool_calls[0].arguments, { task_id: 'task-x', objective: 'do the thing' });
  assert.deepEqual(second.extra.oathe.claim_events, [{ verb: 'oathe_claim', task_id: 'task-x' }]);
  assert.match(second.observation.results.find((r) => r.source_call_id === 'call_2').content, /"claimed":true/);
  // a second token_count with no agent row between them closed nothing: an orphan, counted in
  // the record — never a second call on a step already closed (measured 2026-09-02)
  assert.deepEqual(second.metrics, { prompt_tokens: 700, completion_tokens: 40, cached_tokens: 100 });
  assert.equal(second.llm_call_count, 1);
  assert.equal(t.extra.record.orphan_token_counts, 1);
  assert.equal(second.message, '', 'the answer that followed the token_counts belongs to the NEXT call');

  const third = t.steps[4];
  assert.equal(third.message, 'Claimed the task.');
  assert.equal(third.timestamp, 't11');
  assert.equal(third.llm_call_count, undefined, 'no token_count closed this call in the record — no count is invented');
  // function_call with a namespace composes it into the name
  const spawn = third.tool_calls.find((c) => c.tool_call_id === 'call_3');
  assert.equal(spawn.function_name, 'collaboration__spawn_agent');
  assert.deepEqual(spawn.arguments, { task_name: 'draft-1', message: 'opaque' });
  // exec source with NO single inner tool keeps the raw source as the argument — never {}
  const rawExec = third.tool_calls.find((c) => c.tool_call_id === 'call_4');
  assert.equal(rawExec.function_name, 'exec');
  assert.match(rawExec.arguments.input, /ALL_TOOLS\.filter/);

  // the legacy JSON function_call shape still projects
  const legacy = t.steps[6];
  assert.equal(legacy.tool_calls[0].function_name, 'shell');
  assert.deepEqual(legacy.tool_calls[0].arguments, { command: ['bash', '-lc', 'ls'] });

  assert.equal(t.final_metrics.total_prompt_tokens, 1200, 'the orphan\'s 50 is nobody\'s');
  assert.equal(t.final_metrics.total_completion_tokens, 120);
  assert.equal(t.final_metrics.total_cached_tokens, 200);
  assert.equal(t.extra.record.source_path, file);

  // the incident's exact failure: a codex session's oathe acts are attributable
  assert.deepEqual(claimIntervals(t), [{ task_id: 'task-x', start_index: 3, end_index: 6 }]);
});

/**
 * A codex rollout from explicit rows (session_meta prepended) — for boundary and shape cases.
 * `children` writes the thread index and a minimal rollout per child, the way the store
 * embeds fan-out: `[{id, agentPath}]`.
 */
function codexRollout(rows, { meta = {}, children = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-atif-r-'));
  const dir = path.join(home, '.codex/sessions/2026/08/25');
  fs.mkdirSync(dir, { recursive: true });
  const threadId = '01a00000-0000-7000-8000-00000000f00d';
  const file = path.join(dir, `rollout-2026-08-25T10-00-00-${threadId}.jsonl`);
  fs.writeFileSync(file, [
    { timestamp: 't0', type: 'session_meta', payload: { id: threadId, cwd: '/work/proj', source: 'cli', cli_version: '0.150.0', model_provider: 'openai', ...meta } },
    ...rows,
  ].map((r) => JSON.stringify(r)).join('\n'));
  if (children.length > 0) {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(path.join(home, '.codex/state_5.sqlite'));
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT, title TEXT,
               tokens_used INTEGER, git_sha TEXT, git_branch TEXT, source TEXT, created_at INTEGER);
             CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);`);
    for (const { id, agentPath, rows: childRows = null } of children) {
      const childFile = path.join(dir, `rollout-2026-08-25T10-05-00-${id}.jsonl`);
      fs.writeFileSync(childFile, [
        { timestamp: 't0', type: 'session_meta', payload: { id, cwd: '/work/proj', source: { subagent: { thread_spawn: { parent_thread_id: threadId, agent_path: agentPath } } }, cli_version: '0.150.0', model_provider: 'openai' } },
        ...(childRows ?? [{ timestamp: 't1', type: 'response_item', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'child work' }] } }]),
      ].map((r) => JSON.stringify(r)).join('\n'));
      db.prepare('INSERT INTO threads (id, rollout_path, cwd, source, created_at) VALUES (?, ?, ?, ?, 1)')
        .run(id, childFile, '/work/proj', JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: threadId, depth: 1, agent_path: agentPath, agent_nickname: agentPath.split('/').at(-1), agent_role: 'worker' } } }));
      db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run(threadId, id, 'open');
    }
    db.close();
  }
  return new CodexAtifProjector({ store: new CodexTraceStore({ harness: 'codex', home }) }).project(file);
}
/** An inter-agent message row the way codex writes it (measured 2026-09-01): addressed, a typed first line, headers, then the payload. */
const inbound = (author, recipient, type, payload, extraParts = []) => ({
  timestamp: 't', type: 'response_item',
  payload: {
    type: 'agent_message', id: `am_${author}_${recipient}_${type}`.replaceAll(/\W/g, '_'), author, recipient,
    content: [{ type: 'input_text', text: `Message Type: ${type}\nTask name: ${recipient}\nSender: ${author}\nPayload:\n${payload}` }, ...extraParts],
  },
});
const call = (id, cmd, ts = 't') => ({ timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call', id: `ctc_${id}`, status: 'completed', call_id: id, name: 'exec', input: `const r = await tools.exec_command({cmd:"${cmd}"});\n` } });
const output = (id, text) => ({ timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call_output', id: `o_${id}`, call_id: id, output: [{ type: 'input_text', text }] } });
const reasoning = (id) => ({ timestamp: 't', type: 'response_item', payload: { type: 'reasoning', id, summary: [], encrypted_content: 'gAAAA' } });
const usage = (input, output) => ({ timestamp: 't', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output }, total_token_usage: {} } } });

test('Codex projection: token_count with info: null is a documented vendor state (Harbor #970) — tolerated: no metrics, no invented zeros, the call still closes and counts', () => {
  const { home, file } = codexFixture({
    extraRows: [
      { timestamp: 'tx', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex' } } },
      { timestamp: 'ty', type: 'response_item', payload: { type: 'message', id: 'msg_9', role: 'assistant', content: [{ type: 'output_text', text: 'after a null count' }] } },
    ],
  });
  const t = new CodexAtifProjector({ store: new CodexTraceStore({ harness: 'codex', home }) }).project(file);
  assert.equal(t.final_metrics.total_prompt_tokens, 1200, 'totals unchanged');
  assert.equal(t.steps.length, 8, 'the null-info count closed the legacy call: the answer opened a new step');
  assert.equal(t.steps[6].llm_call_count, 1, 'a call happened; only its usage is unknown');
  assert.equal(t.steps[6].metrics, undefined, 'unknown usage is absent, never zeros');
  assert.equal(t.steps[7].message, 'after a null count');
});

test('Codex projection: a rollout with NO usage-bearing token_count keeps the reasoning boundary — and says so in extra.record.step_boundary', () => {
  const t = codexRollout([
    reasoning('rs_1'), call('c1', 'one'), output('c1', 'ok'),
    reasoning('rs_2'), call('c2', 'two'), output('c2', 'ok'),
  ]);
  assert.equal(t.extra.record.step_boundary, 'reasoning');
  assert.deepEqual(t.steps.map((s) => s.tool_calls?.[0]?.tool_call_id), ['c1', 'c2'], 'each reasoning row opened a response');
  assert.ok(t.steps.every((s) => s.llm_call_count === undefined), 'no token_count, no call count — nothing invented');
});

test('Codex projection: a token_count with no agent step to land on is counted, never lost — extra.record.orphan_token_counts', () => {
  const t = codexRollout([
    usage(10, 1),
    { timestamp: 't', type: 'response_item', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
    call('c1', 'one'), output('c1', 'ok'), usage(20, 2),
  ]);
  assert.equal(t.extra.record.orphan_token_counts, 1);
  assert.equal(t.final_metrics.total_prompt_tokens, 20, 'the orphan\'s usage is not attributed to anyone');
  assert.equal(t.steps.at(-1).llm_call_count, 1);
});

test('Codex projection: a compacted row is a synthetic system step — timestamped, llm_call_count 0 (deterministic dispatch, RFC)', () => {
  const t = codexRollout([
    call('c1', 'one', 't1'), output('c1', 'ok'), usage(10, 1),
    { timestamp: 't9', type: 'compacted', payload: { message: 'summary' } },
    call('c2', 'two', 't10'), output('c2', 'ok'), usage(10, 1),
  ]);
  const compacted = t.steps.find((s) => s.source === 'system');
  assert.deepEqual([compacted.message, compacted.timestamp, compacted.llm_call_count], ['[context compacted]', 't9', 0]);
  assert.equal(t.steps.find((s) => s.tool_calls?.[0]?.tool_call_id === 'c2').timestamp, 't10');
});

// The typed item stream (event_msg item_completed, measured 2026-09-01: row order call → item →
// output → token_count; an item's id is its own, never the call id — except SubAgentActivity,
// whose id IS the spawn call's). Items ENRICH the calls they complete; they are never the spine.
const item = (type, fields) => ({
  timestamp: 't', type: 'event_msg',
  payload: { type: 'item_completed', thread_id: 'th', turn_id: 'turn-1', item: { type, ...fields }, started_at_ms: 1, completed_at_ms: 2 },
});

test('Codex items: a CommandExecution completes its call with the STRUCTURAL exit code — the annotator prefers it to the text parse', () => {
  const t = codexRollout([
    reasoning('rs_1'), call('c1', 'make it'),
    item('CommandExecution', { id: 'exec-1', command: ['bash', '-lc', 'make it'], cwd: '/work/proj', status: 'failed', exit_code: 3, stdout: 'built', stderr: '', aggregated_output: 'built' }),
    output('c1', 'built\nExit code 0'), usage(10, 1),
  ]);
  const result = t.steps[0].observation.results[0];
  assert.equal(result.extra.record.exit_code, 3, 'the record\'s own exit code, structural');
  assert.equal(t.extra.record.uncorrelated_items, undefined);
  const annotated = new OatheAnnotator().annotate(t);
  assert.equal(annotated.steps[0].observation.results[0].extra.oathe.observed.exit_code, 3, 'the record outranks the text');
});

test('Codex items: an McpToolCall RECOVERS an exec call whose source could not be parsed — the record knows the server, the tool and the arguments; claim events then fire', () => {
  const t = codexRollout([
    reasoning('rs_1'),
    { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'c1', name: 'exec', input: 'const args = {task_id: "task-r"};\nconst r = await tools.mcp__oathe__oathe_claim(args);\n' } },
    item('McpToolCall', { id: 'exec-2', server: 'oathe', tool: 'oathe_claim', arguments: { task_id: 'task-r', objective: 'recovered' }, status: 'completed', result: { content: [{ type: 'text', text: '{"claimed":true}' }], isError: false } }),
    output('c1', '{"claimed":true}'), usage(10, 1),
  ]);
  const recovered = t.steps[0].tool_calls[0];
  assert.equal(recovered.function_name, 'mcp__oathe__oathe_claim');
  assert.deepEqual(recovered.arguments, { task_id: 'task-r', objective: 'recovered' }, 'never {input: raw} when the record knows better');
  const annotated = new OatheAnnotator().annotate(t);
  assert.deepEqual(annotated.steps[0].extra.oathe.claim_events, [{ verb: 'oathe_claim', task_id: 'task-r' }]);
});

test('Codex items: a FileChange names the files changed — on the call\'s result and in the record\'s files_touched', () => {
  const t = codexRollout([
    reasoning('rs_1'),
    { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'c1', name: 'exec', input: 'const patch = "*** Begin Patch";\nconst r = await tools.apply_patch(patch);\n' } },
    item('FileChange', { id: 'exec-4', changes: { '/work/proj/new.js': { type: 'add', content: 'x' }, '/work/proj/old.js': { type: 'update', content: 'y' } }, status: 'completed', stdout: 'Success', stderr: '' }),
    output('c1', 'Success. Updated the following files:\nA /work/proj/new.js'), usage(10, 1),
  ]);
  assert.deepEqual(t.steps[0].observation.results[0].extra.record.files_changed, ['/work/proj/new.js', '/work/proj/old.js']);
  assert.deepEqual(t.extra.record.files_touched, ['/work/proj/new.js', '/work/proj/old.js']);
});

test('Codex items: an item that completes no awaiting call is counted, never lost — extra.record.uncorrelated_items, announced in the evidence view', () => {
  const t = codexRollout([
    reasoning('rs_1'), call('c1', 'make it'), output('c1', 'ok'),
    item('CommandExecution', { id: 'exec-5', command: ['bash', '-lc', 'something else'], cwd: '/w', status: 'completed', exit_code: 0, stdout: '', stderr: '' }),
    usage(10, 1),
  ]);
  assert.deepEqual(t.extra.record.uncorrelated_items, { CommandExecution: 1 });
  assert.equal(t.steps[0].observation.results[0].extra, undefined, 'a mismatched item enriches nothing');
  assert.match(renderEvidenceView(t, { budget: 100000 }), /\[1 uncorrelated item: CommandExecution\]/);
});

test('Codex items: EXPECTED shapes refuse loud — an item_completed without an item; a SubAgentActivity(started) without its thread', () => {
  assert.throws(() => codexRollout([
    reasoning('rs_1'), call('c1', 'x'),
    { timestamp: 't', type: 'event_msg', payload: { type: 'item_completed', thread_id: 'th', turn_id: 'turn-1' } },
    output('c1', 'ok'), usage(1, 1),
  ]), (e) => e instanceof AtifError && e.code === 'ATIF_CODEX_ITEM_SHAPE');
  assert.throws(() => codexRollout([
    reasoning('rs_1'),
    { timestamp: 't', type: 'response_item', payload: { type: 'function_call', id: 'fc_1', name: 'spawn_agent', namespace: 'collaboration', call_id: 'call_s', arguments: '{"task_name":"a"}' } },
    item('SubAgentActivity', { id: 'call_s', kind: 'started', agent_path: '/root/a' }),
    { timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', id: 'fco_1', call_id: 'call_s', output: 'spawned' } },
    usage(1, 1),
  ]), (e) => e instanceof AtifError && e.code === 'ATIF_CODEX_ITEM_SHAPE');
});

test('Codex items: a SubAgentActivity(started) ties the spawn call to the thread it started — a record fact on the call; interacted keys by its call, completed by the thread (measured: its id is not a call id)', () => {
  const childId = '01a00000-0000-7000-8000-00000000beef';
  const t = codexRollout([
    reasoning('rs_1'),
    { timestamp: 't', type: 'response_item', payload: { type: 'function_call', id: 'fc_1', name: 'spawn_agent', namespace: 'collaboration', call_id: 'call_s', arguments: '{"task_name":"draft-1","message":"opaque"}' } },
    item('SubAgentActivity', { id: 'call_s', kind: 'started', agent_thread_id: childId, agent_path: '/root/draft-1' }),
    { timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', id: 'fco_1', call_id: 'call_s', output: 'spawned' } },
    { timestamp: 't', type: 'response_item', payload: { type: 'function_call', id: 'fc_2', name: 'send_message', namespace: 'collaboration', call_id: 'call_m', arguments: '{"message":"go"}' } },
    item('SubAgentActivity', { id: 'call_m', kind: 'interacted', agent_thread_id: childId, agent_path: '/root/draft-1' }),
    { timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', id: 'fco_2', call_id: 'call_m', output: 'sent' } },
    usage(10, 1),
    item('SubAgentActivity', { id: 'sub-lifecycle-1', kind: 'completed', agent_thread_id: childId, agent_path: '/root/draft-1' }),
  ]);
  const spawn = t.steps[0].tool_calls[0];
  assert.deepEqual(spawn.extra.record, { agent_thread_id: childId, agent_path: '/root/draft-1' });
  assert.equal(t.extra.record.uncorrelated_items, undefined, 'interacted resolves by its call, completed by the thread the spawn started — lifecycle, not orphans');
  const unknown = codexRollout([
    reasoning('rs_1'), call('c1', 'x'), output('c1', 'ok'), usage(1, 1),
    item('SubAgentActivity', { id: 'sub-lifecycle-9', kind: 'completed', agent_thread_id: 'never-started', agent_path: '/root/ghost' }),
  ]);
  assert.deepEqual(unknown.extra.record.uncorrelated_items, { SubAgentActivity: 1 }, 'a completion for a thread nothing started is an orphan, counted');
});

test('Codex items: one exec source can run SEVERAL commands (measured up to 9) — every CommandExecution under a raw exec call rides its result as executions; exactly one is an exit_code', () => {
  const multi = codexRollout([
    reasoning('rs_1'),
    { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'c1', name: 'exec', input: 'const [a, b] = await Promise.all([tools.exec_command({cmd:"one"}), tools.exec_command({cmd:"two"})]);\n' } },
    item('CommandExecution', { id: 'exec-1', command: ['bash', '-lc', 'one'], cwd: '/w', status: 'completed', exit_code: 0, stdout: '', stderr: '' }),
    item('CommandExecution', { id: 'exec-2', command: ['bash', '-lc', 'two'], cwd: '/w', status: 'failed', exit_code: 1, stdout: '', stderr: '' }),
    output('c1', 'one ok; two failed'), usage(10, 1),
  ]);
  // What ran INSIDE the call belongs to the call (ruling 2026-09-04: acts are call-level facts,
  // known the moment the source is written); what came back belongs to the result.
  const call = multi.steps[0].tool_calls[0];
  assert.deepEqual(call.extra.record.executions, [
    { tool: 'exec_command', arguments: { cmd: 'one' }, command: 'one', exit_code: 0 },
    { tool: 'exec_command', arguments: { cmd: 'two' }, command: 'two', exit_code: 1 },
  ], 'born from the source (the tool and the arguments it states), completed by the items (the command and its exit code)');
  const result = multi.steps[0].observation.results[0];
  assert.equal(result.extra?.record?.executions, undefined, 'the result carries outcomes, never the dispatch ledger');
  assert.equal(multi.extra.record.uncorrelated_items, undefined);
  assert.equal(new OatheAnnotator().annotate(multi).steps[0].observation.results[0].extra?.oathe, undefined, 'no single exit code to observe — nothing invented');

  // A command passed through a variable: the reader keeps the raw source; the one
  // CommandExecution under it is the record's decode of what ran — its exit code rides.
  const variable = codexRollout([
    reasoning('rs_1'),
    { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_2', status: 'completed', call_id: 'c2', name: 'exec', input: 'const cmd = "ls -la";\nconst r = await tools.exec_command({cmd});\n' } },
    item('CommandExecution', { id: 'exec-3', command: ['bash', '-lc', 'ls -la'], cwd: '/w', status: 'completed', exit_code: 0, stdout: 'files', stderr: '' }),
    output('c2', 'files'), usage(10, 1),
  ]);
  assert.deepEqual(variable.steps[0].observation.results[0].extra.record, { exit_code: 0 });
  assert.equal(variable.steps[0].tool_calls[0].extra?.record?.executions, undefined, 'one command IS the call — no ledger restates it');
  assert.equal(variable.extra.record.uncorrelated_items, undefined);
});

test('Codex items: a command that outlives its call (exec_command yields, write_stdin continues) completes LATE — the CommandExecution still lands on the call it belongs to', () => {
  const t = codexRollout([
    reasoning('rs_1'),
    { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'c1', name: 'exec', input: 'const r = await tools.exec_command({cmd:"npm test", yield_time_ms: 1000});\n' } },
    output('c1', 'still running after 1000ms; session_id 7'), usage(10, 1),
    { timestamp: 't', type: 'response_item', payload: { type: 'function_call', id: 'fc_1', name: 'write_stdin', call_id: 'c2', arguments: '{"session_id":7,"chars":"","yield_time_ms":5000}' } },
    item('CommandExecution', { id: 'exec-1', command: ['bash', '-lc', 'npm test'], cwd: '/w', status: 'completed', exit_code: 1, stdout: 'fail', stderr: '' }),
    { timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', id: 'fco_1', call_id: 'c2', output: '1 failing\nExit code 1' } },
    usage(10, 1),
  ]);
  const first = t.steps[0].observation.results.find((r) => r.source_call_id === 'c1');
  assert.deepEqual(first.extra.record, { exit_code: 1 }, 'the late completion enriches the call that started the command');
  assert.equal(t.extra.record.uncorrelated_items, undefined);
  const late = codexRollout([
    reasoning('rs_1'),
    { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'c1', name: 'exec', input: 'const cmd = "make";\nconst r = await tools.exec_command({cmd, yield_time_ms: 1000});\n' } },
    output('c1', 'still running'), usage(10, 1),
    item('CommandExecution', { id: 'exec-2', command: ['bash', '-lc', 'make'], cwd: '/w', status: 'completed', exit_code: 0, stdout: '', stderr: '' }),
  ]);
  assert.deepEqual(late.steps[0].observation.results[0].extra.record, { exit_code: 0 }, 'a raw exec that completed with no command yet is the late completion\'s home');
  assert.equal(late.extra.record.uncorrelated_items, undefined);
  // An MCP act's item can complete after its output row too (measured on a 0.149-alpha
  // rollout): the answered call that names the act is its home, never an orphan.
  const lateMcp = codexRollout([
    reasoning('rs_1'),
    { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'c1', name: 'exec', input: 'const r = await tools.mcp__oathe__oathe_statement({task_id:"task-l", proposition:"late"});\n' } },
    output('c1', '{"recorded":true}'), usage(10, 1),
    item('McpToolCall', { id: 'exec-3', server: 'oathe', tool: 'oathe_statement', arguments: { task_id: 'task-l', proposition: 'late' }, status: 'completed' }),
  ]);
  assert.equal(lateMcp.extra.record.uncorrelated_items, undefined);
  assert.equal(lateMcp.steps[0].tool_calls[0].function_name, 'mcp__oathe__oathe_statement');
});

test('Codex items: an exec source that runs SEVERAL inner calls (an MCP act and a command) stays one exec call — the record lists what ran inside, and claim events read it', () => {
  const t = codexRollout([
    reasoning('rs_1'),
    { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'c1', name: 'exec', input: 'const claim = await tools.mcp__oathe__oathe_claim({task_id: "task-m"});\nconst r = await tools.exec_command({cmd: "make"});\n' } },
    item('McpToolCall', { id: 'exec-1', server: 'oathe', tool: 'oathe_claim', arguments: { task_id: 'task-m', objective: 'two things in one exec' }, status: 'completed', result: { content: [{ type: 'text', text: '{"claimed":true}' }], isError: false } }),
    item('CommandExecution', { id: 'exec-2', command: ['bash', '-lc', 'make'], cwd: '/w', status: 'completed', exit_code: 0, stdout: '', stderr: '' }),
    output('c1', 'claimed; made'), usage(10, 1),
  ]);
  const call = t.steps[0].tool_calls[0];
  assert.equal(call.function_name, 'exec', 'two inner calls — the exec is not any one of them');
  assert.ok(typeof call.arguments.input === 'string', 'the raw source stays the argument');
  assert.deepEqual(call.extra.record.executions, [
    { tool: 'mcp__oathe__oathe_claim', arguments: { task_id: 'task-m', objective: 'two things in one exec' }, status: 'completed' },
    { tool: 'exec_command', arguments: { cmd: 'make' }, command: 'make', exit_code: 0 },
  ], 'the ledger of what ran inside rides the CALL — named from the source, completed by the items');
  assert.equal(t.extra.record.uncorrelated_items, undefined);
  const annotated = new OatheAnnotator().annotate(t);
  assert.deepEqual(annotated.steps[0].extra.oathe.claim_events, [{ verb: 'oathe_claim', task_id: 'task-m' }],
    'the speech act inside a multi-call exec is on the record — the annotator reads the call');
});

test('Codex ledger: pending only where an item will complete it; a loop lands two items on one named act — the second is appended WITH its name; one command inside a cell is the call itself — no ledger', () => {
  const t = codexRollout([
    reasoning('rs_1'),
    { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'c1', name: 'exec', input: 'await tools.apply_patch("*** Begin Patch\\n*** End Patch");\nfor (const p of ["one", "two"]) await tools.mcp__oathe__oathe_statement({task_id: "task-p", proposition: p});\n' } },
    item('FileChange', { id: 'fc-1', changes: { '/w/a.txt': { kind: 'add' } }, status: 'completed' }),
    item('McpToolCall', { id: 'mcp-1', server: 'oathe', tool: 'oathe_statement', arguments: { task_id: 'task-p', proposition: 'one' }, status: 'completed' }),
    item('McpToolCall', { id: 'mcp-2', server: 'oathe', tool: 'oathe_statement', arguments: { task_id: 'task-p', proposition: 'two' }, status: 'completed' }),
    output('c1', 'ok'), usage(10, 1),
  ]);
  const ledger = t.steps[0].tool_calls[0].extra.record.executions;
  assert.equal(ledger.length, 3);
  assert.equal(ledger[0].tool, 'apply_patch');
  assert.equal('pending' in ledger[0], false, 'no item completes a patch entry (FileChange enriches the result) — the record never claims to be waiting for one');
  assert.deepEqual(ledger[1], { tool: 'mcp__oathe__oathe_statement', arguments: { task_id: 'task-p', proposition: 'one' }, status: 'completed' },
    'the entry the source named (task_id stated, proposition a variable) completed by its item');
  assert.deepEqual(ledger[2], { tool: 'mcp__oathe__oathe_statement', arguments: { task_id: 'task-p', proposition: 'two' }, status: 'completed' },
    'the loop\'s second act — appended, and named, so the annotator reads it');
  assert.deepEqual(t.steps[0].observation.results[0].extra.record, { files_changed: ['/w/a.txt'] }, 'outcomes stay on the result');
  assert.equal(t.extra.record.uncorrelated_items, undefined);
  assert.deepEqual(new OatheAnnotator().annotate(t).steps[0].extra.oathe.claim_events,
    [{ verb: 'oathe_statement', task_id: 'task-p' }, { verb: 'oathe_statement', task_id: 'task-p' }]);
});

test('Codex source: a multi-call exec cell names its acts the MOMENT it is written — no item, no output row yet — so a blocking done inside it is visible to its own verification', () => {
  // The exact cell that stalled cloud-gate1-product-alignment (2026-09-04): sed + claim + done
  // in one cell; verification ran while the cell was still executing. The source alone must
  // yield the acts: claim_events, and the interval that lets discovery confirm performance.
  const src = 'text(await tools.exec_command({cmd:"sed -n \'107,118p\' /tmp/pasted.txt",max_output_tokens:1600})); '
    + 'text(await tools.mcp__oathe__oathe_claim({task_id:"gate1-align",objective:"Assess the packet",parent:null})); '
    + 'text(await tools.mcp__oathe__oathe_done({task_id:"gate1-align",proposition:"Reviewed.",evidence_ref:"/tmp/pasted.txt"}));';
  const running = codexRollout([
    reasoning('rs_1'),
    { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'c1', name: 'exec', input: src } },
  ]);
  const call = running.steps[0].tool_calls[0];
  assert.equal(call.function_name, 'exec');
  assert.deepEqual(call.extra.record.executions.map((e) => e.tool),
    ['exec_command', 'mcp__oathe__oathe_claim', 'mcp__oathe__oathe_done'], 'every inner call, in dispatch order, from the source');
  assert.deepEqual(call.extra.record.executions[1].arguments, { task_id: 'gate1-align', objective: 'Assess the packet', parent: null });
  assert.equal(running.steps[0].observation, undefined, 'the cell has not answered — nothing invented');
  const annotated = new OatheAnnotator().annotate(running);
  assert.deepEqual(annotated.steps[0].extra.oathe.claim_events,
    [{ verb: 'oathe_claim', task_id: 'gate1-align' }, { verb: 'oathe_done', task_id: 'gate1-align' }]);
  assert.deepEqual(claimIntervals(annotated).map((i) => i.task_id), ['gate1-align'], 'the interval exists before the cell returns');

  // The claim's item lands (the call returned inside the cell) — it COMPLETES the source entry,
  // never adds a second one; the command's item completes the exec_command entry the same way.
  const landed = codexRollout([
    reasoning('rs_1'),
    { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'c1', name: 'exec', input: src } },
    item('CommandExecution', { id: 'exec-0', command: ['bash', '-lc', "sed -n '107,118p' /tmp/pasted.txt"], cwd: '/w', status: 'completed', exit_code: 0, stdout: '', stderr: '' }),
    item('McpToolCall', { id: 'exec-1', server: 'oathe', tool: 'oathe_claim', arguments: { task_id: 'gate1-align', objective: 'Assess the packet', parent: null }, status: 'completed', result: { content: [{ type: 'text', text: '{"claimed":true}' }], isError: false } }),
  ]);
  const ledger = landed.steps[0].tool_calls[0].extra.record.executions;
  assert.equal(ledger.length, 3, 'items complete entries; they never duplicate them');
  assert.deepEqual(ledger[0], { tool: 'exec_command', arguments: { cmd: "sed -n '107,118p' /tmp/pasted.txt", max_output_tokens: 1600 }, command: "sed -n '107,118p' /tmp/pasted.txt", exit_code: 0 });
  assert.equal(ledger[1].status, 'completed');
  assert.equal(ledger[2].status, undefined, 'the done is still running');
  assert.equal(landed.extra.record.uncorrelated_items, undefined);
});

test('Codex source: a single-call exec cell whose argument is a VARIABLE still names its act at call-start with the literal fields it can read; the item completes the arguments', () => {
  // The exact cell that was falsely rejected (review-a3-gate1-plan, 2026-09-04): evidence_ref:p.
  const src = 'const p="/tmp/A3.md"; const r=await tools.mcp__oathe__oathe_done({task_id:"a3-review",proposition:"Completed the review.",evidence_ref:p}); for(const c of(r?.content||[])){if(c.type==="text")text(c.text)}';
  const running = codexRollout([
    reasoning('rs_1'),
    { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'c1', name: 'exec', input: src } },
  ]);
  const call = running.steps[0].tool_calls[0];
  assert.equal(call.function_name, 'mcp__oathe__oathe_done', 'one inner call — the exec IS that act, variable or not');
  assert.deepEqual(call.arguments, { task_id: 'a3-review', proposition: 'Completed the review.', input: src },
    'the literal fields the source states, the raw source beside them — never an invented evidence_ref');
  const annotated = new OatheAnnotator().annotate(running);
  assert.deepEqual(annotated.steps[0].extra.oathe.claim_events, [{ verb: 'oathe_done', task_id: 'a3-review' }]);

  const landed = codexRollout([
    reasoning('rs_1'),
    { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'c1', name: 'exec', input: src } },
    item('McpToolCall', { id: 'exec-1', server: 'oathe', tool: 'oathe_done', arguments: { task_id: 'a3-review', proposition: 'Completed the review.', evidence_ref: '/tmp/A3.md' }, status: 'completed', result: { content: [{ type: 'text', text: '{"done":true}' }], isError: false } }),
    output('c1', '{"done":true}'), usage(10, 1),
  ]);
  assert.deepEqual(landed.steps[0].tool_calls[0].arguments,
    { task_id: 'a3-review', proposition: 'Completed the review.', evidence_ref: '/tmp/A3.md' },
    'the item knows the whole argument set — the record ends complete');
  assert.equal(landed.extra.record.uncorrelated_items, undefined);
});

// The inter-agent bus (measured 2026-09-01: 24 FINAL_ANSWER rows in the incident parent, one
// NEW_TASK in each child, MESSAGE for a mid-task nudge; 35 UNADDRESSED agent_message rows
// across the 40 newest rollouts are the agent's own words). A child's answer addressed to
// this thread is NEVER this agent's SAID.

const CHILD_ID = '01a00000-0000-7000-8000-00000000beef';
const spawnRows = (childId) => [
  reasoning('rs_1'),
  { timestamp: 't', type: 'response_item', payload: { type: 'function_call', id: 'fc_1', name: 'spawn_agent', namespace: 'collaboration', call_id: 'call_s', arguments: '{"task_name":"draft-1","message":"opaque"}' } },
  item('SubAgentActivity', { id: 'call_s', kind: 'started', agent_thread_id: childId, agent_path: '/root/draft-1' }),
  { timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', id: 'fco_1', call_id: 'call_s', output: 'spawned' } },
  usage(10, 1),
];

test('Codex inbound: a child\'s FINAL_ANSWER addressed to this thread is a SYSTEM step (llm_call_count 0) whose observation carries the message and a ref to the embedded child — never the agent\'s SAID', () => {
  const t = codexRollout([
    ...spawnRows(CHILD_ID),
    inbound('/root/draft-1', '/root', 'FINAL_ANSWER', 'the answer is 42'),
    { timestamp: 't', type: 'response_item', payload: { type: 'agent_message', id: 'am_own', content: [{ type: 'output_text', text: 'thanks, noted' }] } },
    usage(5, 1),
  ], { children: [{ id: CHILD_ID, agentPath: '/root/draft-1' }] });
  assert.ok(!t.steps.some((s) => s.source === 'agent' && s.message.includes('the answer is 42')), 'the child\'s words are not the parent\'s SAID');
  const received = t.steps.find((s) => s.source === 'system' && s.extra?.record?.inbound);
  assert.ok(received, 'the answer arrived as a system step');
  assert.equal(received.llm_call_count, 0, 'a receipt, not a model call');
  assert.equal(received.message, '[inbound FINAL_ANSWER from /root/draft-1]');
  assert.deepEqual(received.extra.record.inbound, { author: '/root/draft-1', recipient: '/root', message_type: 'FINAL_ANSWER' });
  const [result] = received.observation.results;
  assert.match(result.content, /^Message Type: FINAL_ANSWER\n[\s\S]*the answer is 42$/);
  assert.deepEqual(result.subagent_trajectory_ref, [{ trajectory_id: CHILD_ID }], 'the ref resolves through the spawn item\'s agent_path to the EMBEDDED child');
  assert.equal(result.source_call_id, undefined, 'no tool call produced it');
  assert.equal(t.subagent_trajectories[0].trajectory_id, CHILD_ID, 'and the child is there to resolve to');
  assert.equal(t.extra.record.unresolved_inbound, undefined);
  const own = t.steps.find((s) => s.source === 'agent' && s.message === 'thanks, noted');
  assert.ok(own, 'an UNADDRESSED agent_message stays the agent\'s own words');
});

test('Codex inbound: a ref must RESOLVE — a thread the spawn item names but the index does not carry rides the record as agent_thread_id, counted unresolved, never pointed at; an author nothing started is unresolved too', () => {
  const named = codexRollout([...spawnRows(CHILD_ID), inbound('/root/draft-1', '/root', 'FINAL_ANSWER', 'from a child not on this machine')]);
  const receipt = named.steps.find((s) => s.source === 'system' && s.extra?.record?.inbound);
  assert.equal(receipt.observation.results[0].subagent_trajectory_ref, undefined, 'no embedded child, no ref');
  assert.equal(receipt.extra.record.inbound.agent_thread_id, CHILD_ID, 'what the record knows is kept');
  assert.equal(named.extra.record.unresolved_inbound, 1);
  const ghost = codexRollout([
    reasoning('rs_1'), call('c1', 'x'), output('c1', 'ok'), usage(1, 1),
    inbound('/root/ghost', '/root', 'FINAL_ANSWER', 'from nowhere'),
  ]);
  const received = ghost.steps.find((s) => s.source === 'system' && s.extra?.record?.inbound);
  assert.equal(received.observation.results[0].subagent_trajectory_ref, undefined);
  assert.equal(received.extra.record.inbound.agent_thread_id, undefined);
  assert.equal(ghost.extra.record.unresolved_inbound, 1);
});

test('Codex inbound: the delegated brief (NEW_TASK from an ancestor) is the child\'s USER step — the harness converters\' shape for a delegated prompt — with the address on the record and an encrypted payload said so', () => {
  const t = codexRollout([
    { timestamp: 't', type: 'response_item', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'the plaintext brief' }] } },
    inbound('/root', '/root/draft-1', 'NEW_TASK', '', [{ type: 'encrypted_content', encrypted_content: 'gAAAA-opaque' }]),
    reasoning('rs_1'), call('c1', 'do it'), output('c1', 'done'), usage(10, 1),
  ], { meta: { source: { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 1, agent_path: '/root/draft-1', agent_nickname: 'draft-1', agent_role: 'drafter' } } } } });
  assert.deepEqual(t.steps.map((s) => s.source), ['user', 'user', 'agent']);
  const task = t.steps[1];
  assert.match(task.message, /^Message Type: NEW_TASK\n[\s\S]*\[payload encrypted\]$/);
  assert.deepEqual(task.extra.record.inbound, { author: '/root', recipient: '/root/draft-1', message_type: 'NEW_TASK' });
  assert.equal(t.extra.record.unresolved_inbound, undefined);
});

test('Codex inbound: the evidence view names who sent what — FROM lines, never SAID', async () => {
  const parent = codexRollout([
    ...spawnRows(CHILD_ID),
    inbound('/root/draft-1', '/root', 'FINAL_ANSWER', 'the answer is 42'),
  ], { children: [{ id: CHILD_ID, agentPath: '/root/draft-1' }] });
  const view = renderEvidenceView(parent, { budget: 100000 });
  assert.match(view, new RegExp(`FROM /root/draft-1 \\(FINAL_ANSWER\\) → subagent ${CHILD_ID}: Message Type: FINAL_ANSWER`));
  assert.doesNotMatch(view, /SAID: Message Type/);
  const child = codexRollout([
    inbound('/root', '/root/draft-1', 'NEW_TASK', 'the brief'),
    reasoning('rs_1'), call('c1', 'do it'), output('c1', 'done'), usage(10, 1),
  ], { meta: { source: { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 1, agent_path: '/root/draft-1' } } } } });
  assert.match(renderEvidenceView(child, { budget: 100000 }), /FROM \/root \(NEW_TASK\): Message Type: NEW_TASK/);
  assert.doesNotMatch(renderEvidenceView(child, { budget: 100000 }), /USER: Message Type/);
});

// A forked child (spawn_agent fork_turns:"all" — 5 of 27 spawns store-wide, 2026-09-01) begins
// with the parent's own rows under the parent's payload.ids: context it inherited, not work it
// did. The RFC's is_copied_context marks those steps (excluded from SFT); nothing oathe reads
// them as the child's acts.
test('Codex fork: a child\'s leading steps built entirely from rows the parent already holds are is_copied_context; its own work is not; a copied claim is never the child\'s claim event', () => {
  const claimRow = { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_p1', status: 'completed', call_id: 'c_p1', name: 'exec', input: 'const r = await tools.mcp__oathe__oathe_claim({task_id:"parent-task"});\n' } };
  const claimOut = { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call_output', id: 'o_p1', call_id: 'c_p1', output: [{ type: 'input_text', text: '{"claimed":true}' }] } };
  const parentTurn = [
    { timestamp: 't', type: 'response_item', payload: { type: 'message', id: 'msg_p1', role: 'user', content: [{ type: 'input_text', text: 'the parent\'s brief' }] } },
    { timestamp: 't', type: 'response_item', payload: { type: 'reasoning', id: 'rs_p1', summary: [], encrypted_content: 'gAAAA' } },
    claimRow, claimOut,
    { timestamp: 't', type: 'response_item', payload: { type: 'message', id: 'msg_p2', role: 'assistant', content: [{ type: 'output_text', text: 'the parent\'s answer' }] } },
  ];
  const t = codexRollout([
    ...parentTurn,
    { timestamp: 't', type: 'response_item', payload: { type: 'function_call', id: 'fc_1', name: 'spawn_agent', namespace: 'collaboration', call_id: 'call_s', arguments: '{"task_name":"draft-1","fork_turns":"all"}' } },
    item('SubAgentActivity', { id: 'call_s', kind: 'started', agent_thread_id: CHILD_ID, agent_path: '/root/draft-1' }),
    { timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', id: 'fco_1', call_id: 'call_s', output: 'spawned' } },
    usage(10, 1),
  ], { children: [{ id: CHILD_ID, agentPath: '/root/draft-1', rows: [
    ...parentTurn, // the fork: the parent's turn, same payload.ids
    usage(5, 1),
    inbound('/root', '/root/draft-1', 'NEW_TASK', 'now do your part'),
    reasoning('rs_c1'), call('c_c1', 'child work'), output('c_c1', 'done'), usage(7, 2),
  ] }] });
  const child = t.subagent_trajectories[0];
  const copied = child.steps.filter((s) => s.is_copied_context === true);
  assert.deepEqual(copied.map((s) => s.source), ['user', 'agent'], 'the parent\'s brief and the parent\'s turn, inherited');
  assert.ok(child.steps.filter((s) => !s.is_copied_context).length >= 2, 'the child\'s own steps are not marked');
  assert.ok(!child.steps.find((s) => s.tool_calls?.some((c) => c.tool_call_id === 'c_c1')).is_copied_context, 'the child\'s own call is its own');
  assert.equal(t.steps.some((s) => s.is_copied_context), false, 'the parent inherits nothing');

  const annotated = new OatheAnnotator().annotate(t);
  const annotatedChild = annotated.subagent_trajectories[0];
  assert.ok(annotatedChild.steps.every((s) => !s.is_copied_context || !s.extra?.oathe?.claim_events), 'a copied claim is the parent\'s act, never the child\'s claim event');
  assert.deepEqual(claimIntervals(annotatedChild), [], 'so the child is never attributed the parent\'s task');
  assert.deepEqual(claimIntervals(annotated), [{ task_id: 'parent-task', start_index: 1, end_index: annotated.steps.length - 1 }], 'the parent keeps its own');

  const view = renderEvidenceView(annotated, { budget: 100000 });
  assert.match(view, /\[2 copied-context steps elided\]/, 'the child\'s section says what it inherited and skips it');
  assert.doesNotMatch(view.slice(view.indexOf('SUBAGENT')), /the parent's answer/, 'inherited words never render under the child');
});

test('Codex projection: a compaction response_item (codex 0.150-alpha, encrypted summary, no compacted line row beside it) is the same synthetic system step', () => {
  const t = codexRollout([
    call('c1', 'one', 't1'), output('c1', 'ok'), usage(10, 1),
    { timestamp: 't9', type: 'response_item', payload: { type: 'compaction', id: 'cmp_1', encrypted_content: 'gAAAA-opaque' } },
    call('c2', 'two', 't10'), output('c2', 'ok'), usage(10, 1),
  ]);
  const compacted = t.steps.find((s) => s.source === 'system');
  assert.deepEqual([compacted.message, compacted.timestamp, compacted.llm_call_count], ['[context compacted]', 't9', 0]);
  assert.equal(t.extra.record.unrecognized_rows, undefined, 'a handled row, not a quarantined one');
});

test('Codex items: an Extension (web.search) is an action with NO response_item counterpart — it projects as a tool call with its results as the observation', () => {
  const t = codexRollout([
    reasoning('rs_1'),
    item('Extension', { kind: 'web.search', id: 'exec-9', query: 'oathe launch', action: { type: 'search', url: 'https://example.test/?q=oathe' }, results: [{ title: 'Oathe', url: 'https://example.test/oathe' }] }),
    usage(10, 1),
  ]);
  const step = t.steps[0];
  assert.deepEqual(step.tool_calls[0], {
    tool_call_id: 'exec-9', function_name: 'web.search',
    arguments: { query: 'oathe launch', action: { type: 'search', url: 'https://example.test/?q=oathe' } },
  });
  assert.equal(step.observation.results[0].source_call_id, 'exec-9');
  assert.match(step.observation.results[0].content, /example\.test\/oathe/);
});

test('Codex projection: an UNKNOWN row type quarantines visibly — counted and announced, never a refusal and never silence', () => {
  const { home, file } = codexFixture({
    extraRows: [
      { timestamp: 'tx', type: 'response_item', payload: { type: 'holo_call', beam: 'b1' } },
      { timestamp: 'ty', type: 'event_msg', payload: { type: 'tachyon_pulse' } },
      { timestamp: 'tz', type: 'quantum_state', payload: {} },
    ],
  });
  const t = new CodexAtifProjector({ store: new CodexTraceStore({ harness: 'codex', home }) }).project(file);
  assert.equal(t.steps.length, 7, 'unknown rows contribute no steps');
  assert.deepEqual(t.extra.record.unrecognized_rows,
    { 'response_item.holo_call': 1, 'event_msg.tachyon_pulse': 1, 'quantum_state': 1 });
  const view = renderEvidenceView(t, { budget: 100000 });
  assert.match(view, /\[3 unrecognized rows: event_msg\.tachyon_pulse, quantum_state, response_item\.holo_call\]/,
    'the evidence view announces what the projection could not read');
});

test('Codex projection: a turn_context row closes the open agent step — turns are step boundaries', () => {
  const { home, file } = codexFixture({
    extraRows: [
      { timestamp: 'tx', type: 'turn_context', payload: { turn_id: 'turn-2', cwd: '/work/proj' } },
      {
        timestamp: 'ty', type: 'response_item',
        payload: { type: 'custom_tool_call', id: 'ctc_9', status: 'completed', call_id: 'call_6', name: 'exec', input: 'const r = await tools.exec_command({cmd:"true"});\n' },
      },
    ],
  });
  const t = new CodexAtifProjector({ store: new CodexTraceStore({ harness: 'codex', home }) }).project(file);
  assert.equal(t.steps.length, 8, 'the post-turn call lands on a NEW agent step');
  assert.equal(t.steps[7].tool_calls[0].tool_call_id, 'call_6');
});

test('Codex projection: EXPECTED shapes gone missing refuse loud — a token_count without info.last_token_usage, a custom_tool_call without input', () => {
  const flat = codexFixture({
    extraRows: [{ timestamp: 'tx', type: 'event_msg', payload: { type: 'token_count', input_tokens: 5, output_tokens: 1 } }],
  });
  assert.throws(
    () => new CodexAtifProjector({ store: new CodexTraceStore({ harness: 'codex', home: flat.home }) }).project(flat.file),
    (e) => e instanceof AtifError && e.code === 'ATIF_CODEX_TOKEN_SHAPE',
    'metrics must never silently become zeros');

  const noInput = codexFixture({
    extraRows: [{ timestamp: 'tx', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_9', call_id: 'call_9', name: 'exec' } }],
  });
  assert.throws(
    () => new CodexAtifProjector({ store: new CodexTraceStore({ harness: 'codex', home: noInput.home }) }).project(noInput.file),
    (e) => e instanceof AtifError && e.code === 'ATIF_CODEX_CALL_SHAPE',
    'an action with its command missing is an unreadable record, not an empty one');
});

test('Codex fan-out: spawn-edge children embed with their spawn identity and edge status; an inbound answer resolves its ref through the index', () => {
  const { home, file, threadId } = codexFixture({ extraRows: [inbound('/root/draft-1', '/root', 'FINAL_ANSWER', 'child says done')] });
  const childId = '01a00000-0000-7000-8000-00000000beef';
  const dir = path.join(home, '.codex/sessions/2026/08/25');
  const childFile = path.join(dir, `rollout-2026-08-25T10-05-00-${childId}.jsonl`);
  fs.writeFileSync(childFile, [
    JSON.stringify({ timestamp: 't0', type: 'session_meta', payload: { id: childId, cwd: '/work/proj', source: { subagent: { thread_spawn: { parent_thread_id: threadId } } }, cli_version: '0.150.0', model_provider: 'openai' } }),
    JSON.stringify({ timestamp: 't1', type: 'response_item', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'child work' }] } }),
  ].join('\n'));
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(path.join(home, '.codex/state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT, title TEXT,
             tokens_used INTEGER, git_sha TEXT, git_branch TEXT, source TEXT, created_at INTEGER);
           CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);`);
  db.prepare('INSERT INTO threads (id, rollout_path, cwd, source, created_at) VALUES (?, ?, ?, ?, 1)')
    .run(childId, childFile, '/work/proj', JSON.stringify({
      subagent: { thread_spawn: { parent_thread_id: threadId, depth: 1, agent_path: '/root/draft-1', agent_nickname: 'draft-1', agent_role: 'drafter' } },
    }));
  db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run(threadId, childId, 'open');
  db.close();

  const t = new CodexAtifProjector({ store: new CodexTraceStore({ harness: 'codex', home }) }).project(file);
  assert.equal(t.subagent_trajectories.length, 1);
  const child = t.subagent_trajectories[0];
  assert.equal(child.trajectory_id, childId);
  assert.deepEqual(child.extra.record.subagent_meta,
    { kind: 'thread_spawn', status: 'open', agent_nickname: 'draft-1', agent_role: 'drafter', agent_path: '/root/draft-1', depth: 1 },
    'who this child was and how its spawn ended, in the record\'s own words');
  const view = renderEvidenceView(t, { budget: 100000 });
  assert.match(view, new RegExp(`SUBAGENT ${childId} \\(draft-1\\)`), 'the evidence view names the child');
  const received = t.steps.find((s) => s.source === 'system' && s.extra?.record?.inbound);
  assert.deepEqual(received.observation.results[0].subagent_trajectory_ref, [{ trajectory_id: childId }],
    'no spawn item in this window — the thread index\'s agent_path resolves the author');
  // The spawn call's receipt carries the ref too: no SubAgentActivity item in this window, so
  // the call's task_name resolves against the index's agent_nickname.
  const spawnStep = t.steps.find((s) => s.tool_calls?.some((c) => c.tool_call_id === 'call_3'));
  const receipt = spawnStep.observation.results.find((r) => r.source_call_id === 'call_3');
  assert.deepEqual(receipt.subagent_trajectory_ref, [{ trajectory_id: childId, extra: { agent_path: '/root/draft-1' } }]);
});

test('Codex fan-out: with the spawn item the receipt\'s ref resolves by the thread it names; a child that never answered still gets its ref on a receipt-less call; child usage folds into the root', () => {
  const t = codexRollout([
    ...spawnRows(CHILD_ID),
    { timestamp: 't', type: 'response_item', payload: { type: 'function_call', id: 'fc_2', name: 'spawn_agent', namespace: 'collaboration', call_id: 'call_t', arguments: '{"task_name":"draft-2"}' } },
    item('SubAgentActivity', { id: 'call_t', kind: 'started', agent_thread_id: '01a00000-0000-7000-8000-00000000c0de', agent_path: '/root/draft-2' }),
    usage(10, 1),
  ], { children: [{ id: CHILD_ID, agentPath: '/root/draft-1' }, { id: '01a00000-0000-7000-8000-00000000c0de', agentPath: '/root/draft-2' }] });
  const owning = (callId) => t.steps.find((s) => s.tool_calls?.some((c) => c.tool_call_id === callId));
  const first = owning('call_s').observation.results.find((r) => r.source_call_id === 'call_s');
  assert.deepEqual(first.subagent_trajectory_ref, [{ trajectory_id: CHILD_ID, extra: { agent_path: '/root/draft-1' } }]);
  const second = owning('call_t').observation.results.find((r) => r.source_call_id === 'call_t');
  assert.ok(second, 'a call with no output row still gets a result to carry its ref (qwen parity)');
  assert.equal(second.content, undefined);
  assert.deepEqual(second.subagent_trajectory_ref, [{ trajectory_id: '01a00000-0000-7000-8000-00000000c0de', extra: { agent_path: '/root/draft-2' } }]);
  assert.equal(t.final_metrics.total_steps, t.steps.length, 'total_steps is this trajectory\'s own');
  assert.equal(new AtifValidator().validate(t).ok, true);
});

test('projectorFor picks the projector from the store that OWNS the path', async () => {
  const { home: ch, file: cf } = claudeFixture();
  const { home: xh, file: xf } = codexFixture();
  assert.ok((await projectorFor(cf, { home: ch })) instanceof ClaudeAtifProjector);
  assert.ok((await projectorFor(xf, { home: xh })) instanceof CodexAtifProjector);
});

// ------------------------------------------------------------------ validator

function validTrajectory() {
  const { home, file } = claudeFixture();
  return new ClaudeAtifProjector({ store: new ClaudeTraceStore({ harness: 'claude', home }) }).project(file);
}

test('the validator accepts every projector output (finalize() already ran it once)', () => {
  const v = new AtifValidator();
  assert.equal(v.validate(validTrajectory()).ok, true);
});

test('the validator accepts the reference models\' whole version ladder (v1.0–v1.8, v1.8 = audio parts) while the converters keep emitting v1.7; a ref may resolve by path, or by id with session_id riding informationally', () => {
  const v = new AtifValidator();
  for (const version of ['ATIF-v1.0', 'ATIF-v1.7', 'ATIF-v1.8']) {
    const t = validTrajectory();
    t.schema_version = version;
    assert.equal(v.validate(t).ok, true, `${version} is accepted inbound`);
  }
  assert.equal(validTrajectory().schema_version, ATIF_SCHEMA_VERSION, 'emitted: what the reference converters emit');
  assert.equal(ATIF_SCHEMA_VERSION, 'ATIF-v1.7');
  const byPath = validTrajectory();
  byPath.steps[4].observation.results[0].subagent_trajectory_ref = [{ trajectory_path: 's3://bucket/child.json', session_id: 'run-1' }];
  assert.equal(v.validate(byPath).ok, true, 'the file-ref form needs no embedded child');
  const both = validTrajectory();
  both.steps[4].observation.results[0].subagent_trajectory_ref = [{ trajectory_id: 'sub1', session_id: 'run-1', extra: { via: 'task-notification' } }];
  assert.equal(v.validate(both).ok, true);
});

test('each broken invariant refuses with its OWN typed code', () => {
  const v = new AtifValidator();
  const cases = [
    [(t) => { t.steps[1].step_id = 7; }, /step_id/],
    [(t) => { t.steps[1].observation.results[0].source_call_id = 'nope'; }, /source_call_id/],
    [(t) => { t.made_up_field = 1; }, /unknown field/i],
    [(t) => { t.steps[0].tool_calls = []; }, /agent-only/i],
    [(t) => { t.schema_version = 'ATIF-v9.9'; }, /schema_version/],
    [(t) => { t.schema_version = 'ATIF-v1.9'; }, /schema_version/],
    [(t) => { t.subagent_trajectories[0].trajectory_id = null; }, /trajectory_id/],
    [(t) => { t.steps = []; }, /steps/],
    // subagent_trajectory_ref — the reference models' SubagentTrajectoryRef: extra forbidden,
    // resolvable by trajectory_id (embedded) or trajectory_path (external); session_id is
    // informational, never a key. A trajectory_id must name an EMBEDDED child (the RFC's
    // resolution rule — held here, though the reference model itself only checks the one-of).
    [(t) => { t.steps[4].observation.results[0].subagent_trajectory_ref = [{ session_id: 'run-1' }]; }, /trajectory_id.*trajectory_path|resolvable/],
    [(t) => { t.steps[4].observation.results[0].subagent_trajectory_ref = [{ trajectory_id: 'nobody' }]; }, /nobody.*embedded|embedded.*nobody/],
    [(t) => { t.steps[4].observation.results[0].subagent_trajectory_ref = [{ trajectory_id: 'sub1', beam: 'b' }]; }, /unknown field 'beam'/],
    [(t) => { t.steps[4].observation.results[0].subagent_trajectory_ref = { trajectory_id: 'sub1' }; }, /array/],
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

test('renderEvidenceView aligns SAID/DID/GOT per step and marks the speech acts', async () => {
  const { home, file } = claudeFixture();
  const t = await projectAnnotated(file, { home });
  const view = renderEvidenceView(t, { budget: 100000 });
  assert.match(view, /SAID: Running the tests now\./);
  assert.match(view, /DID: Bash\(/);
  assert.match(view, /GOT \[exit 1\]: FAIL: 3 tests failed/);
  assert.match(view, /CLAIM\(oathe_done task-x\)/);
  assert.match(view, /USER: run the tests then claim done/);
  assert.match(view, /SUBAGENT sub1 \(Explore\)/);
  assert.match(view, /files touched: \/work\/proj\/fix\.js/);
});

test('renderEvidenceView under budget pressure elides the HEAD, announces it, keeps the tail whole — within the EXACT budget', async () => {
  const { home, file } = claudeFixture();
  const t = await projectAnnotated(file, { home });
  const view = renderEvidenceView(t, { budget: 700 });
  assert.ok(view.length <= 700, `the budget is the bound, no slack (${view.length})`);
  assert.match(view, /\[\d+ earlier steps? elided: \d+ tool calls?, \d+ claims?\]/);
  assert.match(view, /FROM task-notification \(sub1\) → subagent sub1/, 'the tail (the most recent step) survives whole');
  assert.doesNotMatch(view, /SAID: Running the tests now/, 'the head was elided');
  assert.match(renderEvidenceView(t, { budget: 1400 }), /CLAIM\(oathe_done task-x\)/, 'a wider budget keeps more of the tail');
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
  const store = new ClaudeTraceStore({ harness: 'claude',});
  const newest = store.newestTranscript();
  if (!newest) return t.skip('no local Claude store');
  const trajectory = new ClaudeAtifProjector({ store }).project(newest);
  assert.equal(new AtifValidator().validate(trajectory).ok, true,
    `CLAUDE ATIF DRIFT on ${newest}`);
  assert.ok(trajectory.steps.length >= 1);
});

test('LIVE: the newest real Codex rollout projects to valid ATIF end to end', (t) => {
  const store = new CodexTraceStore({ harness: 'codex',});
  const newest = store.newestRollout();
  if (!newest) return t.skip('no local Codex store');
  const trajectory = new CodexAtifProjector({ store }).project(newest);
  assert.equal(new AtifValidator().validate(trajectory).ok, true,
    `CODEX ATIF DRIFT on ${newest}`);
  assert.ok(trajectory.steps.length >= 1);
});

// ---------------------------------------------------------------- claim intervals (R3, §5)

function step(events = null, source = 'agent') {
  const s = { source, message: 'm' };
  if (events) s.extra = { oathe: { claim_events: events.map(([verb, task_id]) => ({ verb, task_id })) } };
  return s;
}

test('R3 §5.5#1/#3: a planning-only trajectory has NO claim intervals — planning is context, not evidence', () => {
  const t = { steps: [step(null, 'user'), step(), step()] };
  assert.deepEqual(claimIntervals(t), []);
});

test('R3 §5.5#5: claim then work is one interval from the claiming step to the end — pre-claim steps excluded', () => {
  const t = { steps: [step(null, 'user'), step(), step([['oathe_claim', 'x']]), step(), step()] };
  assert.deepEqual(claimIntervals(t), [{ task_id: 'x', start_index: 2, end_index: 4 }]);
});

test('R3 §5.5#6: switching from claim A to claim B closes A at the step before the switch', () => {
  const t = { steps: [step([['oathe_claim', 'a']]), step(), step([['oathe_statement', 'b']]), step()] };
  assert.deepEqual(claimIntervals(t), [
    { task_id: 'a', start_index: 0, end_index: 1 },
    { task_id: 'b', start_index: 2, end_index: 3 },
  ]);
});

test('R3 §5.5#7: done and yield close the interval AT their own step — later steps are unattributed', () => {
  const t = { steps: [step([['oathe_claim', 'x']]), step([['oathe_done', 'x']]), step(), step()] };
  assert.deepEqual(claimIntervals(t), [{ task_id: 'x', start_index: 0, end_index: 1 }]);
});

test('R3 §5.5#9: a statement alone (a later session continuing durable work) opens a fresh interval', () => {
  const t = { steps: [step(null, 'user'), step([['oathe_statement', 'x']]), step()] };
  assert.deepEqual(claimIntervals(t), [{ task_id: 'x', start_index: 1, end_index: 2 }]);
});

test('R3: board reads carry no task_id and focus nothing', () => {
  const t = { steps: [step([['oathe_board', undefined]]), step()] };
  assert.deepEqual(claimIntervals(t), []);
});

test('R3: sliceForTask keeps exactly the task\'s interval steps — and falls back to the whole trajectory when no interval exists', () => {
  const t = { steps: [step(null, 'user'), step([['oathe_claim', 'x']]), step(), step([['oathe_done', 'x']]), step()] };
  const sliced = sliceForTask(t, 'x');
  assert.equal(sliced.steps.length, 3, 'claim step through done step');
  assert.equal(sliceForTask(t, 'unknown-task').steps.length, t.steps.length,
    'no recorded interval → whole-session evidence is the only honest option');
});

test('a sliced trajectory renumbers step_ids and records what it did — the slice is validator-safe and announces itself', () => {
  const t = { steps: [step(null, 'user'), step([['oathe_claim', 'x']]), step(), step([['oathe_done', 'x']]), step()] };
  const sliced = sliceForTask(t, 'x');
  assert.deepEqual(sliced.steps.map((s) => s.step_id), [1, 2, 3], 'sequential-from-1 — a re-validated slice must pass');
  assert.deepEqual(sliced.extra.oathe.sliced, { task_id: 'x', original_step_ids: [2, 3, 4], subagents_elided: 0 });
  assert.equal(t.steps[1].step_id, undefined, 'the input trajectory is untouched — the renumbering happened on the copy');
});

/** A child trajectory with its own claim events — the fan-out slicing unit. */
function childT(id, events) {
  return {
    trajectory_id: id,
    steps: [{ step_id: 1, ...step(events) }],
    extra: { oathe: {} },
  };
}

test('sliceForTask partitions children by their OWN claim intervals — the task\'s child stays, siblings for other tasks go (the 22-sibling dilution)', () => {
  // The incident shape: the parent is pure orchestration (no intervals of its own); each
  // child claimed its own task. The task's evidence is ITS child, not 21 siblings.
  const t = {
    steps: [step(null, 'user'), step()],
    subagent_trajectories: [
      childT('mine', [['oathe_claim', 'x'], ['oathe_done', 'x']]),
      childT('other-1', [['oathe_claim', 'y']]),
      childT('other-2', [['oathe_claim', 'z']]),
      childT('silent', null),
    ],
  };
  const sliced = sliceForTask(t, 'x');
  assert.deepEqual(sliced.subagent_trajectories.map((c) => c.trajectory_id), ['mine'],
    'a sibling positively naming the task exists → other-task and silent children are elided');
  assert.equal(sliced.extra.oathe.sliced.subagents_elided, 3);
  assert.equal(sliced.steps.length, 2, 'the interval-less parent keeps its whole (small) step record');
  assert.equal(t.subagent_trajectories.length, 4, 'the input trajectory is untouched');
});

test('sliceForTask child honesty fallbacks: no child names the task → silent children stay; other-task children go regardless', () => {
  const t = {
    steps: [step(null, 'user')],
    subagent_trajectories: [childT('other', [['oathe_claim', 'y']]), childT('silent', null)],
  };
  const sliced = sliceForTask(t, 'x');
  assert.deepEqual(sliced.subagent_trajectories.map((c) => c.trajectory_id), ['silent'],
    'a child positively attributed to ANOTHER task is never this task\'s evidence; an unattributed child may be');
  const untouched = sliceForTask({ steps: [step(null, 'user')], subagent_trajectories: [childT('silent', null)] }, 'x');
  assert.equal(untouched.subagent_trajectories.length, 1, 'nothing to decide → nothing changes');
  assert.equal(untouched.extra?.oathe?.sliced, undefined, 'an untouched trajectory carries no slice marker');
});

test('projectorFor refuses a path no store owns — typed, never the Claude projector by default', async () => {
  await assert.rejects(projectorFor('/tmp/random.jsonl'), (e) => e instanceof TraceContractError && e.code === 'TRACE_OWNER_UNKNOWN');
});

// ── Conformance-lane findings (2026-09-01, the first run of Harbor's converters on our corpus) ──

test('Claude projection: a streamed message\'s usage is its LAST row (Claude Code accumulates usage per message id — Harbor claude_code.py reads the same), counted once; llm_call_count is the distinct API responses in the step', () => {
  const assistant = (id, content, usage) => ({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5', id, content, ...(usage ? { usage } : {}) } });
  const t = claudeTranscript([
    userRow('go'),
    assistant('msg_A', [{ type: 'thinking', thinking: 'hm' }], { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 60, cache_creation_input_tokens: 10 }),
    assistant('msg_A', [{ type: 'text', text: 'first' }], { input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 60, cache_creation_input_tokens: 10 }),
    assistant('msg_A', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }], { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 10 }),
    userRow([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]),
    // two API responses with no user row between them are TWO steps (one inference each)
    assistant('msg_B', [{ type: 'text', text: 'b' }], { input_tokens: 10, output_tokens: 2 }),
    assistant('msg_C', [{ type: 'text', text: 'c' }], { input_tokens: 20, output_tokens: 3 }),
    userRow('again'),
    assistant('msg_D', [{ type: 'text', text: 'no usage on this row' }], null),
  ]);
  assert.deepEqual(t.steps.map((s) => s.source), ['user', 'agent', 'agent', 'agent', 'user', 'agent']);
  const [, a1, a2, a3, , a4] = t.steps;
  assert.deepEqual(a1.metrics, { prompt_tokens: 170, completion_tokens: 40, cached_tokens: 60, extra: { cache_creation_input_tokens: 10 } },
    'the last row of msg_A carries the final output_tokens; the prompt side is counted once');
  assert.equal(a1.llm_call_count, 1);
  assert.deepEqual([a2.metrics, a3.metrics], [{ prompt_tokens: 10, completion_tokens: 2, cached_tokens: 0 }, { prompt_tokens: 20, completion_tokens: 3, cached_tokens: 0 }]);
  assert.deepEqual([a2.llm_call_count, a3.llm_call_count], [1, 1]);
  assert.equal(a4.metrics, undefined, 'no usage, no metrics — never zeros');
  assert.equal(a4.llm_call_count, undefined, 'no usage-bearing response, no count — nothing invented');
  assert.equal(t.final_metrics.total_completion_tokens, 45);
  assert.equal(t.final_metrics.total_prompt_tokens, 200);
});

test('Codex projection: agent.model_name is the first turn_context\'s model (Harbor codex.py reads the same) — the provider is never passed off as a model; absent, it is null', () => {
  const user = { timestamp: 't2', type: 'response_item', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } };
  const withTurn = codexRollout([
    { timestamp: 't1', type: 'turn_context', payload: { turn_id: 'turn-1', cwd: '/work/proj', model: 'gpt-5.6-sol' } },
    user,
    { timestamp: 't3', type: 'turn_context', payload: { turn_id: 'turn-2', cwd: '/work/proj', model: 'gpt-5.6-lite' } },
  ]);
  assert.equal(withTurn.agent.model_name, 'gpt-5.6-sol');
  const none = codexRollout([user]);
  assert.equal(none.agent.model_name, null, '"openai" is a provider, not a model — nothing is invented');
});

test('Claude projection: one API response is ONE step even when the harness interleaves receipts — async launches write each tool_use row after the previous receipt (measured 2026-09-01), so the turn is the message id, not row adjacency; its usage counts once', () => {
  const launch = (id) => ({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5', id: 'msg_M', content: [{ type: 'tool_use', id, name: 'Agent', input: { prompt: 'go' } }], usage: { input_tokens: 100, output_tokens: 40 } } });
  const t = claudeTranscript([
    userRow('fan out'),
    launch('toolu_a'), userRow([{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'launched a' }]),
    launch('toolu_b'), userRow([{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'launched b' }]),
    launch('toolu_c'), userRow([{ type: 'tool_result', tool_use_id: 'toolu_c', content: 'launched c' }]),
    { type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5', id: 'msg_N', content: [{ type: 'text', text: 'all launched' }], usage: { input_tokens: 10, output_tokens: 5 } } },
  ]);
  assert.deepEqual(t.steps.map((s) => s.source), ['user', 'agent', 'agent']);
  const [, launches, after] = t.steps;
  assert.deepEqual(launches.tool_calls.map((c) => c.tool_call_id), ['toolu_a', 'toolu_b', 'toolu_c']);
  assert.deepEqual(launches.observation.results.map((r) => r.source_call_id), ['toolu_a', 'toolu_b', 'toolu_c']);
  assert.deepEqual(launches.metrics, { prompt_tokens: 100, completion_tokens: 40, cached_tokens: 0 }, 'one response, counted once');
  assert.equal(launches.llm_call_count, 1);
  assert.equal(after.llm_call_count, 1);
  assert.equal(t.final_metrics.total_completion_tokens, 45);
});

test('Codex projection: a token_count with no agent rows since the last one closed NOTHING — an orphan, counted and attributed to nobody (a compaction\'s own call, measured 2026-09-02), never a second call on the previous step', () => {
  const tokenCount = (input, output) => ({ timestamp: 't', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output }, last_token_usage: { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output }, model_context_window: 1000 }, rate_limits: null } });
  const t = codexRollout([
    { timestamp: 't1', type: 'response_item', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
    { timestamp: 't2', type: 'response_item', payload: { type: 'message', id: 'm2', role: 'assistant', content: [{ type: 'output_text', text: 'working' }] } },
    tokenCount(500, 80),
    { timestamp: 't3', type: 'compacted', payload: { message: 'summary' } },
    tokenCount(300, 20), // the compaction's own call — no agent row to land on
    { timestamp: 't4', type: 'response_item', payload: { type: 'message', id: 'm3', role: 'assistant', content: [{ type: 'output_text', text: 'after' }] } },
    tokenCount(700, 30),
  ]);
  assert.deepEqual(t.steps.map((s) => s.source), ['user', 'agent', 'system', 'agent']);
  assert.equal(t.steps[1].llm_call_count, 1, 'the second token_count is not this step\'s');
  assert.deepEqual(t.steps[1].metrics, { prompt_tokens: 500, completion_tokens: 80, cached_tokens: 0 });
  assert.equal(t.steps[2].llm_call_count, 0, 'a compacted row is deterministic dispatch');
  assert.equal(t.steps[3].llm_call_count, 1);
  assert.equal(t.extra.record.orphan_token_counts, 1);
  assert.equal(t.final_metrics.total_prompt_tokens, 1200, 'the orphan\'s usage is not attributed to anyone');
});
