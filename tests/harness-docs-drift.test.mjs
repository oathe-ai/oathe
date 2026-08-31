// The docs-drift lane (drift monitors P1): a tracked lock pins url+sha per snapshot page; the
// detector re-pulls through pullDocs, compares, and FAILS LOUD naming each changed or
// unreachable page and the adapters that depend on it. Condition-based: nothing is remembered
// between runs; `--lock` re-pins from the local snapshot manifest after a human reviewed the
// change. Driven here with the injected fetcher — the suite never touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DriftReport, checkDrift, writeLock, readLock, EXIT_DRIFT } from '../scripts/harness-docs-drift.mjs';
import { pullDocs } from '../scripts/pull-harness-docs.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-drift-')));
const SOURCES = [
  { harness: 'codex', slug: 'agents-md', url: 'https://example.test/codex/agents-md.md' },
  { harness: 'cursor', slug: 'hooks', url: 'https://example.test/cursor/hooks.md' },
];
const fetcherFor = (bodies) => async (url) => {
  if (!(url in bodies)) throw new Error(`HTTP 404: ${url}`);
  return { body: bodies[url], contentType: 'text/markdown' };
};
const BODIES = { 'https://example.test/codex/agents-md.md': '# agents\n', 'https://example.test/cursor/hooks.md': '# hooks\n' };

async function pinned() {
  const snapshotDir = scratch();
  await pullDocs({ outDir: snapshotDir, sources: SOURCES, fetcher: fetcherFor(BODIES), clock: () => '2026-08-29T00:00:00.000Z' });
  const lockPath = path.join(scratch(), 'harness-docs.lock.json');
  const lock = writeLock({ snapshotDir, lockPath, sources: SOURCES, clock: () => '2026-08-29T00:00:00.000Z' });
  return { snapshotDir, lockPath, lock };
}

test('--lock pins url + sha per page from the local snapshot manifest, sorted, with the pin time', async () => {
  const { lockPath, lock } = await pinned();
  assert.equal(lock.format, 1);
  assert.deepEqual(lock.sources.map((s) => `${s.harness}/${s.slug}`), ['codex/agents-md', 'cursor/hooks']);
  assert.equal(lock.sources[0].sha256, sha('# agents\n'));
  assert.equal(lock.sources[0].url, SOURCES[0].url);
  assert.equal(lock.sources[0].pinned_at, '2026-08-29T00:00:00.000Z');
  assert.deepEqual(readLock(lockPath), lock);
});

test('--lock without a snapshot is a loud refusal, not an empty lock', () => {
  assert.throws(() => writeLock({ snapshotDir: scratch(), lockPath: path.join(scratch(), 'x.json'), sources: SOURCES }),
    (e) => e.code === 'OATHE_DOCS_SNAPSHOT_ABSENT');
});

test('unchanged pages: ok, exit 0, nothing named', async () => {
  const { lock } = await pinned();
  const report = await checkDrift({ lock, sources: SOURCES, fetcher: fetcherFor(BODIES), dependents: () => ['codex'] });
  assert.ok(report instanceof DriftReport);
  assert.equal(report.drifted, false);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.changed, []);
  assert.deepEqual(report.unreachable, []);
});

test('a changed page is DRIFT: named with its url, both shas, and the adapters that depend on it', async () => {
  const { lock } = await pinned();
  const live = { ...BODIES, 'https://example.test/codex/agents-md.md': '# agents\n\nAGENTS.override.md is gone\n' };
  const report = await checkDrift({ lock, sources: SOURCES, fetcher: fetcherFor(live), dependents: (key) => (key === 'codex/agents-md' ? ['codex'] : []) });
  assert.equal(report.drifted, true);
  assert.equal(report.exitCode, EXIT_DRIFT);
  assert.equal(report.changed.length, 1);
  const [c] = report.changed;
  assert.equal(c.key, 'codex/agents-md');
  assert.equal(c.url, SOURCES[0].url);
  assert.equal(c.locked_sha256, sha('# agents\n'));
  assert.equal(c.live_sha256, sha(live['https://example.test/codex/agents-md.md']));
  assert.deepEqual(c.dependents, ['codex']);
  const text = report.render();
  assert.match(text, /codex\/agents-md/);
  assert.match(text, /depends: codex/);
  assert.match(text, /harness-docs-drift: drift/);
});

test('an unreachable page is DRIFT too — a page that vanished is a change', async () => {
  const { lock } = await pinned();
  const live = { 'https://example.test/codex/agents-md.md': '# agents\n' }; // cursor/hooks gone
  const report = await checkDrift({ lock, sources: SOURCES, fetcher: fetcherFor(live), dependents: () => ['cursor'] });
  assert.equal(report.drifted, true);
  assert.equal(report.unreachable.length, 1);
  assert.equal(report.unreachable[0].key, 'cursor/hooks');
  assert.match(report.unreachable[0].error, /404/);
});

test('a source with no lock entry, or a lock entry with no source, is DRIFT — the pin and the list must agree', async () => {
  const { lock } = await pinned();
  const extra = [...SOURCES, { harness: 'claude-code', slug: 'headless', url: 'https://example.test/cc/headless.md' }];
  const r1 = await checkDrift({ lock, sources: extra, fetcher: fetcherFor({ ...BODIES, 'https://example.test/cc/headless.md': '# h\n' }), dependents: () => [] });
  assert.deepEqual(r1.unlocked, ['claude-code/headless']);
  assert.equal(r1.drifted, true);
  const r2 = await checkDrift({ lock, sources: [SOURCES[0]], fetcher: fetcherFor(BODIES), dependents: () => [] });
  assert.deepEqual(r2.stale, ['cursor/hooks']);
  assert.equal(r2.drifted, true);
});

test('condition-based: two checks against the same live pages produce the same report and write nothing', async () => {
  const { lock, lockPath } = await pinned();
  const before = fs.readFileSync(lockPath, 'utf8');
  const a = await checkDrift({ lock, sources: SOURCES, fetcher: fetcherFor(BODIES), dependents: () => [] });
  const b = await checkDrift({ lock, sources: SOURCES, fetcher: fetcherFor(BODIES), dependents: () => [] });
  assert.deepEqual(a.toJSON(), b.toJSON());
  assert.equal(fs.readFileSync(lockPath, 'utf8'), before);
});
