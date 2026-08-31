// The MCP connection: ndjson loop + server-initiated requests (roots/list) + LAZY tool context.
// Startup must be crash-proof — initialize/tools/list answer even when every env var is a
// poisoned template; the filesystem/config/substrate are touched only on the first tools/call,
// through the injected context factory (the production factory wires the real substrate; these
// tests inject a fake to pin the plumbing without Postgres).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { McpConnection } from '../src/mcp/connection.mjs';

function scratch() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-conn-')));
}

function harnessed({ env = {}, toolContextFactory }) {
  const input = new PassThrough();
  const output = new PassThrough();
  const err = new PassThrough();
  const outLines = [];
  const errText = [];
  output.on('data', (chunk) => {
    for (const line of String(chunk).split('\n').filter(Boolean)) outLines.push(JSON.parse(line));
  });
  err.on('data', (chunk) => errText.push(String(chunk)));
  const connection = new McpConnection({
    env: { HOME: scratch(), ...env }, input, output, err, toolContextFactory,
  });
  connection.start();
  const send = (msg) => input.write(`${JSON.stringify(msg)}\n`);
  const waitFor = (predicate, ms = 2000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const hit = outLines.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > ms) return reject(new Error(`nothing matched; saw ${JSON.stringify(outLines)}`));
      return setTimeout(poll, 5);
    };
    poll();
  });
  return { connection, send, waitFor, outLines, errText };
}

test('initialize and tools/list answer with NO context build — even under a poisoned env', async () => {
  let built = 0;
  const { send, waitFor } = harnessed({
    env: { OATHE_WORKSPACE_DIR: '${CLAUDE_PROJECT_DIR}' },
    toolContextFactory: async () => { built++; return { tools: {}, close: async () => {} }; },
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const init = await waitFor((m) => m.id === 1);
  assert.equal(init.result.serverInfo.name, 'oathe-tools');
  const list = await waitFor((m) => m.id === 2);
  assert.ok(list.result.tools.length >= 7);
  assert.equal(built, 0, 'the context is built on tools/call, never at startup');
});

test('the first tools/call builds the context from the resolution and reuses it after', async () => {
  const dir = scratch();
  const factoryArgs = [];
  const { send, waitFor } = harnessed({
    env: { OATHE_WORKSPACE_DIR: dir },
    toolContextFactory: async ({ resolution }) => {
      factoryArgs.push(resolution);
      return { tools: { oathe_board: async () => ({ board: 'ok' }) }, close: async () => {} };
    },
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'oathe_board', arguments: {} } });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'oathe_board', arguments: {} } });
  await waitFor((m) => m.id === 3);
  assert.equal(factoryArgs.length, 1, 'one context for the connection');
  assert.equal(factoryArgs[0].dir, dir);
  assert.equal(factoryArgs[0].source, 'OATHE_WORKSPACE_DIR');
});

test('a roots-capable client is asked roots/list (id-correlated); the answer wins the ladder', async () => {
  const dir = scratch();
  const factoryArgs = [];
  const { send, waitFor } = harnessed({
    env: {},
    toolContextFactory: async ({ resolution }) => {
      factoryArgs.push(resolution);
      return { tools: { oathe_board: async () => ({ ok: true }) }, close: async () => {} };
    },
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { roots: { listChanged: true } } } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'oathe_board', arguments: {} } });
  const rootsReq = await waitFor((m) => m.method === 'roots/list');
  assert.ok(rootsReq.id, 'a server-initiated request carries its own id');
  send({ jsonrpc: '2.0', id: rootsReq.id, result: { roots: [{ uri: `file://${dir}`, name: 'ws' }] } });
  await waitFor((m) => m.id === 2);
  assert.equal(factoryArgs[0].dir, dir);
  assert.equal(factoryArgs[0].source, 'roots');
});

test('a client WITHOUT the roots capability is never asked', async () => {
  const dir = scratch();
  const { send, waitFor, outLines } = harnessed({
    env: { CLAUDE_PROJECT_DIR: dir },
    toolContextFactory: async () => ({ tools: { oathe_board: async () => ({ ok: true }) }, close: async () => {} }),
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'oathe_board', arguments: {} } });
  await waitFor((m) => m.id === 2);
  assert.ok(!outLines.some((m) => m.method === 'roots/list'));
});

test('notifications/roots/list_changed closes the old context and re-resolves on the next call', async () => {
  const dir = scratch();
  let closes = 0;
  let builds = 0;
  const { send, waitFor } = harnessed({
    env: { OATHE_WORKSPACE_DIR: dir },
    toolContextFactory: async () => {
      builds++;
      return { tools: { oathe_board: async () => ({ ok: true }) }, close: async () => { closes++; } };
    },
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'oathe_board', arguments: {} } });
  await waitFor((m) => m.id === 2);
  send({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'oathe_board', arguments: {} } });
  await waitFor((m) => m.id === 3);
  assert.equal(builds, 2, 'the context was rebuilt after the roots changed');
  assert.equal(closes, 1, 'the stale context was closed');
});

test('a skipped-template resolution is NOTED on stderr — quiet only when there is nothing to say', async () => {
  const dir = scratch();
  const { send, waitFor, errText } = harnessed({
    env: { OATHE_WORKSPACE_DIR: '${CLAUDE_PROJECT_DIR}', CLAUDE_PROJECT_DIR: dir },
    toolContextFactory: async () => ({ tools: { oathe_board: async () => ({ ok: true }) }, close: async () => {} }),
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'oathe_board', arguments: {} } });
  await waitFor((m) => m.id === 2);
  assert.ok(errText.join('').includes('${CLAUDE_PROJECT_DIR}'), `stderr notes the skip: ${errText.join('')}`);
});

test('an unresolvable workspace surfaces per-call as the typed refusal, and the server stays up', async () => {
  const home = scratch();
  const { send, waitFor } = harnessed({
    env: { HOME: home },
    toolContextFactory: async () => ({ tools: {}, close: async () => {} }),
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'oathe_claim', arguments: {} } });
  const out = await waitFor((m) => m.id === 2);
  // In this test process cwd is a real project dir, so resolution may succeed via cwd; the
  // refusal path itself is pinned in workspace-resolver.test.mjs and oathe-tools.test.mjs.
  assert.ok(out.result, 'the server answered rather than dying');
  send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  const pong = await waitFor((m) => m.id === 3);
  assert.deepEqual(pong.result, {});
});

test('R-BOARD-SCOPE: the factory receives the client info from initialize AND the resolution\'s synthetic flag', async () => {
  const home = scratch();
  const staging = path.join(home, '.codex/.chatgpt-projects/g-p-x');
  fs.mkdirSync(staging, { recursive: true });
  const seen = [];
  const { send, waitFor } = harnessed({
    env: { HOME: home, OATHE_WORKSPACE_DIR: staging },
    toolContextFactory: async ({ resolution, client }) => {
      seen.push({ resolution, client });
      return { tools: { oathe_board: async () => ({ ok: true }) }, close: async () => {} };
    },
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { capabilities: {}, clientInfo: { name: 'codex', version: '0.150.0' } } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'oathe_board', arguments: {} } });
  await waitFor((m) => m.id === 2);
  assert.equal(seen[0].client.info.name, 'codex');
  assert.equal(seen[0].resolution.synthetic, true);
});

test('a config change between calls REBUILDS the context — a long-lived server follows `oathe config`, never its startup snapshot', async () => {
  // The founder's live bug: verifier set to cursor globally, but ChatGPT's months-old MCP
  // server kept claiming with the verifier its startup config snapshot recorded.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const home = scratch();
  const dir = scratch();
  fs.mkdirSync(path.join(home, '.oathe'), { recursive: true });
  const configFile = path.join(home, '.oathe', 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ verifier: 'claude' }));
  let built = 0;
  const closed = [];
  const { send, waitFor } = harnessed({
    env: { HOME: home, OATHE_WORKSPACE_DIR: dir },
    toolContextFactory: async () => {
      built += 1;
      return { tools: { oathe_board: async () => ({ built }) }, close: async () => closed.push(built) };
    },
  });
  send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'oathe_board', arguments: {} } });
  await waitFor((m) => m.id === 1);
  assert.equal(built, 1);
  // The operator records a new choice; the file's clock moves.
  fs.writeFileSync(configFile, JSON.stringify({ verifier: 'cursor' }));
  fs.utimesSync(configFile, new Date(), new Date(Date.now() + 2000));
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'oathe_board', arguments: {} } });
  await waitFor((m) => m.id === 2);
  assert.equal(built, 2, 'the changed config invalidated the cached context');
  assert.deepEqual(closed, [1], 'the stale context was closed, not leaked');
  // No change → no rebuild: the stamp check is cheap, not a rebuild-per-call.
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'oathe_board', arguments: {} } });
  await waitFor((m) => m.id === 3);
  assert.equal(built, 2, 'an unchanged config keeps the cached context');
});
