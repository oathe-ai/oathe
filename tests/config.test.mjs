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
  assert.equal(cfg.get('verifierEvidenceBudget'), 24000);
  assert.equal(cfg.get('pagerQuietHours'), 24);
});

test('principal defaults to the OS user — the one fallback, named once here (D0-PREVIEW: OATHE_PRINCIPAL or the OS user)', () => {
  // Before 2026-09-03 the key defaulted to null and three consumers each wrote
  // `config.get('principal') || env.USER || 'operator'` — the same fallback hardcoded thrice,
  // and `oathe config principal` answered null. The founder's word: it should be the user.
  const { env, cwd } = scratch();
  const cfg = new OatheConfig({ env, cwd });
  assert.equal(cfg.get('principal'), os.userInfo().username);
  assert.equal(cfg.source('principal'), 'default');
  assert.equal(new OatheConfig({ env: { ...env, OATHE_PRINCIPAL: 'ada' }, cwd }).get('principal'), 'ada');
  assert.throws(() => new OatheConfig({ env: { ...env, OATHE_PRINCIPAL: '' }, cwd }),
    (e) => e.code === 'OATHE_CONFIG_VALUE_INVALID', 'an empty principal is refused, never silently someone else');
});

test('R-PAGER: pagerQuietHours is a positive-int key with a 24h default — the quiet-claim threshold', () => {
  const { env, cwd } = scratch();
  assert.equal(new OatheConfig({ env, cwd }).get('pagerQuietHours'), 24);
  assert.equal(new OatheConfig({ env: { ...env, OATHE_PAGER_QUIET_HOURS: '6' }, cwd }).get('pagerQuietHours'), 6);
  assert.throws(() => new OatheConfig({ env: { ...env, OATHE_PAGER_QUIET_HOURS: '0' }, cwd }).get('pagerQuietHours'));
});

test('defaultAgent is a null-or-launchable key — who picks your work back up, chosen at onboarding', () => {
  const { env, cwd } = scratch();
  assert.equal(new OatheConfig({ env, cwd }).get('defaultAgent'), null);
  assert.equal(new OatheConfig({ env: { ...env, OATHE_DEFAULT_AGENT: 'claude' }, cwd }).get('defaultAgent'), 'claude');
  assert.throws(() => new OatheConfig({ env: { ...env, OATHE_DEFAULT_AGENT: 'vim' }, cwd }).get('defaultAgent'));
});

test('notchApp is a null-or-string key — the machine opts into the notch by naming its binary', () => {
  const { env, cwd } = scratch();
  assert.equal(new OatheConfig({ env, cwd }).get('notchApp'), null);
  assert.equal(new OatheConfig({ env: { ...env, OATHE_NOTCH_APP: '/x/OatheNotch' }, cwd }).get('notchApp'), '/x/OatheNotch');
});

test('notchMotionMinutes is a positive-int key with a 60m default — what "in motion" means on the glass', () => {
  const { env, cwd } = scratch();
  assert.equal(new OatheConfig({ env, cwd }).get('notchMotionMinutes'), 60);
  assert.equal(new OatheConfig({ env: { ...env, OATHE_NOTCH_MOTION_MINUTES: '15' }, cwd }).get('notchMotionMinutes'), 15);
  assert.throws(() => new OatheConfig({ env: { ...env, OATHE_NOTCH_MOTION_MINUTES: '0' }, cwd }).get('notchMotionMinutes'));
});

test('notchHeartbeatSeconds is a positive-int key with a 300s default — the serve-mode drift guard', () => {
  const { env, cwd } = scratch();
  assert.equal(new OatheConfig({ env, cwd }).get('notchHeartbeatSeconds'), 300);
  assert.equal(new OatheConfig({ env: { ...env, OATHE_NOTCH_HEARTBEAT_SECONDS: '30' }, cwd }).get('notchHeartbeatSeconds'), 30);
  assert.throws(() => new OatheConfig({ env: { ...env, OATHE_NOTCH_HEARTBEAT_SECONDS: '0' }, cwd }).get('notchHeartbeatSeconds'));
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

test('runtimeProvider defaults to auto and accepts the two explicit providers', () => {
  const config = new OatheConfig({ env: {}, cwd: os.tmpdir() });
  assert.equal(config.get('runtimeProvider'), 'auto');
  assert.equal(config.source('runtimeProvider'), 'default');
  const forced = new OatheConfig({ env: { OATHE_RUNTIME_PROVIDER: 'standalone' }, cwd: os.tmpdir() });
  assert.equal(forced.get('runtimeProvider'), 'standalone');
  assert.equal(forced.source('runtimeProvider'), 'env');
});

test('runtimeProvider refuses an unknown provider name loudly', () => {
  assert.throws(
    () => new OatheConfig({ env: { OATHE_RUNTIME_PROVIDER: 'cloud' }, cwd: os.tmpdir() }),
    (e) => e.name === 'ConfigError' && e.code === 'OATHE_CONFIG_VALUE_INVALID');
});

test('R6: pgHost default honors PGHOST, then the platform socket convention — never a bare macOS assumption', async () => {
  const { OatheConfig } = await import('../src/config.mjs');
  const cfg = new OatheConfig({ env: {} });
  const expected = process.env.PGHOST
    || (process.platform === 'darwin' ? '/tmp' : '/var/run/postgresql');
  assert.equal(cfg.get('pgHost'), expected);
});

test('a cwd that does not exist refuses at construction — never a silently-wrong config root', () => {
  const { env } = scratch();
  assert.throws(() => new OatheConfig({ env, cwd: '/no/such/place' }),
    (e) => e instanceof ConfigError && e.code === 'OATHE_CONFIG_CWD_INVALID');
  // The exact shape of the desktop bug: an unexpanded template must refuse HERE, not walk to /.
  assert.throws(() => new OatheConfig({ env, cwd: '${CLAUDE_PROJECT_DIR}' }),
    (e) => e.code === 'OATHE_CONFIG_CWD_INVALID' && e.message.includes('${CLAUDE_PROJECT_DIR}'));
});

test('OatheConfig.global() loads defaults → global file → env with NO workspace layer', () => {
  const { env, cwd } = scratch();
  fs.mkdirSync(env.OATHE_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.OATHE_HOME, 'config.json'), JSON.stringify({ verifier: 'codex' }));
  fs.writeFileSync(path.join(cwd, '.oathe.json'), JSON.stringify({ verifier: 'claude' }));
  const cfg = OatheConfig.global({ env });
  assert.equal(cfg.get('verifier'), 'codex', 'the workspace file is never read');
  assert.equal(cfg.source('verifier'), 'global');
  const withEnv = OatheConfig.global({ env: { ...env, OATHE_VERIFIER: 'claude' } });
  assert.equal(withEnv.get('verifier'), 'claude');
  assert.equal(withEnv.source('verifier'), 'env');
});

test('autoActivate is a boolean key: default true, env-coercible, garbage refused', () => {
  const { env, cwd } = scratch();
  const cfg = new OatheConfig({ env, cwd });
  assert.equal(cfg.get('autoActivate'), true);
  assert.equal(new OatheConfig({ env: { ...env, OATHE_AUTO_ACTIVATE: 'false' }, cwd }).get('autoActivate'), false);
  assert.equal(new OatheConfig({ env: { ...env, OATHE_AUTO_ACTIVATE: '0' }, cwd }).get('autoActivate'), false);
  assert.equal(new OatheConfig({ env: { ...env, OATHE_AUTO_ACTIVATE: 'true' }, cwd }).get('autoActivate'), true);
  assert.throws(() => new OatheConfig({ env: { ...env, OATHE_AUTO_ACTIVATE: 'banana' }, cwd }),
    (e) => e.code === 'OATHE_CONFIG_VALUE_INVALID');
  fs.writeFileSync(path.join(cwd, '.oathe.json'), JSON.stringify({ autoActivate: false }));
  assert.equal(new OatheConfig({ env, cwd }).get('autoActivate'), false);
});

test('rootsTimeoutMs is a positive-int key with a 2000ms default', () => {
  const { env, cwd } = scratch();
  assert.equal(new OatheConfig({ env, cwd }).get('rootsTimeoutMs'), 2000);
  assert.equal(new OatheConfig({ env: { ...env, OATHE_ROOTS_TIMEOUT_MS: '500' }, cwd }).get('rootsTimeoutMs'), 500);
  assert.throws(() => new OatheConfig({ env: { ...env, OATHE_ROOTS_TIMEOUT_MS: '-1' }, cwd }),
    (e) => e.code === 'OATHE_CONFIG_VALUE_INVALID');
});

test('verifier accepts every harness with a headless run — cursor included — and defaults to the first capable one', async () => {
  const { verifierCapable } = await import('../src/harnesses/catalog.mjs');
  const { env, cwd } = scratch();
  assert.equal(new OatheConfig({ env, cwd }).get('verifier'), verifierCapable()[0]);
  assert.equal(new OatheConfig({ env: { ...env, OATHE_VERIFIER: 'cursor' }, cwd }).get('verifier'), 'cursor');
  assert.throws(() => new OatheConfig({ env: { ...env, OATHE_VERIFIER: 'cowork' }, cwd }).get('verifier'), /cowork/);
});

test('the notch restart budget is config: how long init waits for launchd to take the agent, and how often it asks', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-config-'));
  const env = { HOME: cwd, OATHE_HOME: path.join(cwd, '.oathe') };
  assert.equal(new OatheConfig({ env, cwd }).get('notchRestartSeconds'), 10);
  assert.equal(new OatheConfig({ env, cwd }).get('notchRestartPollMs'), 100);
  assert.equal(new OatheConfig({ env: { ...env, OATHE_NOTCH_RESTART_SECONDS: '3' }, cwd }).get('notchRestartSeconds'), 3);
});
