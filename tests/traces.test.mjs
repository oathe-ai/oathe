import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClaudeTraceStore, CodexTraceStore, TraceContractError } from '../src/traces.mjs';
import { requireSqlite } from './helpers.mjs';

// A below-floor runtime fails these lanes LOUDLY with the floor named — never a silent skip.
requireSqlite();

// ---------------------------------------------------------------- fixtures (synthetic)

function claudeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-tr-claude-'));
  const cwd = path.join(home, 'work', 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const store = new ClaudeTraceStore({ harness: 'claude', home });
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
  const store = new CodexTraceStore({ harness: 'codex', home });
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

test('trace-path ownership is asked of the stores (catalog.ownerOfTracePath): codex, claude, or nobody', async () => {
  const { ownerOfTracePath } = await import('../src/harnesses/catalog.mjs');
  assert.equal(ownerOfTracePath('/Users/x/.codex/sessions/2026/08/25/rollout-a.jsonl'), 'codex');
  assert.equal(ownerOfTracePath('/Users/x/.claude/projects/p/s.jsonl'), 'claude');
  assert.equal(ownerOfTracePath('/tmp/random.jsonl'), null, 'no fallback owner — a stray file is not evidence');
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


function spawnIndex(home, rows) {
  const { DatabaseSync } = require_node_sqlite();
  const db = new DatabaseSync(path.join(home, '.codex/state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT, title TEXT,
             tokens_used INTEGER, git_sha TEXT, git_branch TEXT, source TEXT, created_at INTEGER);
           CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);`);
  for (const { parent, id, rollout_path, cwd = null, source = null, status = 'open' } of rows) {
    db.prepare('INSERT INTO threads (id, rollout_path, cwd, source, created_at) VALUES (?, ?, ?, ?, 1)')
      .run(id, rollout_path, cwd, source);
    db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run(parent, id, status);
  }
  db.close();
}

test('CodexTraceStore.childThreads derives fan-out from the sqlite spawn edges — with the edge status and the spawn identity', () => {
  const { store, home, threadId } = codexFixture();
  // the index the way codex writes it (source shape measured live, 2026-08-31)
  spawnIndex(home, [{
    parent: threadId,
    id: 'child-1',
    rollout_path: '/tmp/child-rollout.jsonl',
    cwd: '/work/proj',
    source: JSON.stringify({
      subagent: { thread_spawn: { parent_thread_id: threadId, depth: 1, agent_path: '/root/draft-1', agent_nickname: 'draft-1', agent_role: 'drafter' } },
    }),
  }]);
  const children = store.childThreads(threadId);
  assert.equal(children.length, 1);
  assert.equal(children[0].thread_id, 'child-1');
  assert.equal(children[0].rollout_path, '/tmp/child-rollout.jsonl');
  assert.equal(children[0].status, 'open', 'a failed/aborted child must be distinguishable from a completed one');
  assert.deepEqual(children[0].spawn,
    { parent_thread_id: threadId, depth: 1, agent_path: '/root/draft-1', agent_nickname: 'draft-1', agent_role: 'drafter' },
    'the spawn identity rides along — who this child was, in the record\'s own words');
});

test('CodexTraceStore.childThreads refuses a threads.source that is not JSON — an expected shape gone unreadable', () => {
  const { store, home, threadId } = codexFixture();
  spawnIndex(home, [{ parent: threadId, id: 'child-1', rollout_path: '/tmp/child-rollout.jsonl', source: '{not json' }]);
  assert.throws(() => store.childThreads(threadId),
    (e) => e instanceof TraceContractError && e.code === 'TRACE_CODEX_SOURCE_MALFORMED');
});

// ---------------------------------------------------------------- the file a session's rows live in

test('ClaudeTraceStore.transcriptFor: a RESUMED session\'s rows live in the original file — the harness reports <new-id>.jsonl and never writes it (measured 2026-09-01)', () => {
  const { store, file, sessionId } = claudeFixture();
  const projectDir = path.dirname(file);
  const resumed = '99999999-8888-7777-6666-555555555555';
  // After a resume the harness stamps every new row with session_id (the rotated id) while
  // sessionId (the file's own id) stays — that stamp is the positive evidence.
  fs.appendFileSync(file, `\n${JSON.stringify({ type: 'user', uuid: 'u9', sessionId, session_id: resumed, cwd: '/x', message: { role: 'user', content: 'after the resume' } })}`);
  // A newer sibling that merely MENTIONS the id in its text is not the session's file.
  const bystander = path.join(projectDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  fs.writeFileSync(bystander, JSON.stringify({ type: 'user', uuid: 'b1', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', message: { role: 'user', content: `look at ${resumed}` } }));
  const ghost = path.join(projectDir, `${resumed}.jsonl`);
  assert.equal(store.transcriptFor({ sessionId: resumed, reportedPath: ghost }), file, 'the file whose rows carry the session id');
  assert.equal(store.transcriptFor({ sessionId, reportedPath: file }), file, 'a reported file that exists is the answer, no scan');
  const fresh = path.join(projectDir, 'ffffffff-0000-0000-0000-000000000000.jsonl');
  assert.equal(store.transcriptFor({ sessionId: 'ffffffff-0000-0000-0000-000000000000', reportedPath: fresh }), fresh,
    'a fresh session\'s file is created lazily — nothing carries its id yet, so the reported path stands');
  assert.equal(store.transcriptFor({ sessionId: 'x', reportedPath: null }), null, 'no transcript store is a fact');
});

test('CodexTraceStore.transcriptFor: the thread index names the rollout when the reported path is not on disk', () => {
  const { store, home, threadId, file } = codexFixture();
  spawnIndex(home, [{ parent: 'root', id: threadId, rollout_path: file }]);
  const ghost = path.join(home, '.codex/sessions/2026/08/25/rollout-ghost.jsonl');
  assert.equal(store.transcriptFor({ sessionId: threadId, reportedPath: ghost }), file);
  assert.equal(store.transcriptFor({ sessionId: threadId, reportedPath: file }), file);
  const unindexed = path.join(home, '.codex/sessions/2026/08/25/rollout-new.jsonl');
  assert.equal(store.transcriptFor({ sessionId: 'not-indexed', reportedPath: unindexed }), unindexed,
    'an unindexed thread keeps the reported path — a rollout not written yet');
});

function require_node_sqlite() {
  return process.getBuiltinModule('node:sqlite');
}

// ---------------------------------------------------------------- live-store contract (fail loud on drift)

test('LIVE CONTRACT: the newest real Claude transcript on this machine still parses', (t) => {
  const store = new ClaudeTraceStore({ harness: 'claude',});
  const newest = store.newestTranscript();
  if (!newest) return t.skip('no ~/.claude/projects store on this machine — contract unverifiable here');
  const seen = store.validate(newest);
  assert.equal(seen.ok, true, `CLAUDE TRACE DRIFT: ${seen.detail} (${newest})`);
});

test('LIVE CONTRACT: the newest real Codex rollout on this machine still parses', (t) => {
  const store = new CodexTraceStore({ harness: 'codex',});
  const newest = store.newestRollout();
  if (!newest) return t.skip('no ~/.codex/sessions store on this machine — contract unverifiable here');
  const seen = store.validate(newest);
  assert.equal(seen.ok, true, `CODEX TRACE DRIFT: ${seen.detail} (${newest})`);
});
