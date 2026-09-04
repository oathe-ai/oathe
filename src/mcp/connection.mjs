// oathe — the MCP connection: the ndjson JSON-RPC loop, server-initiated requests
// (roots/list, id-correlated), and the LAZY tool context. Startup is crash-proof by
// construction: nothing beyond the transport is built until the first tools/call, so a
// poisoned environment (an unexpanded ${...} template, an empty allowlisted env) can never
// kill the server before it answers initialize — it surfaces per call, typed, through the
// resolution ladder instead.

import fs from 'node:fs';
import readline from 'node:readline';

import { dispatch, lazyTools } from './oathe-tools.mjs';
import { OatheConfig } from '../config.mjs';
import { WorkspaceResolver } from '../workspace-resolver.mjs';
import { harnessForClient } from '../harnesses/catalog.mjs';
import { resolveSpeaker } from '../speaker.mjs';
import { buildPaths, homeOf } from '../paths.mjs';
import { packageVersion } from '../context.mjs';

export class McpConnection {
  /**
   * @param {{env?: NodeJS.ProcessEnv, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream,
   *          err?: NodeJS.WritableStream, toolContextFactory?: (o: {resolution: object, client: object}) =>
   *          Promise<{tools: object, close: () => Promise<void>}>, cwd?: () => string, home?: string}} o
   */
  constructor({
    env = process.env, input = process.stdin, output = process.stdout, err = process.stderr,
    toolContextFactory = null, cwd = () => process.cwd(), home = homeOf(env),
  } = {}) {
    this.env = env;
    this.input = input;
    this.output = output;
    this.err = err;
    this.factory = toolContextFactory ?? defaultToolContextFactory({ env });
    this.cwd = cwd;
    this.home = home;
    this.version = packageVersion(buildPaths(env)); // the package's own file — no environment to poison
    this.client = { capabilities: {}, info: null };
    this.pending = new Map();
    this.requestSeq = 0;
    this.resolver = null;
    this.contextPromise = null;
    this.currentContext = null;
    this.closed = false;
    this.rl = null;
    this.served = lazyTools(() => this.#context());
  }

  start() {
    this.rl = readline.createInterface({ input: this.input });
    this.rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      let msg;
      try { msg = JSON.parse(s); } catch { return; }
      void this.handleMessage(msg);
    });
    return this;
  }

  /**
   * The ONE entry for a parsed frame — the daemon feeds its per-socket lines here. It never
   * throws: in a one-shot stdio process an unhandled rejection was a crash the client
   * noticed; in a daemon it would take every other session down with it (phase 2).
   */
  async handleMessage(msg) {
    try {
      await this.#onMessage(msg);
    } catch (e) {
      this.err.write(`oathe mcp: ${String(e?.message || e).slice(0, 300)}\n`);
      let id;
      try { id = msg?.id; } catch { id = undefined; }
      if (id !== undefined && id !== null) {
        this.#tryWrite({ jsonrpc: '2.0', id, error: { code: -32603, message: 'internal error — the server lives; detail on stderr' } });
      }
    }
  }

  /** End this connection: park nothing, leak nothing. Idempotent — the daemon closes on
   *  socket end AND on error, whichever comes first. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.rl?.close();
    for (const [id, entry] of this.pending) {
      entry.reject(new Error(`connection closed before ${id} was answered`));
    }
    this.pending.clear();
    await this.#invalidate();
  }

  /** A server→client request; the response routes back by id. */
  request(method, params = {}) {
    const id = `srv-${++this.requestSeq}`;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.#write({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  async #onMessage(msg) {
    // A response to one of OUR requests: no method, an id we issued.
    if (msg.method === undefined && msg.id !== undefined && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method === 'initialize') {
      this.client = {
        capabilities: msg.params?.capabilities ?? {},
        info: msg.params?.clientInfo ?? null,
      };
    }
    if (msg.method === 'notifications/roots/list_changed') {
      await this.#invalidate();
      return;
    }
    const out = await dispatch(msg, { tools: this.served, version: this.version });
    if (out) this.#write(out);
  }

  #write(obj) {
    this.output.write(`${JSON.stringify(obj)}\n`);
  }

  /** A write to a transport that may already be gone — close() owns the cleanup either way. */
  #tryWrite(obj) {
    try { this.#write(obj); } catch { /* transport gone */ }
  }

  /**
   * The one lazily-built context per resolution — rebuilt when the roots change OR when a
   * config layer file's clock moves (two stats per call): `oathe config verifier cursor`
   * must reach a server that has been alive for months, not wait for its restart. The
   * founder hit this live — a ChatGPT session's claims kept the verifier its startup
   * snapshot recorded.
   */
  async #context() {
    if (this.contextPromise) {
      const cached = await this.contextPromise.catch(() => null);
      if (cached && this.#configStamp(cached.resolution?.root ?? null) !== cached.configStamp) {
        await this.#invalidate();
      }
    }
    if (!this.contextPromise) {
      this.contextPromise = this.#buildContext();
      this.contextPromise.catch(() => { this.contextPromise = null; });
    }
    return this.contextPromise;
  }

  /** The config layers' clocks, as one comparable string; an absent file is its own state. */
  #configStamp(root) {
    return OatheConfig.filesFor({ env: this.env, cwd: root })
      .map((f) => { try { return `${f}:${fs.statSync(f).mtimeMs}`; } catch { return `${f}:absent`; } })
      .join('|');
  }

  async #buildContext() {
    if (!this.resolver) {
      // rootsTimeoutMs flows from config; the global layer is read HERE, lazily, so a broken
      // config file surfaces as this call's typed error, never a startup crash.
      const { OatheConfig } = await import('../config.mjs');
      const timeoutMs = OatheConfig.global({ env: this.env }).get('rootsTimeoutMs');
      const rootsProvider = this.client.capabilities?.roots
        ? async () => (await this.request('roots/list'))?.roots ?? []
        : null;
      this.resolver = new WorkspaceResolver({
        env: this.env, cwd: this.cwd, rootsProvider, timeoutMs, home: this.home,
      });
    }
    const resolution = await this.resolver.resolve();
    if (resolution.diagnostics.length > 0) {
      this.err.write(`oathe mcp: workspace resolved via ${resolution.source}; `
        + `${resolution.diagnostics.join('; ')}\n`);
    }
    // The stamp is taken BEFORE the factory reads the files: a write racing the build can
    // only cause one extra rebuild next call, never a missed change.
    const configStamp = this.#configStamp(resolution.root ?? null);
    const context = await this.factory({ resolution, client: this.client });
    if (this.closed) {
      // close() raced the build: the context that finished late is not a leaked pg client.
      await context.close?.().catch?.(() => {});
      throw new Error('connection closed during context build');
    }
    this.currentContext = context;
    return { resolution, tools: context.tools, context, configStamp };
  }

  async #invalidate() {
    const stale = this.currentContext;
    this.currentContext = null;
    this.contextPromise = null;
    this.resolver?.invalidate();
    if (stale) await stale.close?.().catch?.(() => {});
  }
}

/** The production context: config from the resolved root, real substrate, and the ONE
 *  activation seam (src/activation.mjs) — the resolution's `synthetic` fact rides into both
 *  the tools (board scope) and the seam (no registration, no fences). `speakerPid` is the
 *  process whose ancestry IS the speaker: the daemon passes its forwarder's hello pid (the
 *  walk is measured; the pid is the client's word inside the same-user socket boundary) or
 *  null (nothing to walk — the gate refuses its claims); absent, the speaker is this process. */
export function defaultToolContextFactory({ env, speakerPid = undefined }) {
  return async ({ resolution, client }) => {
    const [
      { Substrate }, { buildPaths }, { OatheConfig }, { WorkspaceRegistry }, { InstallManifest },
      { packageVersion }, { ActivationSeam }, tools,
    ] = await Promise.all([
      import('../substrate.mjs'), import('../paths.mjs'), import('../config.mjs'), import('../registry.mjs'),
      import('../manifest.mjs'), import('../context.mjs'), import('../activation.mjs'), import('./oathe-tools.mjs'),
    ]);
    const paths = buildPaths(env);
    const config = new OatheConfig({ env, cwd: resolution.root });
    const substrate = new Substrate({ database: config.get('db'), paths, env, config });
    const identity = {
      orgId: config.get('org'),
      principalId: config.get('principal'),
      department: config.get('department'),
    };
    const activation = new ActivationSeam({
      cwd: resolution.dir,
      env,
      registry: new WorkspaceRegistry({ registryPath: paths.registryPath }),
      manifest: InstallManifest.load({ manifestPath: paths.manifestPath, backupsDir: paths.backupsDir }),
      config,
      version: packageVersion(paths),
      synthetic: resolution.synthetic,
      harness: harnessForClient(client?.info?.name),
      sourceFor: (tool) => `mcp:${tool}`,
    });
    let successorPromise = null;
    const served = tools.createOatheTools({
      client: substrate,
      identity,
      config,
      workspace: resolution.ref,
      synthetic: resolution.synthetic,
      activation,
      // The SPEAKER primitive — resolved FRESH per context build: our own ancestry never
      // changes, but the device session registry does (a /clear, a rotation), and a stale
      // memo would stamp the first session's id on every later act (found 2026-09-01).
      speaker: resolveSpeaker({
        clientName: client?.info?.name, sessionsPath: paths.sessionsPath, devicePath: paths.devicePath,
        ...(speakerPid !== undefined && { pid: speakerPid }), // null = nothing to walk
      }),

      // Verification over MCP DISPATCHES — the engine never runs inside the server (a run is
      // minutes; the server must keep answering). ONE seam, every surface (verifierSeam).
      verifier: (await import('../verify-dispatch.mjs')).verifierSeam({
        orgId: identity.orgId,
        query: (sql, params) => substrate.query(sql, params),
        paths,
        cwd: resolution.dir,
      }),
      successor: async (o) => {
        if (!successorPromise) {
          successorPromise = import('../runtime/provider.mjs')
            .then(({ resolveRuntimeProvider }) => resolveRuntimeProvider({ config, paths })
              .successor({ substrate, identity, paths }));
          successorPromise.catch(() => { successorPromise = null; }); // a failed build must not poison retries
        }
        return (await successorPromise).pickup(o);
      },
    });
    return { tools: served, close: () => substrate.close() };
  };
}
