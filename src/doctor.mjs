// oathe doctor — verify every manifest row against the world as it is NOW. A user edit inside
// an owned surface is REPORTED, never overwritten: the manifest records what oathe wrote, the
// doctor says whether it still stands, and the user's hand outranks ours.

import fs from 'node:fs';
import path from 'node:path';

import { buildContext, packageVersion } from './context.mjs';
import { FencedBlock, FENCE_STYLES, JsonEntries } from './blocks.mjs';
import { sha256Hex } from './manifest.mjs';
import { launchdJob } from './notch.mjs';
import { defaultExec } from './harnesses/harness.mjs';

function verifyJsonRow(row) {
  if (!fs.existsSync(row.file)) return 'file-missing';
  const text = fs.readFileSync(row.file, 'utf8');
  const engine = new JsonEntries();
  const entries = [];
  for (const p of row.detail?.paths ?? []) {
    const value = engine.read(text, p);
    if (value === undefined) return 'removed';
    entries.push({ path: p, value });
  }
  return sha256Hex(JSON.stringify(entries)) === row.sha256 ? 'ok' : 'user-edited';
}

function verifyFenceRow(row) {
  if (!fs.existsSync(row.file)) return 'file-missing';
  const block = new FencedBlock({ style: FENCE_STYLES[row.detail?.style ?? 'hash'] });
  const seen = block.read(fs.readFileSync(row.file, 'utf8'));
  if (!seen.present) return 'removed';
  return sha256Hex(seen.blockText) === row.sha256 ? 'ok' : 'user-edited';
}

function verifyCliRow(row) {
  if (!fs.existsSync(row.file)) return 'file-missing';
  const text = fs.readFileSync(row.file, 'utf8');
  // A JSON file the CLI owns (claude's ~/.claude.json): the proof is the PARSED entry — a
  // substring cannot survive the CLI's own formatting. detail.command is the address the
  // entry must carry; a different one is a drifted lane, visible on the machine it broke on.
  if (row.detail?.command !== undefined) {
    let entry;
    try { entry = JSON.parse(text)?.mcpServers?.oathe ?? null; } catch { return 'user-edited'; }
    if (entry === null) return 'removed';
    return entry.command === row.detail.command ? 'ok' : 'user-edited';
  }
  return text.includes(row.detail?.proof) ? 'ok' : 'removed';
}

function verifyJsonArrayRow(row) {
  if (!fs.existsSync(row.file)) return 'file-missing';
  let doc;
  try { doc = JSON.parse(fs.readFileSync(row.file, 'utf8')); } catch { return 'user-edited'; }
  const present = (entry) => {
    let node = doc;
    for (const key of entry.path) {
      if (node === null || typeof node !== 'object' || !(key in node)) return false;
      node = node[key];
    }
    return Array.isArray(node) && node.some((el) => el?.command === entry.match);
  };
  return (row.detail?.entries ?? []).every(present) ? 'ok' : 'removed';
}

/** The trace-layer refusals that mean "this runtime cannot read the store" — not a format change. */
const RUNTIME_BOUND_CODES = new Set(['TRACE_CODEX_SQLITE_UNSUPPORTED']);

/**
 * The trace-contract status for a failed projection: a runtime bound (node:sqlite is
 * unflagged only from Node 22.13.0 / 23.4.0 — below that the store never got to read the
 * record) is RUNTIME; anything else is format DRIFT. Both stay loud; the drift lanes need
 * them told apart.
 */
export function traceStatusOf(error) {
  return RUNTIME_BOUND_CODES.has(error?.code) ? 'RUNTIME' : 'DRIFT';
}

// A LaunchAgent is a whole-file write: present and byte-identical to what init recorded, or
// user-edited; gone is gone. (The notch ships with the package — every darwin manifest
// carries this row now.)
// …and "ok" means launchd RUNS it: an agent on disk that launchd dropped (the asynchronous
// bootout race, a bootout by hand) is the not-running notch the person is staring at.
function verifyLaunchAgentRow(row, { launchd }) {
  if (!fs.existsSync(row.file)) return 'file-missing';
  if (sha256Hex(fs.readFileSync(row.file, 'utf8')) !== row.sha256) return 'user-edited';
  return launchd(path.basename(row.file, '.plist')).pid !== null ? 'ok' : 'not-running';
}

// The materialized notch copy: the row's detail names the binary inside the key dir; ok
// means those exact bytes. A replaced binary under the same key is a drift the same way an
// edited plist is — materialization promises immutability per key.
function verifyNotchAppRow(row) {
  const binary = row.detail?.binary;
  if (!binary || !fs.existsSync(binary)) return 'file-missing';
  return sha256Hex(fs.readFileSync(binary)) === row.sha256 ? 'ok' : 'user-edited';
}

// A whole-file write (the shim, the device identity) is byte-identical to what init stamped,
// or user-edited; gone is gone — a gone shim means every harness's MCP entry points at
// nothing, a gone device means every act speaks from no device.
function verifyWholeFileRow(row) {
  if (!fs.existsSync(row.file)) return 'file-missing';
  return sha256Hex(fs.readFileSync(row.file, 'utf8')) === row.sha256 ? 'ok' : 'user-edited';
}

const VERIFIERS = {
  'json-path': verifyJsonRow, fence: verifyFenceRow, 'cli-managed': verifyCliRow, 'json-array': verifyJsonArrayRow,
  'launch-agent': verifyLaunchAgentRow, 'notch-app': verifyNotchAppRow, 'oathe-shim': verifyWholeFileRow,
  'device-id': verifyWholeFileRow,
};

/**
 * The per-surface resolution report (`oathe doctor --surface`): what the ladder received,
 * which rung won, and whether the workspace is registered — no substrate contact, so it
 * answers even on a machine whose database is down. This is the empirical probe the unknown
 * surfaces (Cowork, ChatGPT desktop) get pointed at.
 * @returns {Promise<{resolved: boolean, resolution: object|null, refusal: string|null,
 *                    registered: boolean|null, env_slice: object}>}
 */
export async function runSurfaceReport({ env = process.env, cwd = () => process.cwd() } = {}) {
  const { WorkspaceResolver } = await import('./workspace-resolver.mjs');
  const { projectDirEnvVars } = await import('./harnesses/catalog.mjs');
  const { WorkspaceRegistry } = await import('./registry.mjs');
  const { buildPaths } = await import('./paths.mjs');
  const paths = buildPaths(env);
  const envSlice = Object.fromEntries(
    ['OATHE_WORKSPACE_DIR', ...projectDirEnvVars().map(([, envVar]) => envVar), 'OATHE_LAUNCHED_HARNESS']
      .map((name) => [name, env[name] ?? null]));
  try {
    const resolution = await new WorkspaceResolver({ env, cwd }).resolve();
    let registered = null;
    try {
      registered = new WorkspaceRegistry({ registryPath: paths.registryPath }).get(resolution.ref) !== null;
    } catch { registered = null; }
    return { resolved: true, resolution, refusal: null, registered, env_slice: envSlice };
  } catch (e) {
    return { resolved: false, resolution: null, refusal: String(e?.message || e), registered: null, env_slice: envSlice };
  }
}

/** @returns {Promise<{rows: object[], substrate: object, plugin: {resolves: boolean, detail: string|null}}>} */
export async function runDoctor({ env = process.env, exec = defaultExec } = {}) {
  const launchd = (label) => launchdJob({ label, exec });
  const ctx = buildContext({ env });
  const { manifest, substrate, paths, harnesses } = ctx;
  try {
    // Version FACTS, not a check: the code that runs is the bin on PATH (this package); what
    // each harness has cached is its own manifests-only copy. Upgrade = reinstall + `oathe init`.
    const version = {
      package: packageVersion(paths),
      plugin: Object.fromEntries(harnesses.filter((h) => h.constructor.wiring !== null).map((h) => [h.name, h.installedPluginVersion()])),
    };
    const rows = manifest.rows.map((row) => ({
      harness: row.harness,
      file: row.file,
      kind: row.kind,
      block_version: row.block_version,
      status: (VERIFIERS[row.kind] ?? (() => 'unknown-kind'))(row, { launchd }),
    }));
    // The trace-contract monitor: both vendors disclaim transcript-schema stability, so the
    // doctor validates the NEWEST live record in each engine's store against docs/traces.md and
    // reports DRIFT loudly. An absent store is a distinct, visible status — never a silent skip.
    // Store, newest-record lookup, and projector are each engine adapter's own facts.
    const { byName, traceStores } = await import('./harnesses/catalog.mjs');
    const { projectAnnotated } = await import('./oathe-annotator.mjs');
    const home = ctx.home;
    const traces = {};
    for (const name of traceStores()) {
      const { traces: capability } = byName(name);
      const store = await capability.store({ home });
      const newest = capability.newest(store);
      if (!newest) {
        traces[name] = { status: 'store-absent', newest: null, detail: 'no session records found' };
        continue;
      }
      // The full read the verifier itself performs (converter, validated; then the annotator)
      // — then the census sweep over the recent window: an undeclared row type or a fidelity
      // failure is DRIFT the day it appears on this machine, not the day a verify mis-judges.
      try {
        await projectAnnotated(newest, { home });
        const { censusOf, fidelityOf } = await import('./trace-census.mjs');
        const files = capability.recent(store, {
          days: ctx.config.get('traceCensusDays'), maxFiles: ctx.config.get('traceCensusMaxFiles'),
        });
        const census = censusOf({ store, roster: capability.roster, kindOf: capability.kindOf, files });
        const fidelity = await fidelityOf({
          store, project: (file) => projectAnnotated(file, { home }), fidelity: capability.fidelity, files, traceStatus: traceStatusOf,
        });
        const failures = [
          ...census.undeclared.map((u) => `undeclared ${u.channel}.${u.type} ×${u.count} (first: ${u.example})`),
          ...fidelity.projectionErrors.filter((p) => p.status === 'DRIFT').map((p) => `${p.file}: ${p.detail}`),
          ...fidelity.probes.flatMap((p) => p.failed.map((f) => `${p.probe}: ${f.file}: ${f.detail}`)),
        ];
        const runtime = fidelity.projectionErrors.find((p) => p.status === 'RUNTIME');
        traces[name] = {
          status: runtime ? 'RUNTIME' : failures.length > 0 ? 'DRIFT' : 'ok',
          newest,
          census: { swept: census.swept, undeclared: census.undeclared.length,
            fidelity_failures: fidelity.probes.reduce((n, p) => n + p.failed.length, 0) },
          detail: runtime ? runtime.detail : failures[0] ?? null,
        };
      } catch (e) {
        traces[name] = { status: traceStatusOf(e), newest, detail: String(e?.message || e) };
      }
    }

    let plugin;
    try {
      const manifestDoc = JSON.parse(
        fs.readFileSync(path.join(paths.pluginDir, '.claude-plugin/plugin.json'), 'utf8'));
      plugin = manifestDoc.name === 'oathe'
        ? { resolves: true, detail: null }
        : { resolves: false, detail: `plugin.json names '${manifestDoc.name}', not 'oathe'` };
    } catch (e) {
      plugin = { resolves: false, detail: String(e?.message || e) };
    }

    let runtime;
    try {
      const { resolveRuntimeProvider } = await import('./runtime/provider.mjs');
      const provider = resolveRuntimeProvider({ config: ctx.config, paths });
      // The resolvability probe (Finding 1): an oathe selection whose cage path exists on disk
      // says nothing about whether `npm run link-runtime` was ever run — doctor must surface the
      // SAME probe acceptanceRuntime()/successor() gate on, never report HEALTHY over it.
      runtime = { provider: provider.name, requested: ctx.config.get('runtimeProvider'),
        capabilities: provider.capabilities(), error: null, probe: provider.probe() };
    } catch (e) {
      runtime = { provider: null, requested: ctx.config.get('runtimeProvider'),
        capabilities: null, error: String(e?.message || e), probe: null };
    }

    // The daemon probe (phase 2): a REAL MCP initialize over the socket — the launch-agent
    // row above says what launchd holds; this says whether an MCP server ANSWERS where the
    // forwarders knock (a bare connect proves a listener, not a server — a wedged process
    // squatting the socket must never read as ok; the verifier's catch, 2026-09-04).
    let daemon;
    try {
      const [{ serveSocketPath }, { probeDaemon }] = await Promise.all([
        import('./serve.mjs'), import('./mcp/forwarder.mjs'),
      ]);
      const socket = serveSocketPath(paths, ctx.config);
      const probe = await probeDaemon({ socketPath: socket, timeoutMs: ctx.config.get('serveConnectMs') });
      daemon = { socket, answering: probe.answering, server: probe.server };
    } catch (e) {
      daemon = { socket: null, answering: false, server: null, detail: String(e?.message || e) };
    }

    return { version, rows, substrate: await substrate.status(), plugin, traces, runtime, daemon };
  } finally {
    await substrate.close();
  }
}
