// oathe — the composition seam every verb starts from: paths, manifest, harnesses, substrate,
// identity, version. Built from env + an injectable exec so tests run in a sandbox HOME against
// a scratch database without monkey-patching anything.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildPaths } from './paths.mjs';
import { OatheConfig } from './config.mjs';
import { InstallManifest } from './manifest.mjs';
import { ClaudeHarness, CodexHarness } from './harness.mjs';
import { Substrate } from './substrate.mjs';

export function packageVersion(paths) {
  return JSON.parse(fs.readFileSync(path.join(paths.packageRoot, 'package.json'), 'utf8')).version;
}

export function buildContext({ env = process.env, exec, cwd = process.cwd() } = {}) {
  const paths = buildPaths(env);
  const home = env.HOME || os.homedir();
  const config = new OatheConfig({ env, cwd });
  const manifest = InstallManifest.load({ manifestPath: paths.manifestPath, backupsDir: paths.backupsDir });
  const harnesses = [
    new ClaudeHarness({ home, envPath: env.PATH, paths, exec }),
    new CodexHarness({ home, envPath: env.PATH, paths, exec }),
  ];
  const substrate = new Substrate({ database: config.get('db'), paths, env, config });
  const identity = {
    orgId: config.get('org'),
    principalId: config.get('principal') || env.USER || 'operator',
    department: config.get('department'),
  };
  return { paths, home, manifest, harnesses, substrate, identity, config, version: packageVersion(paths), env };
}
