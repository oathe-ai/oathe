import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InstallManifest, InstallManifestError, MANIFEST_FORMAT, sha256Hex } from '../src/manifest.mjs';

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

test('cliAddressFor(harness) reads the ONE cli-address row a harness has — the address init measured — or null', async () => {
  const { InstallManifest } = await import('../src/manifest.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-manifest-addr-'));
  const m = InstallManifest.load({ manifestPath: path.join(home, 'install-manifest.json'), backupsDir: path.join(home, 'backups') });
  assert.equal(m.cliAddressFor('codex'), null);
  m.upsert({ harness: 'codex', file: '/Users/x/.local/bin/codex', kind: 'cli-address', detail: { bin: 'codex' }, blockVersion: '0.4.5', sha256: null });
  assert.equal(m.cliAddressFor('codex'), '/Users/x/.local/bin/codex');
  assert.equal(m.cliAddressFor('claude'), null);
});

test('the manifest\'s format is its GATE (zero legacy, 2026-09-05): not JSON, another format, or a body without rows/backups refuses typed by name — never an empty manifest read', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-manifest-fmt-'));
  const manifestPath = path.join(home, 'install-manifest.json');
  const load = () => InstallManifest.load({ manifestPath, backupsDir: path.join(home, 'backups') });
  fs.writeFileSync(manifestPath, 'not json{');
  assert.throws(load, (e) => e instanceof InstallManifestError && e.code === 'OATHE_MANIFEST_MALFORMED' && e.message.includes(manifestPath));
  fs.writeFileSync(manifestPath, JSON.stringify({ format: MANIFEST_FORMAT + 1, rows: [], backups: [] }));
  assert.throws(load, (e) => e.code === 'OATHE_MANIFEST_FORMAT' && e.message.includes(`format ${MANIFEST_FORMAT + 1}`) && /uninstall with the oathe that wrote it/.test(e.message));
  fs.writeFileSync(manifestPath, JSON.stringify({ format: MANIFEST_FORMAT, rows: [] }));
  assert.throws(load, (e) => e.code === 'OATHE_MANIFEST_FORMAT', 'a body missing a key this oathe always writes is another oathe\'s file');
  fs.writeFileSync(manifestPath, JSON.stringify({ format: MANIFEST_FORMAT, rows: [], backups: [] }));
  assert.deepEqual([load().rows, load().backups], [[], []]);
});

test('a row\'s identity is (harness, file, kind, detail.id) when the writer names an id — a re-init whose detail changed shape REPLACES its row, never leaves the older one beside it (the live 2026-09-05 `proof` → `proofs` twin)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-manifest-id-'));
  const m = InstallManifest.load({ manifestPath: path.join(home, 'install-manifest.json'), backupsDir: path.join(home, 'backups') });
  m.upsert({ harness: 'claude', file: '/f', kind: 'cli-managed', detail: { id: 'plugin-install', proof: 'x', undo: [] }, blockVersion: '0.4.4', sha256: 'a' });
  m.upsert({ harness: 'claude', file: '/f', kind: 'cli-managed', detail: { id: 'plugin-install', proofs: ['x'], undo: [] }, blockVersion: '0.4.5', sha256: 'a' });
  assert.equal(m.rows.length, 1, 'one row per id — converged');
  assert.deepEqual(m.rows[0].detail, { id: 'plugin-install', proofs: ['x'], undo: [] }, 'the latest writer\'s shape');
  assert.equal(m.rows[0].block_version, '0.4.5', 'stamped with the version that wrote it');
  // Two ids on one file are two rows; rows without an id keep the whole detail as identity.
  m.upsert({ harness: 'claude', file: '/f', kind: 'cli-managed', detail: { id: 'mcp-server', command: '/shim' }, blockVersion: '0.4.5', sha256: 'b' });
  m.upsert({ harness: 'x', file: '/g', kind: 'json-path', detail: { paths: [['a']] }, blockVersion: '0.4.5', sha256: 'c' });
  m.upsert({ harness: 'x', file: '/g', kind: 'json-path', detail: { paths: [['b']] }, blockVersion: '0.4.5', sha256: 'c' });
  assert.equal(m.rows.length, 4);
  // Twins an earlier writer left behind (the live 2026-09-05 manifest) collapse on the next upsert of that identity.
  m.rows.push({ ...m.rows[0], installed_at: 'older' }, { ...m.rows[0], installed_at: 'oldest', detail: { id: 'plugin-install', proof: 'x' } });
  m.upsert({ harness: 'claude', file: '/f', kind: 'cli-managed', detail: { id: 'plugin-install', proofs: ['x'], undo: [] }, blockVersion: '0.4.5', sha256: 'a' });
  assert.equal(m.rows.filter((r) => r.detail?.id === 'plugin-install').length, 1, 'one row per identity, whatever the file held');
});
