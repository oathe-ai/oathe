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
  HARNESS_CLASSES, attestationFor, buildAll, buildWireable, byName, capabilityTable, detectOnlySurfaces, dialectFor,
  docsDependents, harnessForClient, installable, isSyntheticWorkspace, launchable, liveTestable,
  ownerOfTracePath, traceStores, verifierCapable, verifiers, wireable,
} from '../src/harnesses/catalog.mjs';
import { DOC_SOURCES } from '../scripts/pull-harness-docs.mjs';
import { ORIGIN_KINDS } from '../src/harnesses/claude-roster.mjs';
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

test('capability roll-call: each capability is a frozen object with its contract, or null', () => {
  for (const C of HARNESS_CLASSES) {
    const n = C.harnessName;
    assert.ok(C.wiring === null || typeof C.wiring.needsCli === 'boolean', `${n}: wiring is null or {needsCli}`);
    assert.ok(C.hooks === null || (C.hooks.dialect?.matches && C.hooks.dialect?.normalizePayload && C.hooks.dialect?.formatSessionStart), `${n}: hooks is null or {dialect}`);
    assert.ok(C.launch === null || (typeof C.launch.splash === 'boolean' && typeof C.launch.bin === 'string'),
      `${n}: launch is null or {splash, bin} — the adapter names its OWN binary, never the harness name assumed`);
    assert.ok(C.headless === null || (Array.isArray(C.headless.auth) && isFn(C.headless.command) && isFn(C.headless.extract)), `${n}: headless is null or {auth, command, extract}`);
    assert.ok(C.traces === null || (isFn(C.traces.store) && isFn(C.traces.newest) && isFn(C.traces.recent) && isFn(C.traces.projector) && isFn(C.traces.ownsPath)
      && typeof C.traces.roster === 'object' && Object.isFrozen(C.traces.roster) && isFn(C.traces.kindOf)
      && typeof C.traces.fidelity === 'object' && Object.isFrozen(C.traces.fidelity)
      && 'harbor' in C.traces && (C.traces.harbor === null || (typeof C.traces.harbor.agent === 'string'
        && typeof C.traces.harbor.sessions?.home === 'string' && typeof C.traces.harbor.sessions?.logs === 'string'))),
    `${n}: traces is null or {store, newest, recent, projector, ownsPath, roster, kindOf, fidelity, harbor} — harbor names the reference converter and where it reads sessions, or is null`);
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
    claude: { wiring: true, hooks: true, launch: true, headless: true, traces: true, surfaces: true, contextFiles: true, globalContextFiles: false, synthetic: false, install: true, docs: true, attestation: { claude: 'hooks' } },
    codex: { wiring: true, hooks: true, launch: true, headless: true, traces: true, surfaces: true, contextFiles: true, globalContextFiles: true, synthetic: true, install: true, docs: true, attestation: { codex: 'hooks', chatgpt: 'hookless' } },
    cursor: { wiring: true, hooks: true, launch: true, headless: true, traces: false, surfaces: true, contextFiles: true, globalContextFiles: false, synthetic: false, install: true, docs: true, attestation: { cursor: 'hooks' } },
    cowork: { wiring: false, hooks: false, launch: false, headless: false, traces: false, surfaces: false, contextFiles: false, globalContextFiles: false, synthetic: false, install: false, docs: true, attestation: null },
    'chatgpt-web': { wiring: false, hooks: false, launch: false, headless: false, traces: false, surfaces: false, contextFiles: false, globalContextFiles: false, synthetic: false, install: false, docs: false, attestation: null },
  });
});

test('attestation is a touchpoint (ruling 2026-09-04): every surface an adapter owns declares whether its sessions register through hooks, and the catalog answers by SURFACE name — never a harness literal outside src/harnesses/', () => {
  assert.deepEqual(attestationFor('claude'), { harness: 'claude', attestation: 'hooks' });
  assert.deepEqual(attestationFor('codex'), { harness: 'codex', attestation: 'hooks' });
  assert.deepEqual(attestationFor('chatgpt'), { harness: 'codex', attestation: 'hookless' }, 'the ChatGPT desktop app embeds codex and runs no hooks — its claims are admitted on discovery');
  assert.deepEqual(attestationFor('cursor'), { harness: 'cursor', attestation: 'hooks' });
  assert.equal(attestationFor('nobody'), null, 'an unknown surface is nobody\'s — the gate refuses it');
  assert.equal(attestationFor(null), null);
  for (const C of HARNESS_CLASSES) {
    if (C.surfaces === null) { assert.equal(C.attestation, null, `${C.harnessName}: a surface that never speaks declares null`); continue; }
    assert.ok(C.attestation && Object.keys(C.attestation).length > 0, `${C.harnessName} declares attestation per owned surface`);
    for (const v of Object.values(C.attestation)) assert.ok(['hooks', 'hookless'].includes(v), `${C.harnessName}: ${v}`);
  }
});

test('the GOLDEN payload roster — every trace row type is handled or CONSCIOUSLY ignored, per engine; a new type is a reviewed row change', () => {
  // Rows measured over the 40 most recent real rollouts/transcripts on 2026-08-31 (codex CLI
  // 0.149–0.150, Claude Code 2.1.x). `handled` types project; `ignored` types were seen,
  // judged non-evidence, and each carries its reason; anything else quarantines visibly at
  // projection and fails the census lane as DRIFT.
  assert.deepEqual(byName('codex').traces.roster, {
    line: {
      handled: ['session_meta', 'response_item', 'event_msg', 'turn_context', 'compacted'],
      ignored: {
        world_state: 'environment snapshot — context machinery, not agent actions',
        inter_agent_communication_metadata: 'fan-out routing metadata ({trigger_turn} only) — the sqlite spawn edges and the SubAgentActivity items carry the fact',
      },
    },
    response_item: {
      handled: ['message', 'agent_message', 'reasoning', 'function_call', 'local_shell_call',
        'custom_tool_call', 'function_call_output', 'custom_tool_call_output',
        'tool_search_call', 'tool_search_output', 'compaction'],
      ignored: {},
    },
    event_msg: {
      handled: ['token_count', 'item_completed'],
      ignored: {
        task_started: 'turn lifecycle marker — response_item is ground truth (docs/traces.md)',
        task_complete: 'turn lifecycle marker — response_item is ground truth',
        thread_settings_applied: 'settings bookkeeping, not agent action',
        user_message: 'nudge-channel duplicate of the response_item user message',
        agent_message: 'nudge-channel duplicate of the response_item agent message',
        agent_reasoning: 'nudge-channel duplicate of the response_item reasoning row',
        turn_aborted: 'turn lifecycle marker — the absence of further items already shows it',
      },
    },
    // The typed item stream (item_completed.item.type) — the vendor's own decode of what the
    // exec source wraps, plus lifecycle facts that exist nowhere else. Measured 2026-09-01:
    // 100% of cli/exec/child rollouts carry it (8/14 vscode) — enrichment, never the spine.
    item: {
      handled: ['CommandExecution', 'McpToolCall', 'FileChange', 'SubAgentActivity', 'Extension'],
      ignored: {
        Reasoning: 'the response_item reasoning row is the fact (encrypted either way)',
        AgentMessage: 'the response_item message row is the fact',
        UserMessage: 'the response_item user message row is the fact',
        CollabAgentToolCall: 'the collaboration function_call and its output are the fact; the item repeats them',
        ContextCompaction: 'the compacted line row is the fact',
        DynamicToolCall: 'a dynamic tool call rides its own function_call/output pair',
        Plan: 'a plan update is the agent\'s own words, carried by the message row',
        ImageView: 'an image view is a read, not an action the record claims',
      },
    },
  });
  assert.deepEqual(byName('claude').traces.roster, {
    line: {
      handled: ['user', 'assistant', 'system', 'ai-title', 'file-history-snapshot'],
      ignored: {
        'last-prompt': 'editor bookkeeping, not conversation',
        mode: 'UI mode marker',
        'permission-mode': 'UI mode marker',
        'atis-latch': 'harness-internal latch',
        'bridge-session': 'harness-internal session bridging',
        attachment: 'attachment bookkeeping — the message rows carry the content',
        'queue-operation': 'queue bookkeeping',
        // The nine the first live census surfaced (measured 2026-09-01) — the reviewed-row
        // process working: each ignored type carries its reason.
        'agent-name': 'agent naming bookkeeping, not conversation',
        'agent-setting': 'agent settings bookkeeping',
        'artifact-autoreact-ledger': 'artifact auto-reply bookkeeping',
        'artifact-comment-monitor': 'artifact comment-watch bookkeeping',
        'cost-state': 'usage accounting snapshot',
        'custom-title': 'user-set display title (ai-title is the handled title row)',
        'file-history-delta': 'incremental sibling of file-history-snapshot — inter-snapshot bookkeeping',
        'frame-link': 'session frame linkage bookkeeping',
        'pr-link': 'PR linkage bookkeeping',
      },
    },
  });
  // Claude's origin.kind table — measured over the 40 newest transcripts (2026-09-01: human
  // 417, task-notification 262, auto-continuation 1, peer 1; absent = tool-result rows): which
  // user rows are the person's and which the harness's. An unknown kind quarantines visibly.
  assert.deepEqual(ORIGIN_KINDS, { human: 'user', 'task-notification': 'system', peer: 'system', 'auto-continuation': 'system' });
  // The fidelity probes — the census lane's raw-vs-projection checks; one set, every trace-store engine.
  assert.deepEqual(Object.keys(byName('codex').traces.fidelity),
    ['tool-call-args', 'token-metrics', 'claim-events', 'subagent-embedding', 'cross-source', 'attribution']);
  assert.deepEqual(Object.keys(byName('claude').traces.fidelity),
    ['tool-call-args', 'token-metrics', 'claim-events', 'subagent-embedding', 'cross-source', 'attribution']);
  // kindOf is the census classifier: one parsed row → its roster coordinate.
  const codexKind = byName('codex').traces.kindOf;
  assert.deepEqual(codexKind({ type: 'response_item', payload: { type: 'custom_tool_call' } }),
    { channel: 'response_item', type: 'custom_tool_call' });
  assert.deepEqual(codexKind({ type: 'turn_context', payload: {} }), { channel: 'line', type: 'turn_context' });
  assert.deepEqual(codexKind({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall' } } }),
    { channel: 'item', type: 'McpToolCall' }, 'an item_completed row is classified by the item it completes');
  assert.deepEqual(byName('claude').traces.kindOf({ type: 'assistant' }), { channel: 'line', type: 'assistant' });
});

test('the roster and docs/traces.md are held CLOSED against each other — no upstream page exists, so the doc is the pin', async () => {
  const fs = await import('node:fs');
  const doc = fs.readFileSync(new URL('../docs/traces.md', import.meta.url), 'utf8');
  for (const harness of ['codex', 'claude']) {
    for (const [channel, lane] of Object.entries(byName(harness).traces.roster)) {
      for (const type of [...lane.handled, ...Object.keys(lane.ignored)]) {
        assert.ok(doc.includes(`\`${type}\``),
          `${harness} roster ${channel}.${type} is not in docs/traces.md — the declared contract and the pinned doc drifted apart`);
      }
    }
  }
  for (const kind of Object.keys(ORIGIN_KINDS)) {
    assert.ok(doc.includes(`\`${kind}\``), `claude origin.kind '${kind}' is not in docs/traces.md`);
  }
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
  assert.equal(seen.cursor.presence.cli, false, '…but the sandbox has no agent on PATH');
  assert.equal(seen['chatgpt-web'].installed, false);
  assert.equal(typeof seen.cowork.presence.app, 'boolean');
  const noBins = Object.fromEntries(buildAll({ home, envPath: '/nonexistent', paths, exec }).map((h) => [h.name, h.detect()]));
  assert.equal(noBins.claude.installed, false, 'claude needs its CLI');
  assert.equal(noBins.claude.presence.configHome, path.join(home, '.claude'));
  const cursorBin = fakeBin('agent');
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
  assert.deepEqual(byName('cursor').headless.command('do it', null), ['agent', ['-p', 'do it', '--trust', '--output-format', 'json']]);
  assert.deepEqual(byName('cursor').headless.command('do it', 'm'), ['agent', ['-p', 'do it', '--trust', '--output-format', 'json', '--model', 'm']]);
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
  // ONE address at ONE rigor (connection-lane plan, 2026-09-04): every wired adapter's MCP
  // entry speaks the shim — the same touchpoint may never sit at three rigors again (the
  // 2026-09-04 escape: cursor absolute, claude and codex bare PATH).
  const shim = `${home}/.oathe/bin/oathe`;
  for (const [name, described] of Object.entries(by)) {
    assert.ok(described.includes(shim), `${name}: describe() names the shim address — got:\n${described}`);
  }
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
  assert.deepEqual(byName('cursor').install, { installer: 'curl https://cursor.com/install -fsS | bash', bin: 'agent', versionArgs: ['--version'] });
});

test('the declared binary is the one the pinned install docs verify with — a renamed CLI cannot drift silently', (t) => {
  // A CLI installed by the vendor's own script (`install.installer`) is named by that vendor,
  // not by an npm package's bin — so the adapter's install.bin must be the command one of its
  // own pinned pages tells the user to run after installing (`<bin> --version`). Read from the
  // snapshot, never the web. npm-installed CLIs are held by the install-contract lane instead.
  const snapshot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.harness-docs');
  if (!fs.existsSync(snapshot)) return t.skip('no .harness-docs snapshot on this machine (npm run pull-harness-docs)');
  const verifiesWith = (bin) => new RegExp(`(^|[\\s\`])${bin} --version`, 'm');
  for (const C of HARNESS_CLASSES) {
    if (!C.install?.installer) continue;
    const pages = C.docs.filter((d) => fs.existsSync(path.join(snapshot, `${d}.md`)));
    assert.ok(pages.length > 0, `${C.harnessName}: its pinned pages are in the snapshot`);
    assert.ok(pages.some((d) => verifiesWith(C.install.bin).test(fs.readFileSync(path.join(snapshot, `${d}.md`), 'utf8'))),
      `${C.harnessName}: a pinned page verifies the install with '${C.install.bin} --version' — the declared binary follows the vendor's docs`);
  }
  return undefined;
});

test("cursor's ancestry match takes the CLI by either name on disk: `agent`, and `cursor-agent`, the executable it links to", () => {
  const owns = byName('cursor').surfaces.ownsExec;
  assert.equal(owns('/Users/x/.local/bin/agent'), true, 'the documented command');
  assert.equal(owns('/Users/x/.local/share/cursor-agent/versions/2026.08.25-3e8eec8/cursor-agent'), true, 'the versioned executable behind the symlink');
  assert.equal(owns('/Users/x/.local/bin/cursor-agent'), true, "the installer's legacy symlink");
  assert.equal(owns('/Applications/Cursor.app/Contents/MacOS/Cursor'), true, 'the IDE');
  assert.equal(owns('/usr/local/bin/cursor'), false, "the IDE's shell launcher is not the CLI");
  assert.equal(owns('/usr/local/bin/node'), false);
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
