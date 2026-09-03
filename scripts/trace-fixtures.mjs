// The trace fixture corpus — ONE set of tools over tests/fixtures/traces/<harness>/<fixture>/:
// list the fixtures, materialize a fixture's home/ (the state sidecar bound to the scratch),
// project a fixture the way its expected.json was minted, and repin an expectation from its
// record when the projector changes on purpose. derive-trace-fixtures.mjs mints fixtures with
// these; tests/trace-fixtures.test.mjs replays them with these; nothing projects a fixture
// any other way. A repin never touches the record: the sanitized bytes are the reviewed
// artifact (marker-scan gated, human-read diff), the expectation is derived from them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { byName } from '../src/harnesses/catalog.mjs';

export const CORPUS = new URL('../tests/fixtures/traces/', import.meta.url).pathname;
/** The placeholder a fixture's paths carry in place of the machine's home. */
export const HOME_TOKEN = '<home>';

export class FixtureRepinError extends Error {
  constructor(dir) {
    super(`${dir} carries no home/ — a fixture's expectation is derived from its record, and there is none to derive from`);
    this.name = 'FixtureRepinError';
    this.code = 'OATHE_FIXTURE_REPIN_NO_HOME';
  }
}

export function fixtureDirs(harness, corpus = CORPUS) {
  const root = path.join(corpus, harness);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory())
    .map((d) => path.join(root, d));
}

/** The harness a fixture belongs to — the corpus layout is <corpus>/<harness>/<fixture>. */
export function harnessOf(dir) {
  return path.basename(path.dirname(dir));
}

/** Materialize a fixture's home/ into a scratch dir (state.sql sidecar → state_5.sqlite). */
export function materialize(dir) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-tfx-')));
  fs.cpSync(path.join(dir, 'home'), scratch, { recursive: true });
  const stateSql = path.join(dir, 'state.sql');
  if (fs.existsSync(stateSql)) {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(path.join(scratch, '.codex', 'state_5.sqlite'));
    // the sidecar's paths are home-relative; bind them to this scratch home
    db.exec(fs.readFileSync(stateSql, 'utf8').replaceAll(HOME_TOKEN, scratch));
    db.close();
  }
  return scratch;
}

/**
 * The fixture's projection, home-normalized — exactly what its expected.json holds. `dir` is
 * a fixture (harness and record read from its place in the corpus and its expected.json) or
 * a staging dir being minted (harness and record given).
 */
export async function projectFixture(dir, { harness = harnessOf(dir), record = undefined } = {}) {
  const rel = record ?? JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')).record;
  const scratch = materialize(dir);
  const capability = byName(harness).traces;
  const projector = await capability.projector({ store: capability.store({ home: scratch }) });
  const trajectory = projector.project(path.join(scratch, rel));
  return JSON.parse(JSON.stringify(trajectory).replaceAll(scratch, HOME_TOKEN));
}

export function writeExpected(file, expected) {
  fs.writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`);
}

/** Rewrite a fixture's expected.json from its record — the provenance line and the record pointer stay. */
export async function repin(dir) {
  if (!fs.existsSync(path.join(dir, 'home'))) throw new FixtureRepinError(dir);
  const file = path.join(dir, 'expected.json');
  const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
  writeExpected(file, { ...expected, trajectory: await projectFixture(dir, { record: expected.record }) });
  return file;
}
