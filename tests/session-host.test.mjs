import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { SessionHost } from '../src/session-host.mjs';
import { createOatheTools } from '../src/mcp/oathe-tools.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';

const paths = buildPaths({});
const SCRATCH_DB = `oathe_host_test_${process.pid}`;
const WS = 'ws-hosttest00000';
const identity = { orgId: 'oathe', principalId: 'firia', department: 'founder' };

let substrate;
let tools;

before(async () => {
  substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await substrate.ensureDatabase();
  await substrate.applyDdl();
  await substrate.seed({ orgId: 'oathe', principalId: 'firia', department: 'founder' });
  await substrate.registerYieldCause();
  tools = createOatheTools({ client: substrate, identity, workspace: WS });
});

after(async () => {
  await substrate.close();
  await substrate.dropDatabase();
});

async function leaseHoursLeft(taskId) {
  const { rows } = await substrate.query(
    `SELECT extract(epoch FROM (ownership_valid_until - now())) / 3600 AS hours
       FROM cell.work_claim WHERE task_id = $1 AND state = 'active'`, [taskId]);
  return Number(rows[0].hours);
}

function sleep(ms) { return new Promise((r) => { setTimeout(r, ms); }); }

test('while the cage shows life, the host renews the lease', async () => {
  await tools.oathe_claim({ task_id: 'alive', objective: 'stay leased' });
  await substrate.query(
    "UPDATE cell.work_claim SET ownership_valid_until = now() + interval '1 minute' WHERE task_id = 'alive'");
  const host = new SessionHost({
    client: substrate, identity, workspace: WS,
    liveness: () => true, renewIntervalMs: 40,
  });
  host.start();
  await sleep(140);
  await host.stopSilently();
  assert.ok(await leaseHoursLeft('alive') > 3, 'lease renewed to the full window');
});

test('BORN-RED SEMANTIC: a killed cage stops the renewals and the lease is left to expire — an absence stays an absence', async () => {
  await tools.oathe_claim({ task_id: 'killed', objective: 'die honestly' });
  await substrate.query(
    "UPDATE cell.work_claim SET ownership_valid_until = now() + interval '1 minute' WHERE task_id = 'killed'");
  let alive = true;
  const host = new SessionHost({
    client: substrate, identity, workspace: WS,
    liveness: () => alive, renewIntervalMs: 40,
  });
  host.start();
  await sleep(100);
  alive = false; // the kill: enumerate() would answer empty
  await sleep(140);
  assert.equal(host.running, false, 'the host observed the death and stopped itself');
  const after1 = await leaseHoursLeft('killed');
  await sleep(120);
  const after2 = await leaseHoursLeft('killed');
  assert.ok(after2 <= after1, 'no further renewals after death — the lease only runs DOWN now');
  const { rows } = await substrate.query(
    "SELECT count(*)::int AS n FROM cell.agent_statement WHERE task_id = 'killed'");
  assert.equal(rows[0].n, 0, 'NO statement fabricated for a death nobody witnessed');
});

test('a clean exit records the exit statement — terminal from exit', async () => {
  await tools.oathe_claim({ task_id: 'clean', objective: 'exit cleanly' });
  const host = new SessionHost({
    client: substrate, identity, workspace: WS,
    liveness: () => true, renewIntervalMs: 40,
  });
  host.start();
  await sleep(60);
  await host.stop({ exitCode: 0 });
  assert.equal(host.running, false);
  const { rows } = await substrate.query(
    "SELECT proposition FROM cell.agent_statement WHERE task_id = 'clean'");
  assert.equal(rows.length, 1);
  assert.match(rows[0].proposition, /session ended.*exit 0/i);
});
