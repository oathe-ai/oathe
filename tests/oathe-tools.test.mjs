import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as serverModule from '../src/mcp/oathe-tools.mjs';
import { dispatch, createOatheTools, lazyTools, PROTOCOL_VERSION } from '../src/mcp/oathe-tools.mjs';
import { OatheConfig } from '../src/config.mjs';
import { WorkspaceResolveError } from '../src/workspace-resolver.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';

/** A config bound to a scratch HOME — tests never read the developer's real ~/.oathe. */
function scratchConfig(extraEnv = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-tools-cfg-')));
  return new OatheConfig({ env: { HOME: home, OATHE_HOME: path.join(home, '.oathe'), ...extraEnv }, cwd: home });
}

// ---------------------------------------------------------------- protocol (fake tools)

test('initialize advertises the legacy protocol version and tool capability', async () => {
  const out = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { tools: {} });
  assert.equal(out.result.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(out.result.capabilities, { tools: {} });
  assert.equal(out.result.serverInfo.name, 'oathe-tools');
});

test('tools/list names the EIGHT oathe tools with schemas', async () => {
  const out = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { tools: {} });
  assert.deepEqual(out.result.tools.map((t) => t.name),
    ['oathe_claim', 'oathe_board', 'oathe_statement', 'oathe_amend', 'oathe_yield', 'oathe_done', 'oathe_verify', 'oathe_pickup']);
  assert.ok(out.result.tools.every((t) => t.inputSchema?.type === 'object'));
});

test('an unknown method answers -32601 so modern clients fall back to the legacy handshake', async () => {
  const out = await dispatch({ jsonrpc: '2.0', id: 3, method: 'server/discover' }, { tools: {} });
  assert.equal(out.error.code, -32601);
});

test('notifications produce no response', async () => {
  assert.equal(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, { tools: {} }), null);
});

test('a throwing tool surfaces as a typed isError result, never a bland success', async () => {
  const tools = { oathe_claim: async () => { const e = new Error('refused'); e.code = 'X01'; throw e; } };
  const out = await dispatch(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'oathe_claim', arguments: {} } },
    { tools });
  assert.equal(out.result.isError, true);
  const body = JSON.parse(out.result.content[0].text);
  assert.equal(body.error_code, 'X01');
  assert.equal(body.fail_loud, true);
});

test('calling a tool the server does not have is a typed error', async () => {
  const out = await dispatch(
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    { tools: {} });
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /unknown_tool/);
});

// Resolution is the gate (founder decision, one-click cross-harness): OATHE_LAUNCHED_HARNESS
// is a custody marker only — nothing reads it for tool access.
test('there is no withLaunchGate export — resolution is the gate', () => {
  assert.equal(serverModule.withLaunchGate, undefined);
});

test('a session whose workspace cannot resolve gets the per-call typed OATHE_WORKSPACE_UNRESOLVED refusal', async () => {
  const tools = lazyTools(async () => {
    throw new WorkspaceResolveError('OATHE_WORKSPACE_UNRESOLVED',
      "no workspace directory could be resolved: OATHE_WORKSPACE_DIR ignored ('${CLAUDE_PROJECT_DIR}')");
  });
  const out = await dispatch(
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'oathe_claim', arguments: {} } },
    { tools });
  assert.equal(out.result.isError, true);
  const body = JSON.parse(out.result.content[0].text);
  assert.equal(body.error_code, 'OATHE_WORKSPACE_UNRESOLVED');
  assert.match(body.reason, /\$\{CLAUDE_PROJECT_DIR\}/, 'the refusal names what was received');
});

test('lazyTools serves the full tool-name surface and delegates every call to the loader', async () => {
  const loads = [];
  const tools = lazyTools(async () => {
    loads.push('load');
    return { tools: { oathe_board: async () => ({ ok: true }), oathe_claim: async () => ({ claimed: true }) } };
  });
  assert.deepEqual(Object.keys(tools),
    ['oathe_claim', 'oathe_board', 'oathe_statement', 'oathe_amend', 'oathe_yield', 'oathe_done', 'oathe_verify', 'oathe_pickup'],
    'the lazy surface carries the same names as tools/list before any context exists');
  assert.deepEqual(await tools.oathe_board({}), { ok: true });
  assert.deepEqual(await tools.oathe_claim({}), { claimed: true });
  assert.equal(loads.length, 2, 'no memo here — deduplication belongs to the loader');
});

// ---------------------------------------------------------------- tool semantics (real cell)

const paths = buildPaths({});
const SCRATCH_DB = `oathe_tools_test_${process.pid}`;
const WS = 'ws-abcdef123456';
let substrate;
let tools;

before(async () => {
  substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await substrate.ensureDatabase();
  await substrate.applyDdl();
  await substrate.seed({ orgId: 'oathe', principalId: 'founder', department: 'founder' });
  await substrate.registerYieldCause();
  tools = createOatheTools({
    client: substrate,
    identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' },
    workspace: WS,
    config: scratchConfig(),
  });
});

after(async () => {
  await substrate.close();
  await substrate.dropDatabase();
});

test('oathe_claim mints the task honestly (plan_status unknown) and claims it with the workspace ref', async () => {
  const out = await tools.oathe_claim({ task_id: 'task-x', objective: 'Refactor the auth module' });
  assert.equal(out.claimed, true);
  assert.equal(out.task_id, 'task-x');
  assert.match(out.contract_ref, new RegExp(`^workspace:${WS};contract:oathe/task-x@v1$`));
  const { rows } = await substrate.query(
    "SELECT verification_plan->>'plan_status' AS ps FROM cell.task WHERE task_id = 'task-x'");
  assert.equal(rows[0].ps, 'unknown');
});

test('the lease duration flows from config — nothing hardcoded', async () => {
  const longTools = createOatheTools({
    client: substrate,
    identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' },
    workspace: WS,
    config: scratchConfig({ OATHE_LEASE_HOURS: '12' }),
  });
  await longTools.oathe_claim({ task_id: 'long-lease', objective: 'twelve hour shift' });
  const { rows } = await substrate.query(
    "SELECT extract(epoch FROM (ownership_valid_until - now())) / 3600 AS h "
    + "FROM cell.work_claim WHERE task_id = 'long-lease' AND state = 'active'");
  assert.ok(Number(rows[0].h) > 11, `lease hours: ${rows[0].h}`);
  await longTools.oathe_yield({ task_id: 'long-lease', note: 'shift over' });
});

test('a second claim on the same task is REFUSED by the substrate and surfaces typed', async () => {
  await assert.rejects(
    () => tools.oathe_claim({ task_id: 'task-x', objective: 'second claimant' }),
    (e) => /second|active|exclusive|refus|already/i.test(String(e.message)));
});

test('oathe_board renders only this workspace unless all is asked', async () => {
  const client = substrate;
  await client.query(`
    INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                           verify_by, claim_mode, created_at)
    VALUES ('oathe', 'elsewhere', 'founder', 'other workspace task', 'minted_at_claim',
            '{"plan_status":"unknown"}'::jsonb, now() + interval '1 day', 'exclusive', now())`);
  await client.query(
    `SELECT cell.claim_work('oathe', 'elsewhere', gen_random_uuid(), NULL, NULL, 'founder', 'founder',
            'exclusive', now() + interval '4 hours', 'workspace:ws-000000000000;contract:oathe/elsewhere@v1',
            now(), gen_random_uuid())`);
  const mine = await tools.oathe_board({});
  assert.ok(mine.board.some((r) => r.task_id === 'task-x'));
  assert.ok(!mine.board.some((r) => r.task_id === 'elsewhere'));
  const all = await tools.oathe_board({ all: true });
  assert.ok(all.board.some((r) => r.task_id === 'elsewhere'));
});

test('UX rule 19: attention is read per call, only where it is served — attention:false runs no breach read; a clean board carries no attention key', async () => {
  const seen = [];
  const spy = { query: async (sql, params) => { seen.push(sql); return substrate.query(sql, params); } };
  const identity = { orgId: 'oathe', principalId: 'founder', department: 'founder' };
  const readOnly = createOatheTools({ client: spy, identity, workspace: 'ws-attn000000000', config: scratchConfig(), attention: false });
  const composed = await readOnly.oathe_board({});
  assert.ok(!('attention' in composed) && !('attention_error' in composed) && !('breaches' in composed), 'no breach channel on a read-only composition');
  assert.ok(seen.every((sql) => !/unverified_past_verify_by/.test(sql)), 'no pager query ran (the overdue leg is the pager\'s alone)');

  const served = createOatheTools({ client: spy, identity, workspace: 'ws-attn000000000', config: scratchConfig() });
  const clean = await served.oathe_board({});
  assert.ok(!('attention' in clean), 'nothing to fix on this board — no key, not an empty list');
  assert.deepEqual(clean.breaches, [], 'the pull is present and empty');
  assert.throws(() => createOatheTools({ client: spy, identity, workspace: 'ws-attn000000000' }),
    (e) => e.code === 'OATHE_ATTENTION_NEEDS_CONFIG', 'a served surface without config is a typed refusal, never a per-call attention_error');
});

test('the board row carries last_word_at — the pager\'s own last-word definition, the claim counting as the first word', async () => {
  await tools.oathe_claim({ task_id: 'word-task', objective: 'when did anyone last speak' });
  const { sections } = await tools.oathe_board({});
  const row = sections.mine.find((r) => r.task_id === 'word-task');
  assert.ok(row.last_word_at, 'a fresh claim has a last word — the claim itself');
  assert.match(row.last_word_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/, 'UTC, like lease_until');
  assert.ok('trace_path' in row, 'the latest trace link rides the row — the durable surface fact');
  assert.equal(row.trace_path, null, 'no session has heartbeat this claim yet');
  assert.ok('trace_session_id' in row, 'the session id rides beside the path — the liveness join key');
  assert.equal(row.trace_session_id, null);
  await tools.oathe_yield({ task_id: 'word-task', note: 'fixture done' });
});

test('the wire: every successful WRITE rides one pg_notify on oathe_wire — reads stay silent', async () => {
  const notifies = [];
  const spy = {
    query: (sql, params) => {
      if (/pg_notify/i.test(String(sql))) notifies.push(JSON.parse(params[1]));
      return substrate.query(sql, params);
    },
  };
  const seam = { register: async () => ({}), activate: async () => ({}) };
  const wired = createOatheTools({
    client: spy,
    identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' },
    workspace: WS,
    config: scratchConfig(),
    activation: seam,
    // The SPEAKER primitive: who is speaking, observed from the writer's own ancestry.
    speaker: { surface: 'chatgpt', app: { bundle: '/Applications/ChatGPT.app', pid: 4242 }, session: null },
  });
  await wired.oathe_claim({ task_id: 'wire-task', objective: 'prove the wire' });
  assert.deepEqual(notifies.map((n) => n.kind), ['claimed'], 'a claim emits its speech-act kind');
  assert.equal(notifies[0].task_id, 'wire-task');
  assert.equal(notifies[0].via, 'chatgpt', 'the wire names the surface — the person stays the principal');
  assert.deepEqual(notifies[0].app, { bundle: '/Applications/ChatGPT.app', pid: 4242 },
    'the act carries its living app — a homeless task still knows where it is spoken from');
  await wired.oathe_board({});
  assert.equal(notifies.length, 1, 'a read emits nothing — the feed must never echo itself');
  await wired.oathe_yield({ task_id: 'wire-task', note: 'wire fixture done' });
  assert.deepEqual(notifies.map((n) => n.kind), ['claimed', 'yielded']);
});

// Speaker resolution itself is pinned in tests/speaker.test.mjs — one home, one suite.

test('a SERVING tool surface without its speaker is a typed refusal — the primitive is required where consumed', () => {
  assert.throws(
    () => createOatheTools({
      client: substrate,
      identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' },
      workspace: WS,
      config: scratchConfig(),
      activation: { register: async () => ({}), activate: async () => ({}) },
    }),
    (e) => e.code === 'OATHE_SPEAKER_REQUIRED');
});

test('attribution rides the speech act — a claim leaves its trace-link statement IMMEDIATELY, idempotently, disclosed', async () => {
  const seam = { register: async () => ({}), activate: async () => ({}) };
  // A transcript that EXISTS: a link names a file a verifier can read, or it is not written.
  const transcript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-attr-')), 'attr.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'sess-attr-1', message: { role: 'user', content: 'work' } })}\n`);
  const wired = createOatheTools({
    client: substrate,
    identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' },
    workspace: WS,
    config: scratchConfig(),
    activation: seam,
    speaker: {
      surface: 'claude',
      app: { bundle: '/Applications/iTerm.app', pid: 4242 },
      session: { sessionId: 'sess-attr-1', transcriptPath: transcript, harness: 'claude' },
    },
  });
  const out = await wired.oathe_claim({ task_id: 'attr-task', objective: 'attributed at the act, not at turn end' });
  assert.deepEqual(out.spoken_from, { surface: 'claude', app: '/Applications/iTerm.app', session: 'sess-attr-1' },
    'the act discloses who spoke it');
  assert.ok(!('trace_link' in out), 'a link that landed needs no disclosure');
  const links = () => substrate.query(
    "SELECT evidence_refs FROM cell.agent_statement WHERE task_id = 'attr-task' AND subject_ref = 'trace:sess-attr-1'");
  assert.equal((await links()).rows.length, 1, 'the trace-link exists the moment the claim lands — no turn-end wait');
  assert.deepEqual((await links()).rows[0].evidence_refs, [transcript]);
  // A transcript the harness named but never wrote (a resumed session before its first turn
  // end) is NOT linked as evidence — a ghost link would kill verification at the evidence
  // stage (TRACE_UNREADABLE, live 2026-09-01); the miss is disclosed on the act, and the
  // turn-end heartbeat links the real file.
  const ghostWired = createOatheTools({
    client: substrate,
    identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' },
    workspace: WS,
    config: scratchConfig(),
    activation: seam,
    speaker: { surface: 'claude', app: null, session: { sessionId: 'sess-ghost', transcriptPath: path.join(os.tmpdir(), 'oathe-never', 'ghost.jsonl'), harness: 'claude' } },
  });
  const ghosted = await ghostWired.oathe_claim({ task_id: 'attr-ghost-task', objective: 'spoken before the transcript exists' });
  assert.equal(ghosted.claimed, true, 'the act stands');
  assert.equal(ghosted.trace_link?.linked, false);
  assert.match(ghosted.trace_link?.why, /not on disk/);
  const ghostLinks = await substrate.query("SELECT 1 FROM cell.agent_statement WHERE task_id = 'attr-ghost-task' AND subject_ref = 'trace:sess-ghost'");
  assert.equal(ghostLinks.rows.length, 0, 'no ghost link');
  await ghostWired.oathe_yield({ task_id: 'attr-ghost-task', note: 'fixture done' });
  await wired.oathe_statement({ task_id: 'attr-task', proposition: 'progress mid-turn' });
  assert.equal((await links()).rows.length, 1, 'a second write is idempotent — one link per claim × session');
  // A cursor-shaped session (no transcript store) still attributes — evidence is honestly empty.
  const cursorWired = createOatheTools({
    client: substrate,
    identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' },
    workspace: WS,
    config: scratchConfig(),
    activation: seam,
    speaker: { surface: 'cursor', app: null, session: { sessionId: 'sess-attr-cur', transcriptPath: null, harness: 'cursor' } },
  });
  await cursorWired.oathe_claim({ task_id: 'attr-cursor-task', objective: 'no transcript store, still attributed' });
  const cur = await substrate.query(
    "SELECT evidence_refs FROM cell.agent_statement WHERE task_id = 'attr-cursor-task' AND subject_ref = 'trace:sess-attr-cur'");
  assert.equal(cur.rows.length, 1);
  assert.deepEqual(cur.rows[0].evidence_refs, []);
  await wired.oathe_yield({ task_id: 'attr-task', note: 'fixture done' });
  await cursorWired.oathe_yield({ task_id: 'attr-cursor-task', note: 'fixture done' });
});

test('the PRODUCTION context factory builds serving tools — the path every real MCP call takes', async () => {
  // The pin that would have caught the founder's live TypeError: the lanes exercise
  // createOatheTools directly, but a real tools/call goes through defaultToolContextFactory.
  const { defaultToolContextFactory } = await import('../src/mcp/connection.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-mcp-factory-'));
  try {
    const build = defaultToolContextFactory({ env: { ...process.env, OATHE_DB: SCRATCH_DB } });
    const context = await build({
      resolution: { root: dir, dir, ref: WS, synthetic: false },
      client: { info: { name: 'codex' }, capabilities: {} },
    });
    assert.equal(typeof context.tools.oathe_claim, 'function', 'the factory serves the speech acts');
    assert.equal(typeof context.tools.oathe_pickup, 'function');
    await context.close?.();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('done BLOCKS on its verdict locally — the answer returns in-result, rejection carries the fork, a seam failure never breaks the act', async () => {
  // The trust boundary is the blocking boundary (ruling 2026-08-31): on your own machine a
  // speech act that owes an answer waits for it. The seam owns topology — these fakes ARE
  // the local seam's contract: dispatch, await, return the outcome.
  const seam = { register: async () => ({}), activate: async () => ({}) };
  const wired = (verifier) => createOatheTools({
    client: substrate,
    identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' },
    workspace: WS,
    config: scratchConfig(),
    activation: seam,
    verifier,
    speaker: {
      surface: 'claude', app: null,
      session: { sessionId: 'sess-vod', transcriptPath: '/tmp/vod.jsonl', harness: 'claude' },
    },
  });
  // ACCEPTED: the agent hears its verdict in the same tool call.
  const accepting = wired(async ({ taskId }) => ({ verdict: 'accepted', reason: `evidence holds for ${taskId}`, log: '/tmp/v.log' }));
  await accepting.oathe_claim({ task_id: 'vod-task', objective: 'judged in-call' });
  const done = await accepting.oathe_done({ task_id: 'vod-task', proposition: 'done', evidence_ref: 'x' });
  assert.equal(done.verification.verdict, 'accepted');
  assert.match(done.verification.reason, /evidence holds/);
  // REJECTED: the verdict lands in the lap of the agent with the context — with the fork.
  const rejecting = wired(async () => ({ verdict: 'rejected', reason: 'no artifact on disk', log: '/tmp/v.log' }));
  await rejecting.oathe_claim({ task_id: 'vod-reject', objective: 'judged and found wanting' });
  const judged = await rejecting.oathe_done({ task_id: 'vod-reject', proposition: 'done', evidence_ref: 'x' });
  assert.equal(judged.verification.verdict, 'rejected');
  assert.match(judged.verification.your_options, /prove it .*or descope it/,
    'the fork rides the rejection — rework or amend, in-session');
  // A seam failure never breaks the act: the assertion stands, the miss is disclosed.
  const failing = wired(async () => { const e = new Error('no board'); e.code = 'X'; throw e; });
  await failing.oathe_claim({ task_id: 'vod-fail', objective: 'assertion outlives the seam' });
  const survived = await failing.oathe_done({ task_id: 'vod-fail', proposition: 'done', evidence_ref: 'x' });
  assert.equal(survived.done, true);
  assert.equal(survived.verification.failed, true);
  assert.match(survived.verification.reason, /no board/);
  // oathe_verify passes the awaited outcome through — and NEVER links the caller's transcript.
  const before = await substrate.query(
    "SELECT count(*)::int AS n FROM cell.agent_statement WHERE task_id = 'vod-fail' AND subject_ref = 'trace:sess-vod'");
  const reverdict = await rejecting.oathe_verify({ task_id: 'vod-fail' });
  assert.equal(reverdict.verdict, 'rejected', 'verify returns the verdict too — one rule, both verbs');
  const after = await substrate.query(
    "SELECT count(*)::int AS n FROM cell.agent_statement WHERE task_id = 'vod-fail' AND subject_ref = 'trace:sess-vod'");
  assert.equal(after.rows[0].n, before.rows[0].n, 'a bystander transcript never becomes evidence via verify');
  await accepting.oathe_yield({ task_id: 'vod-task', note: 'fixture done' }).catch(() => {});
  await rejecting.oathe_yield({ task_id: 'vod-reject', note: 'fixture done' }).catch(() => {});
  await failing.oathe_yield({ task_id: 'vod-fail', note: 'fixture done' }).catch(() => {});
});

test('oathe_statement records a statement (a statement, not truth) against the active claim', async () => {
  const out = await tools.oathe_statement({
    task_id: 'task-x', proposition: 'Found the root cause', evidence_ref: 'commit:abc',
  });
  assert.equal(out.recorded, true);
  const { rows } = await substrate.query(
    "SELECT proposition, epistemic_status FROM cell.agent_statement "
    + "WHERE task_id = 'task-x' AND statement_type = 'progress'");
  assert.equal(rows[0].proposition, 'Found the root cause');
  assert.equal(rows[0].epistemic_status, 'observed');
});

test('oathe_statement without an active claim is a typed refusal', async () => {
  await assert.rejects(
    () => tools.oathe_statement({ task_id: 'never-claimed', proposition: 'x' }),
    (e) => e.code === 'OATHE_NO_ACTIVE_CLAIM');
});

test('oathe_yield yields through the DECLARED operator cause and frees the task', async () => {
  const out = await tools.oathe_yield({ task_id: 'task-x', note: 'handing off for tonight' });
  assert.equal(out.yielded, true);
  const { rows } = await substrate.query(
    "SELECT state FROM cell.work_claim WHERE task_id = 'task-x' ORDER BY claimed_at DESC LIMIT 1");
  assert.equal(rows[0].state, 'yielded');
});

test('oathe_yield without an active claim is a typed refusal', async () => {
  await assert.rejects(
    () => tools.oathe_yield({ task_id: 'task-x', note: 'again' }),
    (e) => e.code === 'OATHE_NO_ACTIVE_CLAIM');
});

test('oathe_yield without a note is a typed refusal BEFORE the substrate — the cause is owed, and the refusal names it', async () => {
  // The schema says `required: ['task_id', 'note']`, but the server enforces no schema: a client
  // that ignores it used to reach plpgsql and get FC141 ("a declared cause writing a basis") — a
  // sentence about yield bases, not about the missing note. Fail loud, in the tool's own words,
  // so the model that called it knows why (founder's word, 2026-09-03).
  await tools.oathe_claim({ task_id: 'yield-noteless', objective: 'a claim that tries to leave without a word' });
  for (const args of [{ task_id: 'yield-noteless' }, { task_id: 'yield-noteless', note: '   ' }, { task_id: 'yield-noteless', note: 7 }]) {
    await assert.rejects(() => tools.oathe_yield(args), (e) => {
      assert.equal(e.code, 'OATHE_YIELD_NOTE_REQUIRED');
      assert.match(e.message, /note/, 'names what is missing');
      assert.match(e.message, /refus/, 'the trailer classifier reads refusals by their own word');
      return true;
    });
  }
  const { rows } = await substrate.query(
    "SELECT state FROM cell.work_claim WHERE task_id = 'yield-noteless' ORDER BY claimed_at DESC LIMIT 1");
  assert.equal(rows[0].state, 'active', 'a refused yield leaves the claim exactly where it was');
  await tools.oathe_yield({ task_id: 'yield-noteless', note: 'fixture done' });
});

test('oathe_pickup delegates to the successor seam and returns its compiled frame', async () => {
  const calls = [];
  const seamed = createOatheTools({
    client: substrate,
    identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' },
    workspace: WS,
    config: scratchConfig(),
    successor: async (o) => { calls.push(o); return { mode: 'RECOMPILE', render: '## frame' }; },
  });
  await seamed.oathe_claim({ task_id: 'task-pickup', objective: 'continue me' });
  const out = await seamed.oathe_pickup({ task_id: 'task-pickup' });
  assert.equal(out.mode, 'RECOMPILE');
  assert.equal(out.render, '## frame');
  assert.equal(calls[0].task_id, 'task-pickup');
  assert.ok(calls[0].work_claim_id);
  // R-QUIET: the restored-state banner rides the PICKUP — the one moment it is news.
  assert.match(out.receipt, /restored your session state/i);
  assert.match(out.receipt, /task-pickup/);
});

test('oathe_pickup without a successor seam refuses rather than pretending', async () => {
  await tools.oathe_claim({ task_id: 'task-x' }); // reclaim: task-x was yielded above
  await assert.rejects(
    () => tools.oathe_pickup({ task_id: 'task-x' }),
    (e) => e.code === 'OATHE_PICKUP_UNAVAILABLE' && /oathe_claim/.test(String(e.message)) && /recovery bundle/.test(String(e.message)));
  await tools.oathe_yield({ task_id: 'task-x', note: 'back to yielded for later tests' });
});

test('oathe_pickup on a YIELDED task coaches the recovery: claim again, then pick up', async () => {
  await assert.rejects(
    () => tools.oathe_pickup({ task_id: 'task-x' }),
    (e) => e.code === 'OATHE_NO_ACTIVE_CLAIM' && /yielded/.test(e.message)
      && /claim it again/i.test(e.message));
});

test('oathe_done records a completion statement and moves the claim terminal — the loop can close', async () => {
  await tools.oathe_claim({ task_id: 'done-task', objective: 'finish honestly' });
  const out = await tools.oathe_done({
    task_id: 'done-task', proposition: 'the work described by the objective is done', evidence_ref: 'commit:xyz',
  });
  assert.equal(out.done, true);
  assert.ok(out.statement_id);
  const { rows } = await substrate.query(
    "SELECT statement_type FROM cell.agent_statement WHERE statement_id = $1", [out.statement_id]);
  assert.equal(rows[0].statement_type, 'completion');
  const claim = await substrate.query(
    "SELECT state FROM cell.work_claim WHERE task_id = 'done-task' ORDER BY claimed_at DESC LIMIT 1");
  assert.notEqual(claim.rows[0].state, 'active');
});

test('oathe_claim assigns the verifier engine at claim time, from config', async () => {
  const codexTools = createOatheTools({
    client: substrate,
    identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' },
    workspace: WS,
    config: scratchConfig({ OATHE_VERIFIER: 'codex' }),
  });
  const out = await codexTools.oathe_claim({ task_id: 'assigned-task', objective: 'verifier assigned at claim' });
  assert.equal(out.verifier, 'codex');
  const { rows } = await substrate.query(
    "SELECT subject_ref FROM cell.agent_statement WHERE work_claim_id = $1 AND subject_ref LIKE 'verifier:%'",
    [out.work_claim_id]);
  assert.deepEqual(rows.map((r) => r.subject_ref), ['verifier:codex']);
});

test('oathe_done binds the policy-standard plan (G2-b) and mints the verification task', async () => {
  await tools.oathe_claim({ task_id: 'pipeline-task', objective: 'run the whole done pipeline' });
  const out = await tools.oathe_done({
    task_id: 'pipeline-task', proposition: 'the pipeline ran', evidence_ref: 'commit:abc',
  });
  assert.equal(out.done, true);

  // 1. the plan is now DECLARED with clauses — bound BEFORE the completion terminal (FC161)
  const plan = (await substrate.query(
    "SELECT verification_plan AS p FROM cell.task WHERE task_id = 'pipeline-task'")).rows[0].p;
  assert.equal(plan.plan_status, 'declared');
  assert.deepEqual(plan.clauses, ['acceptance_package']);
  assert.ok(plan.clause_spec.acceptance_package.conditions.length >= 3, JSON.stringify(plan));
  assert.match(plan.bound_by, /policy:oathe-standard/);

  // 2. the verification task exists on the board, open, with its own declared plan + engine
  const vtask = (await substrate.query(
    "SELECT objective, verification_plan AS p FROM cell.task WHERE task_id = 'verify:pipeline-task'")).rows[0];
  assert.ok(vtask, 'verification task minted');
  assert.match(vtask.objective, /verdict/i);
  assert.equal(vtask.p.plan_status, 'declared');
  assert.equal(vtask.p.verifier_engine, 'claude');
  assert.equal(out.verification_task, 'verify:pipeline-task');

  // 3. the result coaches the ruled dispatch: a DIFFERENT principal verifies
  assert.match(out.note, /different principal|FC010/i);
  assert.match(out.note, /oathe verify/);
});

test('oathe_done leaves an already-declared plan alone — the bar never moves after being set', async () => {
  const { rows } = await substrate.query(
    "SELECT verification_plan AS p FROM cell.task WHERE task_id = 'pipeline-task'");
  const before = rows[0].p;
  await tools.oathe_claim({ task_id: 'pipeline-task' }); // re-claim the (asserted) task's successor claim
  await tools.oathe_done({ task_id: 'pipeline-task', proposition: 'done again' });
  const after = (await substrate.query(
    "SELECT verification_plan AS p FROM cell.task WHERE task_id = 'pipeline-task'")).rows[0].p;
  assert.deepEqual(after, before);
});

test('oathe_done without an active claim is a typed refusal', async () => {
  await assert.rejects(
    () => tools.oathe_done({ task_id: 'done-task', proposition: 'again' }),
    (e) => e.code === 'OATHE_NO_ACTIVE_CLAIM');
});

test('the board classifies into four buckets — asserted work is NOT open', async () => {
  // done-task reached completion_asserted earlier in this suite; task-x is yielded (open).
  const { sections } = await tools.oathe_board({});
  assert.ok(sections.asserted.some((r) => r.task_id === 'done-task'), JSON.stringify(sections.asserted));
  assert.ok(!sections.open.some((r) => r.task_id === 'done-task'), 'asserted excluded from open');
  assert.ok(sections.open.some((r) => r.task_id === 'task-x'));
  assert.deepEqual(Object.keys(sections).sort(), ['asserted', 'held', 'mine', 'open']);
});

test('the board collapses to ONE row per task: the latest claim wins', async () => {
  // task-x now has multiple claims (yielded, re-claimed, yielded again) — one row, the latest.
  const { board } = await tools.oathe_board({});
  const rows = board.filter((r) => r.task_id === 'task-x');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'yielded');
});

// ---------------------------------------------------------------- the activation seam

test('read tools REGISTER the workspace; oathe_claim ACTIVATES it and discloses what happened', async () => {
  const calls = [];
  const seamed = createOatheTools({
    client: substrate,
    identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' },
    workspace: WS,
    config: scratchConfig(),
    activation: {
      register: async (source) => { calls.push(['register', source]); return { ref: WS }; },
      activate: async (source) => {
        calls.push(['activate', source]);
        return { ref: WS, fences: ['CLAUDE.md'], registered: true };
      },
    },
    speaker: { surface: null, app: null, session: null }, // a bare terminal — required even when all-null
  });
  await seamed.oathe_board({});
  assert.deepEqual(calls.at(-1), ['register', 'oathe_board']);
  const out = await seamed.oathe_claim({ task_id: 'seam-task', objective: 'activation on claim' });
  assert.deepEqual(calls.at(-1), ['activate', 'oathe_claim']);
  assert.deepEqual(out.activation, { ref: WS, fences: ['CLAUDE.md'], registered: true });
  await seamed.oathe_yield({ task_id: 'seam-task', note: 'seam test done' });
});

test('tools without an activation seam still work — the seam is wiring, not a dependency', async () => {
  const out = await tools.oathe_board({});
  assert.ok(out.sections);
});

// ---------------------------------------------------------------- R-HOME-BOARD: home fixed at mint

const WS2 = 'ws-fedcba654321';
function toolsFor(workspace, extra = {}) {
  return createOatheTools({
    client: substrate,
    identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' },
    workspace,
    config: scratchConfig(),
    ...extra,
  });
}
async function contractRefOf(taskId) {
  const { rows } = await substrate.query(
    "SELECT contract_ref FROM cell.work_claim WHERE task_id = $1 ORDER BY claimed_at DESC LIMIT 1", [taskId]);
  return rows[0]?.contract_ref ?? null;
}

test('a later claim from another folder INHERITS the task\'s home — row and return agree', async () => {
  const home = toolsFor(WS);
  const elsewhere = toolsFor(WS2);
  await home.oathe_claim({ task_id: 'homed-task', objective: 'minted in WS' });
  await home.oathe_yield({ task_id: 'homed-task', note: 'handing off' });
  const out = await elsewhere.oathe_claim({ task_id: 'homed-task' });
  assert.equal(await contractRefOf('homed-task'), `workspace:${WS};contract:oathe/homed-task@v1`,
    'the claim row carries the HOME workspace, not the claiming session\'s');
  assert.equal(out.contract_ref, `workspace:${WS};contract:oathe/homed-task@v1`, 'the return tells the truth');
  assert.equal(out.home, WS);
  await elsewhere.oathe_yield({ task_id: 'homed-task', note: 'done with it' });
});

test('a task minted from a SYNTHETIC workspace is homeless: sentinel ref, home null', async () => {
  const chatgpt = toolsFor('ws-synthetic0000', { synthetic: true });
  const out = await chatgpt.oathe_claim({ task_id: 'chat-task', objective: 'minted in ChatGPT desktop' });
  assert.equal(await contractRefOf('chat-task'), 'workspace:none;contract:oathe/chat-task@v1');
  assert.equal(out.home, null);
  assert.match(out.note, /homeless/i, 'the claim says so');
  await chatgpt.oathe_yield({ task_id: 'chat-task', note: 'over to a real folder' });
});

test('adoption: the first REAL-folder claim of a homeless task sets its home; later claims inherit', async () => {
  const adopter = toolsFor(WS);
  const later = toolsFor(WS2);
  const adopted = await adopter.oathe_claim({ task_id: 'chat-task' });
  assert.equal(adopted.home, WS);
  assert.match(adopted.note, /adopted/i);
  assert.equal(await contractRefOf('chat-task'), `workspace:${WS};contract:oathe/chat-task@v1`);
  await adopter.oathe_yield({ task_id: 'chat-task', note: 'adopted, now handing off' });
  const inherited = await later.oathe_claim({ task_id: 'chat-task' });
  assert.equal(inherited.home, WS, 'home stuck at the adopting folder');
  await later.oathe_yield({ task_id: 'chat-task', note: 'back' });
});

test('a synthetic re-claim of a homeless task keeps it homeless — only real folders adopt', async () => {
  const chatgpt = toolsFor('ws-synthetic0000', { synthetic: true });
  await chatgpt.oathe_claim({ task_id: 'still-homeless', objective: 'minted in ChatGPT' });
  await chatgpt.oathe_yield({ task_id: 'still-homeless', note: 'pause' });
  const again = await chatgpt.oathe_claim({ task_id: 'still-homeless' });
  assert.equal(again.home, null);
  assert.equal(await contractRefOf('still-homeless'), 'workspace:none;contract:oathe/still-homeless@v1');
  await chatgpt.oathe_yield({ task_id: 'still-homeless', note: 'pause' });
});

// ---------------------------------------------------------------- R-HOME-BOARD: the board's home lens

async function boardTaskIds(t, opts = {}) {
  const { board } = await t.oathe_board(opts);
  return board.map((r) => r.task_id);
}

test('STRICT LENS: a task homed in WS stays on WS\'s board even while claimed from WS2 — and never appears on WS2\'s', async () => {
  const home = toolsFor(WS);
  const elsewhere = toolsFor(WS2);
  await home.oathe_claim({ task_id: 'lens-task', objective: 'homed in WS' });
  await home.oathe_yield({ task_id: 'lens-task', note: 'handing to WS2' });
  await elsewhere.oathe_claim({ task_id: 'lens-task' });
  assert.ok((await boardTaskIds(home)).includes('lens-task'), 'the home board keeps it');
  const { sections } = await home.oathe_board({});
  assert.ok(sections.mine.some((r) => r.task_id === 'lens-task'), 'held by this principal — shown as mine on the HOME board');
  assert.ok(!(await boardTaskIds(elsewhere)).includes('lens-task'), 'the claiming folder\'s board stays about ITS folder');
  assert.ok((await boardTaskIds(elsewhere, { all: true })).includes('lens-task'), 'the full board still sees it');
  await elsewhere.oathe_yield({ task_id: 'lens-task', note: 'lens test done' });
});

test('an unclaimed verify: task appears ONLY on its parent\'s home board (and on the full board)', async () => {
  const home = toolsFor(WS);
  await home.oathe_claim({ task_id: 'verified-here', objective: 'done in WS, judged from anywhere' });
  await home.oathe_done({ task_id: 'verified-here', proposition: 'finished', evidence_ref: 'commit:v' });
  assert.ok((await boardTaskIds(home)).includes('verify:verified-here'), 'the verification lives where the work lives');
  assert.ok(!(await boardTaskIds(toolsFor(WS2))).includes('verify:verified-here'),
    'not visible on every board just because it is unclaimed');
  assert.ok((await boardTaskIds(toolsFor(WS2), { all: true })).includes('verify:verified-here'));
});

test('a HOMELESS task appears on every folder board — visibility is the adoption path', async () => {
  const chatgpt = toolsFor('ws-synthetic0000', { synthetic: true });
  await chatgpt.oathe_claim({ task_id: 'adopt-me', objective: 'minted in ChatGPT, waiting for a home' });
  await chatgpt.oathe_yield({ task_id: 'adopt-me', note: 'someone adopt me' });
  assert.ok((await boardTaskIds(toolsFor(WS))).includes('adopt-me'));
  assert.ok((await boardTaskIds(toolsFor(WS2))).includes('adopt-me'));
  const row = (await toolsFor(WS).oathe_board({})).board.find((r) => r.task_id === 'adopt-me');
  assert.equal(row.home, null, 'rows carry their home; homeless is null');
});

test('a claim-less non-verification task (enqueued/legacy) still appears everywhere — pinned deliberately', async () => {
  await substrate.query(`
    INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                           verify_by, claim_mode, created_at)
    VALUES ('oathe', 'enqueued-legacy', 'founder', 'never claimed by anyone', 'enqueued',
            '{"plan_status":"unknown"}'::jsonb, now() + interval '1 day', 'exclusive', now())`);
  assert.ok((await boardTaskIds(toolsFor(WS))).includes('enqueued-legacy'));
  assert.ok((await boardTaskIds(toolsFor(WS2))).includes('enqueued-legacy'));
});

// ---------------------------------------------------------------- R-BOARD-SCOPE: board scope per surface

test('a SYNTHETIC surface serves the FULL board by default — its folder lens would be meaningless', async () => {
  const home = toolsFor(WS);
  await home.oathe_claim({ task_id: 'scope-task', objective: 'homed in WS, seen from ChatGPT' });
  const chatgpt = toolsFor('ws-synthetic0000', { synthetic: true });
  const out = await chatgpt.oathe_board({});
  assert.equal(out.workspace, null, 'no folder lens on a synthetic surface');
  assert.ok(out.board.some((r) => r.task_id === 'scope-task'), 'a task homed elsewhere is visible');
  const explicit = await chatgpt.oathe_board({ all: false });
  assert.equal(explicit.workspace, null, 'asking for the folder lens on a synthetic surface still serves the full board');
  await home.oathe_yield({ task_id: 'scope-task', note: 'scope test done' });
});

test('the lease stamp is unambiguous UTC on every surface', async () => {
  await tools.oathe_claim({ task_id: 'lease-stamp', objective: 'lease render' });
  const board2 = await tools.oathe_board({});
  const mine = board2.board.find((r) => r.task_id === 'lease-stamp');
  assert.match(mine.lease_until, /Z$/, `the lease stamp carries its zone: ${mine.lease_until}`);
  await tools.oathe_yield({ task_id: 'lease-stamp', note: 'fixture done' });
});

test('attribution rides EACH act: after the /clear hook registers a new session under the same process, the next act carries it and links its transcript', async () => {
  const { resolveSpeaker } = await import('../src/speaker.mjs');
  const { SessionRegistry } = await import('../src/sessions.mjs');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-tools-speaker-')));
  const sessionsPath = path.join(dir, 'sessions.json');
  const tA = path.join(dir, 'A.jsonl'); fs.writeFileSync(tA, '');
  const tB = path.join(dir, 'B.jsonl'); fs.writeFileSync(tB, '');
  const facts = (transcriptPath) => () => ({
    ancestry: [{ pid: 200, exec: '/usr/local/bin/claude' }, { pid: 1, exec: '/sbin/launchd' }],
    app: { bundle: '/Applications/iTerm.app', pid: 100 }, transcriptPath, workspace: WS,
  });
  let t = 0;
  const registry = new SessionRegistry({ sessionsPath, clock: () => new Date(1_800_000_000_000 + (t++) * 1000).toISOString() });
  await registry.ensure({ sessionId: 'sess-act-A', pid: 200, facts: facts(tA) });
  const ps = { run: () => ({ status: 0, stdout: '  300  200 /usr/local/bin/node\n  200  100 /usr/local/bin/claude\n  100    1 /Applications/iTerm.app/Contents/MacOS/iTerm2\n    1    0 /sbin/launchd\n', stderr: '' }) };
  const perAct = createOatheTools({
    client: substrate,
    identity: { orgId: 'oathe', principalId: 'founder', department: 'founder' },
    workspace: WS,
    config: scratchConfig(),
    activation: { register: async () => ({}), activate: async () => ({}) },
    speaker: resolveSpeaker({ pid: 300, sessionsPath, platform: 'darwin', exec: ps }),
  });
  const claim = await perAct.oathe_claim({ task_id: 'act-task', objective: 'attribution per act' });
  assert.equal(claim.spoken_from.session, 'sess-act-A');
  await registry.ensure({ sessionId: 'sess-act-B', pid: 200, facts: facts(tB) }); // what /clear's SessionStart writes
  const note = await perAct.oathe_statement({ task_id: 'act-task', proposition: 'spoken after the clear' });
  assert.equal(note.spoken_from.session, 'sess-act-B', 'the act after the clear is attributed to the new session');
  const { rows } = await substrate.query(
    "SELECT s.subject_ref FROM cell.agent_statement s JOIN cell.work_claim c ON c.work_claim_id = s.work_claim_id WHERE c.task_id = 'act-task' AND s.subject_ref LIKE 'trace:%' ORDER BY s.asserted_at");
  assert.deepEqual(rows.map((r) => r.subject_ref), ['trace:sess-act-A', 'trace:sess-act-B'], 'both transcripts are linked to the one claim');
  await perAct.oathe_yield({ task_id: 'act-task', note: 'fixture done' });
});
