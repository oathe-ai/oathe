// oathe — the install manifest: the durable record of every write oathe has made to a user
// surface. `doctor` verifies against it, `uninstall` removes exactly what it lists, and
// `backupOnce` keeps the pre-first-write copy that makes any of this reversible.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from './fslock.mjs';

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export const MANIFEST_FORMAT = 1;

export class InstallManifestError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'InstallManifestError';
    this.code = code;
    this.details = details;
  }
}

export class InstallManifest {
  /** @param {{manifestPath: string, backupsDir: string, clock?: () => string}} o */
  constructor({ manifestPath, backupsDir, clock = () => new Date().toISOString() }) {
    this.manifestPath = manifestPath;
    this.backupsDir = backupsDir;
    this.clock = clock;
    /** @type {Array<{harness: string, file: string, kind: string, scope: string, detail: object|null, block_version: string, sha256: string, installed_at: string}>} */
    this.rows = [];
    /** @type {Array<{file: string, backup: string|null, absent_before: boolean, taken_at: string}>} */
    this.backups = [];
  }

  static load({ manifestPath, backupsDir, clock }) {
    const manifest = new InstallManifest({ manifestPath, backupsDir, clock });
    if (fs.existsSync(manifestPath)) {
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (e) {
        throw new InstallManifestError('OATHE_MANIFEST_MALFORMED',
          `${manifestPath} is not valid JSON (${e.message}) — move it aside and run oathe init (or uninstall with the oathe that wrote it)`, { file: manifestPath });
      }
      // The format is the GATE (zero legacy, founder 2026-09-05): a manifest another oathe wrote
      // is refused by name, never read as an empty one — doctor would say "nothing wired" and
      // uninstall would remove nothing.
      if (doc?.format !== MANIFEST_FORMAT || !Array.isArray(doc.rows) || !Array.isArray(doc.backups)) {
        throw new InstallManifestError('OATHE_MANIFEST_FORMAT',
          `${manifestPath} is format ${JSON.stringify(doc?.format)}; this oathe reads format ${MANIFEST_FORMAT} — `
          + 'uninstall with the oathe that wrote it, then run oathe init', { file: manifestPath, found: doc?.format, expected: MANIFEST_FORMAT });
      }
      manifest.rows = doc.rows;
      manifest.backups = doc.backups;
    }
    return manifest;
  }

  save() {
    // Atomic (temp-then-rename): concurrent hooks and servers read this file; a torn manifest
    // would break doctor/uninstall. Serializing whole load→mutate→save cycles is the caller's
    // job (withFileLock), because a lock inside save() alone cannot prevent lost updates.
    atomicWriteJson(this.manifestPath,
      { format: MANIFEST_FORMAT, saved_at: this.clock(), rows: this.rows, backups: this.backups });
  }

  /** Row identities this object removed since it last read the file — a merge-refresh must not
   *  bring them back from a disk copy that predates the removal. */
  #removed = new Set();

  /** One row per (harness, file, kind, detail identity — `detail.id` when named); a re-run replaces its own row. */
  upsert({ harness, file, kind, scope = 'user', detail = null, blockVersion, sha256 }) {
    const key = this.#key({ harness, file, kind, detail });
    const row = {
      harness, file, kind, scope, detail,
      block_version: blockVersion, sha256, installed_at: this.clock(),
    };
    const at = this.rows.findIndex((r) => this.#key(r) === key);
    if (at === -1) this.rows.push(row);
    else this.rows[at] = row;
    // Converge: every OTHER row with this identity goes too — twins an earlier writer left behind
    // (the live 2026-09-05 manifest carried three copies of one codex stanza row).
    this.rows = this.rows.filter((r, i) => i === (at === -1 ? this.rows.length - 1 : at) || this.#key(r) !== key);
    this.#removed.delete(key); // written again in the same run: a row, not a removal
    return row;
  }

  /**
   * The rows that mean a harness is WIRED — everything but its `cli-address` row, which is a
   * measurement of the machine (recorded for wired and unwired harnesses alike), never a write.
   * Every "is it onboarded?" question asks this, so an address alone wires nothing.
   */
  wiringRowsFor(harness) {
    return this.rows.filter((r) => r.harness === harness && r.kind !== 'cli-address');
  }

  /** The address init measured for a harness's CLI (its `cli-address` row), or null. */
  cliAddressFor(harness) {
    return this.rows.find((r) => r.kind === 'cli-address' && r.harness === harness)?.file ?? null;
  }

  /** A row's identity: the writer's `detail.id` when it names one (so a re-init whose detail changed
   *  shape REPLACES the row — zero legacy, 2026-09-05), else the whole detail. */
  #key({ harness, file, kind, detail }) {
    return JSON.stringify([harness, file, kind, detail?.id !== undefined ? { id: detail.id } : detail ?? null]);
  }

  /** @returns {object[]} the removed rows */
  removeWhere(predicate) {
    const dropped = this.rows.filter(predicate);
    this.rows = this.rows.filter((r) => !predicate(r));
    for (const row of dropped) this.#removed.add(this.#key(row));
    return dropped;
  }

  /**
   * Re-read this manifest's file into THIS object (B4, 2026-09-03). A holder that loaded long
   * ago — the MCP server's context, built once per config change and kept for days — used to
   * write its snapshot back over everything `oathe init` and `oathe uninstall` had recorded
   * since. Plain: rows and backups become the file's (the caller holds the lock and mutates
   * next). With `merge`: rows another writer landed since this object loaded are kept, rows
   * this object removed stay removed, and this object's own rows win on identity — what init
   * and uninstall need at the end of a run long enough for a hook to activate in between.
   * A missing file reads as empty, as load() reads it.
   * @returns {InstallManifest} this
   */
  refresh({ merge = false } = {}) {
    const fresh = InstallManifest.load({ manifestPath: this.manifestPath, backupsDir: this.backupsDir, clock: this.clock });
    if (!merge) {
      this.rows = fresh.rows;
      this.backups = fresh.backups;
    } else {
      const mine = new Set(this.rows.map((r) => this.#key(r)));
      for (const row of fresh.rows) {
        const key = this.#key(row);
        if (!mine.has(key) && !this.#removed.has(key)) this.rows.push(row);
      }
      const backedUp = new Set(this.backups.map((b) => b.file));
      for (const b of fresh.backups) if (!backedUp.has(b.file)) this.backups.push(b);
    }
    this.#removed.clear();
    return this;
  }

  /**
   * Copy `file` into backups/ before oathe's FIRST write to it — later calls are no-ops, so the
   * backup is always the pre-oathe state. A file that does not exist yet is recorded as
   * absent_before (uninstall may then delete what init created).
   * @returns {string|null} the backup path, or null when the file did not exist
   */
  backupOnce(file) {
    const existing = this.backups.find((b) => b.file === file);
    if (existing) return existing.backup;
    let entry;
    if (!fs.existsSync(file)) {
      entry = { file, backup: null, absent_before: true, taken_at: this.clock() };
    } else {
      const content = fs.readFileSync(file, 'utf8');
      fs.mkdirSync(this.backupsDir, { recursive: true });
      const backup = path.join(this.backupsDir, `${sha256Hex(content).slice(0, 12)}-${path.basename(file)}`);
      fs.writeFileSync(backup, content);
      entry = { file, backup, absent_before: false, taken_at: this.clock() };
    }
    this.backups.push(entry);
    return entry.backup;
  }
}
