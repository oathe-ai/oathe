// oathe — the composition seam every verb starts from: paths, manifest, harnesses, substrate,
// identity, version. Built from env + an injectable exec so tests run in a sandbox HOME against
// a scratch database without monkey-patching anything.

import fs from 'node:fs';
import path from 'node:path';

import { buildPaths, homeOf } from './paths.mjs';
import { OatheConfig } from './config.mjs';
import { InstallManifest } from './manifest.mjs';
import { buildAll } from './harnesses/catalog.mjs';
import { Substrate } from './substrate.mjs';

export function packageVersion(paths) {
  return JSON.parse(fs.readFileSync(path.join(paths.packageRoot, 'package.json'), 'utf8')).version;
}

export function buildContext({ env = process.env, exec, cwd = process.cwd() } = {}) {
  const paths = buildPaths(env);
  const home = homeOf(env);
  const config = new OatheConfig({ env, cwd });
  const manifest = InstallManifest.load({ manifestPath: paths.manifestPath, backupsDir: paths.backupsDir });
  const harnesses = buildAll({ home, envPath: env.PATH, paths, exec }); // the ONE roster; consumers filter by capability
  const substrate = new Substrate({ database: config.get('db'), paths, env, config });
  const identity = {
    orgId: config.get('org'),
    principalId: config.get('principal') || env.USER || 'operator',
    department: config.get('department'),
  };
  return { paths, home, manifest, harnesses, substrate, identity, config, version: packageVersion(paths), env };
}
