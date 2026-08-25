// oathe — every filesystem location the package reaches, named once, env-overridable.
//
// The monorepo is consumed READ-ONLY (episode freeze: importing pinned modules is harmless,
// editing is forbidden); the cage lives outside firia-runtime's exports map, so it is imported
// by PATH — `cagePath` is that one sanctioned pre-extraction address.

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEFAULT_MONOREPO = '/Users/firiya/firia-monorepo';

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{monorepo: string, ddlDir: string, cagePath: string, oatheHome: string,
 *            manifestPath: string, backupsDir: string, artifactDir: string,
 *            packageRoot: string, pluginDir: string, mcpServerPath: string}}
 */
export function buildPaths(env = process.env) {
  const monorepo = env.OATHE_MONOREPO || DEFAULT_MONOREPO;
  const oatheHome = env.OATHE_HOME || path.join(os.homedir(), '.oathe');
  const packageRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
  return Object.freeze({
    monorepo,
    ddlDir: path.join(monorepo, 'packages/firia-cell-domain/firia_cell_domain/ddl'),
    cagePath: path.join(monorepo, 'packages/firia-runtime/falsifiers/acp-probe/acp-cage.mjs'),
    oatheHome,
    manifestPath: path.join(oatheHome, 'install-manifest.json'),
    backupsDir: path.join(oatheHome, 'backups'),
    artifactDir: path.join(oatheHome, 'artifacts'),
    packageRoot,
    pluginDir: path.join(packageRoot, 'plugin'),
    mcpServerPath: path.join(packageRoot, 'src/mcp/oathe-tools.mjs'),
  });
}
