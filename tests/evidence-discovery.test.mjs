import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { ClaudeTraceStore, CodexTraceStore, TraceContractError } from '../src/traces.mjs';
import { EvidenceDiscovery } from '../src/evidence-discovery.mjs';
import { requireSqlite } from './helpers.mjs';

requireSqlite();

const TASK = 'discovered-task';
const CLAIM_UUID = crypto.randomUUID();

// ---------------------------------------------------------------- fixtures

/** A scratch home holding a claude store; returns writers for transcripts inside it. */
function scratchClaudeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-ed-home-'));
  const store = new ClaudeTraceStore({ harness: 'claude', home });
  const projectDir = path.join(store.projectsRoot, 'fixture-proj');
  fs.mkdirSync(projectDir, { recursive: true });
  return { home, store, projectDir };
}

/** A transcript that PERFORMED the task: claim act naming it, the UUID echoed in the result. */
function performingTranscript(projectDir, { taskId = TASK, uuid = CLAIM_UUID } = {}) {
  const sessionId = crypto.randomUUID();
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, sessionId, cwd: projectDir,
      message: { role: 'user', content: 'work the task' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId, cwd: projectDir,
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_c1', name: 'mcp__oathe__oathe_claim', input: { task_id: taskId, objective: 'do it' } }] } }),
    JSON.stringify({ type: 'user', uuid: 'r1', parentUuid: 'a1', sessionId, cwd: projectDir,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c1',
        content: `{"claimed":true,"task_id":"${taskId}","work_claim_id":"${uuid}"}` }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'r1', sessionId, cwd: projectDir,
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_w1', name: 'Bash', input: { command: 'make it' } },
        { type: 'text', text: 'DISCOVERED-WORK-MARKER' }] } }),
    JSON.stringify({ type: 'user', uuid: 'r2', parentUuid: 'a2', sessionId, cwd: projectDir,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_w1', content: 'made it\nExit code 0' }] } }),
  ].join('\n'));
  return { file, sessionId };
}

/** A transcript that merely MENTIONS the UUID — an investigator, not a worker. */
function mentioningTranscript(projectDir, { uuid = CLAIM_UUID } = {}) {
  const sessionId = crypto.randomUUID();
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, sessionId, cwd: projectDir,
      message: { role: 'user', content: `why did claim ${uuid} fail?` } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId, cwd: projectDir,
      message: { role: 'assistant', content: [{ type: 'text', text: `investigating ${uuid} — no acts taken` }] } }),
  ].join('\n'));
  return { file, sessionId };
}

/** A stub substrate: answers the task's claims and its trace links. */
function stubClient({ claims = [], links = [] } = {}) {
  return {
    async query(sql) {
      if (/cell\.work_claim/.test(sql)) return { rows: claims };
      if (/cell\.agent_statement/.test(sql)) return { rows: links };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const RECENT = new Date(Date.now() - 60_000).toISOString();

// ---------------------------------------------------------------- store primitives

test('filesSince honors the mtime window and never prunes by path date — a long-lived thread lives in an old partition', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-ed-codex-'));
  const store = new CodexTraceStore({ harness: 'codex', home });
  const oldDir = path.join(home, '.codex/sessions/2026/08/23');
  fs.mkdirSync(oldDir, { recursive: true });
  const fresh = path.join(oldDir, 'rollout-2026-08-23T10-00-00-01a00000-0000-7000-8000-000000000001.jsonl');
  const stale = path.join(oldDir, 'rollout-2026-08-23T11-00-00-01a00000-0000-7000-8000-000000000002.jsonl');
  fs.writeFileSync(fresh, '{}\n');
  fs.writeFileSync(stale, '{}\n');
  const old = (Date.now() - 7 * 86_400_000) / 1000;
  fs.utimesSync(stale, old, old);
  const found = store.evidenceFiles({ sinceMs: Date.now() - 3_600_000 });
  assert.deepEqual(found, [fresh],
    'mtime is the only sound filter — the path date is the thread\'s BIRTH, not its last work');
});

test('contains scans the raw bytes for the claim fingerprint and refuses an unreadable file typed', () => {
  const { store, projectDir } = scratchClaudeHome();
  const { file } = performingTranscript(projectDir);
  assert.equal(store.contains(file, CLAIM_UUID), true);
  assert.equal(store.contains(file, crypto.randomUUID()), false);
  assert.throws(() => store.contains(path.join(projectDir, 'absent.jsonl'), CLAIM_UUID),
    (e) => e instanceof TraceContractError && e.code === 'TRACE_UNREADABLE');
});

// ---------------------------------------------------------------- gather

test('gather discovers the transcript that PERFORMED the task and excludes the one that merely mentions it', async () => {
  const { home, projectDir } = scratchClaudeHome();
  const { file: performed } = performingTranscript(projectDir);
  mentioningTranscript(projectDir);
  const discovery = new EvidenceDiscovery({
    client: stubClient({ claims: [{ work_claim_id: CLAIM_UUID, claimed_at: RECENT }] }),
    orgId: 'oathe', home,
  });
  const traces = await discovery.gather({ taskId: TASK });
  assert.deepEqual(traces.map((t) => ({ path: t.path, via: t.via })), [{ path: performed, via: 'discovered' }],
    'performing, not mentioning, is evidence — the investigator\'s transcript never enters the record');
  assert.ok(traces[0].trajectory.steps?.length > 0, 'a discovered trace arrives projected');
});

test('gather unions linked evidence with discovery — a linked path is never dropped, and it leads', async () => {
  const { home, projectDir } = scratchClaudeHome();
  const { file: performed } = performingTranscript(projectDir);
  const linkedSession = crypto.randomUUID();
  const linked = path.join(projectDir, `${linkedSession}.jsonl`);
  fs.writeFileSync(linked, [
    JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: linkedSession, cwd: projectDir,
      message: { role: 'user', content: 'linked work, no fingerprint' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: linkedSession, cwd: projectDir,
      message: { role: 'assistant', content: [{ type: 'text', text: 'spoken for by the record' }] } }),
  ].join('\n'));
  const discovery = new EvidenceDiscovery({
    client: stubClient({
      claims: [{ work_claim_id: CLAIM_UUID, claimed_at: RECENT }],
      links: [{ subject_ref: `trace:${linkedSession}`, evidence_refs: [linked] }],
    }),
    orgId: 'oathe', home,
  });
  const traces = await discovery.gather({ taskId: TASK });
  assert.deepEqual(traces.map((t) => ({ path: t.path, via: t.via })),
    [{ path: linked, via: 'linked' }, { path: performed, via: 'discovered' }],
    'the record\'s own word leads; discovery adds — never less evidence than the claim recorded');
});

test('a file both linked and discovered serves once, as the record\'s', async () => {
  const { home, projectDir } = scratchClaudeHome();
  const { file, sessionId } = performingTranscript(projectDir);
  const discovery = new EvidenceDiscovery({
    client: stubClient({
      claims: [{ work_claim_id: CLAIM_UUID, claimed_at: RECENT }],
      links: [{ subject_ref: `trace:${sessionId}`, evidence_refs: [file] }],
    }),
    orgId: 'oathe', home,
  });
  const traces = await discovery.gather({ taskId: TASK });
  assert.deepEqual(traces.map((t) => ({ path: t.path, via: t.via })), [{ path: file, via: 'linked' }]);
});

test('a store too busy for the window refuses typed — never a silent partial scan', async () => {
  const { home, projectDir } = scratchClaudeHome();
  performingTranscript(projectDir);
  mentioningTranscript(projectDir);
  const discovery = new EvidenceDiscovery({
    client: stubClient({ claims: [{ work_claim_id: CLAIM_UUID, claimed_at: RECENT }] }),
    orgId: 'oathe', home, maxFiles: 1,
  });
  await assert.rejects(discovery.gather({ taskId: TASK }),
    (e) => e instanceof TraceContractError && e.code === 'TRACE_DISCOVERY_OVERFLOW');
});

test('a codex cell still RUNNING its blocking done is discovered — the source names the acts, no output row needed', async () => {
  // The record at the instant cloud-gate1-product-alignment was judged (2026-09-04): one exec
  // cell (sed + claim + done) written, its claim item landed, its output row not yet.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-ed-cx-'));
  const dir = path.join(home, '.codex/sessions/2026/09/04');
  fs.mkdirSync(dir, { recursive: true });
  const threadId = '01a00000-0000-7000-8000-0000000000aa';
  const file = path.join(dir, `rollout-2026-09-04T13-05-00-${threadId}.jsonl`);
  const uuid = crypto.randomUUID();
  const src = 'text(await tools.exec_command({cmd:"sed -n 1,3p /tmp/p.txt"})); '
    + `text(await tools.mcp__oathe__oathe_claim({task_id:"${TASK}",objective:"assess"})); `
    + `text(await tools.mcp__oathe__oathe_done({task_id:"${TASK}",proposition:"reviewed",evidence_ref:"/tmp/p.txt"}));`;
  fs.writeFileSync(file, [
    { timestamp: 't0', type: 'session_meta', payload: { id: threadId, cwd: '/work', source: 'cli', cli_version: '0.150.0', model_provider: 'openai' } },
    { timestamp: 't1', type: 'turn_context', payload: { turn_id: 'turn-1', cwd: '/work', model: 'gpt-5.6-sol' } },
    { timestamp: 't2', type: 'response_item', payload: { type: 'message', id: 'msg_1', role: 'user', content: [{ type: 'input_text', text: 'assess it' }] } },
    { timestamp: 't3', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'c1', name: 'exec', input: src } },
    { timestamp: 't4', type: 'event_msg', payload: { type: 'item_completed', thread_id: threadId, turn_id: 'turn-1', item: { type: 'McpToolCall', id: 'exec-1', server: 'oathe', tool: 'oathe_claim', arguments: { task_id: TASK, objective: 'assess' }, status: 'completed', result: { content: [{ type: 'text', text: `{"claimed":true,"work_claim_id":"${uuid}"}` }], isError: false } } } },
  ].map((r) => JSON.stringify(r)).join('\n'));
  const discovery = new EvidenceDiscovery({
    client: stubClient({ claims: [{ work_claim_id: uuid, claimed_at: RECENT }] }),
    orgId: 'oathe', home,
  });
  const traces = await discovery.gather({ taskId: TASK });
  assert.deepEqual(traces.map((t) => ({ path: t.path, via: t.via })), [{ path: file, via: 'discovered' }],
    'the acts are on the record from the source alone — the cell need not have returned');
});

test('no claims and no links gather to an empty record — honestly', async () => {
  const { home } = scratchClaudeHome();
  const discovery = new EvidenceDiscovery({ client: stubClient(), orgId: 'oathe', home });
  assert.deepEqual(await discovery.gather({ taskId: TASK }), []);
});

test('an unreadable file in the window is REPORTED, never a stall — evidence elsewhere still serves (Greptile on PR #37, 2026-09-04)', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads everything — the permission fixture cannot exist');
  const { home, projectDir } = scratchClaudeHome();
  const { file: performed } = performingTranscript(projectDir);
  const locked = path.join(projectDir, `${crypto.randomUUID()}.jsonl`);
  fs.writeFileSync(locked, `${JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, cwd: projectDir, message: { role: 'user', content: 'unrelated, unreadable' } })}\n`);
  fs.chmodSync(locked, 0o000);
  try {
    const discovery = new EvidenceDiscovery({
      client: stubClient({ claims: [{ work_claim_id: CLAIM_UUID, claimed_at: RECENT }] }),
      orgId: 'oathe', home,
    });
    const { traces, unreadable } = await discovery.read({ taskId: TASK });
    assert.deepEqual(traces.map((x) => ({ path: x.path, via: x.via })), [{ path: performed, via: 'discovered' }],
      'the task\'s own evidence is found — an unrelated unreadable file never blocks it');
    assert.deepEqual(unreadable.map((u) => ({ path: u.path, code: u.code })), [{ path: locked, code: 'TRACE_UNREADABLE' }],
      'what could not be read is on the result by name and cause — reported, never swallowed');
    assert.deepEqual((await discovery.gather({ taskId: TASK })).map((x) => x.path), [performed], 'gather is read().traces');
  } finally {
    fs.chmodSync(locked, 0o600);
  }
});

test('a store that cannot be ENUMERATED is reported, never a stall — the other stores still serve (Greptile round 2 on PR #37)', async () => {
  const { home, store, projectDir } = scratchClaudeHome();
  const { file: performed } = performingTranscript(projectDir);
  const broken = { harness: 'broken', evidenceFiles() { throw Object.assign(new Error('root vanished mid-walk'), { code: 'ENOENT' }); }, contains() { return false; } };
  const discovery = new EvidenceDiscovery({
    client: stubClient({ claims: [{ work_claim_id: CLAIM_UUID, claimed_at: RECENT }] }),
    orgId: 'oathe', home, storesFor: async () => [broken, store],
  });
  const { traces, unreadable } = await discovery.read({ taskId: TASK });
  assert.deepEqual(traces.map((x) => x.path), [performed], 'the readable store\'s evidence still serves');
  assert.deepEqual(unreadable.map((u) => [u.path, u.code]), [['broken store', 'ENOENT']], 'the store that could not be walked is on the result by name and cause');
});
