// The trace census: the ONE engine (src/trace-census.mjs) that doctor, the census lane, and
// these tests all drive. It answers two questions the 2026-08-31 incident proved nobody was
// asking: does the store contain row types outside the declared roster (DRIFT — additions
// must be reviewed), and does the projection CARRY what the raw record carries (fidelity —
// 'didn't throw' let DID: exec({}) run for days).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { censusOf, fidelityOf, TraceCensusError } from '../src/trace-census.mjs';
import { CodexTraceStore } from '../src/traces.mjs';
import { CodexAtifProjector } from '../src/harnesses/codex-rollout.mjs';
import { OatheAnnotator } from '../src/oathe-annotator.mjs';
import { byName } from '../src/harnesses/catalog.mjs';
import { requireSqlite } from './helpers.mjs';

// A below-floor runtime fails these lanes LOUDLY with the floor named — never a silent skip.
requireSqlite();

const CODEX = byName('codex').traces;

function codexHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-census-'));
  fs.mkdirSync(path.join(home, '.codex/sessions/2026/08/25'), { recursive: true });
  return home;
}

let rolloutSeq = 0;
function writeRollout(home, rows, { mtime = null } = {}) {
  rolloutSeq += 1;
  const id = `01a00000-0000-7000-8000-${String(rolloutSeq).padStart(12, '0')}`;
  const file = path.join(home, '.codex/sessions/2026/08/25', `rollout-2026-08-25T10-00-0${rolloutSeq % 10}-${id}.jsonl`);
  const meta = { timestamp: 't0', type: 'session_meta', payload: { id, cwd: '/work/proj', source: 'cli', cli_version: '0.150.0', model_provider: 'openai' } };
  fs.writeFileSync(file, [meta, ...rows].map((r) => JSON.stringify(r)).join('\n'));
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return { file, id };
}

const userMsg = (text) => ({ timestamp: 't', type: 'response_item', payload: { type: 'message', id: 'm', role: 'user', content: [{ type: 'input_text', text }] } });

test('censusOf: an UNDECLARED row type is flagged with its count, an example file, and both roster lists — an ignored one is not', () => {
  const home = codexHome();
  const store = new CodexTraceStore({ harness: 'codex', home });
  const { file } = writeRollout(home, [
    userMsg('hello'),
    { timestamp: 't', type: 'response_item', payload: { type: 'holo_call', beam: 'b' } },
    { timestamp: 't', type: 'event_msg', payload: { type: 'tachyon_pulse' } },
    { timestamp: 't', type: 'event_msg', payload: { type: 'tachyon_pulse' } },
    { timestamp: 't', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Reasoning' } } }, // an ignored ITEM, with a reason
  ]);
  const seen = censusOf({ store, roster: CODEX.roster, kindOf: CODEX.kindOf, files: [file] });
  assert.equal(seen.swept, 1);
  assert.equal(seen.counts.response_item.message, 1);
  assert.equal(seen.counts.item.Reasoning, 1, 'the item stream is its own lane, classified by item type');
  assert.deepEqual(seen.undeclared.map((u) => [u.channel, u.type, u.count]), [
    ['event_msg', 'tachyon_pulse', 2],
    ['response_item', 'holo_call', 1],
  ]);
  assert.equal(seen.undeclared[0].example, file);
  assert.ok(seen.unusedHandled.some((u) => u.channel === 'response_item' && u.type === 'custom_tool_call'),
    'a handled type absent from the sweep window is VISIBLE, never failing');
});

test('censusOf without a roster/classifier refuses — a pre-roster adapter can never census green', () => {
  const home = codexHome();
  const store = new CodexTraceStore({ harness: 'codex', home });
  assert.throws(() => censusOf({ store, roster: null, kindOf: CODEX.kindOf, files: [] }),
    (e) => e instanceof TraceCensusError && e.code === 'OATHE_TRACE_CENSUS_ROSTER_MISSING');
  assert.throws(() => censusOf({ store, roster: CODEX.roster, kindOf: null, files: [] }),
    (e) => e instanceof TraceCensusError && e.code === 'OATHE_TRACE_CENSUS_ROSTER_MISSING');
});

test('recent(store, {days, maxFiles}) sweeps the window newest-first, caps the cost, and ALWAYS includes the newest record', () => {
  const home = codexHome();
  const store = new CodexTraceStore({ harness: 'codex', home });
  const now = Date.now() / 1000;
  const day = 86400;
  const { file: old } = writeRollout(home, [userMsg('old')], { mtime: now - 10 * day });
  const { file: recent1 } = writeRollout(home, [userMsg('recent1')], { mtime: now - 1 * day });
  const { file: newest } = writeRollout(home, [userMsg('newest')], { mtime: now });
  assert.deepEqual(CODEX.recent(store, { days: 3, maxFiles: 40 }), [newest, recent1],
    'the window is days-bounded, newest first');
  assert.deepEqual(CODEX.recent(store, { days: 3, maxFiles: 1 }), [newest], 'maxFiles caps the cost');
  fs.utimesSync(recent1, now - 20 * day, now - 20 * day);
  fs.utimesSync(newest, now - 20 * day, now - 20 * day);
  const fallback = CODEX.recent(store, { days: 3, maxFiles: 40 });
  assert.equal(fallback.length, 1, 'an all-stale store still yields its newest record — never an empty sweep');
  assert.ok([old, recent1, newest].includes(fallback[0]));
});

test('fidelityOf: a faithful record passes its applicable probes; a projection refusal is classified by the injected status, never lost', async () => {
  const home = codexHome();
  const store = new CodexTraceStore({ harness: 'codex', home });
  const { file: good } = writeRollout(home, [
    userMsg('do it'),
    {
      timestamp: 't', type: 'response_item',
      payload: { type: 'custom_tool_call', id: 'c1', status: 'completed', call_id: 'call_1', name: 'exec', input: 'const r = await tools.exec_command({cmd:"true"});\n' },
    },
    { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call_output', id: 'o1', call_id: 'call_1', output: [{ type: 'input_text', text: 'ok' }] } },
    {
      timestamp: 't', type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 }, model_context_window: 1 } },
    },
  ]);
  const { file: bad } = writeRollout(home, [
    userMsg('drifted'),
    { timestamp: 't', type: 'event_msg', payload: { type: 'token_count', input_tokens: 5 } }, // the extinct flat shape
  ]);
  // The probes judge the ANNOTATED projection (claim events are the annotator's), so the
  // census takes the one read as a function — the converter, then the annotation.
  const projector = new CodexAtifProjector({ store });
  const annotator = new OatheAnnotator();
  const seen = await fidelityOf({
    store,
    project: (file) => annotator.annotate(projector.project(file)),
    fidelity: CODEX.fidelity,
    files: [good, bad],
    traceStatus: (e) => (e?.code === 'TRACE_CODEX_SQLITE_UNSUPPORTED' ? 'RUNTIME' : 'DRIFT'),
  });
  assert.equal(seen.projectionErrors.length, 1);
  assert.equal(seen.projectionErrors[0].file, bad);
  assert.equal(seen.projectionErrors[0].status, 'DRIFT');
  assert.match(seen.projectionErrors[0].detail, /last_token_usage/);
  const args = seen.probes.find((p) => p.probe === 'tool-call-args');
  assert.equal(args.applicable, 1, 'one swept record carried tool calls');
  assert.deepEqual(args.failed, [], 'and its projection carried them faithfully');
  const metrics = seen.probes.find((p) => p.probe === 'token-metrics');
  assert.equal(metrics.applicable, 1);
  assert.deepEqual(metrics.failed, []);
});

test('the codex tool-call-args probe FAILS a projection whose arguments went empty while the raw record carried the command', async () => {
  const entries = [
    { type: 'session_meta', payload: { id: 's1' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_9', name: 'exec', input: 'const r = await tools.exec_command({cmd:"npm test"});' } },
  ];
  const trajectory = {
    session_id: 's1',
    steps: [{ step_id: 1, source: 'agent', message: '', tool_calls: [{ tool_call_id: 'call_9', function_name: 'exec', arguments: {} }] }],
  };
  const seen = await CODEX.fidelity['tool-call-args'](entries, trajectory, {});
  assert.equal(seen.applicable, true);
  assert.equal(seen.ok, false);
  assert.match(seen.detail, /call_9/, 'the failure names the call');
  assert.match(seen.detail, /OATHE_TRACE_FIDELITY_EMPTY_ARGS/, 'and its typed code');
});

test('the token-metrics probe reads the ROOT\'s own steps — folded child usage cannot mask a root whose usage was lost', async () => {
  const entries = [
    { type: 'session_meta', payload: { id: 's1' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 3, output_tokens: 1 } } } },
  ];
  const masked = {
    steps: [{ step_id: 1, source: 'agent', message: '' }],
    final_metrics: { total_prompt_tokens: 500, total_completion_tokens: 50, total_steps: 1 }, // the children's, folded in
    subagent_trajectories: [{ trajectory_id: 'c', steps: [{ step_id: 1, source: 'agent', message: '', metrics: { prompt_tokens: 500, completion_tokens: 50 } }] }],
  };
  const lost = await CODEX.fidelity['token-metrics'](entries, masked, {});
  assert.equal(lost.ok, false, 'the root carried usage and its own steps show none');
  const carried = { ...masked, steps: [{ step_id: 1, source: 'agent', message: '', metrics: { prompt_tokens: 3, completion_tokens: 1 } }] };
  assert.deepEqual(await CODEX.fidelity['token-metrics'](entries, carried, {}), { applicable: true, ok: true, detail: null });
});

test('the codex token-metrics probe is n/a for a record whose only token_count carries info: null — there is nothing to carry', async () => {
  const entries = [
    { type: 'session_meta', payload: { id: 's1' } },
    { type: 'event_msg', payload: { type: 'token_count', info: null } },
  ];
  const seen = await CODEX.fidelity['token-metrics'](entries, { final_metrics: { total_prompt_tokens: 0, total_completion_tokens: 0 } }, {});
  assert.equal(seen.applicable, false, 'a documented vendor state, not a projection that lost the usage');
  const withUsage = [...entries, { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 3 } } } }];
  const lost = await CODEX.fidelity['token-metrics'](withUsage, { final_metrics: { total_prompt_tokens: 0, total_completion_tokens: 0 } }, {});
  assert.equal(lost.ok, false, 'usage in the record, zeros in the projection — that IS the loss');
});

test('the codex cross-source probe: applicable only when correlatable items exist; fails when an item completed no call, or the text and the record disagree on an exit code', async () => {
  const withItem = [
    { type: 'session_meta', payload: { id: 's1' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'const r = await tools.exec_command({cmd:"x"});' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-1', command: ['bash', '-lc', 'x'], exit_code: 2 } } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'boom\nExit code 2' } },
  ];
  const projected = (content, record = { exit_code: 2 }, root = {}) => ({
    session_id: 's1', extra: { record: root },
    steps: [{
      step_id: 1, source: 'agent', message: '',
      tool_calls: [{ tool_call_id: 'c1', function_name: 'exec_command', arguments: { cmd: 'x' } }],
      observation: { results: [{ source_call_id: 'c1', content, extra: { record } }] },
    }],
  });
  assert.deepEqual(await CODEX.fidelity['cross-source'](withItem, projected('boom\nExit code 2'), {}), { applicable: true, ok: true, detail: null });
  const disagreeing = await CODEX.fidelity['cross-source'](withItem, projected('boom\nExit code 0'), {});
  assert.equal(disagreeing.ok, false, 'the text says 0, the record says 2 — a join landed on the wrong call');
  assert.match(disagreeing.detail, /c1/);
  assert.match(disagreeing.detail, /OATHE_TRACE_FIDELITY_CROSS_SOURCE/);
  const orphaned = await CODEX.fidelity['cross-source'](withItem, projected('boom\nExit code 2', { exit_code: 2 }, { uncorrelated_items: { CommandExecution: 1 } }), {});
  assert.equal(orphaned.ok, false, 'an item that completed no call is a join that failed');
  assert.match(orphaned.detail, /uncorrelated.*CommandExecution/);
  const noItems = withItem.filter((r) => r.payload?.type !== 'item_completed');
  assert.equal((await CODEX.fidelity['cross-source'](noItems, projected('boom\nExit code 2'), {})).applicable, false, 'no items, nothing to cross-check');
  assert.equal((await byName('claude').traces.fidelity['cross-source']([], { steps: [] }, {})).applicable, false, 'no item stream on claude — n/a, never a stolen pass');
});

test('the attribution probe: an inbound message rendered as the agent\'s own SAID is a misattribution — named by step, on every trace-store engine; n/a when nothing was sent in', async () => {
  const body = 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/draft-1\nPayload:\nthe child says the work is done and here is why';
  const codexEntries = [
    { type: 'session_meta', payload: { id: 's1', cwd: '/w', source: 'cli' } },
    { type: 'response_item', payload: { type: 'agent_message', id: 'am1', author: '/root/draft-1', recipient: '/root', content: [{ type: 'input_text', text: body }] } },
    { type: 'response_item', payload: { type: 'agent_message', id: 'am2', author: '/root', recipient: '/root/other', content: [{ type: 'input_text', text: 'Message Type: MESSAGE\nPayload:\nan outbound nudge' }] } },
  ];
  const misattributed = { steps: [{ step_id: 1, source: 'agent', message: `I received this: ${body}` }] };
  const attributed = { steps: [{ step_id: 1, source: 'system', message: '[inbound FINAL_ANSWER from /root/draft-1]', observation: { results: [{ content: body }] }, extra: { record: { inbound: { author: '/root/draft-1', recipient: '/root' } } } }] };
  const seen = await CODEX.fidelity.attribution(codexEntries, misattributed, {});
  assert.equal(seen.applicable, true);
  assert.equal(seen.ok, false);
  assert.match(seen.detail, /step 1/, 'the failure names the step');
  assert.match(seen.detail, /OATHE_TRACE_FIDELITY_MISATTRIBUTED/);
  assert.deepEqual(await CODEX.fidelity.attribution(codexEntries, attributed, {}), { applicable: true, ok: true, detail: null });
  const outboundOnly = codexEntries.filter((r) => r.payload?.author !== '/root/draft-1');
  assert.equal((await CODEX.fidelity.attribution(outboundOnly, misattributed, {})).applicable, false, 'a message this thread SENT is its own words — nothing to misattribute');

  const CLAUDE = byName('claude').traces;
  const note = '<task-notification>\n<task-id>sub1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<summary>done</summary>\n<result>the subagent found the answer in the logs</result>\n</task-notification>';
  const claudeEntries = [
    { type: 'user', uuid: 'u1', sessionId: 's', origin: { kind: 'human' }, message: { role: 'user', content: 'go' } },
    { type: 'user', uuid: 'u2', sessionId: 's', origin: { kind: 'task-notification' }, promptSource: 'system', message: { role: 'user', content: note } },
  ];
  const claudeMis = { steps: [{ step_id: 1, source: 'agent', message: `The notification said: ${note}` }] };
  const claudeOk = { steps: [{ step_id: 1, source: 'system', message: '[inbound task-notification sub1]', observation: { results: [{ content: note }] }, extra: { record: { inbound: { kind: 'task-notification', task_id: 'sub1' } } } }] };
  assert.equal((await CLAUDE.fidelity.attribution(claudeEntries, claudeMis, {})).ok, false);
  assert.deepEqual(await CLAUDE.fidelity.attribution(claudeEntries, claudeOk, {}), { applicable: true, ok: true, detail: null });
  assert.equal((await CLAUDE.fidelity.attribution(claudeEntries.slice(0, 1), claudeMis, {})).applicable, false);
});

test('the codex claim-events probe: applicable only when a REAL oathe act was called (a grep about oathe is not one), ok when the events survive', async () => {
  const acted = [
    { type: 'session_meta', payload: { id: 's1' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'const r = await tools.mcp__oathe__oathe_claim({task_id:"t-1"});' } },
  ];
  const talked = [
    { type: 'session_meta', payload: { id: 's2' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'const r = await tools.exec_command({cmd:"rg -n \\"oathe_claim\\" src/"});' } },
  ];
  const withEvents = { session_id: 's1', steps: [{ step_id: 1, source: 'agent', message: '', extra: { oathe: { claim_events: [{ verb: 'oathe_claim', task_id: 't-1' }] } } }] };
  const without = { session_id: 's1', steps: [{ step_id: 1, source: 'agent', message: '' }] };
  assert.deepEqual(await CODEX.fidelity['claim-events'](acted, withEvents, {}), { applicable: true, ok: true, detail: null });
  const lost = await CODEX.fidelity['claim-events'](acted, without, {});
  assert.equal(lost.ok, false);
  assert.match(lost.detail, /OATHE_TRACE_FIDELITY_CLAIMS_LOST/);
  const chatter = await CODEX.fidelity['claim-events'](talked, without, {});
  assert.equal(chatter.applicable, false, 'grepping for oathe_claim is not claiming');
});
