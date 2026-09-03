import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sandbox as sharedSandbox } from './helpers.mjs';
import { runInit } from '../src/init.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { runUninstall } from '../src/uninstall.mjs';
import { Substrate, DDL_FILES } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';
import { launchAgentPath } from '../src/notch.mjs';
import { InstallManifest } from '../src/manifest.mjs';

const SCRATCH_DB = `oathe_init_test_${process.pid}`;
const paths = buildPaths({});

// Once vendor/ddl ships in this tree, the OATHE_DDL_DIR > vendor/ddl > monorepo > null fallback
// chain always resolves a source — "no DDL source at all" is not reachable via env alone
// (nulling OATHE_MONOREPO just falls through to vendor/ddl). Skip loudly rather than silently
// rewrite the test's meaning into a duplicate of the "named source missing" case below.
const skipNoDdlSource = paths.ddlSource === 'vendor'
  && 'no-DDL-source scenario is unreachable once vendor/ddl ships in-tree (fallback chain always resolves it)';

function sandbox() {
  const sb = sharedSandbox({ scratchDb: SCRATCH_DB });
  return { home: sb.home, env: sb.env, exec: sb.exec };
}

after(async () => {
  const substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await substrate.close();
  await substrate.dropDatabase();
});

test('the notch lifecycle: with notchApp configured, init writes the LaunchAgent manifest-owned and bootstraps it NOW; uninstall boots it out and removes it', { skip: process.platform !== 'darwin' && 'LaunchAgents are a darwin surface' }, async () => {
  const { home, env, exec } = sandbox();
  const app = path.join(home, 'OatheNotch');
  fs.writeFileSync(app, '#!/bin/sh\n');
  fs.chmodSync(app, 0o755);
  const wired = { ...env, OATHE_NOTCH_APP: app };
  const result = await runInit({ env: wired, exec, assumeYes: true });
  const plist = launchAgentPath(home);
  assert.ok(fs.existsSync(plist), 'the LaunchAgent landed');
  const plistBody = fs.readFileSync(plist, 'utf8');
  assert.ok(plistBody.includes(path.join(home, '.oathe', 'notch')),
    'the plist runs a MATERIALIZED copy of the configured binary');
  assert.ok(!plistBody.includes(`<string>${app}</string>`),
    'never the mutable source path itself');
  // launchd spawns with a bare PATH and login shells never source .zshrc — init KNOWS where
  // oathe lives (it is oathe running), so it stamps that PATH into the agent's environment.
  assert.ok(plistBody.includes('EnvironmentVariables'), 'the agent carries its environment');
  assert.ok(plistBody.includes(path.dirname(process.execPath)), "the running node's bin dir — where the oathe bin lives — rides PATH");
  assert.ok(result.actions.some((a) => a.harness === 'notch' && a.action === 'launch-agent-written'),
    'the write is reported as a fact');
  const manifest = JSON.parse(fs.readFileSync(path.join(wired.OATHE_HOME, 'install-manifest.json'), 'utf8'));
  assert.ok(manifest.rows.some((r) => r.kind === 'launch-agent' && r.file === plist), 'manifest-owned');
  assert.ok(exec.calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootstrap'),
    'always-on means NOW, not at next login');

  const out = await runUninstall({ env: wired, exec });
  assert.ok(!fs.existsSync(plist), 'uninstall removes exactly what init recorded');
  assert.ok(exec.calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootout'));
  assert.ok(out.actions.some((a) => a.action === 'launch-agent-removed'));
});

test('the notch ships with oathe: WITHOUT notchApp configured, init wires the PACKAGED app — installed for everyone (founder ruling 2026-08-30)', {
  skip: (process.platform !== 'darwin' && 'LaunchAgents are a darwin surface')
    // The app is built at pack time and gitignored — a source checkout honestly lacks it,
    // and the fact-row test below covers that path.
    || (!fs.existsSync(path.join(new URL('..', import.meta.url).pathname, 'notch', 'Oathe Notch.app', 'Contents', 'MacOS', 'OatheNotch'))
        && 'packaged notch app absent (built at pack time) — the missing-binary fact row is the contract here'),
}, async () => {
  const { home, env, exec } = sandbox();
  const result = await runInit({ env, exec, assumeYes: true });
  const plist = launchAgentPath(home);
  assert.ok(fs.existsSync(plist), 'no opt-in needed — the packaged app is the default');
  const plistBody = fs.readFileSync(plist, 'utf8');
  assert.ok(plistBody.includes(path.join(home, '.oathe', 'notch')),
    'the packaged app is materialized under the oathe home — upgrades never replace a running binary in place');
  assert.ok(plistBody.includes('Oathe Notch.app/Contents/MacOS/OatheNotch'),
    'and it is the whole shipped bundle that runs');
  assert.ok(result.actions.some((a) => a.harness === 'notch' && a.action === 'launch-agent-written'));
});

test('a source checkout without the built app states the fact — a row naming the missing binary, never a silent skip', { skip: process.platform !== 'darwin' && 'LaunchAgents are a darwin surface' }, async () => {
  const { wireNotch, packagedNotchApp } = await import('../src/notch.mjs');
  const { home, exec } = sandbox();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-bare-root-'));
  try {
    const config = { get: (k) => (k === 'notchApp' ? null : undefined) };
    const actions = wireNotch({ home, manifest: { upsert: () => {} }, config, version: '0.0.0', exec, packageRoot: bare });
    assert.deepEqual(actions, [{ action: 'notch-binary-missing', file: packagedNotchApp(bare) }]);
    assert.ok(!fs.existsSync(path.join(home, 'Library/LaunchAgents/ai.oathe.notch.plist')));
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('init end-to-end: substrate up, every detected harness onboarded, manifest written, and a re-run is byte-idempotent', async () => {
  const { home, env, exec } = sandbox();
  const result = await runInit({ env, exec });

  assert.deepEqual(result.census.map((c) => [c.name, c.installed]),
    [['claude', true], ['codex', true], ['cursor', true]]);
  assert.deepEqual(result.wired, ['claude', 'codex', 'cursor'], 'off-TTY wires all detected');
  assert.equal(result.substrate.database_exists, true);
  assert.equal(result.substrate.ddl_applied, DDL_FILES.length);
  assert.equal(result.substrate.ddl_expected, DDL_FILES.length);
  assert.equal(result.substrate.yield_cause_registered, true);
  assert.equal(result.principal.principal_id, 'founder');
  assert.equal(result.verifier.principal_id, 'oathe-verifier');
  assert.deepEqual(result.verifier.seats, ['oathe-verifier', 'founder']);

  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.enabledPlugins['oathe@oathe'], true);
  assert.equal(settings.extraKnownMarketplaces.oathe.source.path, paths.packageRoot);
  const toml = fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
  assert.ok(toml.includes('[marketplaces.oathe]'));
  assert.ok(toml.includes('[mcp_servers.oathe]'));
  const cursorMcp = JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8'));
  assert.equal(cursorMcp.mcpServers.oathe.command, path.join(home, 'bin/oathe'),
    'the cursor entry carries the ABSOLUTE bin path — never a bare name');
  const cursorHooks = JSON.parse(fs.readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8'));
  assert.ok(cursorHooks.hooks.sessionStart.length === 1);

  const manifest = JSON.parse(fs.readFileSync(path.join(env.OATHE_HOME, 'install-manifest.json'), 'utf8'));
  assert.ok(manifest.rows.length >= 6);

  const before = {
    settings: fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'),
    toml,
    cursorMcp: fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8'),
    cursorHooks: fs.readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8'),
  };
  await runInit({ env, exec });
  assert.equal(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'), before.settings);
  assert.equal(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8'), before.toml);
  assert.equal(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8'), before.cursorMcp);
  assert.equal(fs.readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8'), before.cursorHooks);
  const manifest2 = JSON.parse(fs.readFileSync(path.join(env.OATHE_HOME, 'install-manifest.json'), 'utf8'));
  assert.equal(manifest2.rows.length, manifest.rows.length);
});

test('the verifier is chosen ONCE at init from the census — recorded globally, a re-run asks nothing', async () => {
  const { env, exec } = sandbox();
  const first = await runInit({ env, exec });
  assert.equal(first.verifier_engine.recorded, true);
  assert.equal(first.verifier_engine.asked, false, 'off-TTY records the announced default');
  assert.ok(['claude', 'codex'].includes(first.verifier_engine.chosen));
  const globalConfig = JSON.parse(fs.readFileSync(path.join(env.OATHE_HOME, 'config.json'), 'utf8'));
  assert.equal(globalConfig.verifier, first.verifier_engine.chosen);
  const second = await runInit({ env, exec });
  assert.equal(second.verifier_engine.recorded, false, 'an explicit choice is never re-asked or re-written');
});

test('a TTY init is one screen: the keys pick exactly what is wired and who verifies; nothing is written before Enter; detect-only surfaces write NOTHING', async () => {
  const { EventEmitter } = await import('node:events');
  const { home, env, exec } = sandbox();
  const writes = [];
  const out = Object.assign(new EventEmitter(), { isTTY: true, write: (t) => { writes.push(t); return true; } });
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: () => {}, pause: () => {}, resume: () => {} });
  const wait = runInit({ env, exec, stdin, out });
  // One screen: down → codex, space → off, down → cursor, down → agent row, down → verifier
  // row, right → codex, Enter. (The agent question sits above the verifier — one more down.)
  let pressed = false;
  let writtenBeforeFirstAnswer = null; // rule 8: nothing is written before Enter
  const timer = setInterval(() => {
    if (!pressed && /enter install/.test(writes.join(''))) {
      pressed = true;
      writtenBeforeFirstAnswer = fs.existsSync(path.join(env.OATHE_HOME, 'install-manifest.json'))
        || (fs.existsSync(path.join(home, '.claude/settings.json')) && fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8').includes('oathe'));
      stdin.emit('data', '\x1b[B \x1b[B\x1b[B\x1b[B\x1b[C\r');
    }
  }, 10);
  const result = await wait.finally(() => clearInterval(timer));
  assert.deepEqual(result.wired, ['claude', 'cursor'], 'exactly the picked harnesses');
  assert.ok(result.actions.some((a) => a.harness === 'codex' && a.action === 'skipped-not-selected'));
  assert.equal(result.verifier_engine.chosen, 'codex');
  assert.equal(result.verifier_engine.asked, true);
  assert.doesNotMatch(writes.join(''), /\[\d+\]/, 'no numbered menu');
  assert.doesNotMatch(writes.join(''), /\[Y\/n\]/, 'no question-by-question conversation');
  assert.equal(writtenBeforeFirstAnswer, false, 'ask everything, THEN do everything: no manifest and no settings key before the first answer');
  assert.ok(!fs.existsSync(path.join(home, '.codex/config.toml'))
    || !fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8').includes('[marketplaces.oathe]'),
  'the unselected harness was not wired');
  assert.ok(result.surfaces.every((s) => typeof s.steps === 'string' && s.steps.length > 0));
});

test('init --harness bypasses the picker and wires only the named harnesses', async () => {
  const { home, env, exec } = sandbox();
  const result = await runInit({ env, exec, harnessFilter: ['codex'] });
  assert.deepEqual(result.wired, ['codex']);
  assert.ok(!fs.existsSync(path.join(home, '.cursor/mcp.json')), 'cursor stayed untouched');
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
  assert.equal('enabledPlugins' in settings, false, 'claude stayed untouched');
  await assert.rejects(() => runInit({ env, exec, harnessFilter: ['vscode'] }),
    (e) => e.code === 'OATHE_INIT_HARNESS_UNKNOWN');
  // A named harness that is not on this machine is a refusal, not a silent drop.
  const bare = sharedSandbox({ scratchDb: SCRATCH_DB, withCursor: false });
  await assert.rejects(() => runInit({ env: bare.env, exec: bare.exec, harnessFilter: ['cursor'] }),
    (e) => e.code === 'OATHE_INIT_HARNESS_ABSENT' && /cursor/.test(e.message));
});

test('--yes and no-TTY apply the plan\'s defaults AND say what they applied', async () => {
  const yes = sandbox();
  const outYes = [];
  await runInit({ env: yes.env, exec: yes.exec, assumeYes: true, out: { write: (t) => outYes.push(t), isTTY: false } });
  assert.match(outYes.join(''), /init: --yes — applying defaults: wire: claude, codex, cursor; default agent: claude; verifier: claude/);
  const pipe = sandbox();
  const errPipe = [];
  await runInit({ env: pipe.env, exec: pipe.exec, out: { write: () => true, isTTY: false }, err: { write: (t) => errPipe.push(t) } });
  assert.match(errPipe.join(''), /init: no TTY — applying defaults: wire: claude, codex, cursor; default agent: claude; verifier: claude/);
});

test('init with the substrate unreachable instructs and refuses instead of onboarding half a world', async () => {
  const { env, exec } = sandbox();
  const dead = { ...env, OATHE_PG_HOST: '/nonexistent-socket-dir' };
  await assert.rejects(() => runInit({ env: dead, exec }), (e) => {
    assert.equal(e.code, 'OATHE_SUBSTRATE_UNREACHABLE');
    assert.match(e.message, /postgres/i);
    return true;
  });
});

test('init refuses BEFORE creating the database when no DDL source resolves', { skip: skipNoDdlSource }, async () => {
  const { env, exec } = sandbox();
  const dbName = `oathe_noddl_init_${process.pid}`;
  const noSource = { ...env, OATHE_MONOREPO: '', OATHE_DB: dbName };
  const admin = new Substrate({ database: 'postgres', paths, env: process.env });
  const scratch = new Substrate({ database: dbName, paths, env: process.env });
  try {
    await assert.rejects(() => runInit({ env: noSource, exec }),
      (e) => e.code === 'DDL_SOURCE_UNAVAILABLE');
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    assert.equal(rows.length, 0, 'no half-created database left behind');
  } finally {
    // Belt-and-suspenders: if init ever unexpectedly provisioned the database before refusing,
    // never leak a scratch database behind a passing (or failing) assertion.
    await scratch.dropDatabase().catch(() => {});
    await admin.close();
  }
});

test('init refuses BEFORE creating the database when OATHE_DDL_DIR names a directory that does not exist', async () => {
  const { env, exec } = sandbox();
  const wrongDdlDir = `/nonexistent-ddl-dir-${process.pid}`;
  const dbName = `oathe_ddlgone_init_${process.pid}`;
  const named = { ...env, OATHE_DDL_DIR: wrongDdlDir, OATHE_DB: dbName };
  await assert.rejects(() => runInit({ env: named, exec }),
    (e) => e.code === 'DDL_SOURCE_UNAVAILABLE' && e.message.includes(wrongDdlDir)
      && /does not exist/.test(e.message));
  const admin = new Substrate({ database: 'postgres', paths, env: process.env });
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    assert.equal(rows.length, 0, 'no half-created database left behind');
  } finally { await admin.close(); }
});

test('doctor over a healthy install reports every row ok; after a user edit inside our keys it REPORTS, never overwrites', async () => {
  const { home, env, exec } = sandbox();
  await runInit({ env, exec });
  const healthy = await runDoctor({ env });
  assert.equal(healthy.substrate.reachable, true);
  // the trace-contract monitor derives store paths from env HOME (nothing hardcoded): the
  // sandbox home has no session stores, and the doctor says so VISIBLY instead of skipping.
  assert.equal(healthy.traces.claude.status, 'store-absent', JSON.stringify(healthy.traces));
  assert.equal(healthy.traces.codex.status, 'store-absent', JSON.stringify(healthy.traces));
  assert.ok(healthy.rows.length >= 4);
  assert.ok(healthy.rows.every((r) => r.status === 'ok'), JSON.stringify(healthy.rows));
  assert.equal(healthy.plugin.resolves, true);
  // The runtime probe (Finding 1: an oathe selection that does not actually resolve
  // oathe-runtime must show unhealthy, never a HEALTHY doctor line over a broken checkout).
  assert.equal(healthy.runtime.provider !== null, true);
  assert.equal(healthy.runtime.probe.ok, true, JSON.stringify(healthy.runtime));

  const settingsPath = path.join(home, '.claude/settings.json');
  const doc = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  doc.enabledPlugins['oathe@oathe'] = false; // the user's own hand
  fs.writeFileSync(settingsPath, `${JSON.stringify(doc, null, 2)}\n`);
  const edited = await runDoctor({ env });
  const row = edited.rows.find((r) => r.file === settingsPath);
  assert.equal(row.status, 'user-edited');
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).enabledPlugins['oathe@oathe'], false,
    'doctor must not have overwritten the user edit');
});

test('uninstall removes exactly the recorded entries, restores nothing else, and keeps the database', async () => {
  const { home, env, exec } = sandbox();
  await runInit({ env, exec });
  const result = await runUninstall({ env, exec });
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.theme, 'dark');
  assert.equal('extraKnownMarketplaces' in settings, false);
  assert.equal('enabledPlugins' in settings, false);
  const toml = fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
  assert.ok(toml.includes('# user config'));
  assert.ok(!toml.includes('[marketplaces.oathe]'));
  const manifest = JSON.parse(fs.readFileSync(path.join(env.OATHE_HOME, 'install-manifest.json'), 'utf8'));
  assert.equal(manifest.rows.length, 0);
  assert.equal(result.database_dropped, false);
  const substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  try {
    const seen = await substrate.status();
    assert.equal(seen.database_exists, true, 'the cell database outlives uninstall');
  } finally {
    await substrate.close();
  }
});

test('R4 (R-OSS-7): public defaults carry no organizational assumptions — operator department', async () => {
  const { OatheConfig } = await import('../src/config.mjs');
  const cfg = new OatheConfig({ env: {} });
  assert.equal(cfg.get('department'), 'operator', 'department default is generic — no founder assumption');
});

test('init writes the managed block into ~/.codex/AGENTS.md (global scope) — the standing rule for folderless sessions; uninstall removes exactly it', async () => {
  const { runUninstall } = await import('../src/uninstall.mjs');
  const { home, env, exec } = sandbox();
  const file = path.join(home, '.codex/AGENTS.md');
  fs.writeFileSync(file, '# my own codex rules\n');
  const result = await runInit({ env, exec });
  assert.ok(result.actions.some((a) => a.harness === 'codex' && a.action === 'global-fence' && a.changed === true), JSON.stringify(result.actions));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('# my own codex rules\n'), 'the user\'s own content is untouched');
  assert.match(text, /## Oathe/);
  assert.match(text, /homeless/);
  const manifest = JSON.parse(fs.readFileSync(path.join(env.OATHE_HOME, 'install-manifest.json'), 'utf8'));
  const row = manifest.rows.find((r) => r.file === file);
  assert.ok(row, 'manifest-recorded');
  assert.equal(row.kind, 'fence');
  assert.equal(row.scope, 'user');
  await runInit({ env, exec });
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'byte-idempotent');
  assert.ok(!fs.existsSync(path.join(home, '.claude/CLAUDE.md')), 'no other harness grows a global fence uninvited');
  await runUninstall({ env, exec });
  assert.equal(fs.readFileSync(file, 'utf8'), '# my own codex rules\n', 'uninstall strips the block and nothing else');
});

test('when ~/.codex/AGENTS.override.md exists the block lands THERE — Codex reads the override instead of AGENTS.md', async () => {
  const { home, env, exec } = sandbox();
  const override = path.join(home, '.codex/AGENTS.override.md');
  fs.writeFileSync(override, '# override rules\n');
  await runInit({ env, exec });
  assert.match(fs.readFileSync(override, 'utf8'), /## Oathe/);
  assert.ok(!fs.existsSync(path.join(home, '.codex/AGENTS.md')), 'a dead fence in the shadowed file is not written');
});

test('UPGRADE PATH: a package root that MOVED (nvm node switch, npm link) re-registers both marketplaces instead of refusing', async () => {
  const { home, env, exec } = sandbox();
  const stale = '/old/global/node_modules/@oathe/oathe';
  fs.appendFileSync(path.join(home, '.codex/config.toml'), `[marketplaces.oathe]\nsource = "${stale}"\n`);
  fs.mkdirSync(path.join(home, '.claude/plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/plugins/known_marketplaces.json'),
    `${JSON.stringify({ oathe: { source: { source: 'directory', path: stale } } }, null, 2)}\n`);
  const result = await runInit({ env, exec });
  assert.deepEqual(result.wired, ['claude', 'codex', 'cursor']);
  const toml = fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
  assert.ok(toml.includes(`source = "${paths.packageRoot}"`), `codex marketplace re-added from the new root: ${toml}`);
  assert.ok(!toml.includes(stale), 'the stale source is gone');
  const known = JSON.parse(fs.readFileSync(path.join(home, '.claude/plugins/known_marketplaces.json'), 'utf8'));
  assert.equal(known.oathe.source.path, paths.packageRoot, 'claude marketplace re-added from the new root');
  const codexCalls = exec.calls.filter((c) => c[0] === 'codex' && c[2] === 'marketplace').map((c) => c[3]);
  assert.deepEqual(codexCalls, ['add', 'remove', 'add'], 'refused add → remove → add, in that order');
  const claudeCalls = exec.calls.filter((c) => c[0] === 'claude' && c[2] === 'marketplace').map((c) => c[3]);
  assert.deepEqual(claudeCalls, ['remove', 'add'], 'a known marketplace at another path is replaced');
});

test('doctor reports the package version beside each harness\'s cached plugin version — facts, not a check', async () => {
  const { env, exec } = sandbox();
  await runInit({ env, exec });
  const report = await runDoctor({ env });
  const VERSION = JSON.parse(fs.readFileSync(path.join(paths.packageRoot, 'package.json'), 'utf8')).version;
  assert.equal(report.version.package, VERSION);
  assert.equal(report.version.plugin.claude, VERSION, 'the sandbox claude fake records the installed version');
  assert.equal(report.version.plugin.codex, null, 'codex keeps no version-keyed cache we can read');
});

test('UPGRADE PATH, same version: a moved package root STILL re-registers the claude marketplace (and re-materializes from it)', async () => {
  const { home, env, exec } = sandbox();
  const stale = '/old/global/node_modules/@oathe/oathe';
  const version = JSON.parse(fs.readFileSync(path.join(paths.packageRoot, 'package.json'), 'utf8')).version;
  fs.mkdirSync(path.join(home, '.claude/plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/plugins/known_marketplaces.json'),
    `${JSON.stringify({ oathe: { source: { source: 'directory', path: stale } } }, null, 2)}\n`);
  // The plugin is ALREADY at the current version — installed earlier through the old path.
  fs.writeFileSync(path.join(home, '.claude/plugins/installed_plugins.json'),
    `${JSON.stringify({ version: 2, plugins: { 'oathe@oathe': [{ scope: 'user', version }] } }, null, 2)}\n`);
  const result = await runInit({ env, exec });
  const known = JSON.parse(fs.readFileSync(path.join(home, '.claude/plugins/known_marketplaces.json'), 'utf8'));
  assert.equal(known.oathe.source.path, paths.packageRoot, 'the marketplace names the root the code actually lives at');
  const claudeCalls = exec.calls.filter((c) => c[0] === 'claude').map((c) => c.slice(1).join(' '));
  assert.deepEqual(claudeCalls, [
    'plugin marketplace remove oathe',
    `plugin marketplace add ${paths.packageRoot}`,
    'plugin install oathe@oathe',
  ], 'a moved root is a materialization: re-register, then install from the new source (the marketplace remove already took the old plugin with it)');
  assert.ok(result.actions.some((a) => a.harness === 'claude' && a.action === 'plugin-installed'));
});

test('doctor names a RUNTIME bound (a missing node module) apart from format DRIFT', async () => {
  const { traceStatusOf } = await import('../src/doctor.mjs');
  const runtime = new Error('node:sqlite is unavailable in this runtime'); runtime.code = 'TRACE_CODEX_SQLITE_UNSUPPORTED';
  assert.equal(traceStatusOf(runtime), 'RUNTIME');
  const drift = new Error('record shape changed'); drift.code = 'TRACE_SCHEMA_DRIFT';
  assert.equal(traceStatusOf(drift), 'DRIFT');
  assert.equal(traceStatusOf(new Error('anything else')), 'DRIFT', 'unknown failures stay loud as drift');
});

test('uninstall DELETES a file init created once nothing of substance remains in it — and keeps one that held anything else', async () => {
  const { runUninstall } = await import('../src/uninstall.mjs');
  const { home, env, exec } = sandbox();
  // The sandbox pre-creates settings.json ({theme}) and config.toml (# user config); cursor's
  // mcp.json and hooks.json do NOT exist — init creates them.
  await runInit({ env, exec });
  assert.ok(fs.existsSync(path.join(home, '.cursor/mcp.json')) && fs.existsSync(path.join(home, '.cursor/hooks.json')));
  await runUninstall({ env, exec });
  assert.ok(!fs.existsSync(path.join(home, '.cursor/mcp.json')), 'created by init, empty after uninstall → removed');
  assert.ok(!fs.existsSync(path.join(home, '.cursor/hooks.json')), 'created by init, empty after uninstall → removed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8')).theme, 'dark', 'the user\'s file stays, with the user\'s keys');
  assert.match(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8'), /# user config/);
});

test('a file init created that the USER later wrote into is kept on uninstall — only our entries leave', async () => {
  const { runUninstall } = await import('../src/uninstall.mjs');
  const { home, env, exec } = sandbox();
  await runInit({ env, exec });
  const mcp = path.join(home, '.cursor/mcp.json');
  const doc = JSON.parse(fs.readFileSync(mcp, 'utf8'));
  doc.mcpServers.theirs = { command: '/usr/local/bin/theirs' };
  fs.writeFileSync(mcp, `${JSON.stringify(doc, null, 2)}\n`);
  await runUninstall({ env, exec });
  const after = JSON.parse(fs.readFileSync(mcp, 'utf8'));
  assert.deepEqual(Object.keys(after.mcpServers), ['theirs']);
});

test('the verifier is a MACHINE-WIDE choice: a per-folder .oathe.json override in the cwd must not silence it', async () => {
  const { home, env } = sandbox();
  const project = fs.mkdtempSync(path.join(home, 'proj-'));
  fs.writeFileSync(path.join(project, '.oathe.json'), '{ "verifier": "codex" }\n');
  // Through the real bin, FROM that folder — the way the founder hit it (2026-08-29).
  const { spawnSync } = await import('node:child_process');
  // --harness cursor: the one onboarding with no CLI calls (the sandbox's claude/codex fakes are in-process only).
  const run = spawnSync(process.execPath, [path.join(paths.packageRoot, 'bin/oathe.mjs'), 'init', '--yes', '--harness', 'cursor'], { cwd: project, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fs.existsSync(path.join(env.OATHE_HOME, 'config.json')), 'the machine-wide choice is written to ~/.oathe/config.json whatever the folder overrides');
  assert.match(run.stdout, /verifier\s+\w+/);
  assert.doesNotMatch(run.stdout, /recorded machine-wide|switch with/, 'the summary verifier line is one word, not prose');
  assert.doesNotMatch(run.stdout, /skipped-not-|assume-yes/, 'the summary speaks sentences, not machine tokens');
});

test('when the machine-wide verifier IS already chosen, init says so instead of silently skipping', async () => {
  const { env, exec } = sandbox();
  fs.mkdirSync(env.OATHE_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.OATHE_HOME, 'config.json'), '{ "verifier": "codex" }\n');
  const out = [];
  const result = await runInit({ env, exec, out: { write: (t) => out.push(t), isTTY: false } });
  assert.equal(result.verifier_engine.asked, false);
  assert.equal(result.verifier_engine.chosen, 'codex');
  assert.match(result.verifier_engine.reason ?? '', /already chosen machine-wide/);
});

test('the verifier candidates require the CLI: an IDE-only Cursor is not offered; one with agent on PATH is', async () => {
  // The sandbox inherits the machine PATH (node must stay findable); this machine may carry a real
  // agent, so the IDE-only case pins PATH to the sandbox bin plus node's own directory.
  const nodeDir = path.dirname(process.execPath);
  const { home, env, exec } = sandbox(); // ~/.cursor exists
  const ideOnly = await runInit({ env: { ...env, PATH: `${path.join(home, 'bin')}:${nodeDir}` }, exec });
  assert.deepEqual(ideOnly.verifier_engine.candidates, ['claude', 'codex']);
  const { home: home2, env: env2, exec: exec2 } = sandbox();
  fs.writeFileSync(path.join(home2, 'bin/agent'), '#!/bin/sh\n'); fs.chmodSync(path.join(home2, 'bin/agent'), 0o755);
  const withCli = await runInit({ env: { ...env2, PATH: `${path.join(home2, 'bin')}:${nodeDir}` }, exec: exec2 });
  assert.deepEqual(withCli.verifier_engine.candidates, ['claude', 'codex', 'cursor']);
});

test('DECLARATIVE end-to-end: wire all → uncheck cursor on the screen → its files and rows are GONE, others byte-identical → the next screen shows [ ] and re-checking re-wires', async () => {
  const { home, env, exec } = sandbox();
  await runInit({ env, exec, assumeYes: true }); // fresh: wires all three
  const cursorFiles = [path.join(home, '.cursor/mcp.json'), path.join(home, '.cursor/hooks.json')];
  for (const f of cursorFiles) assert.ok(fs.existsSync(f), `${f} wired`);
  const othersBefore = [path.join(home, '.claude/settings.json'), path.join(home, '.codex/config.toml')]
    .map((f) => [f, fs.readFileSync(f, 'utf8')]);
  const { EventEmitter } = await import('node:events');
  const tty = () => {
    const writes = [];
    const out = Object.assign(new EventEmitter(), { isTTY: true, columns: 200, write: (t) => { writes.push(t); return true; } });
    const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: () => {}, pause: () => {}, resume: () => {} });
    return { writes, out, stdin };
  };
  const drive = (t, keys) => {
    let sent = false;
    const timer = setInterval(() => {
      if (!sent && /enter install/.test(t.writes.join(''))) { sent = true; t.stdin.emit('data', keys); }
    }, 10);
    return () => clearInterval(timer);
  };
  const t1 = tty();
  const stop1 = drive(t1, '\x1b[B\x1b[B \r'); // down down (to cursor) space (uncheck) Enter
  const second = await runInit({ env, exec, stdin: t1.stdin, out: t1.out }).finally(stop1);
  assert.deepEqual(second.steps.find((s) => s.name === 'cursor').outcome, 'unwired');
  for (const f of cursorFiles) assert.ok(!fs.existsSync(f), `${f} removed by the unwire`);
  const manifest = JSON.parse(fs.readFileSync(path.join(env.OATHE_HOME, 'install-manifest.json'), 'utf8'));
  assert.equal(manifest.rows.filter((r) => r.harness === 'cursor').length, 0, 'no cursor rows remain');
  for (const [f, before] of othersBefore) assert.equal(fs.readFileSync(f, 'utf8'), before, `${f} untouched by the cursor unwire`);
  const t2 = tty();
  const stop2 = drive(t2, '\x1b[B\x1b[B \r'); // same keys: cursor now [ ], space re-checks it
  const third = await runInit({ env, exec, stdin: t2.stdin, out: t2.out }).finally(stop2);
  assert.match(t2.writes.join('').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), /\[ \] Cursor/, 'the screen showed the unwired state');
  assert.ok(third.wired.includes('cursor'), 're-checking re-wires');
  for (const f of cursorFiles) assert.ok(fs.existsSync(f), `${f} re-wired`);
});

test('init plants the welcome marker ONLY when it CREATES the database — re-init plants nothing; a dropped-and-recreated DB replays', async () => {
  const WELCOME_DB = `oathe_welcome_init_${process.pid}`;
  const { env, exec } = sharedSandbox({ scratchDb: WELCOME_DB });
  const marker = path.join(env.OATHE_HOME, 'welcome-pending.json');
  try {
    const first = await runInit({ env, exec, assumeYes: true });
    assert.ok(fs.existsSync(marker), 'a freshly created database plants the one-shot welcome');
    assert.ok(first.actions.some((a) => a.harness === 'notch' && a.action === 'welcome-planted'),
      'the plant is reported as a fact');

    fs.rmSync(marker, { force: true }); // the feed consumed it
    const second = await runInit({ env, exec, assumeYes: true });
    assert.ok(!fs.existsSync(marker), 're-init against an existing database never replays');
    assert.ok(!second.actions.some((a) => a.action === 'welcome-planted'));

    const dropper = new Substrate({ database: WELCOME_DB, paths: buildPaths(env), env });
    await dropper.close();
    await dropper.dropDatabase();
    const third = await runInit({ env, exec, assumeYes: true });
    assert.ok(fs.existsSync(marker), 'a dropped-and-recreated database is made for the first time again');
    assert.ok(third.actions.some((a) => a.harness === 'notch' && a.action === 'welcome-planted'));
  } finally {
    const substrate = new Substrate({ database: WELCOME_DB, paths: buildPaths(env), env });
    await substrate.close();
    await substrate.dropDatabase();
  }
});

test('init and uninstall merge what landed on disk while they ran — a hook that activates mid-run keeps its row, and neither writes a snapshot over a living file (B4)', async () => {
  // Measured 2026-09-03: an init's rows vanished under a long-lived server's stale save (that
  // half is activation's refresh); the other half is init/uninstall themselves, which load at
  // their start and save once at their end while their CLI calls take seconds — a hook that
  // activates a workspace in between must not lose its fence row to that final save.
  const { env, exec } = sandbox();
  const { manifestPath, backupsDir } = buildPaths(env);
  const foreignFence = (file) => {
    const m = InstallManifest.load({ manifestPath, backupsDir });
    m.upsert({ harness: 'project', file, kind: 'fence', detail: null, blockVersion: '9.9.9', sha256: 'f' });
    m.save();
  };
  let fired = false;
  const midInit = { ...exec, run: (...a) => { if (!fired) { fired = true; foreignFence('/elsewhere/CLAUDE.md'); } return exec.run(...a); } };
  await runInit({ env, exec: midInit, assumeYes: true });
  assert.ok(fired, 'the interposed hook fired during init');
  const afterInit = InstallManifest.load({ manifestPath, backupsDir });
  assert.ok(afterInit.rows.some((r) => r.file === '/elsewhere/CLAUDE.md'), "the mid-init fence row survived init's save");
  assert.ok(afterInit.rows.some((r) => r.harness === 'claude'), 'and init recorded its own rows');
  fired = false;
  const midUninstall = { ...exec, run: (...a) => { if (!fired) { fired = true; foreignFence('/elsewhere2/CLAUDE.md'); } return exec.run(...a); } };
  await runUninstall({ env, exec: midUninstall });
  const afterUninstall = InstallManifest.load({ manifestPath, backupsDir });
  assert.ok(afterUninstall.rows.some((r) => r.file === '/elsewhere2/CLAUDE.md'), "a fence row that landed mid-uninstall survived (the next uninstall's business, never a lost update)");
  assert.ok(!afterUninstall.rows.some((r) => r.harness === 'claude' || r.file === '/elsewhere/CLAUDE.md'), "uninstall's own removals held");
});
