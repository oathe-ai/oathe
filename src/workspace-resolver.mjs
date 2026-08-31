// oathe — the ONE workspace-resolution ladder. Every surface that must answer "which folder is
// this session about?" — the MCP server, hooks, CLI verbs, doctor — resolves through here,
// lazily, never at process startup:
//
//   1. OATHE_WORKSPACE_DIR         (explicit binding; an unexpanded ${...} template is skipped)
//   2. harness project-dir env vars (the catalog sweep — CLAUDE_PROJECT_DIR, CURSOR_PROJECT_DIR)
//   3. MCP roots                   (the protocol's own answer, when the client offers one)
//   4. process cwd                 (refused for / and the home directory — a home-dir board is
//                                   silently wrong, and fail-loud beats a wrong default)
//   5. OATHE_WORKSPACE_UNRESOLVED  (naming every input received verbatim, and the fix)
//
// Every skipped rung leaves a diagnostic; the winner's `source` names the rung that decided.
// A resolution also carries `synthetic` (R-BOARD-SCOPE): whether the directory is one a
// harness stages for folderless sessions — derived HERE (describe) and threaded everywhere.

import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { isSyntheticWorkspace, projectDirEnvVars } from './harnesses/catalog.mjs';
import { workspaceRef, workspaceRoot } from './workspace.mjs';

export class WorkspaceResolveError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkspaceResolveError';
    this.code = code;
    this.details = details;
  }
}

export class WorkspaceResolver {
  /**
   * @param {{env?: NodeJS.ProcessEnv, cwd?: () => string, rootsProvider?: (() => Promise<Array<{uri: string}>>)|null,
   *          timeoutMs?: number, home?: string}} o
   *   rootsProvider — pass one ONLY when the connected client declared the roots capability.
   */
  constructor({ env = process.env, cwd = () => process.cwd(), rootsProvider = null, timeoutMs = 2000, home = os.homedir() } = {}) {
    this.env = env;
    this.cwd = cwd;
    this.rootsProvider = rootsProvider;
    this.timeoutMs = timeoutMs;
    this.home = home;
    this.cached = null;
  }

  /**
   * The facts of ONE directory — root, ref, synthetic — derived here and nowhere else. Every
   * accepted rung goes through it, and so does every surface handed a directory by its
   * harness outright (hooks, activation, the CLI) rather than through the ladder. So does the
   * ONE refusal: `/` and the home directory are never a workspace — a board minted there
   * would be silently wrong, and a fence written there would land in `~`.
   * @returns {{dir: string, root: string, ref: string, synthetic: boolean}}
   * @throws {WorkspaceResolveError} OATHE_WORKSPACE_UNRESOLVED for `/` and the home directory
   */
  static describe({ dir, home = os.homedir() }) {
    const real = realdir(dir);
    if (real === '/' || real === realdir(home)) {
      throw new WorkspaceResolveError('OATHE_WORKSPACE_UNRESOLVED',
        `workspace refused: '${dir}' is ${real === '/' ? 'the filesystem root' : 'your home directory'} — `
        + 'almost certainly not the project, and a board minted there would be silently wrong'
        + ' (fix: run from inside the project, or set OATHE_WORKSPACE_DIR)', { dir });
    }
    return { dir, root: workspaceRoot(dir), ref: workspaceRef(dir), synthetic: isSyntheticWorkspace({ dir, home }) };
  }

  /** Forget the cached resolution (e.g. on notifications/roots/list_changed). */
  invalidate() {
    this.cached = null;
  }

  /**
   * @returns {Promise<{dir: string, root: string, ref: string, synthetic: boolean, source: string,
   *                    diagnostics: string[]}>}
   * @throws {WorkspaceResolveError} OATHE_WORKSPACE_UNRESOLVED when no rung yields a directory
   */
  async resolve() {
    if (!this.cached) this.cached = this.#resolveOnce();
    try {
      return await this.cached;
    } catch (e) {
      this.cached = null; // a refusal is not a cache entry — the next call re-consults
      throw e;
    }
  }

  async #resolveOnce() {
    const diagnostics = [];
    // A rung's directory is accepted through describe(); its refusal (/, home) becomes this
    // rung's diagnostic and the ladder moves on — the final refusal names them all.
    const accept = (dir, source) => {
      try {
        return { ...WorkspaceResolver.describe({ dir, home: this.home }), source, diagnostics };
      } catch (e) {
        if (e?.code !== 'OATHE_WORKSPACE_UNRESOLVED') throw e;
        diagnostics.push(`${source}: ${e.message}`);
        return null;
      }
    };

    // Rungs 1–2: the explicit binding, then each harness's declared project-dir variable.
    const envRungs = [['OATHE_WORKSPACE_DIR', this.env.OATHE_WORKSPACE_DIR],
      ...projectDirEnvVars().map(([, envVar]) => [envVar, this.env[envVar]])];
    for (const [name, value] of envRungs) {
      if (value === undefined || value === '') continue;
      if (value.includes('${')) {
        diagnostics.push(`${name} ignored: unexpanded template '${value}' — the harness never substituted it`);
        continue;
      }
      if (realdir(value) === null) {
        diagnostics.push(`${name} ignored: '${value}' is not an existing directory`);
        continue;
      }
      const accepted = accept(value, name);
      if (accepted) return accepted;
    }

    // Rung 3: the MCP client's own answer.
    if (this.rootsProvider === null) {
      diagnostics.push('roots: the client offers no roots capability');
    } else {
      try {
        const roots = await this.#withTimeout(this.rootsProvider(), this.timeoutMs);
        const fileRoot = (roots ?? []).find((r) => String(r?.uri ?? '').startsWith('file://'));
        if (fileRoot) {
          const dir = fileURLToPath(fileRoot.uri);
          if (realdir(dir) === null) {
            diagnostics.push(`roots: '${dir}' is not an existing directory`);
          } else {
            const accepted = accept(dir, 'roots');
            if (accepted) return accepted;
          }
        } else {
          diagnostics.push('roots: the client returned no file:// root');
        }
      } catch (e) {
        diagnostics.push(`roots: ${String(e?.message || e)}`);
      }
    }

    // Rung 4: the process cwd — describe() refuses / and the home directory.
    const cwd = this.cwd();
    if (realdir(cwd) === null) {
      diagnostics.push(`cwd: '${cwd}' is not an existing directory`);
    } else {
      const accepted = accept(cwd, 'cwd');
      if (accepted) return accepted;
    }

    throw new WorkspaceResolveError('OATHE_WORKSPACE_UNRESOLVED',
      'no workspace directory could be resolved for this session:\n'
      + diagnostics.map((d) => `  - ${d}`).join('\n')
      + '\n  fix: set OATHE_WORKSPACE_DIR to the project directory, or start the session from '
      + 'inside the project', { diagnostics });
  }

  #withTimeout(promise, ms) {
    let timer = null;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        // The timer stays ref'd on purpose: a roots provider that never answers must not let
        // the event loop drain before the bound fires — the ladder needs its turn.
        timer = setTimeout(() => reject(new Error(`roots/list timed out after ${ms}ms`)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }
}

/** The real path of an existing directory, or null. */
function realdir(dir) {
  try {
    const real = fs.realpathSync(dir);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}
