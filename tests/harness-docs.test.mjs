// The harness-docs snapshot (.harness-docs/, gitignored) is each adapter's pinned ground truth:
// schema checks and version-drift reviews read the snapshot, not the live web. These tests drive
// the pull machinery with an injected fetcher — the suite never touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DOC_SOURCES, pullDocs } from '../scripts/pull-harness-docs.mjs';

const HARNESSES = ['claude-code', 'cowork', 'claude-desktop', 'codex', 'cursor'];

function scratchDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-docs-')));
}

const fakeFetcher = (bodyFor) => async (url) => {
  const body = bodyFor(url);
  if (body === null) throw new Error(`HTTP 404: ${url}`);
  return { body, contentType: 'text/markdown' };
};

test('DOC_SOURCES covers every harness with absolute https urls and unique per-harness slugs', () => {
  for (const harness of HARNESSES) {
    assert.ok(DOC_SOURCES.some((s) => s.harness === harness), `no sources for ${harness}`);
  }
  const seen = new Set();
  for (const s of DOC_SOURCES) {
    assert.match(s.url, /^https:\/\//, `${s.harness}/${s.slug}: not https`);
    assert.match(s.slug, /^[a-z0-9-]+$/, `${s.harness}/${s.slug}: slug not kebab`);
    const key = `${s.harness}/${s.slug}`;
    assert.ok(!seen.has(key), `duplicate source ${key}`);
    seen.add(key);
  }
});

test('pullDocs writes <harness>/<slug>.md plus a manifest row carrying url, fetched_at, sha256', async () => {
  const outDir = scratchDir();
  const sources = [
    { harness: 'claude-code', slug: 'mcp', url: 'https://example.test/mcp.md' },
    { harness: 'cursor', slug: 'hooks', url: 'https://example.test/hooks' },
  ];
  const result = await pullDocs({
    outDir,
    sources,
    fetcher: fakeFetcher(() => '# doc body\n'),
    clock: () => '2026-08-28T00:00:00.000Z',
  });
  assert.equal(result.failed.length, 0);
  assert.equal(result.written.length, 2);
  const body = fs.readFileSync(path.join(outDir, 'claude-code/mcp.md'), 'utf8');
  assert.equal(body, '# doc body\n');
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  const row = manifest.sources.find((r) => r.harness === 'claude-code' && r.slug === 'mcp');
  assert.equal(row.url, 'https://example.test/mcp.md');
  assert.equal(row.fetched_at, '2026-08-28T00:00:00.000Z');
  assert.equal(row.sha256, crypto.createHash('sha256').update('# doc body\n').digest('hex'));
});

test('a re-pull with unchanged content is byte-idempotent — same file bytes, same sha', async () => {
  const outDir = scratchDir();
  const sources = [{ harness: 'codex', slug: 'hooks', url: 'https://example.test/hooks.md' }];
  const fetcher = fakeFetcher(() => 'stable body\n');
  await pullDocs({ outDir, sources, fetcher, clock: () => '2026-08-28T00:00:00.000Z' });
  const firstBytes = fs.readFileSync(path.join(outDir, 'codex/hooks.md'), 'utf8');
  const firstSha = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')).sources[0].sha256;
  await pullDocs({ outDir, sources, fetcher, clock: () => '2026-08-29T00:00:00.000Z' });
  assert.equal(fs.readFileSync(path.join(outDir, 'codex/hooks.md'), 'utf8'), firstBytes);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')).sources[0].sha256, firstSha);
});

test('a failed fetch is collected loudly per url — successes still land, nothing partial for the failure', async () => {
  const outDir = scratchDir();
  const sources = [
    { harness: 'cursor', slug: 'mcp', url: 'https://example.test/ok' },
    { harness: 'cursor', slug: 'plugins', url: 'https://example.test/missing' },
  ];
  const result = await pullDocs({
    outDir,
    sources,
    fetcher: fakeFetcher((url) => (url.endsWith('/missing') ? null : 'ok body\n')),
    clock: () => '2026-08-28T00:00:00.000Z',
  });
  assert.equal(result.written.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].url, 'https://example.test/missing');
  assert.match(result.failed[0].error, /404/);
  assert.ok(fs.existsSync(path.join(outDir, 'cursor/mcp.md')));
  assert.ok(!fs.existsSync(path.join(outDir, 'cursor/plugins.md')));
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sources.length, 1, 'the manifest records only what actually landed');
});
