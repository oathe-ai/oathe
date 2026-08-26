// oathe — every filesystem location the package reaches, named once, env-overridable.
//
// The monorepo is consumed READ-ONLY (episode freeze: importing pinned modules is harmless,
// editing is forbidden); the cage lives outside oathe-runtime's exports map, so it is imported
// by PATH — `cagePath` is that one sanctioned pre-extraction address.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';


/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{monorepo: string|null, ddlDir: string|null, ddlSource: ('OATHE_DDL_DIR'|'vendor'|'monorepo'|null),
 *            cagePath: string|null, oatheHome: string,
 *            manifestPath: string, backupsDir: string, artifactDir: string, workRoot: string,
 *            packageRoot: string, pluginDir: string, mcpServerPath: string}}
 */
export function buildPaths(env = process.env) {
  // R-D (amended for the public tree): the runtime checkout is named ONLY by env —
  // no baked-in machine default. '' means "none".
  const monorepo = env.OATHE_MONOREPO || null;
  const oatheHome = env.OATHE_HOME || path.join(os.homedir(), '.oathe');
  const packageRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
  const vendorDdl = path.join(packageRoot, 'vendor/ddl');
  const vendorDdlExists = fs.existsSync(vendorDdl);
  const monorepoDdl = monorepo ? path.join(monorepo, 'packages/oathe-cell-domain/oathe_cell_domain/ddl') : null;
  // One resolution, two facts: ddlDir and ddlSource walk the SAME OATHE_DDL_DIR > vendor/ddl >
  // monorepo > null order, so a caller can never see a dir without a matching, named source.
  const ddlDir = env.OATHE_DDL_DIR || (vendorDdlExists ? vendorDdl : null) || monorepoDdl;
  const ddlSource = env.OATHE_DDL_DIR
    ? 'OATHE_DDL_DIR'
    : (vendorDdlExists ? 'vendor' : (monorepoDdl ? 'monorepo' : null));
  return Object.freeze({
    monorepo,
    ddlDir,
    ddlSource,
    cagePath: monorepo ? path.join(monorepo, 'packages/oathe-runtime/falsifiers/acp-probe/acp-cage.mjs') : null,
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
