// The ONE contract suite over every catalog entry — the contributor's spec for a supported
// harness (PLAN.md R-HARNESS-TOUCHPOINTS): every touchpoint is mapped on the adapter as a fact
// or a named, frozen, nullable CAPABILITY, and consumers ask the catalog by capability — never
// a flag, never a name. The golden table below IS the definition of "supported"; adding a
// harness or a capability is a reviewed row change. Hook payload shapes live as fixtures in
// tests/fixtures/hooks/<harness>/ and the dialect must serve every one of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HARNESS_CLASSES, buildAll, buildWireable, byName, capabilityTable, detectOnlySurfaces, dialectFor,
  docsDependents, harnessForClient, installable, isSyntheticWorkspace, launchable, liveTestable,
  ownerOfTracePath, traceStores, verifierCapable, verifiers, wireable,
} from '../src/harnesses/catalog.mjs';
import { DOC_SOURCES } from '../scripts/pull-harness-docs.mjs';
import { sandbox } from './helpers.mjs';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/hooks', import.meta.url));
const scratch = (prefix = 'oathe-contract-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const fakeBin = (...names) => {
  const dir = scratch('oathe-bin-');
  for (const n of names) { fs.writeFileSync(path.join(dir, n), '#!/bin/sh\n'); fs.chmodSync(path.join(dir, n), 0o755); }
  return dir;
};

function fixtures() {
  return fs.readdirSync(FIXTURES_DIR).flatMap((harness) => fs.readdirSync(path.join(FIXTURES_DIR, harness))
    .map((file) => ({ harness, ...JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, harness, file), 'utf8')) })));
}

const isFn = (v) => typeof v === 'function';

test('the roster: every surface oathe knows is one hierarchy — wired harnesses and detect-only surfaces alike', () => {
  assert.deepEqual(HARNESS_CLASSES.map((C) => C.harnessName), ['claude', 'codex', 'cursor', 'cowork', 'chatgpt-web']);
});

test('identity facts: every entry declares them (null where a fact does not apply)', () => {
  for (const C of HARNESS_CLASSES) {
    const n = C.harnessName;
    assert.ok(C.displayName.length > 0, `${n}: displayName`);
    assert.ok(C.bin === null || (typeof C.bin === 'string' && C.bin.length > 0), `${n}: bin is a string or null`);
    assert.ok(Array.isArray(C.clientNames) && C.clientNames.every((s) => typeof s === 'string'), `${n}: clientNames (MCP clientInfo.name values)`);
    assert.ok(Array.isArray(C.contextFiles), `${n}: contextFiles`);
    assert.ok(C.projectDirEnvVar === null || /^[A-Z_]+$/.test(C.projectDirEnvVar), `${n}: projectDirEnvVar`);
    assert.ok(isFn(C.isSyntheticWorkspaceDir), `${n}: isSyntheticWorkspaceDir`);
    assert.ok(Array.isArray(C.globalContextFiles), `${n}: globalContextFiles (precedence order, [] = none)`);
    assert.ok(Array.isArray(C.docs), `${n}: docs`);
    const i = C.install;
    assert.ok(i === null || (typeof i.bin === 'string' && Array.isArray(i.versionArgs) && ((typeof i.npm === 'string') !== (typeof i.installer === 'string'))),
      `${n}: install is null or {npm|installer, bin, versionArgs}`);
    assert.ok(C.note === null || typeof C.note === 'string', `${n}: note (manual steps for a detect-only surface)`);
  }
});

test('capability roll-call: each capability is a frozen object with its contract, or null — and the old flags are GONE', () => {
  for (const C of HARNESS_CLASSES) {
    const n = C.harnessName;
    assert.ok(C.wiring === null || typeof C.wiring.needsCli === 'boolean', `${n}: wiring is null or {needsCli}`);
    assert.ok(C.hooks === null || (C.hooks.dialect?.matches && C.hooks.dialect?.normalizePayload && C.hooks.dialect?.formatSessionStart), `${n}: hooks is null or {dialect}`);
    assert.ok(C.launch === null || (typeof C.launch.splash === 'boolean' && typeof C.launch.bin === 'string'),
      `${n}: launch is null or {splash, bin} — the adapter names its OWN binary, never the harness name assumed`);
    assert.ok(C.headless === null || (Array.isArray(C.headless.auth) && isFn(C.headless.command) && isFn(C.headless.extract)), `${n}: headless is null or {auth, command, extract}`);
    assert.ok(C.traces === null || (isFn(C.traces.store) && isFn(C.traces.newest) && isFn(C.traces.projector) && isFn(C.traces.ownsPath)), `${n}: traces is null or {store, newest, projector, ownsPath}`);
    assert.ok(C.surfaces === null || (isFn(C.surfaces.ownsExec) && isFn(C.surfaces.name)), `${n}: surfaces is null or {ownsExec, name}`);
    for (const flag of ['engine', 'wireable', 'launchable', 'splashOnLaunch', 'hookDialect', 'verifierCommand', 'extractVerifierText', 'traceStore', 'newestTrace', 'atifProjector']) {
      assert.equal(C[flag], undefined, `${n}: the flag/static '${flag}' must not exist — ask the capability`);
    }
    for (const cap of ['wiring', 'hooks', 'launch', 'headless', 'traces', 'surfaces']) {
      if (C[cap] !== null) assert.ok(Object.isFrozen(C[cap]), `${n}: ${cap} is frozen`);
    }
  }
});

test('the GOLDEN capability table — the definition of a supported harness; a row change is a reviewed change', () => {
  assert.deepEqual(capabilityTable(), {
    claude: { wiring: true, hooks: true, launch: true, headless: true, traces: true, surfaces: true, contextFiles: true, globalContextFiles: false, synthetic: false, install: true, docs: true },
    codex: { wiring: true, hooks: true, launch: true, headless: true, traces: true, surfaces: true, contextFiles: true, globalContextFiles: true, synthetic: true, install: true, docs: true },
    cursor: { wiring: true, hooks: true, launch: true, headless: true, traces: false, surfaces: true, contextFiles: true, globalContextFiles: false, synthetic: false, install: true, docs: true },
    cowork: { wiring: false, hooks: false, launch: false, headless: false, traces: false, surfaces: false, contextFiles: false, globalContextFiles: false, synthetic: false, install: false, docs: true },
    'chatgpt-web': { wiring: false, hooks: false, launch: false, headless: false, traces: false, surfaces: false, contextFiles: false, globalContextFiles: false, synthetic: false, install: false, docs: false },
  });
});

test('every process-identity fixture names through exactly the owning adapter — exec paths and bundles as pinned', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { surfaceForSession } = await import('../src/harnesses/catalog.mjs');
  const { nearestAppBundle } = await import('../src/sessions.mjs');
  const dir = new URL('./fixtures/process-identity/', import.meta.url).pathname;
  let seen = 0;
  for (const harness of fs.readdirSync(dir)) {
    for (const file of fs.readdirSync(path.join(dir, harness))) {
      const { payload, expected } = JSON.parse(fs.readFileSync(path.join(dir, harness, file), 'utf8'));
      const app = nearestAppBundle(payload.ancestry);
      assert.deepEqual(app, expected.app, `${harness}/${file}: the focusable app`);
      assert.equal(
        surfaceForSession({ ancestry: payload.ancestry, app, transcriptPath: payload.transcript_path }),
        expected.surface, `${harness}/${file}: the surface name — THEIR app moved something if this drifts`);
      seen += 1;
    }
  }
  assert.ok(seen >= 5, 'the pinned drift fixtures are present');
});

test('surfaceForSession: transcript ownership outranks exec match, and nobody\'s process is null — never a guess', async () => {
  const { surfaceForSession } = await import('../src/harnesses/catalog.mjs');
  // A codex-owned transcript wins even under a claude-looking exec (ownership is the durable route).
  assert.equal(surfaceForSession({
    ancestry: [{ pid: 2, exec: '/usr/local/bin/claude' }],
    app: null,
    transcriptPath: '/Users/x/.codex/sessions/2026/08/30/r.jsonl',
  }), 'codex');
  assert.equal(surfaceForSession({ ancestry: [{ pid: 3, exec: '/usr/bin/vim' }], app: null, transcriptPath: null }),
    null, 'an unowned process names nothing');
});

test('the catalog sweeps answer by capability', () => {
  assert.deepEqual(wireable(), ['claude', 'codex', 'cursor']);
  assert.deepEqual(launchable(), ['claude', 'codex', 'cursor'],
    'every wired harness launches — same primitive, its own bin (R-HARNESS-TOUCHPOINTS)');
  assert.deepEqual(verifierCapable(), ['claude', 'codex', 'cursor'], 'every harness with a headless run can judge');
  assert.deepEqual(traceStores(), ['claude', 'codex']);
  assert.deepEqual(installable(), ['claude', 'codex', 'cursor']);
  assert.deepEqual(liveTestable(), ['claude', 'codex', 'cursor']);
});

test('detection is STRUCTURED — presence {app, cli, configHome}; installed is each adapter\'s own rule over it', () => {
  const { home, exec } = sandbox({ scratchDb: 'unused' }); // ~/.claude, ~/.codex, ~/.cursor + fake claude/codex bins
  const paths = { packageRoot: '/pkg' };
  const withBins = buildAll({ home, envPath: `${home}/bin`, paths, exec });
  const seen = Object.fromEntries(withBins.map((h) => [h.name, h.detect()]));
  for (const d of Object.values(seen)) {
    assert.deepEqual(Object.keys(d).sort(), ['installed', 'name', 'presence']);
    assert.deepEqual(Object.keys(d.presence).sort(), ['app', 'cli', 'configHome']);
    assert.equal(typeof d.presence.cli, 'boolean');
  }
  assert.equal(seen.claude.installed, true); assert.equal(seen.claude.presence.cli, true);
  assert.equal(seen.codex.installed, true);
  assert.equal(seen.cursor.installed, true, 'the IDE alone (config home) installs cursor');
  assert.equal(seen.cursor.presence.cli, false, '…but the sandbox has no cursor-agent on PATH');
  assert.equal(seen['chatgpt-web'].installed, false);
  assert.equal(typeof seen.cowork.presence.app, 'boolean');
  const noBins = Object.fromEntries(buildAll({ home, envPath: '/nonexistent', paths, exec }).map((h) => [h.name, h.detect()]));
  assert.equal(noBins.claude.installed, false, 'claude needs its CLI');
  assert.equal(noBins.claude.presence.configHome, path.join(home, '.claude'));
  const cursorBin = fakeBin('cursor-agent');
  const cursorCli = new (byName('cursor'))({ home, envPath: cursorBin, paths, exec }).detect();
  assert.equal(cursorCli.presence.cli, true);
});

test('verifiers(census) requires the CLI: an IDE-only Cursor is never offered a headless run it cannot make', () => {
  const census = [
    { name: 'claude', installed: true, presence: { app: null, cli: true, configHome: '/h/.claude' } },
    { name: 'codex', installed: false, presence: { app: null, cli: false, configHome: '/h/.codex' } },
    { name: 'cursor', installed: true, presence: { app: null, cli: false, configHome: '/h/.cursor' } },
    { name: 'cowork', installed: true, presence: { app: true, cli: false, configHome: null } },
  ];
  assert.deepEqual(verifiers(census), ['claude']);
  census[2].presence.cli = true;
  assert.deepEqual(verifiers(census), ['claude', 'cursor']);
});

test('headless: one command spelling per harness, model optional, extraction per output shape', () => {
  assert.deepEqual(byName('claude').headless.command('do it', null), ['claude', ['-p', 'do it', '--output-format', 'json']]);
  assert.deepEqual(byName('claude').headless.command('do it', 'opus'), ['claude', ['-p', 'do it', '--output-format', 'json', '--model', 'opus']]);
  assert.deepEqual(byName('codex').headless.command('do it', null), ['codex', ['exec', '--skip-git-repo-check', 'do it']]);
  assert.deepEqual(byName('codex').headless.command('do it', 'o5'), ['codex', ['exec', '--skip-git-repo-check', '-m', 'o5', 'do it']]);
  assert.deepEqual(byName('cursor').headless.command('do it', null), ['cursor-agent', ['-p', 'do it', '--trust', '--output-format', 'json']]);
  assert.deepEqual(byName('cursor').headless.command('do it', 'm'), ['cursor-agent', ['-p', 'do it', '--trust', '--output-format', 'json', '--model', 'm']]);
  assert.equal(byName('claude').headless.extract('{"result": "the text"}'), 'the text');
  assert.throws(() => byName('claude').headless.extract('not json'), /did not return JSON/);
  assert.equal(byName('codex').headless.extract('raw text out'), 'raw text out');
  assert.equal(byName('cursor').headless.extract('{"type":"result","result":"ok"}'), 'ok');
  assert.deepEqual(byName('claude').headless.auth, ['ANTHROPIC_API_KEY']);
  assert.deepEqual(byName('codex').headless.auth, ['CODEX_API_KEY']);
  assert.deepEqual(byName('cursor').headless.auth, ['CURSOR_API_KEY']);
});

test('trace-path ownership is each store\'s own predicate; an unowned path is NOBODY\'s, never a fallback', () => {
  assert.equal(ownerOfTracePath('/Users/x/.codex/sessions/2026/08/28/rollout-1.jsonl'), 'codex');
  assert.equal(ownerOfTracePath('/Users/x/.claude/projects/-x-app/s.jsonl'), 'claude');
  assert.equal(ownerOfTracePath('/somewhere/else.jsonl'), null);
  assert.equal(ownerOfTracePath(''), null);
});

test('MCP client recognition is an adapter fact (clientNames), not a substring guess', () => {
  assert.equal(harnessForClient('claude-code'), 'claude');
  assert.equal(harnessForClient('Codex'), 'codex');
  assert.equal(harnessForClient('cursor'), 'cursor');
  assert.equal(harnessForClient('some-other-client'), null);
  assert.equal(harnessForClient(undefined), null);
});

test('wiring describes itself from the same data it writes — every wired adapter says what init will touch, with paths', () => {
  const { home, env, exec } = sandbox({ scratchDb: 'unused' });
  const paths = { packageRoot: '/pkg' };
  for (const h of buildWireable({ home, envPath: env.PATH, paths, exec })) {
    assert.equal(typeof h.onboard, 'function', `${h.name}: onboard`);
    assert.equal(typeof h.offboard, 'function', `${h.name}: offboard`);
    const lines = h.describe();
    assert.ok(Array.isArray(lines) && lines.length > 0, `${h.name}: describe() returns lines`);
    assert.ok(lines.every((l) => typeof l === 'string' && l.length > 0));
  }
  const by = Object.fromEntries(buildWireable({ home, envPath: env.PATH, paths, exec }).map((h) => [h.name, h.describe().join('\n')]));
  assert.match(by.claude, /settings\.json/); assert.match(by.claude, /claude plugin install/);
  assert.match(by.codex, /config\.toml/); assert.match(by.codex, /AGENTS/);
  assert.match(by.cursor, /mcp\.json/); assert.match(by.cursor, /hooks\.json/);
  assert.deepEqual(buildWireable({ home, envPath: env.PATH, paths, exec }).map((h) => h.name), wireable());
});

test('detect-only surfaces keep their honest contract: detected + manual steps, nothing to wire', () => {
  const home = scratch();
  const seen = detectOnlySurfaces({ home });
  assert.deepEqual(seen.map((s) => s.name), ['cowork', 'chatgpt-web']);
  for (const s of seen) {
    assert.equal(typeof s.detected, 'boolean');
    assert.ok(typeof s.steps === 'string' && s.steps.length > 0, `${s.name}: steps`);
    assert.equal(byName(s.name).wiring, null);
  }
});

test('R-BOARD-SCOPE: only codex knows a synthetic workspace — the ChatGPT-desktop staging dir under ~/.codex', () => {
  const home = scratch('oathe-synth-');
  const staging = path.join(home, '.codex/.chatgpt-projects/g-p-1');
  const sessions = path.join(home, '.codex/sessions/2026');
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  assert.equal(byName('codex').isSyntheticWorkspaceDir({ dir: staging, home }), true);
  assert.equal(byName('codex').isSyntheticWorkspaceDir({ dir: sessions, home }), false, 'not all of ~/.codex');
  for (const name of ['claude', 'cursor']) assert.equal(byName(name).isSyntheticWorkspaceDir({ dir: staging, home }), false);
  assert.equal(isSyntheticWorkspace({ dir: staging, home }), true);
});

test('global instructions files are a codex fact, in CODEX\'S precedence; context files and env vars per harness', () => {
  assert.deepEqual(byName('codex').globalContextFiles, ['AGENTS.override.md', 'AGENTS.md']);
  assert.deepEqual(byName('claude').globalContextFiles, []);
  assert.deepEqual(byName('claude').contextFiles, ['CLAUDE.md']);
  assert.deepEqual(byName('codex').contextFiles, ['AGENTS.md']);
  assert.deepEqual(byName('cursor').contextFiles, ['AGENTS.md']);
  assert.equal(byName('claude').projectDirEnvVar, 'CLAUDE_PROJECT_DIR');
  assert.equal(byName('codex').projectDirEnvVar, null);
  assert.equal(byName('cursor').projectDirEnvVar, 'CURSOR_PROJECT_DIR');
  assert.equal(byName('codex').launch.splash, true, 'codex buries hook output — the splash is its quirk');
  assert.equal(byName('claude').launch.splash, false);
});

test('DRIFT: every declared doc page exists in the snapshot sources, and every source has a dependent', () => {
  const keys = new Set(DOC_SOURCES.map((s) => `${s.harness}/${s.slug}`));
  const declared = new Set();
  for (const C of HARNESS_CLASSES) for (const key of C.docs) { assert.ok(keys.has(key), `${C.harnessName} declares '${key}'`); declared.add(key); }
  for (const key of keys) assert.ok(declared.has(key), `'${key}' is pulled but nobody depends on it`);
  assert.deepEqual(docsDependents('codex/agents-md'), ['codex']);
  assert.deepEqual(docsDependents('cowork/overview'), ['cowork']);
});

test('install facts: how a fresh runner gets each REAL CLI', () => {
  assert.deepEqual(byName('claude').install, { npm: '@anthropic-ai/claude-code', bin: 'claude', versionArgs: ['--version'] });
  assert.deepEqual(byName('codex').install, { npm: '@openai/codex', bin: 'codex', versionArgs: ['--version'] });
  assert.deepEqual(byName('cursor').install, { installer: 'curl https://cursor.com/install -fsS | bash', bin: 'cursor-agent', versionArgs: ['--version'] });
});

test('every hook fixture normalizes through exactly the dialect its adapter declares', () => {
  for (const { harness, payload, expected } of fixtures()) {
    const { dialect } = byName(harness).hooks;
    assert.ok(dialect.matches(payload), `${harness}: own dialect matches its payload`);
    assert.equal(dialectFor(payload), dialect, `${harness}: dialectFor picks the declared dialect`);
    assert.deepEqual(dialect.normalizePayload(payload), expected, `${harness}: normalized payload`);
  }
});

test('sessionStart output speaks each dialect: camelCase hookSpecificOutput vs snake_case additional_context', () => {
  const claudeOut = JSON.parse(byName('claude').hooks.dialect.formatSessionStart({ context: 'CTX', message: 'MSG' }));
  assert.equal(claudeOut.hookSpecificOutput.additionalContext, 'CTX');
  assert.equal(claudeOut.systemMessage, 'MSG');
  // R-QUIET: a null message means SILENCE — the key is omitted, never a "null" on screen.
  const silent = JSON.parse(byName('claude').hooks.dialect.formatSessionStart({ context: 'CTX', message: null }));
  assert.ok(!('systemMessage' in silent), 'a silent render omits the human channel entirely');
  const cursorOut = JSON.parse(byName('cursor').hooks.dialect.formatSessionStart({ context: 'CTX', message: 'MSG' }));
  assert.equal(cursorOut.additional_context, 'CTX');
  assert.equal(byName('codex').hooks.dialect, byName('claude').hooks.dialect, 'codex speaks the claude dialect — one implementation');
});

test('a trace store and projector built by an adapter carry THAT adapter\'s name — the store never spells it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-trace-name-'));
  for (const C of HARNESS_CLASSES.filter((K) => K.traces !== null)) {
    const store = await C.traces.store({ home });
    assert.equal(store.harness, C.harnessName, `${C.harnessName}: store.harness`);
    const projector = await C.traces.projector({ store });
    assert.equal(projector.harness, C.harnessName, `${C.harnessName}: projector.harness`);
  }
  const { TraceStore } = await import('../src/traces.mjs');
  assert.throws(() => new TraceStore({ home }), /harness/); // a nameless store is a typed refusal, not a blank label
});

test('covers: each wiring names the surfaces it serves — the init row states support, not detection', () => {
  const by = Object.fromEntries(HARNESS_CLASSES.map((C) => [C.harnessName, C]));
  assert.equal(by.claude.covers, 'CLI'); // ruling 2026-08-29: desktop app exists but the row stays CLI — no confusion
  assert.equal(by.codex.covers, 'CLI/Desktop App'); // ChatGPT desktop rides the same ~/.codex wiring
  assert.equal(by.cursor.covers, 'CLI/Desktop App');
  assert.equal(by.codex.displayName, 'Codex');
  for (const C of HARNESS_CLASSES.filter((K) => K.wiring !== null)) assert.equal(typeof C.covers, 'string');
  for (const C of HARNESS_CLASSES.filter((K) => K.wiring === null)) assert.equal(C.covers, null, `${C.harnessName}: a detect-only surface covers nothing`);
});
