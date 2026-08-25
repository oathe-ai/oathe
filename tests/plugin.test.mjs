import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { buildPaths } from '../src/paths.mjs';
import { Substrate } from '../src/substrate.mjs';

const paths = buildPaths({});
const pkg = JSON.parse(fs.readFileSync(path.join(paths.packageRoot, 'package.json'), 'utf8'));

// Both harnesses' hook event vocabularies (Claude docs + Codex source, 2026-08-25 research pass).
const CLAUDE_EVENTS = ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit',
  'Stop', 'StopFailure', 'SubagentStop', 'PreCompact', 'Notification'];
const CODEX_EVENTS = ['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreToolUse',
  'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'UserPromptSubmit', 'Stop', 'Interrupt'];

test('plugin.json is valid and version-locked to the package', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(paths.pluginDir, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'oathe');
  assert.equal(manifest.version, pkg.version);
  assert.ok(manifest.description.length > 0);
});

test('the package-root marketplace lists the plugin at a relative source (serves Claude AND Codex)', () => {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(paths.packageRoot, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(marketplace.name, 'oathe');
  assert.ok(marketplace.owner?.name);
  assert.deepEqual(marketplace.plugins.map((p) => [p.name, p.source]), [['oathe', './plugin']]);
});

test('hooks.json uses only events BOTH harnesses know, with plugin-root commands and timeouts', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(paths.pluginDir, 'hooks/hooks.json'), 'utf8')).hooks;
  const events = Object.keys(hooks);
  assert.deepEqual(events.sort(), ['PreCompact', 'SessionStart', 'Stop'].sort());
  for (const event of events) {
    assert.ok(CLAUDE_EVENTS.includes(event), `${event} unknown to Claude`);
    assert.ok(CODEX_EVENTS.includes(event), `${event} unknown to Codex`);
    for (const group of hooks[event]) {
      for (const hook of group.hooks) {
        assert.equal(hook.type, 'command');
        // The plugin tree carries NO paths: the plugin is COPIED to each harness's cache on
        // install, so the one stable machine-independent address is the npm bin on PATH.
        assert.match(hook.command, /^oathe hook [a-z-]+$/, hook.command);
        assert.ok(Number.isInteger(hook.timeout) && hook.timeout <= 10, 'timeout in seconds, snappy');
      }
    }
  }
  assert.equal(hooks.SessionStart[0].matcher, 'startup|resume|clear');
});

test('the skill obeys the Agent Skills spec: name equals its directory, bounded description, short body', () => {
  const skillPath = path.join(paths.pluginDir, 'skills/oathe-work/SKILL.md');
  const raw = fs.readFileSync(skillPath, 'utf8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(fm, 'frontmatter present');
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1].trim();
  const description = fm[1].match(/^description:\s*(.+)$/m)?.[1].trim();
  assert.equal(name, 'oathe-work');
  assert.ok(description.length > 0 && description.length <= 1024);
  assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(fm[2].split('\n').length < 500, 'body under 500 lines');
});

test('.mcp.json registers the oathe server through the bin — no paths in the plugin tree', () => {
  const mcp = JSON.parse(fs.readFileSync(path.join(paths.pluginDir, '.mcp.json'), 'utf8'));
  const server = mcp.mcpServers?.oathe ?? mcp.oathe;
  assert.equal(server.command, 'oathe');
  assert.deepEqual(server.args, ['mcp']);
  assert.equal(server.env.OATHE_WORKSPACE_DIR, '${CLAUDE_PROJECT_DIR}');
});

// ------------------------------------------------------- hook scripts against a real cell

const SCRATCH_DB = `oathe_plugin_test_${process.pid}`;
let substrate;

function runHook(script, hookInput, env = {}) {
  return spawnSync('node', [path.join(paths.pluginDir, 'hooks', script)], {
    input: JSON.stringify(hookInput),
    encoding: 'utf8',
    env: { ...process.env, OATHE_DB: SCRATCH_DB, ...env },
  });
}

before(async () => {
  substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await substrate.ensureDatabase();
  await substrate.applyDdl();
  await substrate.seed({ orgId: 'oathe', principalId: 'firia', department: 'founder' });
  await substrate.registerYieldCause();
});

after(async () => {
  await substrate.close();
  await substrate.dropDatabase();
});

test('render-board prints this workspace board as markdown at SessionStart', async () => {
  const dir = fs.mkdtempSync(path.join(paths.packageRoot, 'tmp-ws-'));
  try {
    const { workspaceRef } = await import('../src/workspace.mjs');
    const ws = workspaceRef(dir);
    await substrate.query(`
      INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                             verify_by, claim_mode, created_at)
      VALUES ('oathe', 'render-me', 'founder', 'shown on the board', 'minted_at_claim',
              '{"plan_status":"unknown"}'::jsonb, now() + interval '1 day', 'exclusive', now())`);
    await substrate.query(
      `SELECT cell.claim_work('oathe', 'render-me', gen_random_uuid(), NULL, 'firia', 'founder',
              'exclusive', now() + interval '4 hours', $1, now(), gen_random_uuid())`,
      [`workspace:${ws};contract:oathe/render-me@v1`]);
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' },
      { OATHE_PRINCIPAL: 'firia' });
    assert.equal(out.status, 0, out.stderr);
    const payload = JSON.parse(out.stdout);
    const context = payload.hookSpecificOutput.additionalContext;
    assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(context, /## Oathe board/);
    assert.match(context, /render-me/);
    assert.match(context, /yours/i);
    // RECOVERY: state carried across sessions earns the celebration + the star ask.
    assert.match(payload.systemMessage, /\u{1F389}/u);
    assert.match(payload.systemMessage, /saved your session state/i);
    assert.match(payload.systemMessage, /1 task still yours/);
    assert.match(payload.systemMessage, /github\.com\/oathe-ai\/oathe/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('render-board NEVER breaks a session: with the substrate absent it exits 0 with a visible quiet note', () => {
  const out = runHook('render-board.mjs', { cwd: paths.packageRoot }, { OATHE_DB: 'oathe_never_created' });
  assert.equal(out.status, 0);
  const payload = JSON.parse(out.stdout);
  assert.match(payload.systemMessage, /unavailable|not initialized/i);
});

test('render-board on a workspace with NOTHING open confirms visibly that oathe is on watch', () => {
  // OUTSIDE the repo: any dir under packageRoot resolves to the repo's own workspace ref.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-empty-'));
  try {
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' },
      { OATHE_PRINCIPAL: 'firia' });
    assert.equal(out.status, 0, out.stderr);
    const payload = JSON.parse(out.stdout);
    assert.match(payload.systemMessage, /\u{1F37A}/u); // the beer
    assert.match(payload.systemMessage, /no open tasks/i);
    assert.match(payload.systemMessage, /keeping track/i);
    assert.doesNotMatch(payload.systemMessage, /github\.com/, 'the star ask rides RECOVERY only');
    assert.match(payload.hookSpecificOutput.additionalContext, /no open tasks/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('open tasks that are NOT yours summarize without celebration or the star ask', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-offered-'));
  try {
    // An unclaimed task carries no workspace yet, so every folder's list offers it.
    await substrate.query(`
      INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                             verify_by, claim_mode, created_at)
      VALUES ('oathe', 'unsigned-task', 'founder', 'anyone may sign', 'minted_at_claim',
              '{"plan_status":"unknown"}'::jsonb, now() + interval '1 day', 'exclusive', now())`);
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' },
      { OATHE_PRINCIPAL: 'firia' });
    assert.equal(out.status, 0, out.stderr);
    const payload = JSON.parse(out.stdout);
    assert.match(payload.systemMessage, /\u{1F512}/u); // the lock
    assert.match(payload.systemMessage, /1 open \u00b7 0 held/);
    assert.doesNotMatch(payload.systemMessage, /contracts|for signing|elsewhere/i);
    assert.doesNotMatch(payload.systemMessage, /\u{1F389}/u);
    assert.doesNotMatch(payload.systemMessage, /github\.com/);
  } finally {
    await substrate.query("DELETE FROM cell.task WHERE task_id = 'unsigned-task'");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('heartbeat (Stop) renews the active lease for this workspace', async () => {
  const dir = fs.mkdtempSync(path.join(paths.packageRoot, 'tmp-hb-'));
  try {
    const { workspaceRef } = await import('../src/workspace.mjs');
    const ws = workspaceRef(dir);
    await substrate.query(`
      INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                             verify_by, claim_mode, created_at)
      VALUES ('oathe', 'beat-me', 'founder', 'lease renewal', 'minted_at_claim',
              '{"plan_status":"unknown"}'::jsonb, now() + interval '1 day', 'exclusive', now())`);
    await substrate.query(
      `SELECT cell.claim_work('oathe', 'beat-me', gen_random_uuid(), NULL, 'firia', 'founder',
              'exclusive', now() + interval '1 minute', $1, now(), gen_random_uuid())`,
      [`workspace:${ws};contract:oathe/beat-me@v1`]);
    const out = runHook('heartbeat.mjs', { cwd: dir, hook_event_name: 'Stop' }, { OATHE_PRINCIPAL: 'firia' });
    assert.equal(out.status, 0, out.stderr);
    const { rows } = await substrate.query(
      "SELECT ownership_valid_until > now() + interval '3 hours' AS renewed "
      + "FROM cell.work_claim WHERE task_id = 'beat-me' AND state = 'active'");
    assert.equal(rows[0].renewed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('frame-note (PreCompact) records a compaction statement against active claims here', async () => {
  const dir = fs.mkdtempSync(path.join(paths.packageRoot, 'tmp-fn-'));
  try {
    const { workspaceRef } = await import('../src/workspace.mjs');
    const ws = workspaceRef(dir);
    await substrate.query(`
      INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                             verify_by, claim_mode, created_at)
      VALUES ('oathe', 'note-me', 'founder', 'compaction note', 'minted_at_claim',
              '{"plan_status":"unknown"}'::jsonb, now() + interval '1 day', 'exclusive', now())`);
    await substrate.query(
      `SELECT cell.claim_work('oathe', 'note-me', gen_random_uuid(), NULL, 'firia', 'founder',
              'exclusive', now() + interval '4 hours', $1, now(), gen_random_uuid())`,
      [`workspace:${ws};contract:oathe/note-me@v1`]);
    const out = runHook('frame-note.mjs', { cwd: dir, hook_event_name: 'PreCompact' }, { OATHE_PRINCIPAL: 'firia' });
    assert.equal(out.status, 0, out.stderr);
    const { rows } = await substrate.query(
      "SELECT proposition FROM cell.agent_statement WHERE task_id = 'note-me'");
    assert.equal(rows.length, 1);
    assert.match(rows[0].proposition, /compact/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
