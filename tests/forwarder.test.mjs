// oathe — the forwarder (connection-lane phase 2): when the daemon answers, `oathe mcp`
// becomes a thin pipe — one hello line naming its pid, cwd, and the resolution-relevant env
// slice, then bytes both ways, verbatim. The speaker stays MEASURED: the daemon walks the
// forwarder's ancestry from the pid; the hello asserts nothing the daemon cannot check.
// No daemon answering → null: the mode is a measured fact, never config, and the caller
// falls back to today's standalone stdio server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { connectDaemon, McpForwarder, resolutionEnvSlice } from '../src/mcp/forwarder.mjs';

function scratchSocket() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-fwd-'));
  return { dir, socketPath: path.join(dir, 'serve.sock') };
}

test('connectDaemon: no socket, or nothing answering, is NULL — standalone is the measured fallback, never an error', async () => {
  const { dir, socketPath } = scratchSocket();
  try {
    assert.equal(await connectDaemon({ socketPath, timeoutMs: 100 }), null, 'absent file');
    fs.writeFileSync(socketPath, '');
    assert.equal(await connectDaemon({ socketPath, timeoutMs: 100 }), null, 'a dead socket file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolutionEnvSlice carries ONLY what the ladder reads: OATHE_* and the harness project-dir vars — never the whole environment', () => {
  const slice = resolutionEnvSlice({
    OATHE_DB: 'scratch', OATHE_HOME: '/sb/.oathe', CLAUDE_PROJECT_DIR: '/proj',
    PATH: '/usr/bin', HOME: '/Users/x', SECRET_TOKEN: 'never',
  });
  assert.equal(slice.OATHE_DB, 'scratch');
  assert.equal(slice.OATHE_HOME, '/sb/.oathe');
  assert.equal(slice.CLAUDE_PROJECT_DIR, '/proj');
  assert.ok(!('PATH' in slice) && !('HOME' in slice) && !('SECRET_TOKEN' in slice),
    'the hello is a resolution fact, not an environment dump');
});

test('the forwarder speaks the hello FIRST, then pipes frames both ways byte-faithfully, and ends with the socket', async () => {
  const { dir, socketPath } = scratchSocket();
  const serverLines = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        serverLines.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
      // the daemon's side of the exchange: answer the first MCP frame, then hang up
      if (serverLines.some((l) => l.id === 1)) {
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })}\n`);
        socket.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const socket = await connectDaemon({ socketPath, timeoutMs: 500 });
    assert.ok(socket, 'the daemon answered');
    const input = new PassThrough();
    const output = new PassThrough();
    const outLines = [];
    output.on('data', (c) => String(c).split('\n').filter(Boolean).forEach((l) => outLines.push(JSON.parse(l))));
    const ended = new Promise((resolve) => output.on('end', resolve));
    new McpForwarder({
      socket, input, output,
      pid: 31337, cwd: '/work/here', env: { OATHE_DB: 'scratch', PATH: '/usr/bin' },
    }).start();
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (outLines.some((l) => l.id === 1)) return resolve();
        if (Date.now() - started > 2000) return reject(new Error(`no answer; server saw ${JSON.stringify(serverLines)}`));
        return setTimeout(poll, 5);
      };
      poll();
    });
    assert.deepEqual(serverLines[0], { oathe: 'hello', pid: 31337, cwd: '/work/here', env: { OATHE_DB: 'scratch' } },
      'the hello leads, with the pid the daemon will MEASURE and the env slice the ladder reads');
    assert.deepEqual(serverLines[1], { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 'frames ride verbatim');
    assert.deepEqual(outLines[0], { jsonrpc: '2.0', id: 1, result: { ok: true } }, 'answers ride verbatim');
    await ended; // the daemon hanging up ends the forwarder's output — the harness sees its server die and respawns
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probeDaemon: a socket that ACCEPTS but never speaks MCP is NOT an answering daemon — the initialize answer is the proof', async () => {
  // The verifier's catch (2026-09-04): a bare connect proves a listener, not a server.
  // Doctor must never report ok over a wedged process squatting the socket.
  const { probeDaemon } = await import('../src/mcp/forwarder.mjs');
  const { dir, socketPath } = scratchSocket();
  const mute = net.createServer(() => { /* accepts, says nothing */ });
  await new Promise((resolve) => mute.listen(socketPath, resolve));
  try {
    const out = await probeDaemon({ socketPath, timeoutMs: 200 });
    assert.deepEqual(out, { answering: false, server: null }, 'accepting is not answering');
  } finally {
    mute.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probeDaemon: a real MCP answer names the server — doctor reports WHO answered, not just that something did', async () => {
  const { probeDaemon } = await import('../src/mcp/forwarder.mjs');
  const { dir, socketPath } = scratchSocket();
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      if (buffer.includes('"initialize"')) {
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(buffer.split('\n').find((l) => l.includes('initialize'))).id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'oathe-tools', version: '9.9.9' } } })}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const out = await probeDaemon({ socketPath, timeoutMs: 1000 });
    assert.deepEqual(out, { answering: true, server: { name: 'oathe-tools', version: '9.9.9' } });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probeDaemon: nothing listening is answering false, never an error', async () => {
  const { probeDaemon } = await import('../src/mcp/forwarder.mjs');
  const { dir, socketPath } = scratchSocket();
  try {
    assert.deepEqual(await probeDaemon({ socketPath, timeoutMs: 100 }), { answering: false, server: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
