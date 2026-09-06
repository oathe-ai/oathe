// Where work lives (ruling 2026-09-05, superseding R-HOME-BOARD's fixed home): a PLACE is where
// a claim was picked up — a folder or an app — and every act records its place as a statement.
// A task is visible on every place that ever picked it up and RESIDES where it was picked up
// last. This module is the ONE owner of two grammars: the contract_ref (the ledger's own field,
// `workspace:<ws|none>;contract:<org>/<task>@v1`) and the place (`workspace:<ws>` | `app:<surface>`),
// in JavaScript and in SQL. Nothing here touches the database.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ContractRef, HomeBoard, HomeError, NO_FOLDER, Place, PlaceEvidence, Pickup } from '../src/home.mjs';
import { PLACE_SUBJECT_PREFIX } from '../src/statements.mjs';
import { verificationTaskId, VERIFICATION_PREFIX, verifiedTaskId } from '../src/plans.mjs';

test('ContractRef round-trips a real workspace: build → string → parse', () => {
  const ref = new ContractRef({ workspace: 'ws-abcdef123456', orgId: 'oathe', taskId: 'task-x' });
  assert.equal(String(ref), 'workspace:ws-abcdef123456;contract:oathe/task-x@v1');
  const parsed = ContractRef.parse(String(ref));
  assert.equal(parsed.workspace, 'ws-abcdef123456');
  assert.equal(parsed.orgId, 'oathe');
  assert.equal(parsed.taskId, 'task-x');
  assert.equal(parsed.hasFolder, true);
});

test('an app pickup prints the ledger\'s no-folder token and parses back to workspace null', () => {
  const ref = new ContractRef({ workspace: null, orgId: 'oathe', taskId: 'chat-task' });
  assert.equal(String(ref), `workspace:${NO_FOLDER};contract:oathe/chat-task@v1`);
  assert.equal(NO_FOLDER, 'none', 'the token the substrate verbs transcribe — a claim with no folder is an app pickup, never a third word');
  const parsed = ContractRef.parse(String(ref));
  assert.equal(parsed.workspace, null);
  assert.equal(parsed.hasFolder, false);
});

test('a real workspace ref always has a folder, and the grammar is strict', () => {
  assert.equal(ContractRef.parse('workspace:ws-000000000000;contract:oathe/t@v1').hasFolder, true);
  assert.throws(() => ContractRef.parse('garbage'),
    (e) => e instanceof HomeError && e.code === 'OATHE_CONTRACT_REF_MALFORMED');
  assert.throws(() => ContractRef.parse('workspace:ws-1;contract:oathe/t@v2'),
    (e) => e.code === 'OATHE_CONTRACT_REF_MALFORMED', 'the version suffix is part of the grammar');
});

test('the verification prefix has ONE owner: plans.mjs names it, home anchors through it', () => {
  assert.equal(VERIFICATION_PREFIX, 'verify:');
  assert.equal(verificationTaskId('t'), 'verify:t');
  assert.equal(verifiedTaskId('verify:t'), 't');
  assert.equal(verifiedTaskId('t'), null, 'a non-verification id has no verified task');
  assert.equal(HomeBoard.anchorTaskId('verify:t'), 't', 'a verification task is homed where its parent is');
  assert.equal(HomeBoard.anchorTaskId('t'), 't');
});

test('a Place is where a claim was picked up — a folder or an app — with ONE grammar, strict', () => {
  assert.equal(String(Place.workspace('ws-abcdef123456')), 'workspace:ws-abcdef123456');
  assert.equal(String(Place.app('chatgpt')), 'app:chatgpt');
  const folder = Place.parse('workspace:ws-abcdef123456');
  assert.deepEqual([folder.kind, folder.ref, folder.isFolder], ['workspace', 'ws-abcdef123456', true]);
  const app = Place.parse('app:chatgpt');
  assert.deepEqual([app.kind, app.ref, app.isFolder], ['app', 'chatgpt', false]);
  assert.equal(Place.parse(String(app)).toString(), 'app:chatgpt', 'round-trips');
  for (const bad of ['garbage', 'workspace:', 'app:', 'folder:ws-1', 'workspace:none']) {
    assert.throws(() => Place.parse(bad), (e) => e instanceof HomeError && e.code === 'OATHE_PLACE_MALFORMED', `refused: ${bad}`);
  }
  assert.equal(Place.parseOrNull(null), null, 'no place is null, never a throw for a row that has none');
});

test('the SQL projections of the place rule are generated from the same constants — residence is the LAST pickup, places are every pickup, a verification task anchors through its parent', () => {
  const residence = HomeBoard.residenceSql('t');
  assert.ok(residence.includes(`'${PLACE_SUBJECT_PREFIX}%'`), 'reads the place statements — the subject prefix is statements.mjs\'s');
  assert.ok(residence.includes(`${PLACE_SUBJECT_PREFIX.length + 1}`), 'the place text is the subject past the prefix — offset from the constant');
  assert.match(residence, /ORDER BY pickup\.at DESC LIMIT 1/, 'the latest pickup decides where it resides');
  assert.ok(residence.includes(`'${VERIFICATION_PREFIX}%'`) && residence.includes(`${VERIFICATION_PREFIX.length + 1}`), 'the parent anchor rides the JS prefix');
  // ONE record: the place statement. The ledger's contract_ref slot is never read as a pickup —
  // a claim without a place statement does not exist (zero legacy, founder 2026-09-05).
  assert.doesNotMatch(residence, /UNION ALL/, 'one source, not two');
  assert.ok(!residence.includes('work_claim'), 'the ledger is not consulted for where work lives');
  assert.ok(!residence.includes('app:'), 'no surface is inferred from anything');
  const places = HomeBoard.placesSql('t');
  assert.match(places, /array_agg\(DISTINCT/, 'every place that ever picked it up');
  assert.ok(places.includes(`'${PLACE_SUBJECT_PREFIX}%'`));
  assert.equal(HomeBoard.homeSql, undefined, 'the earliest-folder home is retired — one notion of where work lives, not two');
  assert.equal(HomeBoard.prototype.of, undefined, 'nothing derives a fixed home any more');
});

test('PlaceEvidence is the one grammar for what a pickup knows beside its place: app bundle, device, project dir — each only when known; refs round-trip through parse and read back as a row', () => {
  const full = new PlaceEvidence({ app: '/Applications/ChatGPT.app', device: 'dev-1', dir: '/Users/x/.codex/.chatgpt-projects/g-p-1' });
  assert.deepEqual(full.refs, ['app:/Applications/ChatGPT.app', 'device:dev-1', 'dir:/Users/x/.codex/.chatgpt-projects/g-p-1']);
  assert.deepEqual(PlaceEvidence.parse(full.refs).row(), { place_app: '/Applications/ChatGPT.app', place_device: 'dev-1', place_dir: '/Users/x/.codex/.chatgpt-projects/g-p-1' });
  assert.deepEqual(new PlaceEvidence({}).refs, [], 'unknown facts leave no ref — never a null string');
  assert.deepEqual(PlaceEvidence.parse(null).row(), { place_app: null, place_device: null, place_dir: null });
  assert.deepEqual(PlaceEvidence.parse(['trace:not-mine', 'device:dev-2']).row(), { place_app: null, place_device: 'dev-2', place_dir: null }, 'foreign refs are ignored');
});

test('Pickup.of is the ONE answer to where a surface picks work up and what it knows: a folder session is its workspace (the folder is the registry\'s fact, not evidence); an app session is app:<surface> with the project dir as evidence; a surface with neither has no place — and require() refuses it', () => {
  const speaker = { surface: 'claude', app: { bundle: '/Applications/iTerm.app', pid: 1 }, device: 'dev-1' };
  const folder = Pickup.of({ workspace: 'ws-abcdef123456', synthetic: false, dir: '/srv/app', speaker });
  assert.equal(String(folder.place), 'workspace:ws-abcdef123456');
  assert.deepEqual(folder.evidence.refs, ['app:/Applications/iTerm.app', 'device:dev-1'], 'no dir: for a folder — the folder IS the place');
  const chatgpt = { surface: 'chatgpt', app: { bundle: '/Applications/ChatGPT.app', pid: 2 }, device: 'dev-1' };
  const app = Pickup.of({ workspace: 'ws-synthetic0000', synthetic: true, dir: '/Users/x/.codex/.chatgpt-projects/g-p-1', speaker: chatgpt });
  assert.equal(String(app.place), 'app:chatgpt');
  assert.deepEqual(app.evidence.refs, ['app:/Applications/ChatGPT.app', 'device:dev-1', 'dir:/Users/x/.codex/.chatgpt-projects/g-p-1'], 'the project folder rides an app pickup');
  const appNoDir = Pickup.of({ workspace: null, synthetic: false, dir: null, speaker: chatgpt });
  assert.equal(String(appNoDir.place), 'app:chatgpt');
  assert.deepEqual(appNoDir.evidence.refs, ['app:/Applications/ChatGPT.app', 'device:dev-1']);
  const nowhere = Pickup.of({ workspace: null, synthetic: true, dir: '/x', speaker: null });
  assert.equal(nowhere.place, null);
  assert.throws(() => nowhere.require('t-1'), (e) => e instanceof HomeError && e.code === 'OATHE_PLACE_UNKNOWN' && /t-1/.test(e.message));
  assert.equal(folder.require('t-1'), folder.place);
});
