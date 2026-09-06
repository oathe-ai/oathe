// oathe — the forwarder (connection-lane phase 2): the session side of the daemon seam.
// `oathe mcp` stays the per-session child every harness spawns (its process ancestry is the
// speaker's measurable identity — the deepest fact the stdio design got right), but when the
// device daemon answers on its socket the child becomes a THIN PIPE: one hello line naming
// its pid, cwd, and the resolution-relevant env slice, then bytes both ways, verbatim. The
// daemon walks the hello's pid on this machine (src/speaker.mjs); the pid itself is this
// process's word, held inside the same-OS-user boundary the 0600 socket draws — the walk is
// measured, the starting point is trusted with the socket. No daemon answering → null:
// the mode is a measured fact, never config, and the caller runs today's standalone server.

import fs from 'node:fs';
import net from 'node:net';

import { projectDirEnvVars } from '../harnesses/catalog.mjs';

/**
 * The env the workspace-resolution ladder and the tools actually read: OATHE_* and each
 * harness's project-dir variable — never the whole environment (the hello is a resolution
 * fact, not an environment dump).
 */
export function resolutionEnvSlice(env) {
  const ladder = new Set(projectDirEnvVars().map(([, envVar]) => envVar));
  return Object.fromEntries(Object.entries(env)
    .filter(([k, v]) => v !== undefined && (k.startsWith('OATHE_') || ladder.has(k))));
}

/**
 * One connect attempt inside the budget. NULL means "no daemon" — an absent file, a stale
 * socket nobody serves, a refused connect: all the same measured fact, never an error.
 * @returns {Promise<net.Socket|null>}
 */
export function connectDaemon({ socketPath, timeoutMs }) {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) return resolve(null);
    const socket = net.connect(socketPath);
    const timer = setTimeout(() => { socket.destroy(); resolve(null); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', () => { clearTimeout(timer); socket.destroy(); resolve(null); });
    return undefined;
  });
}

/**
 * The doctor's probe: a bare connect proves a LISTENER, not a server (the verifier's catch,
 * 2026-09-04 — a wedged process squatting the socket must never read as ok). The proof is a
 * real MCP initialize answered inside the budget, and the report names WHO answered.
 * @returns {Promise<{answering: boolean, server: {name: string, version: string}|null}>}
 */
export async function probeDaemon({ socketPath, timeoutMs }) {
  const socket = await connectDaemon({ socketPath, timeoutMs });
  if (!socket) return { answering: false, server: null };
  return new Promise((resolve) => {
    let buffer = '';
    const done = (out) => { socket.destroy(); resolve(out); };
    const timer = setTimeout(() => done({ answering: false, server: null }), timeoutMs);
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 'oathe-doctor-probe' && msg.result?.serverInfo?.name) {
          clearTimeout(timer);
          return done({ answering: true, server: { name: msg.result.serverInfo.name, version: msg.result.serverInfo.version } });
        }
      }
      return undefined;
    });
    socket.on('error', () => { clearTimeout(timer); done({ answering: false, server: null }); });
    socket.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 'oathe-doctor-probe', method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'oathe-doctor', version: '0' } },
    })}\n`);
  });
}

export class McpForwarder {
  /** @param {{socket: net.Socket, input: NodeJS.ReadableStream, output: NodeJS.WritableStream,
   *           env: NodeJS.ProcessEnv, cwd: string, pid: number}} o */
  constructor({ socket, input, output, env, cwd, pid }) {
    this.socket = socket;
    this.input = input;
    this.output = output;
    this.hello = { oathe: 'hello', pid, cwd, env: resolutionEnvSlice(env) };
  }

  start() {
    this.socket.write(`${JSON.stringify(this.hello)}\n`);
    this.input.pipe(this.socket);
    // The daemon hanging up (an upgrade's restart) ends this pipe: the harness sees its
    // server die and respawns a fresh forwarder against the new daemon — never a half-alive
    // session on stale state.
    this.socket.pipe(this.output);
    return this;
  }
}
