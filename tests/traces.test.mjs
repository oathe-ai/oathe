import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClaudeTraceStore, CodexTraceStore, TraceContractError, harnessForTracePath } from '../src/traces.mjs';

// ---------------------------------------------------------------- fixtures (synthetic)

function claudeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-tr-claude-'));
  const cwd = path.join(home, 'work', 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const store = new ClaudeTraceStore({ home });
  const projectDir = store.projectDirFor(cwd);
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  const rows = [
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId, cwd, gitBranch: 'main', timestamp: 't', message: { role: 'user', content: 'do it' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId, cwd, timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    { type: 'ai-title', sessionId, aiTitle: 'Fixture session' },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  const subDir = path.join(projectDir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-abc123.jsonl'),
    `${JSON.stringify({ type: 'user', uuid: 's1', sessionId, agentId: 'abc123', message: { role: 'user', content: 'sub work' } })}\n`);
  fs.writeFileSync(path.join(subDir, 'agent-abc123.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Sub work', toolUseId: 'toolu_x', spawnDepth: 1 }));
  return { home, cwd, store, sessionId, file };
}

function codexFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-tr-codex-'));
  const store = new CodexTraceStore({ home });
  const threadId = '01a03800-0000-7000-8000-000000000001';
  const dir = path.join(home, '.codex/sessions/2026/08/25');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-08-25T10-00-00-${threadId}.jsonl`);
  const rows = [
    { timestamp: 't', type: 'session_meta', payload: { id: threadId, session_id: threadId, cwd: '/work/proj', source: 'cli' } },
    { timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  return { home, store, threadId, file };
}

test('harnessForTracePath keys on the codex store dir, defaulting to claude', () => {
  assert.equal(harnessForTracePath('/Users/x/.codex/sessions/2026/08/25/rollout-a.jsonl'), 'codex');
  assert.equal(harnessForTracePath('/Users/x/.claude/projects/p/s.jsonl'), 'claude');
  assert.equal(harnessForTracePath('/tmp/random.jsonl'), 'claude');
});

// ---------------------------------------------------------------- Claude store

test('ClaudeTraceStore derives the encoded project dir from cwd — nothing hardcoded', () => {
  const { store, cwd } = claudeFixture();
  const dir = store.projectDirFor(cwd);
  assert.ok(dir.endsWith(cwd.replaceAll('/', '-').replaceAll('_', '-').replaceAll('.', '-')));
  assert.ok(dir.includes('.claude/projects'));
});

test('ClaudeTraceStore.describe reads identity, title, and entry counts from a transcript', () => {
  const { store, file, sessionId, cwd } = claudeFixture();
  const seen = store.describe(file);
  assert.equal(seen.session_id, sessionId);
  assert.equal(seen.cwd, cwd);
  assert.equal(seen.title, 'Fixture session');
  assert.ok(seen.entries >= 3);
  assert.equal(seen.harness, 'claude');
});

test('ClaudeTraceStore.subagentsFor finds fan-out traces with their meta', () => {
  const { store, file } = claudeFixture();
  const subs = store.subagentsFor(file);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].agent_id, 'abc123');
  assert.equal(subs[0].meta.agentType, 'general-purpose');
  assert.ok(fs.existsSync(subs[0].path));
});

test('ClaudeTraceStore.validate REFUSES a transcript that breaks the contract — typed, loud', () => {
  const { store, file } = claudeFixture();
  assert.equal(store.validate(file).ok, true);
  const bad = `${file}.bad.jsonl`;
  fs.writeFileSync(bad, '{"no":"session"}\n{"type":"user"}\n');
  const seen = store.validate(bad);
  assert.equal(seen.ok, false);
  assert.match(seen.detail, /sessionId/i);
  assert.throws(() => store.describe(bad), (e) => e instanceof TraceContractError);
});

// ---------------------------------------------------------------- Codex store

test('CodexTraceStore.describe reads session_meta identity from a rollout', () => {
  const { store, file, threadId } = codexFixture();
  const seen = store.describe(file);
  assert.equal(seen.session_id, threadId);
  assert.equal(seen.cwd, '/work/proj');
  assert.equal(seen.harness, 'codex');
  assert.ok(seen.entries >= 2);
});

test('CodexTraceStore.validate refuses a rollout whose first line is not session_meta', () => {
  const { store, file } = codexFixture();
  assert.equal(store.validate(file).ok, true);
  const bad = `${file}.bad.jsonl`;
  fs.writeFileSync(bad, `${JSON.stringify({ timestamp: 't', type: 'response_item', payload: {} })}\n`);
  const seen = store.validate(bad);
  assert.equal(seen.ok, false);
  assert.match(seen.detail, /session_meta/);
});

test('CodexTraceStore.childThreads derives fan-out from the sqlite spawn edges', () => {
  const { store, home, threadId } = codexFixture();
  // build the index the way codex does
  const { DatabaseSync } = require_node_sqlite();
  const db = new DatabaseSync(path.join(home, '.codex/state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT, title TEXT,
             tokens_used INTEGER, git_sha TEXT, git_branch TEXT, source TEXT, created_at INTEGER);
           CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);`);
  db.prepare('INSERT INTO threads (id, rollout_path, cwd, created_at) VALUES (?, ?, ?, 1)')
    .run('child-1', '/tmp/child-rollout.jsonl', '/work/proj');
  db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run(threadId, 'child-1', 'done');
  db.close();
  const children = store.childThreads(threadId);
  assert.equal(children.length, 1);
  assert.equal(children[0].thread_id, 'child-1');
  assert.equal(children[0].rollout_path, '/tmp/child-rollout.jsonl');
});

function require_node_sqlite() {
  return process.getBuiltinModule('node:sqlite');
}

// ---------------------------------------------------------------- live-store contract (fail loud on drift)

test('LIVE CONTRACT: the newest real Claude transcript on this machine still parses', (t) => {
  const store = new ClaudeTraceStore({});
  const newest = store.newestTranscript();
  if (!newest) return t.skip('no ~/.claude/projects store on this machine — contract unverifiable here');
  const seen = store.validate(newest);
  assert.equal(seen.ok, true, `CLAUDE TRACE DRIFT: ${seen.detail} (${newest})`);
});

test('LIVE CONTRACT: the newest real Codex rollout on this machine still parses', (t) => {
  const store = new CodexTraceStore({});
  const newest = store.newestRollout();
  if (!newest) return t.skip('no ~/.codex/sessions store on this machine — contract unverifiable here');
  const seen = store.validate(newest);
  assert.equal(seen.ok, true, `CODEX TRACE DRIFT: ${seen.detail} (${newest})`);
});
