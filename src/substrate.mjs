// oathe — the local cell substrate: detect Postgres, create the cell database, apply the shipped
// DDL additively, seed the operator principal, register the operator yield cause.
//
// The DDL source of truth is the monorepo's 26 files, applied in DDL_FILES order — the list is
// carried here VERBATIM because the DDL README binds "applied in DDL_FILES order from apply.py,
// never by glob"; a unit test cross-checks this list against both apply.py and the directory, so
// drift fails the suite rather than reordering a schema. Idempotency is oathe's own bookkeeping
// (oathe.ddl_applied), not an assumption about the files: an applied file is skipped, an applied
// file whose bytes CHANGED is a refusal (pinned files do not drift quietly), never DROP anything.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require('pg');

export const DDL_FILES = Object.freeze([
  '001_core.sql',
  '002_claim.sql',
  '003_verification.sql',
  '004_delegation.sql',
  '005_escalation.sql',
  '006_dependency.sql',
  '007_assignment.sql',
  '008_effect_receipt.sql',
  '009_verified_edge.sql',
  '010_parent_child_verification.sql',
  '011_confirm.sql',
  '012_evaluator_lane.sql',
  '013_claim_terminal.sql',
  '014_claim_settlement.sql',
  '015_claim_yield.sql',
  '016_reopened_reclaim.sql',
  '017_claim_yield_causes.sql',
  '018_receiptless_unknown.sql',
  '019_verification_contract_freeze.sql',
  '020_context_compilation.sql',
  '021_execution_attempt_closure.sql',
  '022_verification_clause.sql',
  '023_executor_role.sql',
  '024_executor_role_hardening.sql',
  '025_running_attempt_uniqueness.sql',
  '026_acceptance_authority.sql',
]);

const YIELD_CAUSE_FN = 'cell.oathe_yield_operator';
const YIELD_BASIS_PREFIX = 'operator_decision';

export class SubstrateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SubstrateError';
    this.code = code;
    this.details = details;
  }
}

export class Substrate {
  /** @param {{database?: string, paths: object, env?: NodeJS.ProcessEnv}} o */
  constructor({ database = 'oathe_local', paths, env = process.env }) {
    this.database = database;
    this.paths = paths;
    this.host = env.OATHE_PG_HOST || '/tmp'; // homebrew's default socket dir on this machine
    this.port = Number(env.OATHE_PG_PORT || 5432);
    /** @type {import('pg').Client|null} */
    this.client = null;
  }

  connectionConfig(database = this.database) {
    return { host: this.host, port: this.port, database };
  }

  /** libpq-style connection string for consumers (firia-runtime config) that want one. */
  connectionString(database = this.database) {
    return `postgresql://localhost/${database}?host=${encodeURIComponent(this.host)}&port=${this.port}`;
  }

  async #adminClient() {
    const client = new pg.Client(this.connectionConfig('postgres'));
    await client.connect();
    return client;
  }

  async #cellClient() {
    if (!this.client) {
      this.client = new pg.Client(this.connectionConfig());
      await this.client.connect();
    }
    return this.client;
  }

  async query(sql, params) {
    const client = await this.#cellClient();
    return client.query(sql, params);
  }

  /** @returns {Promise<{reachable: boolean, detail: string|null}>} */
  async detect() {
    let admin;
    try {
      admin = await this.#adminClient();
      await admin.query('SELECT 1');
      return { reachable: true, detail: null };
    } catch (e) {
      return { reachable: false, detail: String(e?.message || e) };
    } finally {
      if (admin) await admin.end().catch(() => {});
    }
  }

  /** @returns {Promise<{created: boolean}>} */
  async ensureDatabase() {
    const admin = await this.#adminClient();
    try {
      const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [this.database]);
      if (rows.length > 0) return { created: false };
      // CREATE DATABASE cannot be parameterized; the name is oathe's own constant, quoted anyway.
      await admin.query(`CREATE DATABASE "${this.database.replaceAll('"', '""')}"`);
      return { created: true };
    } finally {
      await admin.end();
    }
  }

  /** Scratch-test helper only — the product NEVER drops (uninstall keeps the DB sans --purge-db). */
  async dropDatabase() {
    const admin = await this.#adminClient();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${this.database.replaceAll('"', '""')}"`);
    } finally {
      await admin.end();
    }
  }

  shaOf(filename) {
    const bytes = fs.readFileSync(path.join(this.paths.ddlDir, filename));
    return require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  }

  /**
   * Apply DDL_FILES in order. Each file runs in its own transaction and is recorded in
   * oathe.ddl_applied; the first failure is terminal (the README's rule).
   * @returns {Promise<{applied: string[], skipped: string[]}>}
   */
  async applyDdl() {
    const client = await this.#cellClient();
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS oathe;
      CREATE TABLE IF NOT EXISTS oathe.ddl_applied (
        filename   text PRIMARY KEY,
        sha256     text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query('SELECT filename, sha256 FROM oathe.ddl_applied');
    const recorded = new Map(rows.map((r) => [r.filename, r.sha256]));
    const applied = [];
    const skipped = [];
    for (const filename of DDL_FILES) {
      const sha = this.shaOf(filename);
      const prior = recorded.get(filename);
      if (prior === sha) { skipped.push(filename); continue; }
      if (prior !== undefined) {
        throw new SubstrateError('DDL_DRIFT',
          `${filename} was applied with sha ${prior.slice(0, 12)}… but the file on disk now hashes `
          + `${sha.slice(0, 12)}… — a pinned DDL file does not drift quietly; refusing to re-apply`,
          { filename });
      }
      const sql = fs.readFileSync(path.join(this.paths.ddlDir, filename), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO oathe.ddl_applied (filename, sha256) VALUES ($1, $2)', [filename, sha]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new SubstrateError('DDL_APPLY_FAILED',
          `${filename} failed to apply: ${String(e?.message || e)} — the first failure is terminal`,
          { filename, cause: String(e?.message || e) });
      }
      applied.push(filename);
    }
    return { applied, skipped };
  }

  /** @returns {Promise<{inserted: boolean}>} */
  async seed({ orgId, principalId, department }) {
    const { rowCount } = await this.query(
      `INSERT INTO cell.principal (org_id, principal_id, role, assigner_principal_id, department)
       VALUES ($1, $2, 'ceo', NULL, $3) ON CONFLICT DO NOTHING`,
      [orgId, principalId, department]);
    return { inserted: rowCount === 1 };
  }

  /**
   * The operator yield cause: a real plpgsql function (record_claim_yield resolves its caller off
   * the call stack via cell.written_by) plus its declared basis prefix. The play script's exact
   * pattern, productized under oathe's name.
   */
  async registerYieldCause() {
    await this.query(`
      CREATE OR REPLACE FUNCTION ${YIELD_CAUSE_FN}(
        p_work_claim_id uuid, p_note text, p_at timestamptz, p_event_id uuid
      ) RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN
        PERFORM cell.record_claim_yield(p_work_claim_id, '${YIELD_BASIS_PREFIX}: ' || p_note, p_at, p_event_id);
      END $fn$`);
    await this.query(
      `INSERT INTO cell.claim_yield_cause (cause, basis_prefix) VALUES ($1, $2)
       ON CONFLICT (cause) DO UPDATE SET basis_prefix = EXCLUDED.basis_prefix`,
      [YIELD_CAUSE_FN, YIELD_BASIS_PREFIX]);
    return { registered: true };
  }

  async status() {
    const reachable = await this.detect();
    if (!reachable.reachable) {
      return { reachable: false, database_exists: false, ddl_applied: 0, yield_cause_registered: false };
    }
    const admin = await this.#adminClient();
    let databaseExists;
    try {
      const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [this.database]);
      databaseExists = rows.length > 0;
    } finally {
      await admin.end();
    }
    if (!databaseExists) {
      return { reachable: true, database_exists: false, ddl_applied: 0, yield_cause_registered: false };
    }
    const ddl = await this.query(
      "SELECT count(*)::int AS n FROM pg_tables t WHERE schemaname = 'oathe' AND tablename = 'ddl_applied'");
    const ddlApplied = ddl.rows[0].n === 0
      ? 0
      : (await this.query('SELECT count(*)::int AS n FROM oathe.ddl_applied')).rows[0].n;
    // With no DDL there is no cell schema to ask about the yield cause.
    const causeRegistered = ddlApplied > 0
      && (await this.query(
        'SELECT count(*)::int AS n FROM cell.claim_yield_cause WHERE cause = $1', [YIELD_CAUSE_FN],
      )).rows[0].n === 1;
    return {
      reachable: true,
      database_exists: true,
      ddl_applied: ddlApplied,
      yield_cause_registered: causeRegistered,
    };
  }

  async close() {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }
}
