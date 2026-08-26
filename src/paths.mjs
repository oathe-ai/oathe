// oathe — every filesystem location the package reaches, named once, env-overridable.
//
// The monorepo is consumed READ-ONLY (episode freeze: importing pinned modules is harmless,
// editing is forbidden); the cage lives outside firia-runtime's exports map, so it is imported
// by PATH — `cagePath` is that one sanctioned pre-extraction address.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEFAULT_MONOREPO = '/Users/firiya/firia-monorepo';

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{monorepo: string|null, ddlDir: string|null, cagePath: string|null, oatheHome: string,
 *            manifestPath: string, backupsDir: string, artifactDir: string, workRoot: string,
 *            packageRoot: string, pluginDir: string, mcpServerPath: string}}
 */
export function buildPaths(env = process.env) {
  // R-D: an explicit OATHE_MONOREPO is taken at its word ('' means "none"); only the DEFAULT is probed.
  const monorepo = env.OATHE_MONOREPO !== undefined
    ? (env.OATHE_MONOREPO || null)
    : (fs.existsSync(DEFAULT_MONOREPO) ? DEFAULT_MONOREPO : null);
  const oatheHome = env.OATHE_HOME || path.join(os.homedir(), '.oathe');
  const packageRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
  const vendorDdl = path.join(packageRoot, 'vendor/ddl');
  const ddlDir = env.OATHE_DDL_DIR
    || (fs.existsSync(vendorDdl) ? vendorDdl : null)
    || (monorepo ? path.join(monorepo, 'packages/firia-cell-domain/firia_cell_domain/ddl') : null);
  return Object.freeze({
    monorepo,
    ddlDir,
    cagePath: monorepo ? path.join(monorepo, 'packages/firia-runtime/falsifiers/acp-probe/acp-cage.mjs') : null,
    oatheHome,
    manifestPath: path.join(oatheHome, 'install-manifest.json'),
    backupsDir: path.join(oatheHome, 'backups'),
    artifactDir: path.join(oatheHome, 'artifacts'),
    workRoot: path.join(oatheHome, 'work'),
    packageRoot,
    pluginDir: path.join(packageRoot, 'plugin'),
    mcpServerPath: path.join(packageRoot, 'src/mcp/oathe-tools.mjs'),
  });
}
