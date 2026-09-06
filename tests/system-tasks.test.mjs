// oathe — the machine's own tasks and the words for what happens to them (plan 2026-09-05,
// launch/2026-09-05-engines-places-plan.md). One grammar for system tasks (`verify:<task>`,
// `update:<harness>`), one vocabulary for an engine's failure (`engine-failure:<engine>[:<cause>]`)
// and an update's (`update-failure:<harness>`), one table for a row in flight (`verifying`,
// `updating <Name>`), and ONE resolver for a CLI's address on a PATH.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SYSTEM_TASKS, systemTaskId, systemTaskOf, isSystemTaskSql,
  VERIFICATION_PREFIX, verificationTaskId, isVerificationTask, verifiedTaskId,
} from '../src/plans.mjs';
import { engineFailureRef, parseEngineFailure, isEngineFailureSql, updateFailureRef, isUpdateFailureSql } from '../src/statements.mjs';
import { IN_FLIGHT, JUDGMENT, KINDS, UPDATE_ACT } from '../src/breach-digest.mjs';
import { updatable } from '../src/harnesses/catalog.mjs';
import { Harness } from '../src/harnesses/harness.mjs';
import { noticeFor } from '../src/wire.mjs';

test('system tasks have ONE grammar: <kind>:<subject> — verify: and update: — and the verify helpers are thin calls on it', () => {
  assert.deepEqual(SYSTEM_TASKS, { verify: 'verify:', update: 'update:' });
  assert.equal(systemTaskId('verify', 't-1'), 'verify:t-1');
  assert.equal(systemTaskId('update', 'codex'), 'update:codex');
  assert.deepEqual(systemTaskOf('verify:t-1'), { kind: 'verify', subject: 't-1' });
  assert.deepEqual(systemTaskOf('update:codex'), { kind: 'update', subject: 'codex' });
  assert.equal(systemTaskOf('plain-task'), null);
  assert.throws(() => systemTaskId('deploy', 'x'), /system task kind/, 'an unknown kind is refused, never a new prefix by accident');
  assert.equal(VERIFICATION_PREFIX, SYSTEM_TASKS.verify);
  assert.equal(verificationTaskId('t'), 'verify:t');
  assert.equal(isVerificationTask('verify:t'), true);
  assert.equal(isVerificationTask('update:codex'), false, 'an update is a system task, not a verification');
  assert.equal(verifiedTaskId('verify:t'), 't');
  const sql = isSystemTaskSql('t.task_id');
  assert.match(sql, /t\.task_id LIKE 'verify:%'/);
  assert.match(sql, /t\.task_id LIKE 'update:%'/, 'every system kind is excluded from work rows by the one SQL');
});

test('an engine failure is typed by its cause: engine-failure:<engine>[:<cause>] — one writer, one parser; an update failure is its sibling', () => {
  assert.equal(engineFailureRef('codex'), 'engine-failure:codex');
  assert.equal(engineFailureRef('codex', 'outdated'), 'engine-failure:codex:outdated');
  assert.deepEqual(parseEngineFailure('engine-failure:codex:outdated'), { engine: 'codex', cause: 'outdated' });
  assert.deepEqual(parseEngineFailure('engine-failure:claude'), { engine: 'claude', cause: null });
  assert.equal(parseEngineFailure('evidence-failure:x'), null);
  assert.match(isEngineFailureSql('col'), /LIKE 'engine-failure:%'/);
  assert.equal(updateFailureRef('codex'), 'update-failure:codex');
  assert.match(isUpdateFailureSql('col'), /LIKE 'update-failure:%'/);
});

test('a row in flight has ONE table of words: verifying (a judge holds it) and updating <Name> (the machine updates its engine); the judgment words read from it; the update act has its word', () => {
  assert.equal(IN_FLIGHT.verify.word, 'verifying');
  assert.equal(typeof IN_FLIGHT.verify.detail, 'string');
  assert.equal(IN_FLIGHT.update.word('Codex'), 'updating Codex');
  assert.match(IN_FLIGHT.update.detail('Codex'), /Codex/);
  assert.equal(JUDGMENT.verifying.word, IN_FLIGHT.verify.word, 'spelled once');
  assert.equal(UPDATE_ACT, 'update ↗');
  assert.ok(Object.values(KINDS).every((k) => k.act.endsWith('↗')), 'every act word is an arrow — the update joins them');
});

test('the catalog says which harness the glass can update: the adapter declares install.update', () => {
  assert.equal(updatable('codex'), true);
  assert.equal(updatable('claude'), true);
  assert.equal(updatable('cursor'), false, 'no declared updater — no update act, the stall words stay honest');
  assert.equal(updatable('nobody'), false);
});

test('Harness.resolveOnPath is the ONE resolver of a CLI\'s address: the first executable on the given PATH, or null', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-resolve-'));
  const a = path.join(home, 'a'); const b = path.join(home, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, 'codex'), '#!/bin/sh\n'); fs.chmodSync(path.join(b, 'codex'), 0o755);
  fs.writeFileSync(path.join(a, 'codex'), 'not executable'); // present but not X_OK — skipped
  assert.equal(Harness.resolveOnPath(`${a}:${b}`, 'codex'), path.join(b, 'codex'));
  assert.equal(Harness.resolveOnPath(`${a}:${b}`, 'agent'), null);
  assert.equal(Harness.resolveOnPath('', 'codex'), null);
  assert.equal(Harness.resolveOnPath(undefined, 'codex'), null);
});

test('the wire has the update\'s two notices: engine_updated (sage, re-verifying) and engine_update_failed (amber, the tail)', () => {
  assert.deepEqual(noticeFor('engine_updated', 'update:codex', 'Codex'), { text: '✓ Codex updated — re-verifying.', tone: 'sage' });
  const failed = noticeFor('engine_update_failed', 'update:codex', 'Codex: npm ERR! EACCES');
  assert.equal(failed.tone, 'amber');
  assert.match(failed.text, /✗ Codex update failed/);
  assert.match(failed.text, /npm ERR! EACCES/);
});
