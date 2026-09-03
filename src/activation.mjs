// oathe — workspace activation: THE fence writer. One implementation puts the managed
// `## Oathe` section into the context files of every harness detected on the machine (each
// adapter's own declared fact), backed up once and manifest-recorded project-scope, registers
// the workspace centrally, and DISCLOSES what it wrote. The launcher preflight, the
// SessionStart hook, and oathe_claim all activate through here — byte-identical output, no
// drift between paths. `autoActivate` (config) is the off switch: false = register only.
// A SYNTHETIC workspace (R-BOARD-SCOPE — a harness staging dir, not a project folder) is
// never activated: no fences, no registry row; the writer defends itself so every caller
// inherits the rule.

import path from 'node:path';

import { fenceBody, writeFence } from './fence.mjs';
import { buildAll, byName, census } from './harnesses/catalog.mjs';
import { withFileLock } from './fslock.mjs';
import { homeOf } from './paths.mjs';
import { WorkspaceResolver } from './workspace-resolver.mjs';

export { fenceBody } from './fence.mjs';

/** The context files the machine's detected harnesses actually read — each adapter's fact. */
export function contextFileTargets({ env }) {
  const home = homeOf(env);
  const seen = census(buildAll({ home, envPath: env.PATH ?? '', paths: null }));
  return [...new Set(seen.filter((s) => s.installed).flatMap((s) => byName(s.name).contextFiles))];
}

/**
 * Activate `cwd`'s workspace: register centrally, then (unless autoActivate is off) write the
 * fences + manifest rows. Idempotent; every write is disclosed.
 * @param {{cwd: string, env: NodeJS.ProcessEnv, manifest: object, registry?: object|null,
 *          config?: object|null, version: string, source: string, harness?: string|null}} o
 * @returns {Promise<{workspace: string|null, synthetic: boolean, registered: boolean,
 *                    fences: string[], actions: object[], disclosed: string}>}
 *          workspace is null for a synthetic directory — it has no board.
 */
export async function activateWorkspace({
  cwd, env, manifest, registry = null, config = null, version, source, harness = null,
}) {
  const { ref: workspace, synthetic } = WorkspaceResolver.describe({ dir: cwd, home: homeOf(env) });
  if (synthetic) {
    return {
      workspace: null,
      synthetic,
      registered: false,
      fences: [],
      actions: [],
      disclosed: 'synthetic workspace (a harness staging directory, not a project folder) — '
        + 'nothing registered, no files written',
    };
  }
  if (registry) await registry.register({ cwd, source, harness });
  const autoOn = config ? config.get('autoActivate') : true;
  if (!autoOn) {
    return {
      workspace,
      synthetic,
      registered: registry !== null,
      fences: [],
      actions: [],
      disclosed: 'activation off (autoActivate=false) — workspace registered only, no files written',
    };
  }
  const targets = contextFileTargets({ env });
  const actions = [];
  const written = [];
  // The lock spans the whole read-modify-write over the shared manifest: concurrent hooks and
  // servers activate at once, and save() alone cannot prevent a lost update.
  await withFileLock(manifest.manifestPath, async () => {
    // The file, not the snapshot (B4): this manifest object may have been loaded when the
    // server's context was built, days before — read what is on disk now, then add to THAT.
    manifest.refresh();
    for (const file of targets) {
      const target = path.join(cwd, file);
      const { changed } = writeFence({ manifest, file: target, version, body: fenceBody(workspace), scope: 'project' });
      actions.push({ action: `${file.toLowerCase().replace('.', '-')}-fence`, file: target, changed });
      written.push(file);
      if (registry) await registry.recordFence(workspace, file, version);
    }
    manifest.save();
  });
  const changedFiles = actions.filter((a) => a.changed).map((a) => path.basename(a.file));
  return {
    workspace,
    synthetic,
    registered: registry !== null,
    fences: written,
    actions,
    disclosed: changedFiles.length > 0
      ? `oathe pinned this folder's board into ${changedFiles.join(' and ')} (managed section; `
        + 'remove with `oathe uninstall`)'
      : `board fences current in ${written.join(' and ')}`,
  };
}

/**
 * The tools' activation seam — ONE implementation for every tool host (the MCP connection,
 * the CLI): every successful speech act registers the workspace centrally; `oathe_claim`
 * activates through the writer above. A synthetic workspace registers nothing (the writer
 * already refuses to activate one). `sourceFor` names the host's registry-source convention.
 */
export class ActivationSeam {
  /**
   * @param {{cwd: string, env: NodeJS.ProcessEnv, registry: object, manifest: object, config: object,
   *          version: string, synthetic: boolean, sourceFor: (tool: string) => string, harness?: string|null}} o
   */
  constructor({ cwd, env, registry, manifest, config, version, synthetic, sourceFor, harness = null }) {
    this.cwd = cwd;
    this.env = env;
    this.registry = registry;
    this.manifest = manifest;
    this.config = config;
    this.version = version;
    this.synthetic = synthetic;
    this.sourceFor = sourceFor;
    this.harness = harness;
  }

  /** @returns {Promise<object|null>} the registry row, or null for a synthetic workspace */
  register(tool) {
    if (this.synthetic) return Promise.resolve(null);
    return this.registry.register({ cwd: this.cwd, source: this.sourceFor(tool), harness: this.harness });
  }

  activate(tool) {
    const { cwd, env, manifest, registry, config, version, harness } = this;
    return activateWorkspace({ cwd, env, manifest, registry, config, version, harness, source: this.sourceFor(tool) });
  }
}
