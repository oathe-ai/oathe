import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OatheConfig, ConfigError } from '../src/config.mjs';

function scratch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-cfg-'));
  const cwd = path.join(home, 'ws');
  fs.mkdirSync(cwd, { recursive: true });
  const env = { HOME: home, OATHE_HOME: path.join(home, '.oathe') };
  return { home, cwd, env };
}

test('defaults are named once and reachable — no consumer hardcodes them', () => {
  const { env, cwd } = scratch();
  const cfg = new OatheConfig({ env, cwd });
  assert.equal(cfg.get('org'), 'oathe');
  assert.equal(cfg.get('db'), 'oathe_local');
  assert.equal(cfg.get('leaseHours'), 4);
  assert.equal(cfg.get('verifyByHours'), 24);
  assert.equal(cfg.get('verifier'), 'claude');
  assert.equal(cfg.get('verifierPrincipal'), 'oathe-verifier');
  assert.match(cfg.get('starUrl'), /^https:\/\//);
  assert.equal(cfg.get('verifierEvidenceBudget'), 24000);
});

test('source(key) reports where a value came from — default, global, workspace, or env', () => {
  const { env, cwd } = scratch();
  const bare = new OatheConfig({ env, cwd });
  assert.equal(bare.source('verifier'), 'default');
  fs.mkdirSync(env.OATHE_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.OATHE_HOME, 'config.json'), JSON.stringify({ verifier: 'codex' }));
  assert.equal(new OatheConfig({ env, cwd }).source('verifier'), 'global');
  fs.writeFileSync(path.join(cwd, '.oathe.json'), JSON.stringify({ verifier: 'claude' }));
  assert.equal(new OatheConfig({ env, cwd }).source('verifier'), 'workspace');
  assert.equal(new OatheConfig({ env: { ...env, OATHE_VERIFIER: 'codex' }, cwd }).source('verifier'), 'env');
});

test('layering: global file overrides defaults, workspace file overrides global, env overrides all', () => {
  const { env, cwd } = scratch();
  fs.mkdirSync(env.OATHE_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.OATHE_HOME, 'config.json'), JSON.stringify({ verifier: 'codex', leaseHours: 8 }));
  fs.writeFileSync(path.join(cwd, '.oathe.json'), JSON.stringify({ verifier: 'claude' }));
  const cfg = new OatheConfig({ env, cwd });
  assert.equal(cfg.get('leaseHours'), 8, 'global layer');
  assert.equal(cfg.get('verifier'), 'claude', 'workspace outranks global');
  const cfg2 = new OatheConfig({ env: { ...env, OATHE_VERIFIER: 'codex' }, cwd });
  assert.equal(cfg2.get('verifier'), 'codex', 'env outranks files');
});

test('an unknown key is a typed refusal, never undefined', () => {
  const { env, cwd } = scratch();
  const cfg = new OatheConfig({ env, cwd });
  assert.throws(() => cfg.get('nonsense'), (e) => e instanceof ConfigError && e.code === 'OATHE_CONFIG_KEY_UNKNOWN');
});

test('a config file carrying an unknown key or invalid value refuses loudly at load', () => {
  const { env, cwd } = scratch();
  fs.writeFileSync(path.join(cwd, '.oathe.json'), JSON.stringify({ verifier: 'gemini' }));
  assert.throws(() => new OatheConfig({ env, cwd }), (e) => e.code === 'OATHE_CONFIG_VALUE_INVALID');
  fs.writeFileSync(path.join(cwd, '.oathe.json'), JSON.stringify({ made_up: 1 }));
  assert.throws(() => new OatheConfig({ env, cwd }), (e) => e.code === 'OATHE_CONFIG_KEY_UNKNOWN');
});

test('set() writes the chosen scope and round-trips', () => {
  const { env, cwd } = scratch();
  const cfg = new OatheConfig({ env, cwd });
  cfg.set('verifier', 'codex', { scope: 'workspace' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, '.oathe.json'), 'utf8')).verifier, 'codex');
  cfg.set('leaseHours', 6, { scope: 'global' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.OATHE_HOME, 'config.json'), 'utf8')).leaseHours, 6);
  const reread = new OatheConfig({ env, cwd });
  assert.equal(reread.get('verifier'), 'codex');
  assert.equal(reread.get('leaseHours'), 6);
  assert.throws(() => cfg.set('verifier', 'gemini', { scope: 'global' }), (e) => e.code === 'OATHE_CONFIG_VALUE_INVALID');
});

test('workspace file is found from a SUBDIRECTORY via the git/workspace root', () => {
  const { env, cwd } = scratch();
  fs.mkdirSync(path.join(cwd, '.git'));
  fs.writeFileSync(path.join(cwd, '.oathe.json'), JSON.stringify({ verifier: 'codex' }));
  const sub = path.join(cwd, 'deep/nested');
  fs.mkdirSync(sub, { recursive: true });
  const cfg = new OatheConfig({ env, cwd: sub });
  assert.equal(cfg.get('verifier'), 'codex');
});
