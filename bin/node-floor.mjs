#!/usr/bin/env node
// oathe — the floor at the INSTALL door (R-NODE-FLOOR). npm treats `engines` as a warning, so
// `preinstall` executes the same gate the bin executes: a below-floor runtime never receives
// an installed package whose first command would refuse it. One declaration (package.json
// engines.node), read through assertNodeFloor; at or above the floor this says nothing and
// exits 0. Installs with --ignore-scripts skip it and meet the bin's own door instead.

import { assertNodeFloor } from '../src/node-floor.mjs';
import { buildPaths } from '../src/paths.mjs';

try {
  assertNodeFloor({ packageRoot: buildPaths(process.env).packageRoot });
} catch (e) {
  process.stderr.write(`[${e?.code ?? 'OATHE_NODE_FLOOR'}] ${e?.message ?? e}\n`);
  process.exit(1);
}
