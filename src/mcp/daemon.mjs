// oathe — the serve daemon (connection-lane phase 2): the device's one oathe presence. It
// listens on a 0600 unix socket under the oathe home (fs perms ARE the auth — no port, no
// per-user collision; ports return at the cloud seam) and serves each forwarder connection
// with the SAME McpConnection the stdio server runs — a socket is a duplex stream, so there
// is one connection implementation and two transports, by construction. Per connection: the
// hello's env slice overlays the daemon's env, its cwd seeds the resolution ladder, and its
// pid seeds the SPEAKER: the daemon walks THAT pid's ancestry on this machine. The walk is
// measured; the starting pid is the forwarder's own word, accepted because only this OS user
// can reach the 0600 socket — no peer credential (SO_PEERCRED/getpeereid) is read. A hello
// with no usable pid, or none at all, is served with NOTHING walked (speakerPid null) and its
// claims are refused at the gate — never resolved from this daemon's own ancestry (ruling
// 2026-09-04). launchd owns this process's liveness (src/serve.mjs
// wires the agent through the shared launchd machinery); a replaced install restarts it,
// and every forwarder's pipe ends with it — sessions respawn against the new daemon.

import fs from 'node:fs';
import net from 'node:net';
import readline from 'node:readline';

import { McpConnection, defaultToolContextFactory } from './connection.mjs';
import { connectDaemon } from './forwarder.mjs';

export class OatheServeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class OatheDaemon {
  /**
   * @param {{env: NodeJS.ProcessEnv, socketPath: string, err?: {write: Function},
   *          toolContextFactory?: (o: {env: object, speakerPid: number|null}) => Function,
   *          onHello?: (hello: object) => void}} o
   *   toolContextFactory — the per-connection factory builder; the default is the production
   *   one (real substrate). onHello is a test seam.
   */
  constructor({ env, socketPath, err = process.stderr, toolContextFactory = defaultToolContextFactory, onHello = null }) {
    this.env = env;
    this.socketPath = socketPath;
    this.err = err;
    this.toolContextFactory = toolContextFactory;
    this.onHello = onHello;
    this.server = null;
    this.connections = new Set();
    this.sockets = new Set();
  }

  async start() {
    // One daemon per socket: a LIVE daemon is a typed refusal, a stale file (nothing
    // answering) is replaced — the crash/kill leftover must never brick the restart.
    const alive = await connectDaemon({ socketPath: this.socketPath, timeoutMs: 500 });
    if (alive) {
      alive.destroy();
      throw new OatheServeError('OATHE_SERVE_RUNNING',
        `a daemon is already serving on ${this.socketPath} — two would race the socket; stop it (launchctl, or oathe uninstall) before starting another`);
    }
    fs.rmSync(this.socketPath, { force: true });
    this.server = net.createServer((socket) => this.#serve(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', (e) => reject(new OatheServeError('OATHE_SERVE_LISTEN',
        `cannot listen on ${this.socketPath}: ${String(e?.message || e)}`)));
      this.server.listen(this.socketPath, resolve);
    });
    fs.chmodSync(this.socketPath, 0o600); // this user's alone — the socket's perms are the auth
    return this;
  }

  #serve(socket) {
    this.sockets.add(socket);
    const rl = readline.createInterface({ input: socket });
    let connection = null;
    rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      let msg;
      try { msg = JSON.parse(s); } catch { return; }
      if (connection === null) {
        const hello = msg?.oathe === 'hello' ? msg : null;
        if (hello) this.onHello?.(hello);
        connection = this.#connectionFor({ hello, socket });
        this.connections.add(connection);
        if (hello) return; // the hello is the binding, not a frame
      }
      void connection.handleMessage(msg);
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (connection) {
        this.connections.delete(connection);
        void connection.close();
      }
    });
  }

  #connectionFor({ hello, socket }) {
    // The hello's slice OVERLAYS the daemon's env — same-user trust boundary (the socket is
    // 0600), and exactly what the stdio server saw when it inherited the session's env.
    const env = { ...this.env, ...(hello?.env ?? {}) };
    return new McpConnection({
      env,
      input: socket,
      output: socket,
      err: this.err,
      ...(hello?.cwd ? { cwd: () => hello.cwd } : {}),
      // The forwarder's own pid, walked by the daemon — or NULL when no hello named a usable
      // one: nothing to walk, and never this daemon's own ancestry (ruling 2026-09-04).
      toolContextFactory: this.toolContextFactory({ env, speakerPid: Number.isInteger(hello?.pid) && hello.pid > 0 ? hello.pid : null }),
    });
    // NOTE: start() is never called — the daemon owns the socket's line loop (#serve); the
    // connection only ever sees parsed frames through handleMessage.
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    await Promise.all([...this.connections].map((c) => c.close()));
    this.connections.clear();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    fs.rmSync(this.socketPath, { force: true }); // the address does not outlive the daemon
  }
}
