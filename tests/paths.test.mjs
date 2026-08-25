import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

import { buildPaths } from '../src/paths.mjs';

test('buildPaths defaults to the founder machine layout', () => {
  const p = buildPaths({});
  assert.equal(p.monorepo, '/Users/firiya/firia-monorepo');
  assert.equal(p.ddlDir, path.join(p.monorepo, 'packages/firia-cell-domain/firia_cell_domain/ddl'));
  assert.equal(p.cagePath, path.join(p.monorepo, 'packages/firia-runtime/falsifiers/acp-probe/acp-cage.mjs'));
  assert.equal(p.oatheHome, path.join(os.homedir(), '.oathe'));
  assert.equal(p.manifestPath, path.join(p.oatheHome, 'install-manifest.json'));
  assert.equal(p.backupsDir, path.join(p.oatheHome, 'backups'));
  assert.equal(p.artifactDir, path.join(p.oatheHome, 'artifacts'));
});

test('buildPaths honours env overrides and derives dependents from them', () => {
  const p = buildPaths({ OATHE_MONOREPO: '/tmp/mono', OATHE_HOME: '/tmp/oathe-home' });
  assert.equal(p.monorepo, '/tmp/mono');
  assert.equal(p.ddlDir, '/tmp/mono/packages/firia-cell-domain/firia_cell_domain/ddl');
  assert.equal(p.cagePath, '/tmp/mono/packages/firia-runtime/falsifiers/acp-probe/acp-cage.mjs');
  assert.equal(p.manifestPath, '/tmp/oathe-home/install-manifest.json');
  assert.equal(p.backupsDir, '/tmp/oathe-home/backups');
});

test('buildPaths locates the package root and the plugin tree it ships', () => {
  const p = buildPaths({});
  assert.ok(p.packageRoot.endsWith('oathe-playground'));
  assert.equal(p.pluginDir, path.join(p.packageRoot, 'plugin'));
  assert.equal(p.mcpServerPath, path.join(p.packageRoot, 'src/mcp/oathe-tools.mjs'));
});
