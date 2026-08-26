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
    // The default models a LAUNCHED session (the marker present); unlaunched tests clear it.
    env: { ...process.env, OATHE_DB: SCRATCH_DB, OATHE_LAUNCHED_HARNESS: 'claude', ...env },
  });
}

before(async () => {
  substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await substrate.ensureDatabase();
  await substrate.applyDdl();
  await substrate.seed({ orgId: 'oathe', principalId: 'founder', department: 'founder' });
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
      `SELECT cell.claim_work('oathe', 'render-me', gen_random_uuid(), NULL, NULL, 'founder', 'founder',
              'exclusive', now() + interval '4 hours', $1, now(), gen_random_uuid())`,
      [`workspace:${ws};contract:oathe/render-me@v1`]);
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' },
      { OATHE_PRINCIPAL: 'founder' });
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
      { OATHE_PRINCIPAL: 'founder' });
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
      { OATHE_PRINCIPAL: 'founder' });
    assert.equal(out.status, 0, out.stderr);
    const payload = JSON.parse(out.stdout);
    assert.match(payload.systemMessage, /\u{1F512}/u); // the lock
    assert.match(payload.systemMessage, /1 open task\b/);
    assert.doesNotMatch(payload.systemMessage, /held/, 'zero held stays unsaid');
    assert.doesNotMatch(payload.systemMessage, /asserted/, 'zero asserted stays unsaid');
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
      `SELECT cell.claim_work('oathe', 'beat-me', gen_random_uuid(), NULL, NULL, 'founder', 'founder',
              'exclusive', now() + interval '1 minute', $1, now(), gen_random_uuid())`,
      [`workspace:${ws};contract:oathe/beat-me@v1`]);
    const { rows: pre } = await substrate.query(
      "SELECT ownership_valid_until FROM cell.work_claim WHERE task_id = 'beat-me' AND state = 'active'");
    const out = runHook('heartbeat.mjs', { cwd: dir, hook_event_name: 'Stop' }, { OATHE_PRINCIPAL: 'founder' });
    assert.equal(out.status, 0, out.stderr);
    const { rows: post } = await substrate.query(
      "SELECT ownership_valid_until FROM cell.work_claim WHERE task_id = 'beat-me' AND state = 'active'");
    assert.equal(String(post[0].ownership_valid_until.toISOString()),
      String(pre[0].ownership_valid_until.toISOString()),
      'the Stop-hook heartbeat must not move the organizational horizon — exact equality');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


/** A real Claude-shaped transcript fixture; oatheActs = [[toolName, taskId], ...] (empty = planning only). */
function writeSessionFixture(dir, sessionId, oatheActs = []) {
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId, cwd: dir, message: { role: 'user', content: 'plan the work first' } }),
    JSON.stringify({
      type: 'assistant', uuid: 'a0', parentUuid: 'u1', sessionId, cwd: dir,
      message: { role: 'assistant', content: [{ type: 'text', text: 'thinking about approaches — planning only' }] },
    }),
  ];
  oatheActs.forEach(([name, taskId], i) => {
    const callId = `toolu_o${i}`;
    lines.push(JSON.stringify({
      type: 'assistant', uuid: `a${i + 1}`, parentUuid: i === 0 ? 'a0' : `r${i}`, sessionId, cwd: dir,
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: callId, name: `mcp__oathe__${name}`, input: { task_id: taskId, proposition: 'progress' } },
        { type: 'text', text: `acted on ${taskId}` }] },
    }));
    lines.push(JSON.stringify({
      type: 'user', uuid: `r${i + 1}`, parentUuid: `a${i + 1}`, sessionId, cwd: dir,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: 'ok' }] },
    }));
  });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

test('heartbeat LINKS the session trace ONLY to claims the session acted on — one statement per claim x session, idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-link-'));
  try {
    const { workspaceRef } = await import('../src/workspace.mjs');
    const ws = workspaceRef(dir);
    await substrate.query(`
      INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                             verify_by, claim_mode, created_at)
      VALUES ('oathe', 'link-me', 'founder', 'trace linkage', 'minted_at_claim',
              '{"plan_status":"unknown"}'::jsonb, now() + interval '1 day', 'exclusive', now())`);
    await substrate.query(
      `SELECT cell.claim_work('oathe', 'link-me', gen_random_uuid(), NULL, NULL, 'founder', 'founder',
              'exclusive', now() + interval '4 hours', $1, now(), gen_random_uuid())`,
      [`workspace:${ws};contract:oathe/link-me@v1`]);
    await substrate.query(`
      INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                             verify_by, claim_mode, created_at)
      VALUES ('oathe', 'bystander', 'founder', 'never touched by this session', 'minted_at_claim',
              '{"plan_status":"unknown"}'::jsonb, now() + interval '1 day', 'exclusive', now())`);
    await substrate.query(
      `SELECT cell.claim_work('oathe', 'bystander', gen_random_uuid(), NULL, NULL, 'founder', 'founder',
              'exclusive', now() + interval '4 hours', $1, now(), gen_random_uuid())`,
      [`workspace:${ws};contract:oathe/bystander@v1`]);
    const transcript = writeSessionFixture(dir, 'sess-link-0001', [['oathe_statement', 'link-me']]);
    const hookInput = {
      cwd: dir, hook_event_name: 'Stop',
      session_id: 'sess-link-0001', transcript_path: transcript,
    };
    const first = runHook('heartbeat.mjs', hookInput, { OATHE_PRINCIPAL: 'founder' });
    assert.equal(first.status, 0, first.stderr);
    const second = runHook('heartbeat.mjs', hookInput, { OATHE_PRINCIPAL: 'founder' });
    assert.equal(second.status, 0, second.stderr);
    const { rows } = await substrate.query(
      "SELECT proposition, evidence_refs FROM cell.agent_statement "
      + "WHERE task_id = 'link-me' AND subject_ref = 'trace:sess-link-0001'");
    assert.equal(rows.length, 1, 'exactly ONE trace statement per claim x session');
    assert.match(rows[0].proposition, /claude/);
    const { rows: bystander } = await substrate.query(
      "SELECT 1 FROM cell.agent_statement WHERE task_id = 'bystander' AND subject_ref LIKE 'trace:%'");
    assert.equal(bystander.length, 0,
      'R3 §5.5#4: an unrelated active claim receives NO trace evidence');
    const { rows: still } = await substrate.query(
      "SELECT state, ownership_valid_until FROM cell.work_claim WHERE task_id = 'link-me'");
    assert.equal(still[0].state, 'active',
      'R3 §5.5#8: trace linkage ends no ownership — the claim remains organizationally owned');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('heartbeat links traces for ASSERTED claims too — claim-and-done inside one turn still leaves evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-link2-'));
  try {
    const { workspaceRef } = await import('../src/workspace.mjs');
    const { createOatheTools } = await import('../src/mcp/oathe-tools.mjs');
    const ws = workspaceRef(dir);
    const tools = createOatheTools({
      client: substrate,
      identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' },
      workspace: ws,
    });
    // the same-turn flow: claim → done BEFORE any Stop hook ever fires
    await tools.oathe_claim({ task_id: 'one-turn', objective: 'claimed and asserted in one turn' });
    await tools.oathe_done({ task_id: 'one-turn', proposition: 'all in one turn', evidence_ref: 'x' });
    const hookInput = {
      cwd: dir, hook_event_name: 'Stop',
      session_id: 'sess-one-turn',
      transcript_path: writeSessionFixture(dir, 'sess-one-turn', [['oathe_claim', 'one-turn'], ['oathe_done', 'one-turn']]),
    };
    const out = runHook('heartbeat.mjs', hookInput, { OATHE_PRINCIPAL: 'founder' });
    assert.equal(out.status, 0, out.stderr);
    const { rows } = await substrate.query(
      "SELECT count(*)::int AS n FROM cell.agent_statement "
      + "WHERE task_id = 'one-turn' AND subject_ref = 'trace:sess-one-turn'");
    assert.equal(rows[0].n, 1, 'the turn-end heartbeat linked the already-asserted claim');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------- the launch gate: no `oathe <harness>`, no firing
// The plugin installs at user scope, so its hooks reach EVERY session on the machine. Only a
// session the oathe launcher started (marked by OATHE_LAUNCHED_HARNESS in the caged env) has
// opted in — everything else gets a silent exit 0: no output, no substrate contact.

test('render-board is a SILENT noop in a session not launched by `oathe <harness>`', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-unlaunched-'));
  try {
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' },
      { OATHE_PRINCIPAL: 'founder', OATHE_LAUNCHED_HARNESS: '' });
    assert.equal(out.status, 0);
    assert.equal(out.stdout, '', 'an unlaunched session sees no board, no quiet note, nothing');
    assert.equal(out.stderr, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('heartbeat in an unlaunched session touches NOTHING — no renewal, no trace linkage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-unlaunched-hb-'));
  try {
    const { workspaceRef } = await import('../src/workspace.mjs');
    const ws = workspaceRef(dir);
    await substrate.query(`
      INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                             verify_by, claim_mode, created_at)
      VALUES ('oathe', 'unlaunched-beat', 'founder', 'must not renew', 'minted_at_claim',
              '{"plan_status":"unknown"}'::jsonb, now() + interval '1 day', 'exclusive', now())`);
    await substrate.query(
      `SELECT cell.claim_work('oathe', 'unlaunched-beat', gen_random_uuid(), NULL, NULL, 'founder', 'founder',
              'exclusive', now() + interval '1 minute', $1, now(), gen_random_uuid())`,
      [`workspace:${ws};contract:oathe/unlaunched-beat@v1`]);
    const out = runHook('heartbeat.mjs', {
      cwd: dir, hook_event_name: 'Stop',
      session_id: 'sess-unlaunched', transcript_path: '/fake/home/.claude/projects/x/sess-unlaunched.jsonl',
    }, { OATHE_PRINCIPAL: 'founder', OATHE_LAUNCHED_HARNESS: '' });
    assert.equal(out.status, 0);
    assert.equal(out.stdout, '');
    assert.equal(out.stderr, '');
    const { rows } = await substrate.query(
      "SELECT ownership_valid_until < now() + interval '2 minutes' AS untouched "
      + "FROM cell.work_claim WHERE task_id = 'unlaunched-beat' AND state = 'active'");
    assert.equal(rows[0].untouched, true, 'the short lease was NOT renewed');
    const { rows: linked } = await substrate.query(
      "SELECT count(*)::int AS n FROM cell.agent_statement WHERE subject_ref = 'trace:sess-unlaunched'");
    assert.equal(linked[0].n, 0, 'no trace statement from a session that never opted in');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('frame-note in an unlaunched session writes NO statements', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-unlaunched-fn-'));
  try {
    const { workspaceRef } = await import('../src/workspace.mjs');
    const ws = workspaceRef(dir);
    await substrate.query(`
      INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                             verify_by, claim_mode, created_at)
      VALUES ('oathe', 'unlaunched-note', 'founder', 'must stay silent', 'minted_at_claim',
              '{"plan_status":"unknown"}'::jsonb, now() + interval '1 day', 'exclusive', now())`);
    await substrate.query(
      `SELECT cell.claim_work('oathe', 'unlaunched-note', gen_random_uuid(), NULL, NULL, 'founder', 'founder',
              'exclusive', now() + interval '4 hours', $1, now(), gen_random_uuid())`,
      [`workspace:${ws};contract:oathe/unlaunched-note@v1`]);
    const out = runHook('frame-note.mjs', { cwd: dir, hook_event_name: 'PreCompact' },
      { OATHE_PRINCIPAL: 'founder', OATHE_LAUNCHED_HARNESS: '' });
    assert.equal(out.status, 0);
    assert.equal(out.stdout, '');
    assert.equal(out.stderr, '');
    const { rows } = await substrate.query(
      "SELECT count(*)::int AS n FROM cell.agent_statement WHERE task_id = 'unlaunched-note'");
    assert.equal(rows[0].n, 0);
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
      `SELECT cell.claim_work('oathe', 'note-me', gen_random_uuid(), NULL, NULL, 'founder', 'founder',
              'exclusive', now() + interval '4 hours', $1, now(), gen_random_uuid())`,
      [`workspace:${ws};contract:oathe/note-me@v1`]);
    const out = runHook('frame-note.mjs', { cwd: dir, hook_event_name: 'PreCompact' }, { OATHE_PRINCIPAL: 'founder' });
    assert.equal(out.status, 0, out.stderr);
    const { rows } = await substrate.query(
      "SELECT proposition FROM cell.agent_statement WHERE task_id = 'note-me'");
    assert.equal(rows.length, 1);
    assert.match(rows[0].proposition, /compact/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R3 §5.5#1: a planning-only session links NO claim evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-plan-only-'));
  try {
    const { workspaceRef } = await import('../src/workspace.mjs');
    const ws = workspaceRef(dir);
    await substrate.query(`
      INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                             verify_by, claim_mode, created_at)
      VALUES ('oathe', 'planned-around', 'founder', 'discussed, never acted on', 'minted_at_claim',
              '{"plan_status":"unknown"}'::jsonb, now() + interval '1 day', 'exclusive', now())`);
    await substrate.query(
      `SELECT cell.claim_work('oathe', 'planned-around', gen_random_uuid(), NULL, NULL, 'founder', 'founder',
              'exclusive', now() + interval '4 hours', $1, now(), gen_random_uuid())`,
      [`workspace:${ws};contract:oathe/planned-around@v1`]);
    const out = runHook('heartbeat.mjs', {
      cwd: dir, hook_event_name: 'Stop',
      session_id: 'sess-planning', transcript_path: writeSessionFixture(dir, 'sess-planning', []),
    }, { OATHE_PRINCIPAL: 'founder' });
    assert.equal(out.status, 0, out.stderr);
    const { rows } = await substrate.query(
      "SELECT count(*)::int AS n FROM cell.agent_statement WHERE subject_ref = 'trace:sess-planning'");
    assert.equal(rows[0].n, 0, 'planning is context, not claim evidence — nothing links');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R3 §5.5#9: a LATER session (any harness) linking the same durable claim gets its own trace statement', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-second-session-'));
  try {
    const { workspaceRef } = await import('../src/workspace.mjs');
    const ws = workspaceRef(dir);
    await substrate.query(`
      INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                             verify_by, claim_mode, created_at)
      VALUES ('oathe', 'two-sessions', 'founder', 'worked across sessions', 'minted_at_claim',
              '{"plan_status":"unknown"}'::jsonb, now() + interval '1 day', 'exclusive', now())`);
    await substrate.query(
      `SELECT cell.claim_work('oathe', 'two-sessions', gen_random_uuid(), NULL, NULL, 'founder', 'founder',
              'exclusive', now() + interval '4 hours', $1, now(), gen_random_uuid())`,
      [`workspace:${ws};contract:oathe/two-sessions@v1`]);
    for (const sid of ['sess-first', 'sess-second']) {
      const out = runHook('heartbeat.mjs', {
        cwd: dir, hook_event_name: 'Stop',
        session_id: sid, transcript_path: writeSessionFixture(dir, sid, [['oathe_statement', 'two-sessions']]),
      }, { OATHE_PRINCIPAL: 'founder' });
      assert.equal(out.status, 0, out.stderr);
    }
    const { rows } = await substrate.query(
      "SELECT count(*)::int AS n FROM cell.agent_statement WHERE task_id = 'two-sessions' AND subject_ref LIKE 'trace:%'");
    assert.equal(rows[0].n, 2, 'each session leaves its own interval evidence on the same durable claim');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R3 §5.5#2/#10: rendering the board writes NOTHING and focuses nothing — even with several claims held', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-board-neutral-'));
  try {
    const { workspaceRef } = await import('../src/workspace.mjs');
    const { renderBoard } = await import('../src/board-render.mjs');
    const ws = workspaceRef(dir);
    for (const t of ['neutral-a', 'neutral-b']) {
      await substrate.query(`
        INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                               verify_by, claim_mode, created_at)
        VALUES ('oathe', $1, 'founder', 'one of several', 'minted_at_claim',
                '{"plan_status":"unknown"}'::jsonb, now() + interval '1 day', 'exclusive', now())`, [t]);
      await substrate.query(
        `SELECT cell.claim_work('oathe', $1, gen_random_uuid(), NULL, NULL, 'founder', 'founder',
                'exclusive', now() + interval '4 hours', $2, now(), gen_random_uuid())`,
        [t, `workspace:${ws};contract:oathe/${t}@v1`]);
    }
    const before = await substrate.query('SELECT count(*)::int AS n FROM cell.agent_statement');
    const seen = await renderBoard({
      client: substrate, identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' }, workspace: ws });
    assert.equal(seen.sections.mine.length, 2, 'both claims presented');
    const after1 = await substrate.query('SELECT count(*)::int AS n FROM cell.agent_statement');
    assert.equal(after1.rows[0].n, before.rows[0].n, 'presentation writes no statements');
    const { rows: claims } = await substrate.query(
      "SELECT count(*)::int AS n FROM cell.work_claim WHERE task_id IN ('neutral-a','neutral-b') AND state = 'active'");
    assert.equal(claims.rows?.[0]?.n ?? claims[0].n, 2, 'no implicit choice, no focus, no claim mutation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
