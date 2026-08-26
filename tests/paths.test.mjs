import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { buildPaths } from '../src/paths.mjs';

test('buildPaths has NO baked-in monorepo default: env-only, taken verbatim', () => {
  const here = buildPaths({});
  assert.equal(here.monorepo, null, 'no env, no monorepo — never a machine-specific default');
  const forced = buildPaths({ OATHE_MONOREPO: '/tmp/mono' });
  assert.equal(forced.monorepo, '/tmp/mono', 'explicit env is taken at its word even if absent');
  assert.equal(forced.cagePath, '/tmp/mono/packages/oathe-runtime/falsifiers/acp-probe/acp-cage.mjs');
});

test('a null monorepo nulls its derived paths and nothing throws', () => {
  const p = buildPaths({ OATHE_MONOREPO: '' }); // empty string = explicit "no monorepo"
  assert.equal(p.monorepo, null);
  assert.equal(p.cagePath, null);
  // ddlDir falls through the resolution order; with no vendor/ddl in-tree it is null too
  const vendorPresent = fs.existsSync(path.join(p.packageRoot, 'vendor/ddl'));
  assert.equal(p.ddlDir, vendorPresent ? path.join(p.packageRoot, 'vendor/ddl') : null);
  assert.equal(p.ddlSource, vendorPresent ? 'vendor' : null);
});

test('the DDL source resolution order: OATHE_DDL_DIR > vendor/ddl > monorepo > null', () => {
  const forced = buildPaths({ OATHE_DDL_DIR: '/tmp/my-ddl', OATHE_MONOREPO: '/tmp/mono' });
  assert.equal(forced.ddlDir, '/tmp/my-ddl');
  assert.equal(forced.ddlSource, 'OATHE_DDL_DIR');
  const viaMono = buildPaths({ OATHE_MONOREPO: '/tmp/mono' });
  const vendorPresentForMono = fs.existsSync(path.join(viaMono.packageRoot, 'vendor/ddl'));
  if (vendorPresentForMono) {
    // vendor/ddl now ships in-tree and outranks monorepo in the resolution order
    assert.equal(viaMono.ddlDir, path.join(viaMono.packageRoot, 'vendor/ddl'));
    assert.equal(viaMono.ddlSource, 'vendor');
  } else {
    assert.equal(viaMono.ddlDir, '/tmp/mono/packages/oathe-cell-domain/oathe_cell_domain/ddl');
    assert.equal(viaMono.ddlSource, 'monorepo');
  }
  const noSource = buildPaths({ OATHE_MONOREPO: '' });
  const vendorPresent = fs.existsSync(path.join(noSource.packageRoot, 'vendor/ddl'));
  if (!vendorPresent) {
    assert.equal(noSource.ddlDir, null);
    assert.equal(noSource.ddlSource, null, 'no OATHE_DDL_DIR, no vendor/ddl, no monorepo — ddlSource is null too');
  }
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
  assert.equal(manifest.name, '@oathe/oathe');
  assert.equal(p.pluginDir, path.join(p.packageRoot, 'plugin'));
  assert.equal(p.mcpServerPath, path.join(p.packageRoot, 'src/mcp/oathe-tools.mjs'));
});
