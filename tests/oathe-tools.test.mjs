import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { dispatch, makeToolDefs, createOatheTools, PROTOCOL_VERSION } from '../src/mcp/oathe-tools.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';

// ---------------------------------------------------------------- protocol (fake tools)

test('initialize advertises the legacy protocol version and tool capability', async () => {
  const out = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { tools: {} });
  assert.equal(out.result.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(out.result.capabilities, { tools: {} });
  assert.equal(out.result.serverInfo.name, 'oathe-tools');
});

test('tools/list names the five oathe tools with schemas', async () => {
  const out = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { tools: {} });
  assert.deepEqual(out.result.tools.map((t) => t.name),
    ['oathe_claim', 'oathe_board', 'oathe_statement', 'oathe_yield', 'oathe_pickup']);
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
  await substrate.seed({ orgId: 'oathe', principalId: 'firia', department: 'founder' });
  await substrate.registerYieldCause();
  tools = createOatheTools({
    client: substrate,
    identity: { orgId: 'oathe', principalId: 'firia', department: 'founder' },
    workspace: WS,
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
    `SELECT cell.claim_work('oathe', 'elsewhere', gen_random_uuid(), NULL, 'firia', 'founder',
            'exclusive', now() + interval '4 hours', 'workspace:ws-000000000000;contract:oathe/elsewhere@v1',
            now(), gen_random_uuid())`);
  const mine = await tools.oathe_board({});
  assert.ok(mine.board.some((r) => r.task_id === 'task-x'));
  assert.ok(!mine.board.some((r) => r.task_id === 'elsewhere'));
  const all = await tools.oathe_board({ all: true });
  assert.ok(all.board.some((r) => r.task_id === 'elsewhere'));
});

test('oathe_statement records a statement (a statement, not truth) against the active claim', async () => {
  const out = await tools.oathe_statement({
    task_id: 'task-x', proposition: 'Found the root cause', evidence_ref: 'commit:abc',
  });
  assert.equal(out.recorded, true);
  const { rows } = await substrate.query(
    "SELECT proposition, epistemic_status FROM cell.agent_statement WHERE task_id = 'task-x'");
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

test('oathe_pickup delegates to the successor seam and returns its compiled frame', async () => {
  const calls = [];
  const seamed = createOatheTools({
    client: substrate,
    identity: { orgId: 'oathe', principalId: 'firia', department: 'founder' },
    workspace: WS,
    successor: async (o) => { calls.push(o); return { mode: 'RECOMPILE', render: '## frame' }; },
  });
  await seamed.oathe_claim({ task_id: 'task-pickup', objective: 'continue me' });
  const out = await seamed.oathe_pickup({ task_id: 'task-pickup' });
  assert.equal(out.mode, 'RECOMPILE');
  assert.equal(out.render, '## frame');
  assert.equal(calls[0].task_id, 'task-pickup');
  assert.ok(calls[0].work_claim_id);
});

test('oathe_pickup without a successor seam refuses rather than pretending', async () => {
  await assert.rejects(
    () => tools.oathe_pickup({ task_id: 'task-x' }),
    (e) => e.code === 'OATHE_PICKUP_UNAVAILABLE');
});
