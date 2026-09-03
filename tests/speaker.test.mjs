import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveSpeaker } from '../src/speaker.mjs';
import { SessionRegistry } from '../src/sessions.mjs';

const scratch = () => path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-speaker-'))), 'sessions.json');

/** A ps table the walk reads: me (node) under a harness under an app under launchd. */
const psTable = (rows) => ({ run: () => ({ status: 0, stdout: rows.join('\n') + '\n', stderr: '' }) });

test('a writer with a REGISTERED harness parent resolves its full speaker — surface, app, session', async () => {
  const sessionsPath = scratch();
  await new SessionRegistry({ sessionsPath }).ensure({
    sessionId: 'sess-A', pid: 200,
    facts: () => ({
      ancestry: [{ pid: 200, exec: '/usr/local/bin/claude' }, { pid: 1, exec: '/sbin/launchd' }],
      app: { bundle: '/Applications/iTerm.app', pid: 100 },
      transcriptPath: `${os.homedir()}/.claude/projects/x/t.jsonl`,
      workspace: 'ws-abcdef123456',
    }),
    // this test's pid 200 must read alive for the row to survive ensure's sweep
  });
  const speaker = resolveSpeaker({
    pid: 300, sessionsPath, platform: 'darwin',
    exec: psTable([
      '  300  200 /usr/local/bin/node',
      '  200  100 /usr/local/bin/claude',
      '  100    1 /Applications/iTerm.app/Contents/MacOS/iTerm2',
      '    1    0 /sbin/launchd',
    ]),
  });
  assert.equal(speaker.session?.sessionId, 'sess-A', 'my parent chain names my session');
  assert.equal(speaker.session?.harness, 'claude');
  assert.ok(speaker.session?.transcriptPath.endsWith('t.jsonl'));
  assert.equal(speaker.surface, 'claude');
  assert.deepEqual(speaker.app, { bundle: '/Applications/iTerm.app', pid: 100 });
});

test('a REGISTERED session whose reported transcript the harness never wrote (a resume rotated the id) resolves to the file that carries its rows', async () => {
  const sessionsPath = scratch();
  const projectDir = path.join(path.dirname(sessionsPath), '.claude', 'projects', 'x');
  fs.mkdirSync(projectDir, { recursive: true });
  const original = path.join(projectDir, '11111111-2222-3333-4444-555555555555.jsonl');
  fs.writeFileSync(original, JSON.stringify({
    type: 'user', uuid: 'u1', sessionId: '11111111-2222-3333-4444-555555555555', session_id: 'sess-B',
    message: { role: 'user', content: 'resumed here' },
  }));
  await new SessionRegistry({ sessionsPath }).ensure({
    sessionId: 'sess-B', pid: 200,
    facts: () => ({
      ancestry: [{ pid: 200, exec: '/usr/local/bin/claude' }, { pid: 1, exec: '/sbin/launchd' }],
      app: { bundle: '/Applications/iTerm.app', pid: 100 },
      transcriptPath: path.join(projectDir, 'sess-B.jsonl'), // what the hook was told — never written
      workspace: 'ws-abcdef123456',
    }),
  });
  const speaker = resolveSpeaker({
    pid: 300, sessionsPath, platform: 'darwin',
    exec: psTable([
      '  300  200 /usr/local/bin/node',
      '  200  100 /usr/local/bin/claude',
      '  100    1 /Applications/iTerm.app/Contents/MacOS/iTerm2',
      '    1    0 /sbin/launchd',
    ]),
  });
  assert.equal(speaker.session?.sessionId, 'sess-B');
  assert.equal(speaker.session?.transcriptPath, original, 'the act links the file the session actually writes');
});

test('ChatGPT-embedded codex with NO session row: surface chatgpt + the app — session honestly null', () => {
  const speaker = resolveSpeaker({
    pid: 300, sessionsPath: scratch(), platform: 'darwin', clientName: 'codex',
    exec: psTable([
      '  300  200 /Users/x/.nvm/versions/node/v22.3.0/bin/node',
      '  200  100 /Applications/ChatGPT.app/Contents/Resources/codex',
      '  100    1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
      '    1    0 /sbin/launchd',
    ]),
  });
  assert.equal(speaker.surface, 'chatgpt', 'the ancestry outranks the client\'s self-declared name');
  assert.deepEqual(speaker.app, { bundle: '/Applications/ChatGPT.app', pid: 100 });
  assert.equal(speaker.session, null, 'no registry row — never a guessed session');
});

test('a blind walk (ps failure) falls to the client\'s word — the observable-truth shape, no throw', () => {
  const speaker = resolveSpeaker({
    pid: 300, sessionsPath: scratch(), platform: 'darwin', clientName: 'codex',
    exec: { run: () => ({ status: 1, stdout: '', stderr: 'no ps' }) },
  });
  assert.equal(speaker.surface, 'codex');
  assert.equal(speaker.app, null);
  assert.equal(speaker.session, null);
});

test('a cursor session with a null transcript still resolves — harness from the process, transcript null', async () => {
  const sessionsPath = scratch();
  await new SessionRegistry({ sessionsPath }).ensure({
    sessionId: 'sess-C', pid: 200,
    facts: () => ({
      ancestry: [{ pid: 200, exec: '/usr/local/bin/agent' }, { pid: 1, exec: '/sbin/launchd' }],
      app: null, transcriptPath: null, workspace: null,
    }),
  });
  const speaker = resolveSpeaker({
    pid: 300, sessionsPath, platform: 'darwin', clientName: 'cursor',
    exec: psTable(['  300  200 node', '  200    1 /usr/local/bin/agent', '    1    0 /sbin/launchd']),
  });
  assert.equal(speaker.session?.sessionId, 'sess-C');
  assert.equal(speaker.session?.transcriptPath, null, 'no transcript store is a fact, not a failure');
  assert.equal(speaker.session?.harness, 'cursor');
  assert.equal(speaker.surface, 'cursor');
});

test("the session is a per-act fact: a /clear registers a new id under the same process, and the SAME speaker answers it — the ancestry walk ran once", async () => {
  // The MCP server resolves its speaker once, at context build, and the context rebuilds only
  // on config changes — so a session that outlived a /clear kept stamping its first id (found
  // by the 0.4.1 final review on its own first claim). The walk is a fact of the process; the
  // session is a fact of the moment: looked up in the registry every time it is read.
  const sessionsPath = scratch();
  const dir = path.dirname(sessionsPath);
  const tA = path.join(dir, 'A.jsonl'); fs.writeFileSync(tA, '');
  const tB = path.join(dir, 'B.jsonl'); fs.writeFileSync(tB, '');
  const facts = (transcriptPath) => () => ({
    ancestry: [{ pid: 200, exec: '/usr/local/bin/claude' }, { pid: 1, exec: '/sbin/launchd' }],
    app: { bundle: '/Applications/iTerm.app', pid: 100 }, transcriptPath, workspace: 'ws-abcdef123456',
  });
  let t = 0;
  const registry = new SessionRegistry({ sessionsPath, clock: () => new Date(1_800_000_000_000 + (t++) * 1000).toISOString() });
  await registry.ensure({ sessionId: 'sess-A', pid: 200, facts: facts(tA) });
  let psRuns = 0;
  const counting = { run: (...a) => { psRuns++; return psTable([
    '  300  200 /usr/local/bin/node', '  200  100 /usr/local/bin/claude',
    '  100    1 /Applications/iTerm.app/Contents/MacOS/iTerm2', '    1    0 /sbin/launchd',
  ]).run(...a); } };
  const speaker = resolveSpeaker({ pid: 300, sessionsPath, platform: 'darwin', exec: counting });
  assert.equal(speaker.session?.sessionId, 'sess-A');
  await registry.ensure({ sessionId: 'sess-B', pid: 200, facts: facts(tB) }); // the /clear SessionStart hook
  assert.equal(speaker.session?.sessionId, 'sess-B', 'the same speaker object speaks as the id registered last');
  assert.ok(speaker.session?.transcriptPath.endsWith('B.jsonl'), 'and links the new transcript');
  assert.equal(speaker.surface, 'claude');
  assert.equal(psRuns, 1, 'the ancestry walk is a fact of the process — never re-walked per act');
});
