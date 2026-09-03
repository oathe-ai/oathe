// ONE fence writer: activation puts the managed `## Oathe` section into the context files of
// every harness detected on the machine (each adapter's own declared fact), records
// project-scope manifest rows + registry fences, and discloses what it wrote. The launcher
// preflight, the SessionStart hook, and oathe_claim all call THIS — byte-identical output,
// no drift between paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { activateWorkspace } from '../src/activation.mjs';
import { InstallManifest } from '../src/manifest.mjs';
import { WorkspaceRegistry } from '../src/registry.mjs';
import { OatheConfig } from '../src/config.mjs';
import { workspaceRef } from '../src/workspace.mjs';
import { sandbox } from './helpers.mjs';

const CLOCK = () => '2026-08-28T12:00:00.000Z';

function fixture({ extraEnv = {} } = {}) {
  const sb = sandbox({ scratchDb: 'unused' }); // sandbox home carries .claude, .codex, AND .cursor
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-act-ws-')));
  const oatheHome = path.join(sb.home, '.oathe');
  const manifest = new InstallManifest({
    manifestPath: path.join(oatheHome, 'install-manifest.json'),
    backupsDir: path.join(oatheHome, 'backups'),
    clock: CLOCK,
  });
  const registry = new WorkspaceRegistry({ registryPath: path.join(oatheHome, 'workspaces.json'), clock: CLOCK });
  const env = { ...sb.env, ...extraEnv };
  const config = new OatheConfig({ env, cwd });
  return { sb, cwd, manifest, registry, config, env };
}

test('activation never writes back a stale snapshot: a row another writer saved after this context loaded survives the activation (B4)', async () => {
  const { cwd, manifest, registry, config, env } = fixture();
  manifest.save(); // the context loaded (an empty manifest) at the server's first tool call…
  const init = new InstallManifest({ manifestPath: manifest.manifestPath, backupsDir: manifest.backupsDir, clock: CLOCK });
  init.upsert({ harness: 'claude', file: '/h/.claude/settings.json', kind: 'json-path', detail: { paths: [['a']] }, blockVersion: '0.4.1', sha256: 'x' });
  init.save(); // …then `oathe init` ran in another process and recorded its wiring.
  await activateWorkspace({ cwd, env, manifest, registry, config, version: '9.9.9', source: 'tool:oathe_claim' });
  const onDisk = JSON.parse(fs.readFileSync(manifest.manifestPath, 'utf8')).rows;
  assert.ok(onDisk.some((r) => r.harness === 'claude' && r.kind === 'json-path'), "init's row is still on disk after the long-lived context's activation");
  assert.ok(onDisk.some((r) => r.kind === 'fence'), 'and the activation recorded its own fence rows');
  assert.ok(manifest.rows.some((r) => r.harness === 'claude'), 'the context now sees the row it did not write');
});

test('activation writes the fence into every detected harness context file, records, and discloses', async () => {
  const { cwd, manifest, registry, config, env } = fixture();
  const out = await activateWorkspace({
    cwd, env, manifest, registry, config, version: '9.9.9', source: 'hook:session-start',
  });
  const ref = workspaceRef(cwd);
  assert.equal(out.workspace, ref);
  assert.deepEqual(out.fences.sort(), ['AGENTS.md', 'CLAUDE.md'], 'claude + codex detected in the sandbox');
  const claudeMd = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
  assert.ok(claudeMd.includes('## Oathe'));
  assert.ok(claudeMd.includes(ref));
  assert.ok(!/SessionStart/.test(claudeMd), 'the fence body is surface-neutral — hooks may not fire everywhere');
  assert.equal(claudeMd, fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8'), 'one body for every surface');
  const rows = manifest.rows.filter((r) => r.kind === 'fence');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.scope === 'project'));
  assert.deepEqual(registry.get(ref).fences, { 'CLAUDE.md': '9.9.9', 'AGENTS.md': '9.9.9' });
  assert.equal(registry.get(ref).registered_by, 'hook:session-start');
  assert.match(out.disclosed, /CLAUDE\.md/);
  assert.match(out.disclosed, /AGENTS\.md/);
});

test('activation is byte-idempotent: a second run changes nothing and says so', async () => {
  const { cwd, manifest, registry, config, env } = fixture();
  const o = { cwd, env, manifest, registry, config, version: '9.9.9', source: 'mcp:oathe_claim' };
  await activateWorkspace(o);
  const before = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
  const second = await activateWorkspace(o);
  assert.equal(fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8'), before);
  assert.ok(second.actions.every((a) => a.changed === false));
});

test('a user CLAUDE.md is appended to, backed up once, and its own content never touched', async () => {
  const { cwd, manifest, registry, config, env } = fixture();
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# My project\n\nMy own notes.\n');
  await activateWorkspace({ cwd, env, manifest, registry, config, version: '9.9.9', source: 'cli:claim' });
  const text = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
  assert.ok(text.startsWith('# My project\n\nMy own notes.\n'));
  assert.ok(text.includes('## Oathe'));
  const backup = manifest.backups.find((b) => b.file === path.join(cwd, 'CLAUDE.md'));
  assert.equal(backup.absent_before, false);
  assert.ok(fs.readFileSync(backup.backup, 'utf8').includes('My own notes'));
});

test('autoActivate=false registers centrally but writes NO files, disclosed honestly', async () => {
  const { cwd, manifest, registry, config, env } = fixture({ extraEnv: { OATHE_AUTO_ACTIVATE: 'false' } });
  const out = await activateWorkspace({
    cwd, env, manifest, registry, config, version: '9.9.9', source: 'hook:session-start',
  });
  assert.deepEqual(out.fences, []);
  assert.ok(!fs.existsSync(path.join(cwd, 'CLAUDE.md')));
  assert.equal(manifest.rows.length, 0);
  assert.ok(registry.get(workspaceRef(cwd)), 'registration still happened');
  assert.match(out.disclosed, /registered only|activation off/i);
});

test('cursor detection alone (config home, no CLI) brings AGENTS.md into the target set', async () => {
  const { sb, cwd, manifest, registry, config } = fixture();
  // A machine with ONLY cursor: point env HOME at a home carrying just ~/.cursor.
  const bareHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-act-home-')));
  fs.mkdirSync(path.join(bareHome, '.cursor'));
  const env = { ...sb.env, HOME: bareHome, PATH: '/nonexistent' };
  const out = await activateWorkspace({
    cwd, env, manifest, registry, config, version: '9.9.9', source: 'hook:session-start',
  });
  assert.deepEqual(out.fences, ['AGENTS.md'], 'cursor reads AGENTS.md; no CLAUDE.md-reading harness present');
});

test('uninstall coverage: the fence rows carry everything needed to remove them', async () => {
  const { cwd, manifest, registry, config, env } = fixture();
  await activateWorkspace({ cwd, env, manifest, registry, config, version: '9.9.9', source: 'cli:claim' });
  const fenceRows = manifest.rows.filter((r) => r.kind === 'fence');
  for (const row of fenceRows) {
    assert.ok(fs.existsSync(row.file));
    assert.equal(row.harness, 'project');
    assert.ok(row.sha256);
    assert.equal(row.block_version, '9.9.9');
  }
});

test('R-BOARD-SCOPE: a synthetic workspace is never activated — no fences, no registry row, said plainly', async () => {
  const { sb, manifest, registry, config, env } = fixture();
  const staging = path.join(sb.home, '.codex/.chatgpt-projects/g-p-synthetic');
  fs.mkdirSync(staging, { recursive: true });
  const out = await activateWorkspace({
    cwd: staging, env, manifest, registry, config, version: '9.9.9', source: 'hook:session-start',
  });
  assert.equal(out.registered, false);
  assert.deepEqual(out.fences, []);
  assert.match(out.disclosed, /synthetic/i);
  assert.ok(!fs.existsSync(path.join(staging, 'CLAUDE.md')) && !fs.existsSync(path.join(staging, 'AGENTS.md')));
  assert.equal(registry.list().length, 0, 'a staging dir carries no board — not even a registry row');
  assert.equal(manifest.rows.length, 0);
});

test('the GLOBAL fence body speaks to sessions with no folder: machine-wide board, homeless claims, true in a folder too', async () => {
  const { globalFenceBody, fenceBody, SPEECH_ACT_RULE } = await import('../src/fence.mjs');
  const body = globalFenceBody();
  const flat = body.replaceAll('\n', ' '); // the file is wrapped for people; the sentences are what matter
  assert.ok(body.startsWith('## Oathe'));
  assert.match(flat, /homeless/);
  assert.match(flat, /claim before you build/);
  assert.ok(flat.includes(SPEECH_ACT_RULE), 'one sentence carries the rule everywhere');
  assert.ok(body.split('\n').every((l) => l.length <= 90), 'wrapped for the humans who read the file');
  assert.doesNotMatch(body, /workspace `ws-/, 'no folder identity — it is read by every session');
  assert.equal(fenceBody('ws-000000000000').includes('workspace `ws-000000000000`'), true, 'the folder body is unchanged');
});

test('activation REFUSES the home directory — no ~/CLAUDE.md, no registry row, the typed refusal', async () => {
  const { sb, manifest, registry, config, env } = fixture();
  await assert.rejects(
    activateWorkspace({ cwd: sb.home, env, manifest, registry, config, version: '9.9.9', source: 'cli:claim' }),
    (e) => e.code === 'OATHE_WORKSPACE_UNRESOLVED');
  assert.ok(!fs.existsSync(path.join(sb.home, 'CLAUDE.md')) && !fs.existsSync(path.join(sb.home, 'AGENTS.md')));
  assert.equal(registry.list().length, 0);
});
