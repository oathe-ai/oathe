#!/usr/bin/env node
// oathe — the docs-drift lane (drift monitors P1). A harness's documentation is the ground
// truth our adapters were written against; when a page we depend on changes, something in
// the tree may be wrong and nobody will know. This detector makes that LOUD: a tracked lock
// (harness-docs.lock.json) pins url + sha per snapshot page; a run re-pulls every locked page
// through the same pullDocs machinery the snapshot uses, compares, and exits 3 naming each
// changed or unreachable page and the adapters that depend on it (their `static docs`).
// Condition-based: nothing is remembered between runs. `--lock` re-pins from the local
// snapshot manifest AFTER a human has reviewed the change and the adapter facts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DOC_SOURCES, pullDocs } from './pull-harness-docs.mjs';

export const EXIT_DRIFT = 3;
export const EXIT_REFUSED = 2;
const key = (s) => `${s.harness}/${s.slug}`;

export class DocsDriftError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DocsDriftError';
    this.code = code;
  }
}

/** The outcome of one check — data first, one render, one exit code. */
export class DriftReport {
  constructor({ changed = [], unreachable = [], unlocked = [], stale = [], unchanged = [], liveDir = null } = {}) {
    this.changed = changed;
    this.unreachable = unreachable;
    this.unlocked = unlocked;
    this.stale = stale;
    this.unchanged = unchanged;
    this.liveDir = liveDir;
  }

  get drifted() {
    return this.changed.length + this.unreachable.length + this.unlocked.length + this.stale.length > 0;
  }

  get exitCode() {
    return this.drifted ? EXIT_DRIFT : 0;
  }

  toJSON() {
    const { changed, unreachable, unlocked, stale, unchanged } = this;
    return { changed, unreachable, unlocked, stale, unchanged };
  }

  /** The human line-by-line report, trailer last — the same voice as every oathe verb. */
  render({ snapshotDir = null } = {}) {
    const lines = [];
    const depends = (d) => (d.length > 0 ? `  depends: ${d.join(', ')}` : '  depends: (nobody — an orphan pin)');
    for (const c of this.changed) {
      lines.push(`changed      ${c.key}  ${c.url}`);
      lines.push(`             locked ${c.locked_sha256.slice(0, 12)}  live ${c.live_sha256.slice(0, 12)}${depends(c.dependents)}`);
      if (snapshotDir && this.liveDir) {
        lines.push(`             review: diff ${path.join(snapshotDir, c.file)} ${path.join(this.liveDir, c.file)}`);
      }
    }
    for (const u of this.unreachable) lines.push(`unreachable  ${u.key}  ${u.url}: ${u.error}${depends(u.dependents)}`);
    for (const k of this.unlocked) lines.push(`unlocked     ${k}  (a DOC_SOURCE with no lock entry — run harness-docs-lock after a pull)`);
    for (const k of this.stale) lines.push(`stale        ${k}  (a lock entry with no DOC_SOURCE — run harness-docs-lock)`);
    lines.push(this.drifted
      ? `harness-docs-drift: drift (${this.changed.length} changed, ${this.unreachable.length} unreachable, `
        + `${this.unlocked.length} unlocked, ${this.stale.length} stale)`
      : `harness-docs-drift: ok (${this.unchanged.length} pages)`);
    return `${lines.join('\n')}\n`;
  }
}

export function readLock(lockPath) {
  return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
}

/**
 * Pin every listed source from the LOCAL snapshot manifest (what the last pull actually
 * landed). A missing snapshot is a refusal — an empty lock would make every page "unlocked"
 * and the monitor permanently red for the wrong reason.
 */
export function writeLock({ snapshotDir, lockPath, sources = DOC_SOURCES, clock = () => new Date().toISOString() }) {
  const manifestPath = path.join(snapshotDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new DocsDriftError('OATHE_DOCS_SNAPSHOT_ABSENT',
      `no snapshot manifest at ${manifestPath} — run \`npm run pull-harness-docs\` first`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const wanted = new Set(sources.map(key));
  const pinnedAt = clock();
  const pinned = manifest.sources
    .filter((s) => wanted.has(key(s)))
    .map((s) => ({ harness: s.harness, slug: s.slug, url: s.url, file: s.file, sha256: s.sha256, pinned_at: pinnedAt }))
    .sort((a, b) => key(a).localeCompare(key(b)));
  const lock = { format: 1, sources: pinned };
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

/**
 * Re-pull every locked page (into a scratch dir, so a run never touches the snapshot) and
 * compare against the lock. `dependents(key)` names the adapters to re-verify.
 * @returns {Promise<DriftReport>}
 */
export async function checkDrift({ lock, sources = DOC_SOURCES, fetcher = undefined, dependents, clock = undefined }) {
  const locked = new Map(lock.sources.map((s) => [key(s), s]));
  const listed = new Map(sources.map((s) => [key(s), s]));
  const unlocked = [...listed.keys()].filter((k) => !locked.has(k));
  const stale = [...locked.keys()].filter((k) => !listed.has(k));
  const toCheck = sources.filter((s) => locked.has(key(s)));
  const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-docs-live-'));
  const { written, failed } = await pullDocs({ outDir: liveDir, sources: toCheck, ...(fetcher ? { fetcher } : {}), ...(clock ? { clock } : {}) });
  const changed = [];
  const unchanged = [];
  for (const w of written) {
    const pin = locked.get(key(w));
    if (pin.sha256 === w.sha256) unchanged.push(key(w));
    else changed.push({ key: key(w), url: w.url, file: w.file, locked_sha256: pin.sha256, live_sha256: w.sha256, dependents: dependents(key(w)) });
  }
  const unreachable = failed.map((f) => ({ key: key(f), url: f.url, error: f.error, dependents: dependents(key(f)) }));
  return new DriftReport({ changed, unreachable, unlocked, stale, unchanged, liveDir });
}

async function main(argv) {
  const packageRoot = path.dirname(path.dirname(fs.realpathSync(process.argv[1])));
  const snapshotDir = path.join(packageRoot, '.harness-docs');
  const lockPath = path.join(packageRoot, 'harness-docs.lock.json');
  if (argv.includes('--lock')) {
    try {
      const lock = writeLock({ snapshotDir, lockPath });
      process.stdout.write(`harness-docs-lock: ${lock.sources.length} page(s) pinned into ${lockPath}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`harness-docs-lock: refused — ${e.message}\n`);
      return EXIT_REFUSED;
    }
  }
  if (!fs.existsSync(lockPath)) {
    process.stderr.write(`harness-docs-drift: refused — no lock at ${lockPath}; run \`npm run harness-docs-lock\` after a pull\n`);
    return EXIT_REFUSED;
  }
  const { docsDependents } = await import('../src/harnesses/catalog.mjs');
  const report = await checkDrift({ lock: readLock(lockPath), dependents: docsDependents });
  process.stdout.write(report.render({ snapshotDir }));
  return report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
