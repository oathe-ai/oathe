// oathe — the harness catalog: the ONE registry over every adapter, and the sweeps that answer
// every "which harness can…?" BY CAPABILITY. Nothing else in the tree keys on a harness name or
// a flag: the verifier asks verifierCapable(), the doctor asks traceStores(), the launcher asks
// launchable(), init asks wireable() and verifiers(census). Adding a harness means adding an
// adapter file and one entry HERE — the contract suite's golden capability table is the spec.

import { Harness, HarnessOnboardError, census } from './harness.mjs';
import { DIALECTS } from './dialects.mjs';
import { TraceContractError } from '../traces.mjs';
import { ClaudeHarness } from './claude.mjs';
import { CodexHarness } from './codex.mjs';
import { CursorHarness } from './cursor.mjs';
import { ChatGptWebSurface, CoworkSurface } from './surfaces.mjs';

export { Harness, HarnessOnboardError, census, ClaudeHarness, CodexHarness, CursorHarness, CoworkSurface, ChatGptWebSurface };

/** Every surface oathe knows — wired harnesses and detect-only surfaces, one hierarchy. */
export const HARNESS_CLASSES = Object.freeze([ClaudeHarness, CodexHarness, CursorHarness, CoworkSurface, ChatGptWebSurface]);

/** @returns {typeof Harness} */
export function byName(name) {
  const found = HARNESS_CLASSES.find((C) => C.harnessName === name);
  if (!found) {
    throw new Error(`no harness '${name}' — known harnesses: ${HARNESS_CLASSES.map((C) => C.harnessName).join(', ')}`);
  }
  return found;
}

const names = (predicate) => HARNESS_CLASSES.filter(predicate).map((C) => C.harnessName);

/** The harnesses an installer can wire (the wiring capability). */
export function wireable() {
  return names((C) => C.wiring !== null);
}

/** The harnesses `oathe <name>` can launch inside the cage (the launch capability). */
export function launchable() {
  return names((C) => C.launch !== null);
}

/** The harnesses that can judge completed work — every one with a headless run. Validates config. */
export function verifierCapable() {
  return names((C) => C.headless !== null);
}

/** The verifier candidates on THIS machine: headless-capable AND the CLI is actually present. */
export function verifiers(seen) {
  const present = new Map(seen.map((d) => [d.name, d]));
  return verifierCapable().filter((name) => present.get(name)?.presence?.cli === true);
}

/** The harnesses with a session-record store the verifier and doctor read (the traces capability). */
export function traceStores() {
  return names((C) => C.traces !== null);
}

/** The harnesses with a REAL CLI the install-contract lane can install and prove against. */
export function installable() {
  return names((C) => C.install !== null);
}

/** The harnesses with a headless run the live-behaviour lane can drive. */
export function liveTestable() {
  return names((C) => C.headless !== null);
}

/**
 * The golden capability table — harness → which capabilities it possesses. The contract suite
 * pins it row for row: a supported harness has every touchpoint mapped, and a row change is a
 * reviewed change (PLAN.md R-HARNESS-TOUCHPOINTS).
 */
export function capabilityTable() {
  return Object.fromEntries(HARNESS_CLASSES.map((C) => [C.harnessName, {
    wiring: C.wiring !== null,
    hooks: C.hooks !== null,
    launch: C.launch !== null,
    headless: C.headless !== null,
    traces: C.traces !== null,
    surfaces: C.surfaces !== null,
    contextFiles: C.contextFiles.length > 0,
    globalContextFiles: C.globalContextFiles.length > 0,
    synthetic: C.isSyntheticWorkspaceDir !== Harness.isSyntheticWorkspaceDir,
    install: C.install !== null,
    docs: C.docs.length > 0,
  }]));
}

/** [name, envVar] pairs for every adapter that documents a project-dir env var. */
export function projectDirEnvVars() {
  return HARNESS_CLASSES.filter((C) => C.projectDirEnvVar !== null)
    .map((C) => [C.harnessName, C.projectDirEnvVar]);
}

/** R-BOARD-SCOPE: does ANY adapter stage `dir` as a synthetic workspace? Asked once, by the resolver. */
export function isSyntheticWorkspace({ dir, home }) {
  return HARNESS_CLASSES.some((C) => C.isSyntheticWorkspaceDir({ dir, home }));
}

/** Drift: the adapters and surfaces whose facts derive from the snapshot page `key`. */
export function docsDependents(key) {
  return names((C) => C.docs.includes(key));
}

/** The hook dialect whose sniff accepts `input`, or null — shapes, not harness identity. */
export function dialectFor(input) {
  return DIALECTS.find((d) => d.matches(input)) ?? null;
}

/** The harness an MCP client is, from its declared clientNames — or null. */
export function harnessForClient(clientName) {
  const name = String(clientName ?? '').toLowerCase();
  if (name === '') return null;
  return HARNESS_CLASSES.find((C) => C.clientNames.some((c) => name.includes(c)))?.harnessName ?? null;
}

/** Which store owns a session record — each store's own predicate; null when nobody's. */
export function ownerOfTracePath(file) {
  return HARNESS_CLASSES.find((C) => C.traces?.ownsPath(file))?.harnessName ?? null;
}

/**
 * The NEAREST adapter-owned process in an ancestry chain — the harness the chain speaks
 * for. Harnesses interpose helpers between themselves and their children (Cursor's agent CLI
 * runs hooks through a /bin/zsh; MCP servers are node), so ownership is never decided by
 * the chain's head alone. -1 when nobody in the chain is a harness. ONE implementation:
 * surface naming, speaker resolution, and hook registration all ask here.
 */
export function ownedAncestorIndex(ancestry) {
  return ancestry.findIndex((a) => HARNESS_CLASSES.some((C) => C.surfaces?.ownsExec(a?.exec ?? '')));
}

/**
 * NAME the surface a registered session speaks from — facts in, name out, at read time
 * (the sessions file stores facts only, so naming evolves without rewriting history).
 * Ownership: the trace store that owns the transcript wins (environment-independent);
 * else the adapter owning the NEAREST harness process in the chain. Nobody's process is
 * null — never a guess.
 */
export function surfaceForSession({ ancestry = [], app = null, transcriptPath = null }) {
  const idx = ownedAncestorIndex(ancestry);
  const exec = (idx === -1 ? ancestry[0]?.exec : ancestry[idx].exec) ?? '';
  const owner = ownerOfTracePath(transcriptPath ?? '')
    ?? (idx === -1 ? null : HARNESS_CLASSES.find((C) => C.surfaces?.ownsExec(exec))?.harnessName) ?? null;
  if (owner === null) return null;
  const { surfaces } = byName(owner);
  return surfaces === null ? owner : surfaces.name({ exec, appBundle: app?.bundle ?? null });
}

/**
 * The ATIF projector for a session record, from the store that owns it — or a typed refusal:
 * a file no store owns is not evidence, never "probably Claude".
 */
export async function projectorFor(file, { home } = {}) {
  const owner = ownerOfTracePath(file);
  if (owner === null) {
    throw new TraceContractError('TRACE_OWNER_UNKNOWN',
      `no trace store owns '${file}' — known stores: ${traceStores().join(', ')}`, { file });
  }
  const { traces } = byName(owner);
  const store = await traces.store({ home });
  return traces.projector({ store });
}

/**
 * The file a session's rows actually live in, asked of the store that owns the reported
 * path — each store knows how its harness rotates ids and where it keeps writing (see the
 * stores' transcriptFor). A path no store owns, or none at all, is returned as reported.
 */
export function transcriptFor({ sessionId, reportedPath, home } = {}) {
  const owner = ownerOfTracePath(reportedPath ?? '');
  if (owner === null) return reportedPath ?? null;
  return byName(owner).traces.store({ home }).transcriptFor({ sessionId, reportedPath });
}

/** Instantiate every adapter whose wiring exists — the init/uninstall roster. */
export function buildWireable({ home, envPath, paths, exec }) {
  return HARNESS_CLASSES.filter((C) => C.wiring !== null).map((C) => new C({ home, envPath, paths, exec }));
}

/** Instantiate every adapter — detection sweeps (the picker census) see them all. */
export function buildAll({ home, envPath, paths, exec }) {
  return HARNESS_CLASSES.map((C) => new C({ home, envPath, paths, exec }));
}

/** The detect-only surfaces as the picker prints them: detected + the manual steps. */
export function detectOnlySurfaces({ home, platform = process.platform }) {
  return HARNESS_CLASSES.filter((C) => C.wiring === null).map((C) => {
    const surface = new C({ home, platform });
    return { name: C.harnessName, displayName: C.displayName, detected: surface.detect().installed, steps: C.note };
  });
}
