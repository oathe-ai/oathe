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

test('refresh() re-reads the file into the SAME object — a holder that loaded long ago sees what others saved, never its snapshot (B4)', () => {
  // The MCP server builds its context once per config change and keeps the manifest object for
  // days; every oathe_claim through it used to write that snapshot back over init's rows
  // (measured 2026-09-03: rows dated 2026-08-31 beside files the 0.4.0 init had rewritten).
  const { manifestPath, backupsDir } = scratch();
  const longLived = InstallManifest.load({ manifestPath, backupsDir, clock: FIXED_CLOCK });
  longLived.save();
  const init = InstallManifest.load({ manifestPath, backupsDir, clock: FIXED_CLOCK });
  init.upsert({ harness: 'claude', file: '/h/.claude/settings.json', kind: 'json-path', detail: { paths: [['a']] }, blockVersion: '0.4.1', sha256: 'x' });
  init.backupOnce(manifestPath); // any file: the backups list must travel too
  init.save();
  assert.deepEqual(longLived.rows, [], 'the stale snapshot, before refresh');
  const same = longLived.refresh();
  assert.equal(same, longLived, 'refresh returns the object it refreshed');
  assert.equal(longLived.rows.length, 1);
  assert.equal(longLived.rows[0].harness, 'claude');
  assert.equal(longLived.backups.length, 1, 'backups refreshed with the rows');
  longLived.upsert({ harness: 'project', file: '/ws/CLAUDE.md', kind: 'fence', detail: null, blockVersion: '0.4.1', sha256: 'f' });
  longLived.save();
  const onDisk = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).rows.map((r) => r.harness).sort();
  assert.deepEqual(onDisk, ['claude', 'project'], "init's row survived the long-lived holder's save");
});

test('refresh({ merge: true }) keeps rows that landed since this object loaded, drops what this object removed, and lets its own rows win (B4, the init/uninstall case)', () => {
  const { manifestPath, backupsDir } = scratch();
  const seed = InstallManifest.load({ manifestPath, backupsDir, clock: FIXED_CLOCK });
  seed.upsert({ harness: 'codex', file: '/h/.codex/config.toml', kind: 'cli-managed', detail: { stanza: 'old' }, blockVersion: '0.3.1', sha256: 'o' });
  seed.upsert({ harness: 'claude', file: '/h/.claude/settings.json', kind: 'json-path', detail: { paths: [['a']] }, blockVersion: '0.3.1', sha256: 'o' });
  seed.save();
  const init = InstallManifest.load({ manifestPath, backupsDir, clock: FIXED_CLOCK }); // init loads at its start
  // …and while init runs its CLIs, a hook activates a workspace and saves its fence row:
  const hook = InstallManifest.load({ manifestPath, backupsDir, clock: FIXED_CLOCK });
  hook.upsert({ harness: 'project', file: '/ws/CLAUDE.md', kind: 'fence', detail: null, blockVersion: '0.4.1', sha256: 'f' });
  hook.save();
  // init's own work: the codex stanza is offboarded, the claude row is rewritten
  init.removeWhere((r) => r.harness === 'codex');
  init.upsert({ harness: 'claude', file: '/h/.claude/settings.json', kind: 'json-path', detail: { paths: [['a']] }, blockVersion: '0.4.1', sha256: 'n' });
  init.refresh({ merge: true });
  init.save();
  const rows = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).rows;
  assert.deepEqual(rows.map((r) => `${r.harness}@${r.block_version}`).sort(), ['claude@0.4.1', 'project@0.4.1'],
    "the hook's fence row is kept, the removed codex row stays removed, init's rewrite wins");
  // A row removed and then written again in the same run is a row, not a removal.
  init.upsert({ harness: 'codex', file: '/h/.codex/config.toml', kind: 'cli-managed', detail: { stanza: 'old' }, blockVersion: '0.4.1', sha256: 'n' });
  init.refresh({ merge: true });
  assert.ok(init.rows.some((r) => r.harness === 'codex' && r.block_version === '0.4.1'));
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
