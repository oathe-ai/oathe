import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { SessionRegistry, SessionRegistryError, processAncestry, nearestAppBundle, pidAlive } from '../src/sessions.mjs';

function scratch() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-sessions-')));
  return path.join(dir, 'sessions.json');
}

const FACTS = {
  ancestry: [{ pid: process.pid, exec: '/usr/local/bin/claude' }, { pid: 1, exec: '/sbin/launchd' }],
  app: null,
  transcriptPath: '/tmp/t.jsonl',
  workspace: 'ws-abcdef123456',
};

// pid: a real, live pid — aliveness is a fact, not a fixture
const ensureRow = (reg, over = {}) => reg.ensure({ sessionId: 'sess-1', pid: process.pid, facts: () => FACTS, ...over });

test('ensure() registers an unknown session — the facts thunk runs ONCE, the full row lands, never a surface name', async () => {
  const sessionsPath = scratch();
  const reg = new SessionRegistry({ sessionsPath });
  let thunkCalls = 0;
  await ensureRow(reg, { facts: () => { thunkCalls += 1; return FACTS; } });
  assert.equal(thunkCalls, 1, 'unknown session: the facts are observed exactly once');
  const doc = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
  assert.equal(doc.format, 1);
  assert.ok(doc.saved_at);
  const row = doc.sessions['sess-1'];
  assert.equal(row.pid, process.pid);
  assert.deepEqual(row.ancestry, FACTS.ancestry);
  assert.equal(row.app, null);
  assert.equal(row.transcript_path, '/tmp/t.jsonl');
  assert.equal(row.workspace, 'ws-abcdef123456');
  assert.ok(row.registered_at && row.last_seen_at);
  assert.ok(!('surface' in row), 'names are resolved at read, never stored');
});

test('the ancestry walk is ONE ps snapshot — pid→1 over injected exec, depth-capped, [] on ps failure', () => {
  const calls = [];
  const exec = {
    run(cmd, args) {
      calls.push([cmd, ...args]);
      return {
        status: 0,
        stdout: '  100  50 /Applications/ChatGPT.app/Contents/Resources/codex\n'
          + '   50   1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n'
          + '    1   0 /sbin/launchd\n',
        stderr: '',
      };
    },
  };
  const chain = processAncestry({ pid: 100, exec, platform: 'darwin' });
  assert.equal(calls.length, 1, 'one snapshot, walked in memory');
  assert.deepEqual(chain.map((r) => r.pid), [100, 50, 1]);
  assert.equal(chain[1].exec, '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT');
  const broken = processAncestry({ pid: 100, exec: { run: () => ({ status: 1, stdout: '', stderr: 'no' }) }, platform: 'darwin' });
  assert.deepEqual(broken, [], 'a ps failure costs the facts, never a throw');
  assert.deepEqual(processAncestry({ pid: 100, exec, platform: 'linux' }), [], 'the walk is a darwin fact');
});

test('nearestAppBundle picks the FOCUSABLE app process — a nested helper bundle is skipped for its host app', () => {
  const cursor = nearestAppBundle([
    { pid: 9, exec: '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper' },
    { pid: 8, exec: '/Applications/Cursor.app/Contents/MacOS/Cursor' },
    { pid: 1, exec: '/sbin/launchd' },
  ]);
  assert.deepEqual(cursor, { bundle: '/Applications/Cursor.app', pid: 8 });
  const chatgpt = nearestAppBundle([
    { pid: 7, exec: '/Applications/ChatGPT.app/Contents/Resources/codex' },
    { pid: 6, exec: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' },
    { pid: 1, exec: '/sbin/launchd' },
  ]);
  assert.deepEqual(chatgpt, { bundle: '/Applications/ChatGPT.app', pid: 6 });
  const daemon = nearestAppBundle([
    { pid: 5, exec: '/usr/local/bin/claude' },
    { pid: 1, exec: '/sbin/launchd' },
  ]);
  assert.equal(daemon, null, 'a background daemon can never be focused — the honest null');
});

test('ensure() with a matching pid BEATS — the thunk never runs, the facts stay, last_seen_at moves', async () => {
  const sessionsPath = scratch();
  const clockValues = ['2026-08-30T01:00:00.000Z', '2026-08-30T02:00:00.000Z'];
  const reg = new SessionRegistry({ sessionsPath, clock: () => clockValues.shift() });
  await ensureRow(reg);
  await ensureRow(reg, { facts: () => { throw new Error('a beat must not pay for a ps walk'); } });
  const row = reg.get('sess-1');
  assert.equal(row.registered_at, '2026-08-30T01:00:00.000Z');
  assert.equal(row.last_seen_at, '2026-08-30T02:00:00.000Z');
  assert.deepEqual(row.ancestry, FACTS.ancestry, 'facts are first-writer owned while the body lives');
});

test('ensure() RE-REGISTERS on a pid change — a resumed harness keeps its birthday and its unknown facts', async () => {
  const sessionsPath = scratch();
  const clockValues = ['2026-08-30T01:00:00.000Z', '2026-08-30T02:00:00.000Z'];
  const reg = new SessionRegistry({ sessionsPath, clock: () => clockValues.shift() });
  const dead = spawnSync('true').pid; // the session's first body, genuinely gone
  await ensureRow(reg, { pid: dead, facts: () => ({ ...FACTS, ancestry: [{ pid: dead, exec: '/usr/local/bin/claude' }] }) });
  // The same session comes back in a new process; this observer knows the walk but not the workspace.
  const fresh = [{ pid: process.pid, exec: '/usr/local/bin/claude' }, { pid: 1, exec: '/sbin/launchd' }];
  await ensureRow(reg, { facts: () => ({ ancestry: fresh, app: null }) });
  const row = reg.get('sess-1');
  assert.equal(row.pid, process.pid, 'the new body owns the row');
  assert.deepEqual(row.ancestry, fresh, 'process facts refresh with the body');
  assert.equal(row.transcript_path, '/tmp/t.jsonl', 'a fact this observer cannot know survives the merge');
  assert.equal(row.workspace, 'ws-abcdef123456', 'so does the workspace');
  assert.equal(row.registered_at, '2026-08-30T01:00:00.000Z', 'first-seen is the session\'s birthday');
  assert.equal(row.last_seen_at, '2026-08-30T02:00:00.000Z');
});

test('ensure()\'s register path sweeps rows whose pid is gone — liveness is read-time, never a stored flag', async () => {
  const sessionsPath = scratch();
  const reg = new SessionRegistry({ sessionsPath });
  // A dead pid: spawn-and-reap a real process so the pid is genuinely gone.
  const dead = spawnSync('true').pid;
  await ensureRow(reg, { sessionId: 'dead-sess', pid: dead });
  await ensureRow(reg); // the next register sweeps the corpse
  const doc = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
  assert.ok(!('dead-sess' in doc.sessions), 'dead rows are swept in the same mutation');
  assert.ok('sess-1' in doc.sessions);
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(dead), false);
});

test('byAncestry finds the session whose pid appears in a chain — nearest ancestor wins; unknown chain is null', async () => {
  const sessionsPath = scratch();
  const reg = new SessionRegistry({ sessionsPath });
  await ensureRow(reg); // row: sess-1, pid = process.pid
  const hit = reg.byAncestry([
    { pid: 999999, exec: 'node' },          // me — nobody's row
    { pid: process.pid, exec: 'claude' },   // my parent — the registered harness
    { pid: 1, exec: '/sbin/launchd' },
  ]);
  assert.equal(hit?.sessionId, 'sess-1', 'the writer identifies its session by its own parent chain');
  assert.equal(hit?.row.pid, process.pid);
  assert.equal(reg.byAncestry([{ pid: 999998, exec: 'zsh' }, { pid: 1, exec: '/sbin/launchd' }]), null,
    'a chain with no registered pid resolves to nothing — never a guess');
});

test('byAncestry breaks a same-pid tie by the FRESHEST row — a resumed session under the same process wins over its predecessor', async () => {
  const sessionsPath = scratch();
  const reg = new SessionRegistry({ sessionsPath });
  await ensureRow(reg, { sessionId: 'sess-old' });
  await new Promise((resolve) => { setTimeout(resolve, 5); }); // distinct last_seen_at instants
  await ensureRow(reg, { sessionId: 'sess-new' });
  const hit = reg.byAncestry([{ pid: process.pid, exec: 'claude' }]);
  assert.equal(hit?.sessionId, 'sess-new',
    'two rows on one pid (resume, rotation) — attribution follows the freshest, never insertion order');
});

test('a malformed sessions file refuses loudly with OATHE_SESSIONS_MALFORMED naming the file', () => {
  const sessionsPath = scratch();
  fs.writeFileSync(sessionsPath, 'not json{');
  assert.throws(() => new SessionRegistry({ sessionsPath }).load(),
    (e) => e instanceof SessionRegistryError && e.code === 'OATHE_SESSIONS_MALFORMED'
      && String(e.message).includes(sessionsPath));
});

test('two concurrent ensure() calls both land — no lost update', async () => {
  const sessionsPath = scratch();
  const reg = new SessionRegistry({ sessionsPath });
  await Promise.all([
    ensureRow(reg, { sessionId: 'a' }),
    ensureRow(reg, { sessionId: 'b' }),
  ]);
  const doc = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
  assert.ok(doc.sessions.a && doc.sessions.b);
});
