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
      ancestry: [{ pid: 200, exec: '/usr/local/bin/cursor-agent' }, { pid: 1, exec: '/sbin/launchd' }],
      app: null, transcriptPath: null, workspace: null,
    }),
  });
  const speaker = resolveSpeaker({
    pid: 300, sessionsPath, platform: 'darwin', clientName: 'cursor',
    exec: psTable(['  300  200 node', '  200    1 /usr/local/bin/cursor-agent', '    1    0 /sbin/launchd']),
  });
  assert.equal(speaker.session?.sessionId, 'sess-C');
  assert.equal(speaker.session?.transcriptPath, null, 'no transcript store is a fact, not a failure');
  assert.equal(speaker.session?.harness, 'cursor');
  assert.equal(speaker.surface, 'cursor');
});
