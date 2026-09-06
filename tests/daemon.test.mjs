// oathe — the serve daemon (connection-lane phase 2): ONE process per device holding the
// substrate connections, serving MCP over a 0600 unix socket under the oathe home. Sessions
// reach it through the forwarder (`oathe mcp`), which speaks a one-line hello naming its
// pid/cwd/env-slice — and the daemon MEASURES the speaker from that pid's ancestry; identity
// is never client-asserted. A socket is a duplex stream, so the connection class is the same
// McpConnection the stdio server runs — one implementation, two transports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { OatheDaemon, OatheServeError } from '../src/mcp/daemon.mjs';

function scratchSocket() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-daemon-'));
  return { dir, socketPath: path.join(dir, 'serve.sock') };
}

/** A line-speaking client for one test exchange. */
function client(socketPath) {
  const socket = net.connect(socketPath);
  const lines = [];
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += String(chunk);
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) lines.push(JSON.parse(line));
    }
  });
  const send = (obj) => socket.write(`${JSON.stringify(obj)}\n`);
  const waitFor = (predicate, ms = 2000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const hit = lines.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > ms) return reject(new Error(`nothing matched; saw ${JSON.stringify(lines)}`));
      return setTimeout(poll, 5);
    };
    poll();
  });
  return { socket, send, waitFor, lines };
}

test('the daemon listens on a 0600 socket, reads the hello, and the SAME McpConnection answers initialize over it', async () => {
  const { dir, socketPath } = scratchSocket();
  const hellos = [];
  const daemon = new OatheDaemon({
    env: { HOME: dir }, socketPath, err: { write: () => {} },
    toolContextFactory: () => async () => ({ tools: {}, close: async () => {} }),
    onHello: (h) => hellos.push(h),
  });
  try {
    await daemon.start();
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600, 'the socket is this user\'s alone — fs perms are the auth');
    const c = client(socketPath);
    c.send({ oathe: 'hello', pid: 4242, cwd: '/somewhere', env: { OATHE_DB: 'x' } });
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
    const init = await c.waitFor((m) => m.id === 1);
    assert.equal(init.result.serverInfo.name, 'oathe-tools');
    assert.deepEqual(hellos.map((h) => [h.pid, h.cwd]), [[4242, '/somewhere']], 'the hello reached the binding');
    // The doctor's probe against a LIVE daemon: the initialize answer, named — the other
    // half of the accepting-is-not-answering pin (the mute case lives in forwarder.test).
    const { probeDaemon } = await import('../src/mcp/forwarder.mjs');
    const probe = await probeDaemon({ socketPath, timeoutMs: 1000 });
    assert.equal(probe.answering, true);
    assert.equal(probe.server.name, 'oathe-tools', 'the probe reports WHO answered');
    c.socket.destroy();
  } finally {
    await daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a client with NO hello is served too — the first frame is simply the first message — but its speaker pid is NULL: the daemon never resolves a session from its own pid (ruling 2026-09-04)', async () => {
  const { dir, socketPath } = scratchSocket();
  const pids = [];
  const daemon = new OatheDaemon({
    env: { HOME: dir }, socketPath, err: { write: () => {} },
    toolContextFactory: ({ speakerPid }) => { pids.push(speakerPid); return async () => ({ tools: {}, close: async () => {} }); },
  });
  try {
    await daemon.start();
    const c = client(socketPath);
    c.send({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { capabilities: {} } });
    const init = await c.waitFor((m) => m.id === 7);
    assert.equal(init.result.serverInfo.name, 'oathe-tools');
    const bad = client(socketPath);
    bad.send({ oathe: 'hello', pid: 'not-a-pid', cwd: dir, env: {} });
    bad.send({ jsonrpc: '2.0', id: 8, method: 'initialize', params: { capabilities: {} } });
    await bad.waitFor((m) => m.id === 8);
    assert.deepEqual(pids, [null, null], 'no hello, or a hello with no usable pid → nothing to walk: null, never undefined (which would mean "this process")');
    c.socket.destroy(); bad.socket.destroy();
  } finally {
    await daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two sessions are TWO connections: each hello binds its own context (cwd and env never bleed)', async () => {
  const { dir, socketPath } = scratchSocket();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const built = [];
  const daemon = new OatheDaemon({
    env: { HOME: dir, OATHE_DB: 'daemon-default' }, socketPath, err: { write: () => {} },
    toolContextFactory: ({ env, speakerPid }) => async () => {
      built.push({ db: env.OATHE_DB, pid: speakerPid });
      return { tools: { oathe_board: async () => ({ db: env.OATHE_DB }) }, close: async () => {} };
    },
  });
  try {
    await daemon.start();
    const a = client(socketPath);
    const b = client(socketPath);
    a.send({ oathe: 'hello', pid: 111, cwd: proj, env: { OATHE_DB: 'session-a' } });
    b.send({ oathe: 'hello', pid: 222, cwd: proj, env: {} });
    a.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'oathe_board', arguments: {} } });
    b.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'oathe_board', arguments: {} } });
    await a.waitFor((m) => m.id === 1);
    await b.waitFor((m) => m.id === 2);
    assert.deepEqual(built.sort((x, y) => x.pid - y.pid),
      [{ db: 'session-a', pid: 111 }, { db: 'daemon-default', pid: 222 }],
      'the hello\'s env overlays the daemon\'s; the speaker pid is the FORWARDER\'S, per connection');
    a.socket.destroy(); b.socket.destroy();
  } finally {
    await daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a STALE socket file (nothing listening) is replaced; a LIVE daemon is a typed refusal', async () => {
  const { dir, socketPath } = scratchSocket();
  fs.writeFileSync(socketPath, ''); // a plain file where a socket once was
  const daemon = new OatheDaemon({
    env: { HOME: dir }, socketPath, err: { write: () => {} },
    toolContextFactory: () => async () => ({ tools: {}, close: async () => {} }),
  });
  try {
    await daemon.start();
    const second = new OatheDaemon({
      env: { HOME: dir }, socketPath, err: { write: () => {} },
      toolContextFactory: () => async () => ({ tools: {}, close: async () => {} }),
    });
    await assert.rejects(second.start(), (e) => {
      assert.ok(e instanceof OatheServeError);
      assert.equal(e.code, 'OATHE_SERVE_RUNNING');
      return true;
    }, 'two daemons on one socket is a refusal, never a silent steal');
  } finally {
    await daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('close() ends every live connection (contexts closed — no leaked pg clients) and removes the socket', async () => {
  const { dir, socketPath } = scratchSocket();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  let closed = 0;
  const daemon = new OatheDaemon({
    env: { HOME: dir }, socketPath, err: { write: () => {} },
    toolContextFactory: () => async () => ({ tools: { oathe_board: async () => ({}) }, close: async () => { closed += 1; } }),
  });
  try {
    await daemon.start();
    const c = client(socketPath);
    c.send({ oathe: 'hello', pid: 1, cwd: proj, env: {} });
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'oathe_board', arguments: {} } });
    await c.waitFor((m) => m.id === 1);
    await daemon.close();
    assert.equal(closed, 1, 'the connection\'s context went with the daemon');
    assert.ok(!fs.existsSync(socketPath), 'the address does not outlive the daemon');
    c.socket.destroy();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('`oathe mcp` FORWARDS when the daemon answers — the hello carries the child\'s OWN pid (the identity the daemon measures), and initialize rides through', async () => {
  const { dir, socketPath } = scratchSocket();
  const hellos = [];
  const daemon = new OatheDaemon({
    env: { HOME: dir }, socketPath, err: { write: () => {} },
    toolContextFactory: () => async () => ({ tools: {}, close: async () => {} }),
    onHello: (h) => hellos.push(h),
  });
  try {
    await daemon.start();
    const { spawn } = await import('node:child_process');
    const bin = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'oathe.mjs');
    const child = spawn(process.execPath, [bin, 'mcp'], {
      env: { ...process.env, HOME: dir, OATHE_HOME: path.join(dir, '.oathe'), OATHE_SERVE_SOCKET: socketPath },
    });
    try {
      await run(child);
    } finally {
      child.kill('SIGKILL');
    }
  } finally {
    await daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  async function run(child) {
    const outLines = [];
    let buffer = '';
    child.stdout.on('data', (c) => {
      buffer += String(c);
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) outLines.push(JSON.parse(line));
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } })}\n`);
    const init = await new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        const hit = outLines.find((m) => m.id === 1);
        if (hit) return resolve(hit);
        if (Date.now() - started > 5000) return reject(new Error(`no answer through the daemon; saw ${JSON.stringify(outLines)}`));
        return setTimeout(poll, 10);
      };
      poll();
    });
    assert.equal(init.result.serverInfo.name, 'oathe-tools', 'the DAEMON answered — one server, this session piped');
    assert.equal(hellos[0]?.pid, child.pid, 'the hello names the forwarder process — the pid whose ancestry IS the speaker');
  }
});
