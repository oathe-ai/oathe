// oathe — the install manifest: the durable record of every write oathe has made to a user
// surface. `doctor` verifies against it, `uninstall` removes exactly what it lists, and
// `backupOnce` keeps the pre-first-write copy that makes any of this reversible.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const MANIFEST_FORMAT = 1;

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
      const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.rows = doc.rows ?? [];
      manifest.backups = doc.backups ?? [];
    }
    return manifest;
  }

  save() {
    fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
    const doc = { format: MANIFEST_FORMAT, saved_at: this.clock(), rows: this.rows, backups: this.backups };
    fs.writeFileSync(this.manifestPath, `${JSON.stringify(doc, null, 2)}\n`);
  }

  /** One row per (harness, file, kind, detail identity); a re-run replaces its own row. */
  upsert({ harness, file, kind, scope = 'user', detail = null, blockVersion, sha256 }) {
    const key = this.#key({ harness, file, kind, detail });
    const row = {
      harness, file, kind, scope, detail,
      block_version: blockVersion, sha256, installed_at: this.clock(),
    };
    const at = this.rows.findIndex((r) => this.#key(r) === key);
    if (at === -1) this.rows.push(row);
    else this.rows[at] = row;
    return row;
  }

  #key({ harness, file, kind, detail }) {
    return JSON.stringify([harness, file, kind, detail ?? null]);
  }

  /** @returns {object[]} the removed rows */
  removeWhere(predicate) {
    const dropped = this.rows.filter(predicate);
    this.rows = this.rows.filter((r) => !predicate(r));
    return dropped;
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
