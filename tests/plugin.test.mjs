import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { buildPaths } from '../src/paths.mjs';
import { Substrate } from '../src/substrate.mjs';
import { sandbox } from './helpers.mjs';

const paths = buildPaths({});
const pkg = JSON.parse(fs.readFileSync(path.join(paths.packageRoot, 'package.json'), 'utf8'));

// The Claude Code and Codex hook event vocabularies (Claude docs + Codex source, 2026-08-25 research pass).
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

test('hooks.json uses only events Claude Code and Codex both know, with plugin-root commands and timeouts', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(paths.pluginDir, 'hooks/hooks.json'), 'utf8')).hooks;
  const events = Object.keys(hooks);
  assert.deepEqual(events.sort(), ['PreCompact', 'SessionStart', 'Stop'].sort());
  for (const event of events) {
    assert.ok(CLAUDE_EVENTS.includes(event), `${event} unknown to Claude`);
    assert.ok(CODEX_EVENTS.includes(event), `${event} unknown to Codex`);
    for (const group of hooks[event]) {
      for (const hook of group.hooks) {
        assert.equal(hook.type, 'command');
        // The plugin tree carries no MACHINE paths — but a bare bin on PATH dies in every
        // GUI-launched session (launchd's PATH has no nvm; measured 2026-09-04, the claims
        // that never landed). The one machine-independent durable address is the shim the
        // installer materializes under $HOME/.oathe/bin, reached via SHELL-FORM expansion.
        assert.match(hook.command, /^"\$HOME\/\.oathe\/bin\/oathe" hook [a-z-]+$/, hook.command);
        assert.ok(!('args' in hook),
          'shell form is load-bearing: an args array makes the harness exec directly and "$HOME" never expands');
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

test('the plugin carries NO MCP server — the connection is init-written at user scope, on the shim', () => {
  // A plugin-carried server is a RECIPE cached by copy: it can never hold a machine address,
  // so it rode PATH and died in GUI sessions (2026-09-04). The connection is an ADDRESS now —
  // `claude mcp add -s user` written by init — and a plugin entry beside it would register a
  // second server under a different name (plugin:oathe:oathe). The plugin keeps the session
  // surfaces (hooks, skill, commands); it carries no connection at all.
  assert.ok(!fs.existsSync(path.join(paths.pluginDir, '.mcp.json')),
    'plugin/.mcp.json must not exist — the MCP entry is init-written, never plugin-carried');
});

test('the .cursor-plugin manifest adapter mirrors the plugin: version-locked, shim-addressed MCP, inline cursor-dialect hooks', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(paths.pluginDir, '.cursor-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'oathe');
  assert.equal(manifest.version, pkg.version);
  // ${userHome} interpolation is documented for mcp.json's command field (cursor/mcp.md,
  // pinned) — the one machine-independent way a COPIED manifest can say the shim.
  assert.deepEqual(manifest.mcpServers.oathe,
    { command: '${userHome}/.oathe/bin/oathe', args: ['mcp'] });
  const events = Object.keys(manifest.hooks.hooks);
  assert.deepEqual(events.sort(), ['preCompact', 'sessionStart', 'stop'].sort(),
    'the same three lifecycle moments, in Cursor vocabulary');
  for (const event of events) {
    for (const hook of manifest.hooks.hooks[event]) {
      // ACCEPTED EXCEPTION (2026-09-04): interpolation is documented for mcpServers fields,
      // NOT for hook commands — a marketplace install without `oathe init` keeps PATH hooks
      // (fail-soft surface); the init-written ~/.cursor hooks carry the absolute address.
      assert.match(hook.command, /^oathe hook [a-z-]+$/,
        'hook commands stay bare until Cursor documents interpolation for them');
    }
  }
});

// ------------------------------------------------------- hook scripts against a real cell

const SCRATCH_DB = `oathe_plugin_test_${process.pid}`;
let substrate;

// Hooks fire in EVERY session — so the
// hook env is a SANDBOX home: activation's registry/manifest/fence writes land there, never in
// the developer's real ~/.oathe or ~/.claude.
const hookSb = sandbox({ scratchDb: SCRATCH_DB });

function runHook(script, hookInput, env = {}, { spawnCwd } = {}) {
  return spawnSync('node', [path.join(paths.pluginDir, 'hooks', script)], {
    input: JSON.stringify(hookInput),
    encoding: 'utf8',
    ...(spawnCwd ? { cwd: spawnCwd } : {}),
    env: { ...hookSb.env, OATHE_DB: SCRATCH_DB, ...env },
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
    // Second render: the first activates the folder (its write receipt speaks once, pinned
    // elsewhere); every session after that is the ruling's target — an already-managed folder.
    runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' }, { OATHE_PRINCIPAL: 'founder' });
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' },
      { OATHE_PRINCIPAL: 'founder' });
    assert.equal(out.status, 0, out.stderr);
    const payload = JSON.parse(out.stdout);
    const context = payload.hookSpecificOutput.additionalContext;
    assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(context, /## Oathe board/);
    assert.match(context, /render-me/);
    assert.match(context, /yours/i);
    // R-QUIET (2026-08-29): a merely-held task is not news — the human channel stays silent;
    // the restored-state banner belongs to the actual pickup. The board rides the model channel.
    assert.ok(!('systemMessage' in payload), 'no ambient banner for held tasks');
    assert.doesNotMatch(context, /github\.com\/oathe-ai\/oathe/, 'the star ask left the product surface');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a session-less payload says so on stderr and still exits 0 — silence here was the ChatGPT-desktop failure mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-nosess-'));
  try {
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' },
      { OATHE_PRINCIPAL: 'founder' });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stderr, /no session_id/,
      'a payload without session identity is reported visibly — fail-soft, never silent');
    const context = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /cannot be attributed/,
      'the SESSION reads it too (ruling 2026-09-04: fail loud so the model does the right thing) — its claims will be refused');
    assert.match(context, /oathe init/, 'and is told the fix');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('render-board NEVER breaks a session: with the substrate absent it exits 0 with a visible quiet note', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-nodb-'));
  try {
    const out = runHook('render-board.mjs', { cwd: dir }, { OATHE_DB: 'oathe_never_created' });
    assert.equal(out.status, 0);
    const payload = JSON.parse(out.stdout);
    assert.match(payload.systemMessage, /unavailable|not initialized/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('render-board on a workspace with NOTHING open is SILENT on the human channel', () => {
  // OUTSIDE the repo: any dir under packageRoot resolves to the repo's own workspace ref.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-empty-'));
  try {
    // Second render — the first run's activation receipt is not this test's subject.
    runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' }, { OATHE_PRINCIPAL: 'founder' });
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' },
      { OATHE_PRINCIPAL: 'founder' });
    assert.equal(out.status, 0, out.stderr);
    const payload = JSON.parse(out.stdout);
    // R-QUIET: an empty board changes nothing about what the person does next — silence.
    assert.ok(!('systemMessage' in payload), 'an empty board is silence, not a beer');
    assert.match(payload.hookSpecificOutput.additionalContext, /no open tasks/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('open tasks that are NOT yours ride the model channel only — no ambient summary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-offered-'));
  try {
    // An unclaimed task carries no workspace yet, so every folder's list offers it.
    await substrate.query(`
      INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                             verify_by, claim_mode, created_at)
      VALUES ('oathe', 'unsigned-task', 'founder', 'anyone may sign', 'minted_at_claim',
              '{"plan_status":"unknown"}'::jsonb, now() + interval '1 day', 'exclusive', now())`);
    // Second render — the first run's activation receipt is not this test's subject.
    runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' }, { OATHE_PRINCIPAL: 'founder' });
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' },
      { OATHE_PRINCIPAL: 'founder' });
    assert.equal(out.status, 0, out.stderr);
    const payload = JSON.parse(out.stdout);
    // R-QUIET: status pulls (oathe ls) — an open-task inventory is never pushed at the human.
    assert.ok(!('systemMessage' in payload), 'no ambient inventory push');
    assert.match(payload.hookSpecificOutput.additionalContext, /unsigned-task/);
  } finally {
    await substrate.query("DELETE FROM cell.task WHERE task_id = 'unsigned-task'");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R-QUIET: breaches PUSH — a breached promise is the one thing that speaks at session start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-breach-'));
  try {
    // A quiet breach: an active claim whose holder has said nothing past the threshold. The
    // claim is 2h old; only this test's 1h threshold sees it — the other renders stay clean.
    await substrate.query(`
      INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                             verify_by, claim_mode, created_at)
      VALUES ('oathe', 'gone-quiet', 'founder', 'claimed then abandoned', 'minted_at_claim',
              '{"plan_status":"unknown"}'::jsonb, now() + interval '7 days', 'exclusive', now())`);
    await substrate.query(
      `SELECT cell.claim_work('oathe', 'gone-quiet', gen_random_uuid(), NULL, NULL, 'founder', 'founder',
              'exclusive', now() + interval '4 hours', 'workspace:ws-000000000000;contract:oathe/gone-quiet@v1',
              now() - interval '2 hours', gen_random_uuid())`);
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' },
      { OATHE_PRINCIPAL: 'founder', OATHE_PAGER_QUIET_HOURS: '1' });
    assert.equal(out.status, 0, out.stderr);
    const payload = JSON.parse(out.stdout);
    // Founder wording (2026-08-31): counts BY KIND in plain words — the kind-blind
    // "N unclaimed tasks expiring" lied about what the rows were. Details stay on the
    // model channel; the push names the kind so the human knows what it IS.
    assert.match(payload.systemMessage, /1 gone quiet/, 'a breach is pushed at the human, named by kind');
    assert.doesNotMatch(payload.systemMessage, /promise breached|unclaimed|expiring|gone-quiet\b.*\]/i, 'no alarm-speak, no detail dump');
    assert.doesNotMatch(payload.systemMessage, /\u{1F389}|github\.com/u, 'no celebration, no ask');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The row describes THE HARNESS PROCESS: the hook walks up from its ppid to the nearest
 * adapter-owned ancestor (Cursor's agent CLI interposes a short-lived /bin/zsh — registering the
 * shell would sweep the session when it exits), else keeps the ppid. The expectation is
 * computed with the same public helpers the hook uses; the helpers themselves are pinned
 * by the process-identity fixtures in harness-contract.
 */
async function expectedHookPid() {
  const { processAncestry } = await import('../src/sessions.mjs');
  const { ownedAncestorIndex } = await import('../src/harnesses/catalog.mjs');
  const walk = processAncestry({ pid: process.pid }); // the hook's ppid IS this test runner
  const owned = ownedAncestorIndex(walk);
  return owned <= 0 ? process.pid : walk[owned].pid;
}

test('SessionStart registers the session — the DURABLE harness pid (nearest owned ancestor), ancestry, alive at read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-sess-reg-'));
  try {
    const out = runHook('render-board.mjs', {
      cwd: dir, hook_event_name: 'SessionStart', session_id: 'sess-hook-1',
      transcript_path: path.join(hookSb.env.HOME, '.claude', 'projects', 'x', 't.jsonl'),
    }, { OATHE_PRINCIPAL: 'founder' });
    assert.equal(out.status, 0, out.stderr);
    const doc = JSON.parse(fs.readFileSync(path.join(hookSb.env.OATHE_HOME, 'sessions.json'), 'utf8'));
    const row = doc.sessions['sess-hook-1'];
    assert.ok(row, 'the session registered');
    if (process.platform === 'darwin' || process.platform === 'linux') {
      // Measured on every platform that can be (ps on darwin, /proc on linux — ruling 2026-09-04).
      const expected = await expectedHookPid();
      assert.equal(row.pid, expected, 'the row keys on the durable harness process, never an interposer');
      assert.equal(row.ancestry[0]?.pid, expected, 'ancestry starts at that process');
    } else {
      // A platform with neither: the session still registers, keyed on a real pid, with the
      // degradation visible as an EMPTY ancestry.
      assert.deepEqual(row.ancestry, [], 'without a walk the recorded degradation is an EMPTY ancestry');
      assert.ok(Number.isInteger(row.pid) && row.pid > 0, 'still keyed on a real pid');
    }
    assert.ok(row.transcript_path.endsWith('t.jsonl'));
    assert.ok(!('surface' in row), 'facts only — names resolve at read');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('heartbeat beats the session row — last_seen_at moves, registered_at and the facts stay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-sess-beat-'));
  try {
    runHook('render-board.mjs', {
      cwd: dir, hook_event_name: 'SessionStart', session_id: 'sess-hook-2',
      transcript_path: path.join(hookSb.env.HOME, '.claude', 'projects', 'x', 't2.jsonl'),
    }, { OATHE_PRINCIPAL: 'founder' });
    const before = JSON.parse(fs.readFileSync(path.join(hookSb.env.OATHE_HOME, 'sessions.json'), 'utf8')).sessions['sess-hook-2'];
    const out = runHook('heartbeat.mjs', {
      cwd: dir, hook_event_name: 'Stop', session_id: 'sess-hook-2',
      transcript_path: path.join(hookSb.env.HOME, '.claude', 'projects', 'x', 't2.jsonl'),
    }, { OATHE_PRINCIPAL: 'founder' });
    assert.equal(out.status, 0, out.stderr);
    const after = JSON.parse(fs.readFileSync(path.join(hookSb.env.OATHE_HOME, 'sessions.json'), 'utf8')).sessions['sess-hook-2'];
    assert.equal(after.registered_at, before.registered_at, 'first-writer facts stay');
    assert.deepEqual(after.ancestry, before.ancestry);
    assert.ok(after.last_seen_at >= before.last_seen_at, 'the beat moved last_seen_at');
    // The transcript this fixture names does not exist: the hook still exits 0 (fail-soft
    // surface) but says WHY it linked nothing, typed — an annotator or store bug is never
    // swallowed into silence.
    assert.match(out.stderr, /\[TRACE_UNREADABLE\]/, 'the typed reason reaches stderr');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a RESUMED session links the transcript it actually writes: the hook is told <new-id>.jsonl, the rows live in the original — the registry and the trace link name the original', async () => {
  // Measured live 2026-09-01: after `claude --resume` (and after a compaction) the harness
  // rotates session_id and reports transcript_path=<new-id>.jsonl, but keeps appending to the
  // original file, stamping the new rows with session_id. The ghost path killed verification
  // at the evidence stage (TRACE_UNREADABLE) for every claim spoken in a resumed session.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-resume-'));
  const projectDir = path.join(hookSb.env.HOME, '.claude', 'projects', 'resume-x');
  fs.mkdirSync(projectDir, { recursive: true });
  const fileId = '12121212-3434-5656-7878-909090909090';
  const original = path.join(projectDir, `${fileId}.jsonl`);
  const resumed = 'sess-resumed-1';
  fs.writeFileSync(original, [
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: fileId, session_id: resumed, cwd: dir, message: { role: 'user', content: 'claim it' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: fileId, session_id: resumed, cwd: dir,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__oathe__oathe_claim', input: { task_id: 'resumed-task', objective: 'linked after a resume' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: fileId, session_id: resumed, cwd: dir,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"claimed":true}' }] } },
  ].map((r) => JSON.stringify(r)).join('\n'));
  try {
    const { workspaceRef } = await import('../src/workspace.mjs');
    await substrate.query(`
      INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan, verify_by, claim_mode, created_at)
      VALUES ('oathe', 'resumed-task', 'founder', 'linked after a resume', 'minted_at_claim',
              '{"plan_status":"unknown"}'::jsonb, now() + interval '1 day', 'exclusive', now())`);
    await substrate.query(
      `SELECT cell.claim_work('oathe', 'resumed-task', gen_random_uuid(), NULL, NULL, 'founder', 'founder',
              'exclusive', now() + interval '4 hours', $1, now(), gen_random_uuid())`,
      [`workspace:${workspaceRef(dir)};contract:oathe/resumed-task@v1`]);
    const ghost = path.join(projectDir, `${resumed}.jsonl`);
    const out = runHook('heartbeat.mjs', { cwd: dir, hook_event_name: 'Stop', session_id: resumed, transcript_path: ghost },
      { OATHE_PRINCIPAL: 'founder' });
    assert.equal(out.status, 0, out.stderr);
    const row = JSON.parse(fs.readFileSync(path.join(hookSb.env.OATHE_HOME, 'sessions.json'), 'utf8')).sessions[resumed];
    assert.equal(row.transcript_path, original, 'the registry holds the file the session writes, not the one it was told');
    const { rows } = await substrate.query(
      "SELECT evidence_refs FROM cell.agent_statement WHERE task_id = 'resumed-task' AND subject_ref = $1", [`trace:${resumed}`]);
    assert.deepEqual(rows.map((r) => r.evidence_refs), [[original]], 'the trace link names a file a verifier can read');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the heartbeat REGISTERS a session the registry has never seen — a living session is never invisible', async () => {
  // The pin that would have caught the founder's bug: a session predating the registry
  // (or one whose sessions.json was wiped) heals at its next turn end, not never.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-sess-heal-'));
  try {
    const out = runHook('heartbeat.mjs', {
      cwd: dir, hook_event_name: 'Stop', session_id: 'sess-hook-heal',
      transcript_path: path.join(hookSb.env.HOME, '.claude', 'projects', 'x', 'th.jsonl'),
    }, { OATHE_PRINCIPAL: 'founder' });
    assert.equal(out.status, 0, out.stderr);
    const row = JSON.parse(fs.readFileSync(path.join(hookSb.env.OATHE_HOME, 'sessions.json'), 'utf8'))
      .sessions['sess-hook-heal'];
    assert.ok(row, 'no SessionStart ever ran for this session — the heartbeat converges it');
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const expected = await expectedHookPid();
      assert.equal(row.pid, expected, 'the durable harness pid — a real, live process');
      assert.equal(row.ancestry[0]?.pid, expected, 'the full facts land, not a bare beat');
    } else {
      assert.deepEqual(row.ancestry, [], 'without a walk the heartbeat converges the row with the recorded empty-ancestry degradation');
      assert.ok(Number.isInteger(row.pid) && row.pid > 0, 'still keyed on a real pid');
    }
    assert.ok(row.transcript_path.endsWith('th.jsonl'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken sessions file costs the session NOTHING — the board still renders, the failure rides stderr', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-sess-broken-'));
  const sessionsFile = path.join(hookSb.env.OATHE_HOME, 'sessions.json');
  const saved = fs.existsSync(sessionsFile) ? fs.readFileSync(sessionsFile) : null;
  try {
    fs.writeFileSync(sessionsFile, 'not json{');
    const out = runHook('render-board.mjs', {
      cwd: dir, hook_event_name: 'SessionStart', session_id: 'sess-hook-3',
      transcript_path: path.join(hookSb.env.HOME, '.claude', 'projects', 'x', 't3.jsonl'),
    }, { OATHE_PRINCIPAL: 'founder' });
    assert.equal(out.status, 0, out.stderr);
    assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /## Oathe board/);
    assert.match(out.stderr, /sessions/i, 'the failure speaks on stderr, never costs the board');
  } finally {
    if (saved) fs.writeFileSync(sessionsFile, saved); else fs.rmSync(sessionsFile, { force: true });
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
  // A Claude transcript lives in Claude's store layout — trace ownership is by path.
  const file = path.join(dir, '.claude', 'projects', 'fixture', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
    const { OatheConfig } = await import('../src/config.mjs');
    const ws = workspaceRef(dir);
    const tools = createOatheTools({
      client: substrate,
      identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' },
      workspace: ws,
      config: new OatheConfig({ env: { HOME: hookSb.home, OATHE_HOME: hookSb.env.OATHE_HOME }, cwd: dir }),
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

// -------------------------------------- activation: opening a session on a folder ACTIVATES it
// The one-click decision (founder, 2026-08-28): hooks fire in every session, SessionStart
// registers the workspace centrally and writes the context-file fences through the ONE
// activation writer, and DISCLOSES what it wrote. OATHE_LAUNCHED_HARNESS is a custody marker
// only.

test('render-board ACTIVATES: registry row, fences on disk, and the write disclosed in both channels', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-activate-'));
  try {
    const { workspaceRef } = await import('../src/workspace.mjs');
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' });
    assert.equal(out.status, 0, out.stderr);
    const payload = JSON.parse(out.stdout);
    assert.match(payload.systemMessage, /pinned this folder's board/i, 'the write is disclosed to the user');
    assert.match(payload.hookSpecificOutput.additionalContext, /pinned this folder's board/i);
    const claudeMd = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(claudeMd.includes('## Oathe'));
    assert.ok(claudeMd.includes(workspaceRef(dir)));
    assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')), 'codex + cursor detected in the sandbox home');
    const registryDoc = JSON.parse(fs.readFileSync(path.join(hookSb.env.OATHE_HOME, 'workspaces.json'), 'utf8'));
    const row = registryDoc.workspaces[workspaceRef(dir)];
    assert.equal(row.registered_by, 'hook:session-start');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a second session start is byte-idempotent and repeats no disclosure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-activate2-'));
  try {
    const first = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' });
    assert.equal(first.status, 0, first.stderr);
    const bytes = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    const second = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), bytes);
    const payload = JSON.parse(second.stdout);
    // Nothing new written, nothing held, no breach: the human channel is absent entirely.
    assert.ok(!('systemMessage' in payload), 'nothing new written — nothing re-disclosed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('autoActivate=false: the session registers centrally but writes NO files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-activate-off-'));
  try {
    const { workspaceRef } = await import('../src/workspace.mjs');
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' },
      { OATHE_AUTO_ACTIVATE: 'false' });
    assert.equal(out.status, 0, out.stderr);
    assert.ok(!fs.existsSync(path.join(dir, 'CLAUDE.md')), 'no fence files with activation off');
    const registryDoc = JSON.parse(fs.readFileSync(path.join(hookSb.env.OATHE_HOME, 'workspaces.json'), 'utf8'));
    assert.ok(registryDoc.workspaces[workspaceRef(dir)], 'registration still happened');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a session with NO resolvable workspace exits 0 in silence — nothing to speak about', () => {
  // No cwd in the payload, no env binding, and the process cwd is the sandbox home itself
  // (the ladder refuses a home directory rather than minting a silently-wrong board).
  const out = runHook('render-board.mjs', { hook_event_name: 'SessionStart' },
    {}, { spawnCwd: hookSb.home });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
  assert.equal(out.stderr, '');
});

test('the CURSOR dialect round-trips: workspace_roots in, snake_case additional_context out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-cursor-dialect-'));
  try {
    const out = runHook('render-board.mjs', {
      hook_event_name: 'sessionStart',
      conversation_id: 'conv-1',
      session_id: 'conv-1',
      workspace_roots: [dir],
      cursor_version: '1.7.2',
      is_background_agent: false,
    });
    assert.equal(out.status, 0, out.stderr);
    const payload = JSON.parse(out.stdout);
    assert.match(payload.additional_context, /Oathe board|no open tasks/i);
    assert.ok(!('hookSpecificOutput' in payload), 'the reply speaks Cursor, not Claude');
    assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')), 'activation fired from the roots payload');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('activation failing never costs the session its board — reported on stderr, board still renders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-activate-fail-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-ro-home-'));
  const roOatheHome = path.join(home, '.oathe');
  fs.mkdirSync(roOatheHome);
  fs.writeFileSync(path.join(roOatheHome, 'workspaces.json'), 'not json{');
  try {
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' },
      { OATHE_HOME: roOatheHome });
    assert.equal(out.status, 0, out.stderr);
    const payload = JSON.parse(out.stdout);
    assert.ok(payload.hookSpecificOutput.additionalContext.length > 0, 'the board rendered');
    assert.match(out.stderr, /activation/i, 'the failure is visible, never silent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
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

// ------------------------------------------ R-HOME-BOARD: custody follows the principal, not the folder
// A claim you hold on a task homed ELSEWHERE is still yours: the turn-end heartbeat must link
// its trace evidence and the compaction note must land — the folder you happen to stand in
// is not the boundary of your obligations.

async function seedForeignHomedClaim(taskId) {
  await substrate.query(`
    INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                           verify_by, claim_mode, created_at)
    VALUES ('oathe', $1, 'founder', 'homed on another board', 'minted_at_claim',
            '{"plan_status":"unknown"}'::jsonb, now() + interval '1 day', 'exclusive', now())`, [taskId]);
  await substrate.query(
    `SELECT cell.claim_work('oathe', $1, gen_random_uuid(), NULL, NULL, 'founder', 'founder',
            'exclusive', now() + interval '4 hours', $2, now(), gen_random_uuid())`,
    [taskId, `workspace:ws-foreignhome00;contract:oathe/${taskId}@v1`]);
}

test('heartbeat links trace evidence for a claim homed on ANOTHER board — custody is the principal\'s', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-foreign-hb-'));
  try {
    await seedForeignHomedClaim('foreign-linked');
    const transcript = writeSessionFixture(dir, 'sess-foreign', [['oathe_statement', 'foreign-linked']]);
    const out = runHook('heartbeat.mjs', {
      cwd: dir, hook_event_name: 'Stop', session_id: 'sess-foreign', transcript_path: transcript,
    });
    assert.equal(out.status, 0, out.stderr);
    const { rows } = await substrate.query(
      "SELECT count(*)::int AS n FROM cell.agent_statement WHERE task_id = 'foreign-linked' AND subject_ref = 'trace:sess-foreign'");
    assert.equal(rows[0].n, 1, 'the evidence the verifier will demand is linked regardless of the folder');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('frame-note leaves the compaction statement on a foreign-homed claim this principal holds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-foreign-fn-'));
  try {
    await seedForeignHomedClaim('foreign-noted');
    const out = runHook('frame-note.mjs', { cwd: dir, hook_event_name: 'PreCompact' });
    assert.equal(out.status, 0, out.stderr);
    const { rows } = await substrate.query(
      "SELECT count(*)::int AS n FROM cell.agent_statement WHERE task_id = 'foreign-noted' AND execution_actor = 'oathe-precompact-hook'");
    assert.equal(rows[0].n, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------ R-BOARD-SCOPE: a synthetic surface sees the whole board
test('render-board on a ChatGPT-desktop staging dir serves the FULL board and writes nothing there', async () => {
  const staging = path.join(hookSb.home, '.codex/.chatgpt-projects/g-p-sim');
  fs.mkdirSync(staging, { recursive: true });
  const out = runHook('render-board.mjs', { cwd: staging, hook_event_name: 'SessionStart' });
  assert.equal(out.status, 0, out.stderr);
  const payload = JSON.parse(out.stdout);
  assert.match(payload.hookSpecificOutput.additionalContext, /all workspaces/i, 'no folder lens on a synthetic surface');
  assert.ok(!fs.existsSync(path.join(staging, 'CLAUDE.md')), 'no fence inside ~/.codex');
  assert.ok(!fs.existsSync(path.join(staging, 'AGENTS.md')));
  const registryPath = path.join(hookSb.env.OATHE_HOME, 'workspaces.json');
  const rows = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, 'utf8')).workspaces : {};
  assert.ok(!Object.values(rows).some((r) => r.root === staging), 'no registry row for a staging dir');
});

// ------------------------------------------ R-PAGER: breached promises ride the SessionStart context
test('render-board carries the machine-wide breach digest in context — a quiet claim from ANOTHER folder pages here', async () => {
  const dir = fs.mkdtempSync(path.join(paths.packageRoot, 'tmp-ws-'));
  try {
    await substrate.query(`
      INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                             verify_by, claim_mode, created_at)
      VALUES ('oathe', 'quiet-elsewhere', 'founder', 'claimed three days ago, not a word since', 'minted_at_claim',
              '{"plan_status":"unknown"}'::jsonb, now() + interval '30 days', 'exclusive', now() - interval '3 days')`);
    await substrate.query(
      `SELECT cell.claim_work('oathe', 'quiet-elsewhere', gen_random_uuid(), NULL, NULL, 'athena', 'founder',
              'exclusive', now() + interval '4 hours', $1, now() - interval '3 days', gen_random_uuid())`,
      ['workspace:ws-000000000aaa;contract:oathe/quiet-elsewhere@v1']);
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' });
    assert.equal(out.status, 0, out.stderr);
    const context = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /## Breached promises \(all workspaces\)/);
    assert.match(context, /quiet-elsewhere/);
    assert.match(context, /athena/);
    assert.match(context, /quiet for 7[0-9]h/);
    assert.match(context, /## Oathe board/, 'the board itself still renders');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('render-board with a BROKEN pager still delivers the board — the failure goes to stderr', async () => {
  const dir = fs.mkdtempSync(path.join(paths.packageRoot, 'tmp-ws-'));
  await substrate.query('ALTER FUNCTION cell.unverified_past_verify_by(timestamptz) RENAME TO pager_test_broken');
  try {
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' });
    assert.equal(out.status, 0, out.stderr);
    const payload = JSON.parse(out.stdout);
    assert.match(payload.hookSpecificOutput.additionalContext, /## Oathe board/);
    assert.doesNotMatch(payload.hookSpecificOutput.additionalContext, /Breached promises/);
    assert.match(out.stderr, /pager/i);
  } finally {
    await substrate.query('ALTER FUNCTION cell.pager_test_broken(timestamptz) RENAME TO unverified_past_verify_by');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('render-board carries the standing rule on EVERY render — a session with no fence still learns to claim', async () => {
  const dir = fs.mkdtempSync(path.join(paths.packageRoot, 'tmp-ws-'));
  try {
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' });
    assert.equal(out.status, 0, out.stderr);
    const context = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /## Oathe board/);
    assert.match(context, /claim before you build/i);
    // the render-me task from the first test keeps this a NON-empty machine-wide picture in the staging dir
    const staging = path.join(hookSb.home, '.codex/.chatgpt-projects/g-p-rule');
    fs.mkdirSync(staging, { recursive: true });
    const sim = runHook('render-board.mjs', { cwd: staging, hook_event_name: 'SessionStart' });
    const simContext = JSON.parse(sim.stdout).hookSpecificOutput.additionalContext;
    assert.match(simContext, /all workspaces/);
    assert.match(simContext, /claim before you build/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------ drift monitors P3: the hook capture tap
test('OATHE_HOOK_CAPTURE_DIR makes a hook write its RAW stdin payload before normalizing — off by default', () => {
  const dir = fs.mkdtempSync(path.join(paths.packageRoot, 'tmp-ws-'));
  const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-capture-'));
  try {
    const payload = { cwd: dir, hook_event_name: 'SessionStart', session_id: 'cap-1', transcript_path: '/nowhere.jsonl', source: 'startup' };
    const out = runHook('render-board.mjs', payload, { OATHE_HOOK_CAPTURE_DIR: captureDir });
    assert.equal(out.status, 0, out.stderr);
    const files = fs.readdirSync(captureDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^SessionStart-.*\.json$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(captureDir, files[0]), 'utf8')), payload, 'the raw payload, byte-faithful');
    const quiet = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-capture-off-'));
    runHook('render-board.mjs', payload);
    assert.equal(fs.readdirSync(quiet).length, 0, 'nothing is captured unless asked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Forty claims left behind outrank every later render's quiet claim under the cap, and the
// claim rows fan out into more tables than a test should know: this one runs last.
test('UX rule 18 at session start: forty quiet claims are ONE push line, eight context rows and a +N more — never a wall', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-budget-'));
  try {
    for (let i = 0; i < 40; i++) {
      const id = `budget-${String(i).padStart(2, '0')}`;
      await substrate.query(`
        INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                               verify_by, claim_mode, created_at)
        VALUES ('oathe', $1, 'founder', 'one of forty', 'minted_at_claim',
                '{"plan_status":"unknown"}'::jsonb, now() + interval '7 days', 'exclusive', now())`, [id]);
      await substrate.query(
        `SELECT cell.claim_work('oathe', $1, gen_random_uuid(), NULL, NULL, 'founder', 'founder',
                'exclusive', now() + interval '4 hours', $2, now() - interval '2 hours', gen_random_uuid())`,
        [id, `workspace:ws-000000000000;contract:oathe/${id}@v1`]);
    }
    const out = runHook('render-board.mjs', { cwd: dir, hook_event_name: 'SessionStart' },
      { OATHE_PRINCIPAL: 'founder', OATHE_PAGER_QUIET_HOURS: '1' });
    assert.equal(out.status, 0, out.stderr);
    const payload = JSON.parse(out.stdout);
    // Other renders' quiet claims page too under this threshold: the count is whatever is
    // true, the budget is the rows.
    // The first render of a fresh folder also discloses its activation on a second line.
    const total = Number(payload.systemMessage.split('\n')[0].match(/^(\d+) gone quiet$/)?.[1]);
    assert.ok(total >= 40, `the push is the whole count in one line: ${payload.systemMessage}`);
    const section = payload.hookSpecificOutput.additionalContext.slice(
      payload.hookSpecificOutput.additionalContext.indexOf('## Breached promises'));
    assert.equal(section.split('\n').filter((l) => l.startsWith('- [')).length, 8, 'eight rows');
    assert.match(section, new RegExp(`^_\\+${total - 8} more — oathe_board lists every breach on this board; \`oathe ls\` every one on this machine_$`, 'm'));
    assert.ok(Buffer.byteLength(section) < 4096, `a budget, not a wall: ${Buffer.byteLength(section)} bytes`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
