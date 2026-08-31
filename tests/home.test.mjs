// The home board (ruling R-HOME-BOARD): the ONE owner of the contract_ref grammar and of the
// home derivation. A ContractRef is a value object — built, parsed, printed — and HomeBoard
// derives a task's home from the claim ledger (earliest REAL-folder claim of the task or, for
// a verification task, of its parent). Nothing here touches the database except HomeBoard.of.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ContractRef, HomeBoard, HomeError, HOMELESS } from '../src/home.mjs';
import { verificationTaskId, VERIFICATION_PREFIX, verifiedTaskId } from '../src/plans.mjs';

test('ContractRef round-trips a real workspace: build → string → parse', () => {
  const ref = new ContractRef({ workspace: 'ws-abcdef123456', orgId: 'oathe', taskId: 'task-x' });
  assert.equal(String(ref), 'workspace:ws-abcdef123456;contract:oathe/task-x@v1');
  const parsed = ContractRef.parse(String(ref));
  assert.equal(parsed.workspace, 'ws-abcdef123456');
  assert.equal(parsed.orgId, 'oathe');
  assert.equal(parsed.taskId, 'task-x');
  assert.equal(parsed.isHomeless, false);
});

test('a homeless ref prints the sentinel and parses back to workspace null', () => {
  const ref = new ContractRef({ workspace: null, orgId: 'oathe', taskId: 'chat-task' });
  assert.equal(String(ref), `workspace:${HOMELESS};contract:oathe/chat-task@v1`);
  assert.equal(HOMELESS, 'none');
  const parsed = ContractRef.parse(String(ref));
  assert.equal(parsed.workspace, null);
  assert.equal(parsed.isHomeless, true);
});

test('a real workspace ref can never read as homeless, and the grammar is strict', () => {
  assert.equal(ContractRef.parse('workspace:ws-000000000000;contract:oathe/t@v1').isHomeless, false);
  assert.throws(() => ContractRef.parse('garbage'),
    (e) => e instanceof HomeError && e.code === 'OATHE_CONTRACT_REF_MALFORMED');
  assert.throws(() => ContractRef.parse('workspace:ws-1;contract:oathe/t@v2'),
    (e) => e.code === 'OATHE_CONTRACT_REF_MALFORMED', 'the version suffix is part of the grammar');
});

test('the verification prefix has ONE owner: plans.mjs names it, home anchors through it', () => {
  assert.equal(VERIFICATION_PREFIX, 'verify:');
  assert.equal(verificationTaskId('t'), 'verify:t');
  assert.equal(verifiedTaskId('verify:t'), 't');
  assert.equal(verifiedTaskId('t'), null, 'a non-verification id has no verified task');
  assert.equal(HomeBoard.anchorTaskId('verify:t'), 't', 'a verification task is homed where its parent is');
  assert.equal(HomeBoard.anchorTaskId('t'), 't');
});

test('the SQL projection of the home rule is generated from the same constants — no second owner', () => {
  const sql = HomeBoard.homeSql('t');
  assert.match(sql, /split_part/);
  assert.ok(sql.includes(`'workspace:${HOMELESS};%'`), 'the sentinel exclusion rides the JS constant');
  assert.ok(sql.includes(`'${VERIFICATION_PREFIX}%'`), 'the parent anchor rides the JS prefix');
  assert.ok(sql.includes(`${VERIFICATION_PREFIX.length + 1}`), 'substr offset derives from the prefix length');
  assert.match(sql, /ORDER BY c\.claimed_at ASC LIMIT 1/, 'earliest real claim decides');
});
