import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InstallManifest, sha256Hex } from '../src/manifest.mjs';

const FIXED_CLOCK = () => '2026-08-25T00:00:00.000Z';

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-manifest-'));
  return {
    manifestPath: path.join(dir, 'install-manifest.json'),
    backupsDir: path.join(dir, 'backups'),
    dir,
  };
}

test('sha256Hex hashes text stably', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('load on a missing manifest yields an empty manifest that can save itself', () => {
  const { manifestPath, backupsDir } = scratch();
  const m = InstallManifest.load({ manifestPath, backupsDir, clock: FIXED_CLOCK });
  assert.deepEqual(m.rows, []);
  m.save();
  assert.ok(fs.existsSync(manifestPath));
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).rows, []);
});

test('upsert keys on (harness,file,kind,detail-key) — a re-run replaces, never duplicates', () => {
  const { manifestPath, backupsDir } = scratch();
  const m = InstallManifest.load({ manifestPath, backupsDir, clock: FIXED_CLOCK });
  m.upsert({ harness: 'claude', file: '/f', kind: 'fence', blockVersion: '0.1.0', sha256: 'aaa' });
  m.upsert({ harness: 'claude', file: '/f', kind: 'fence', blockVersion: '0.2.0', sha256: 'bbb' });
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0].block_version, '0.2.0');
  assert.equal(m.rows[0].sha256, 'bbb');
  assert.equal(m.rows[0].installed_at, FIXED_CLOCK());
});

test('rows round-trip through save/load byte-identically', () => {
  const { manifestPath, backupsDir } = scratch();
  const m = InstallManifest.load({ manifestPath, backupsDir, clock: FIXED_CLOCK });
  m.upsert({
    harness: 'codex', file: '/g', kind: 'json-path',
    detail: { paths: [['a', 'b']] }, blockVersion: '0.1.0', sha256: 'ccc', scope: 'user',
  });
  m.save();
  const first = fs.readFileSync(manifestPath, 'utf8');
  const reloaded = InstallManifest.load({ manifestPath, backupsDir, clock: FIXED_CLOCK });
  assert.deepEqual(reloaded.rows, m.rows);
  reloaded.save();
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), first);
});

test('backupOnce copies the file to backups/<sha>-<basename> once; a second call is a no-op', () => {
  const { manifestPath, backupsDir, dir } = scratch();
  const target = path.join(dir, 'settings.json');
  fs.writeFileSync(target, '{"a":1}');
  const m = InstallManifest.load({ manifestPath, backupsDir, clock: FIXED_CLOCK });
  const p1 = m.backupOnce(target);
  assert.equal(path.basename(p1), `${sha256Hex('{"a":1}').slice(0, 12)}-settings.json`);
  assert.equal(fs.readFileSync(p1, 'utf8'), '{"a":1}');
  fs.writeFileSync(target, '{"a":2}');
  const p2 = m.backupOnce(target);
  assert.equal(p2, p1);
  assert.equal(fs.readFileSync(p1, 'utf8'), '{"a":1}');
  assert.equal(m.backups.length, 1);
});

test('backupOnce of a file that does not exist yet records an absent-before marker', () => {
  const { manifestPath, backupsDir, dir } = scratch();
  const m = InstallManifest.load({ manifestPath, backupsDir, clock: FIXED_CLOCK });
  const p = m.backupOnce(path.join(dir, 'CLAUDE.md'));
  assert.equal(p, null);
  assert.equal(m.backups[0].absent_before, true);
});

test('removeWhere drops matching rows and reports what it dropped', () => {
  const { manifestPath, backupsDir } = scratch();
  const m = InstallManifest.load({ manifestPath, backupsDir, clock: FIXED_CLOCK });
  m.upsert({ harness: 'claude', file: '/f', kind: 'fence', blockVersion: '1', sha256: 'a' });
  m.upsert({ harness: 'codex', file: '/g', kind: 'fence', blockVersion: '1', sha256: 'b' });
  const dropped = m.removeWhere((r) => r.harness === 'claude');
  assert.equal(dropped.length, 1);
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0].harness, 'codex');
});
