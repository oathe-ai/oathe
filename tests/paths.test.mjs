import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { buildPaths } from '../src/paths.mjs';

test('buildPaths probes the DEFAULT monorepo: present on this machine keeps it; an explicit env wins verbatim', () => {
  const here = buildPaths({});
  // machine-agnostic: default is either the founder path (when it exists) or null — never a lie
  if (fs.existsSync('/Users/firiya/firia-monorepo')) {
    assert.equal(here.monorepo, '/Users/firiya/firia-monorepo');
  } else {
    assert.equal(here.monorepo, null);
  }
  const forced = buildPaths({ OATHE_MONOREPO: '/tmp/mono' });
  assert.equal(forced.monorepo, '/tmp/mono', 'explicit env is taken at its word even if absent');
});

test('a null monorepo nulls its derived paths and nothing throws', () => {
  const p = buildPaths({ OATHE_MONOREPO: '' }); // empty string = explicit "no monorepo"
  assert.equal(p.monorepo, null);
  assert.equal(p.cagePath, null);
  // ddlDir falls through the resolution order; with no vendor/ddl in-tree it is null too
  assert.equal(p.ddlDir, fs.existsSync(path.join(p.packageRoot, 'vendor/ddl')) ? path.join(p.packageRoot, 'vendor/ddl') : null);
});

test('the DDL source resolution order: OATHE_DDL_DIR > vendor/ddl > monorepo > null', () => {
  const forced = buildPaths({ OATHE_DDL_DIR: '/tmp/my-ddl', OATHE_MONOREPO: '/tmp/mono' });
  assert.equal(forced.ddlDir, '/tmp/my-ddl');
  const viaMono = buildPaths({ OATHE_MONOREPO: '/tmp/mono' });
  // no vendor/ddl in tree today → monorepo-derived
  assert.equal(viaMono.ddlDir, '/tmp/mono/packages/firia-cell-domain/firia_cell_domain/ddl');
});

test('buildPaths honours OATHE_HOME override and derives dependents from it', () => {
  const p = buildPaths({ OATHE_HOME: '/tmp/oathe-home' });
  assert.equal(p.oatheHome, '/tmp/oathe-home');
  assert.equal(p.manifestPath, '/tmp/oathe-home/install-manifest.json');
  assert.equal(p.backupsDir, '/tmp/oathe-home/backups');
  assert.equal(p.artifactDir, '/tmp/oathe-home/artifacts');
});

test('buildPaths defaults oatheHome to the user home directory', () => {
  const p = buildPaths({});
  assert.equal(p.oatheHome, path.join(os.homedir(), '.oathe'));
  assert.equal(p.manifestPath, path.join(p.oatheHome, 'install-manifest.json'));
  assert.equal(p.backupsDir, path.join(p.oatheHome, 'backups'));
  assert.equal(p.artifactDir, path.join(p.oatheHome, 'artifacts'));
});

test('buildPaths locates the package root and the plugin tree it ships', () => {
  const p = buildPaths({});
  const manifest = JSON.parse(fs.readFileSync(path.join(p.packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'oathe');
  assert.equal(p.pluginDir, path.join(p.packageRoot, 'plugin'));
  assert.equal(p.mcpServerPath, path.join(p.packageRoot, 'src/mcp/oathe-tools.mjs'));
});
