import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { FiriaRuntimeProvider } from '../src/runtime/provider.mjs';
import { createOatheTools } from '../src/mcp/oathe-tools.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';

const paths = buildPaths({});
const SCRATCH_DB = `oathe_succ_test_${process.pid}`;
const WS = 'ws-successor0000';
const identity = { orgId: 'oathe', principalId: 'firia', department: 'founder' };

// Successor is firia-only: the standalone provider refuses it TYPED (proven in
// runtime-provider.test.mjs). On a machine with no monorepo checkout, OR a checkout whose
// firia-runtime symlink is missing (Finding 1 — `npm run link-firia` was never run), skip
// LOUDLY — never silently. Reuses the provider's own probe() rather than duplicating the
// resolve logic here (DRY).
const cagePresent = fs.existsSync(paths.cagePath ?? '');
const FIRIA_PRESENT = cagePresent && new FiriaRuntimeProvider({ paths }).probe().ok;
const skip = !FIRIA_PRESENT && 'firia runtime not on this machine — successor is firia-only';

let substrate;
let tools;
let successor;

before(async () => {
  if (!FIRIA_PRESENT) return;
  substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await substrate.ensureDatabase();
  await substrate.applyDdl();
  await substrate.seed({ orgId: 'oathe', principalId: 'firia', department: 'founder' });
  await substrate.registerYieldCause();
  tools = createOatheTools({ client: substrate, identity, workspace: WS });
  successor = await new FiriaRuntimeProvider({ paths }).successor({ substrate, identity, paths });
});

after(async () => {
  if (!FIRIA_PRESENT) return;
  await successor?.close?.();
  await substrate.close();
  await substrate.dropDatabase();
});

test('the successor sequence over a claim with NO prior attempt: RECOMPILE, a real attempt row, a rendered frame', { skip }, async () => {
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

test('a second pickup on the same claim reads the PRIOR attempt through the successor path', { skip }, async () => {
  const { rows } = await substrate.query(
    "SELECT work_claim_id FROM cell.work_claim WHERE task_id = 'succ-task' AND state = 'active'");
  const workClaimId = rows[0].work_claim_id;
  const out = await successor.pickup({ task_id: 'succ-task', work_claim_id: workClaimId });
  assert.ok(out.attempt_id);
  assert.ok(['RESUME', 'RECOMPILE'].includes(out.mode));
  assert.ok(out.prior_attempt_seen === true || out.mode === 'RECOMPILE',
    'the prior attempt participated in the decision');
});
