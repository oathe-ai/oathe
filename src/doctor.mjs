// oathe doctor — verify every manifest row against the world as it is NOW. A user edit inside
// an owned surface is REPORTED, never overwritten: the manifest records what oathe wrote, the
// doctor says whether it still stands, and the user's hand outranks ours.

import fs from 'node:fs';
import path from 'node:path';

import { buildContext, packageVersion } from './context.mjs';
import { FencedBlock, FENCE_STYLES, JsonEntries } from './blocks.mjs';
import { sha256Hex } from './manifest.mjs';
import { spawnSync } from 'node:child_process';
import { launchdJob } from './notch.mjs';
import { agentPathEnv } from './launchd.mjs';

/**
 * A manifest the doctor cannot read is a broken install, said loudly (zero legacy, founder
 * 2026-09-05): a row of a kind this tree does not know, or a row missing a field this tree's
 * writer always records, is never a status line — the fix is named.
 */
export class DoctorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DoctorError';
    this.code = code;
    this.details = details;
  }
}

const REINSTALL = 'uninstall with the oathe that wrote it, then run oathe init';
function malformed(row, what) {
  return new DoctorError('OATHE_MANIFEST_ROW_MALFORMED',
    `manifest row ${row.kind} for ${row.file} carries no ${what} — not a row this oathe writes; ${REINSTALL}`, { row });
}
import { defaultExec } from './harnesses/harness.mjs';
import { byName } from './harnesses/catalog.mjs';

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

/** The fence style every fence row records (fence.mjs); a row without one is not ours. */
export function fenceStyleOf(row) {
  const style = FENCE_STYLES[row.detail?.style];
  if (!style) throw malformed(row, 'known fence style');
  return style;
}

function verifyFenceRow(row) {
  const block = new FencedBlock({ style: fenceStyleOf(row) }); // the row's shape first — a malformed row is malformed whatever the file does
  if (!fs.existsSync(row.file)) return 'file-missing';
  const seen = block.read(fs.readFileSync(row.file, 'utf8'));
  if (!seen.present) return 'removed';
  return sha256Hex(seen.blockText) === row.sha256 ? 'ok' : 'user-edited';
}

function verifyCliRow(row) {
  // Two sub-shapes, both written today: a parsed JSON entry (detail.command) or proof lines
  // (detail.proofs). The row's shape is checked before the file — malformed is malformed.
  const proofs = row.detail?.command !== undefined ? null : row.detail?.proofs;
  if (proofs !== null && (!Array.isArray(proofs) || proofs.length === 0)) throw malformed(row, 'proofs');
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
  // Every proof line must stand (the codex stanza carries the address AND the timeout budget the
  // CLI's re-add drops).
  return proofs.every((p) => text.includes(p)) ? 'ok' : 'removed';
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

// A CLI's recorded address (ruling 2026-09-05: engines are addresses) is proved by the
// SUPERVISOR'S ANSWER, not a stat: `<address> <versionArgs>` runs under the LaunchAgent's PATH —
// the world the notch feed and the serve daemon spawn a judgment from — and exit 0 is ok. This
// catches what X_OK misses: a node-script CLI whose interpreter that PATH no longer names.
function verifyCliAddressRow(row, { probe }) {
  if (!fs.existsSync(row.file)) return 'file-missing';
  return probe(row.file, byName(row.harness).install.versionArgs).status === 0 ? 'ok' : 'unreachable';
}

/** Every manifest kind this tree writes, with its verifier — the machine surface (docs/PRODUCT.md §3). */
export const VERIFIERS = {
  'json-path': verifyJsonRow, fence: verifyFenceRow, 'cli-managed': verifyCliRow, 'json-array': verifyJsonArrayRow,
  'launch-agent': verifyLaunchAgentRow, 'notch-app': verifyNotchAppRow, 'oathe-shim': verifyWholeFileRow,
  'device-id': verifyWholeFileRow, 'cli-address': verifyCliAddressRow,
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
function verifierFor(row) {
  const verify = VERIFIERS[row.kind];
  if (!verify) {
    throw new DoctorError('OATHE_MANIFEST_KIND_UNKNOWN',
      `manifest row kind '${row.kind}' (${row.file}) is not one this oathe writes (${Object.keys(VERIFIERS).join(', ')}) — ${REINSTALL}`, { row });
  }
  return verify;
}

export async function runDoctor({ env = process.env, exec = defaultExec } = {}) {
  const launchd = (label) => launchdJob({ label, exec });
  const probe = (file, args) => spawnSync(file, args, { encoding: 'utf8', env: { ...env, PATH: agentPathEnv() }, timeout: 20_000 });
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
      status: verifierFor(row)(row, { launchd, probe }),
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
        // The staging gate (B1, 2026-09-06): the adapter says whether the newest rollout's writer ran
        // from a dir it knows as staging — the day the desktop moves again, this line says so.
        const stagingDrift = capability.stagingDrift?.(store.describe(newest), { home }) ?? null;
        const failures = [
          ...(stagingDrift ? [stagingDrift] : []),
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
