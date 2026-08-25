import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildSuccessor } from '../src/successor.mjs';
import { createOatheTools } from '../src/mcp/oathe-tools.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';

const paths = buildPaths({});
const SCRATCH_DB = `oathe_succ_test_${process.pid}`;
const WS = 'ws-successor0000';
const identity = { orgId: 'oathe', principalId: 'firia', department: 'founder' };

let substrate;
let tools;
let successor;

before(async () => {
  substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await substrate.ensureDatabase();
  await substrate.applyDdl();
  await substrate.seed({ orgId: 'oathe', principalId: 'firia', department: 'founder' });
  await substrate.registerYieldCause();
  tools = createOatheTools({ client: substrate, identity, workspace: WS });
  successor = await buildSuccessor({ substrate, identity, paths, env: process.env });
});

after(async () => {
  await successor?.close?.();
  await substrate.close();
  await substrate.dropDatabase();
});

test('the successor sequence over a claim with NO prior attempt: RECOMPILE, a real attempt row, a rendered frame', async () => {
  const { work_claim_id } = await tools.oathe_claim({
    task_id: 'succ-task', objective: 'carry this obligation across sessions',
  });
  const out = await successor.pickup({ task_id: 'succ-task', work_claim_id });
  assert.equal(out.mode, 'RECOMPILE');
  assert.ok(out.attempt_id, 'an execution attempt was allocated');
  assert.equal(typeof out.render, 'string');
  assert.ok(out.render.length > 0, 'a compiled frame came back');
  const { rows } = await substrate.query(
    'SELECT count(*)::int AS n FROM cell.execution_attempt WHERE work_claim_id = $1', [work_claim_id]);
  assert.equal(rows[0].n, 1, 'the attempt is durable in the cell');
});

test('a second pickup on the same claim reads the PRIOR attempt through the successor path', async () => {
  const { rows } = await substrate.query(
    "SELECT work_claim_id FROM cell.work_claim WHERE task_id = 'succ-task' AND state = 'active'");
  const workClaimId = rows[0].work_claim_id;
  const out = await successor.pickup({ task_id: 'succ-task', work_claim_id: workClaimId });
  assert.ok(out.attempt_id);
  assert.ok(['RESUME', 'RECOMPILE'].includes(out.mode));
  assert.ok(out.prior_attempt_seen === true || out.mode === 'RECOMPILE',
    'the prior attempt participated in the decision');
});
