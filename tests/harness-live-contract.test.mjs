// The live-behaviour lane (drift monitors P3): one real headless session per harness, in a
// sandboxed oathe-wired project, and four assertions against what came back — the hook
// payload captured and normalizing through the declared dialect, the transcript projecting
// through the doctor, the headless output extracting, and the board having reached the
// session (the project registered by our own SessionStart hook). Here the harness is a fake
// process that fires the real hook with the pinned fixture payload and answers in the pinned
// output shape; CI and a developer's machine run the real CLI.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runLiveContract, LiveContractError, LIVE_MARKER } from '../scripts/harness-live-contract.mjs';
import { runInit } from '../src/init.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';
import { sandbox } from './helpers.mjs';

const paths = buildPaths({});
const SCRATCH_DB = `oathe_live_lane_${process.pid}`;
let sb;

const fixturePayload = (harness) => {
  const dir = path.join(paths.packageRoot, 'tests/fixtures/hooks', harness);
  const newest = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().at(-1);
  return JSON.parse(fs.readFileSync(path.join(dir, newest), 'utf8')).payload;
};

/** A fake harness: fires our real SessionStart hook with the documented payload (as the real
 *  one would, env included), then answers the prompt in the documented output shape. */
function fakeHarness(harness, { answer = `${LIVE_MARKER}`, payloadOverride = null, fireHook = true, viaBin = null } = {}) {
  return ({ cmd, args, env, cwd }) => {
    if (fireHook) {
      const payload = payloadOverride ?? { ...fixturePayload(harness) };
      if ('cwd' in payload) payload.cwd = cwd;
      if ('workspace_roots' in payload) payload.workspace_roots = [cwd];
      // viaBin: a node hardlink wearing the harness's bin name, INTERPOSED as the hook's
      // PARENT (the ppid is what registers) — the session-registered check then runs
      // uniformly even for harnesses whose payload carries no transcript (cursor).
      if (viaBin) {
        spawnSync(viaBin, ['-e',
          'const{spawnSync}=require("node:child_process");'
          + 'spawnSync(process.execPath,[process.env.OATHE_TEST_HOOK],{input:process.env.OATHE_TEST_PAYLOAD});'],
        { env: { ...env, OATHE_TEST_HOOK: path.join(paths.pluginDir, 'hooks/render-board.mjs'), OATHE_TEST_PAYLOAD: JSON.stringify(payload) }, encoding: 'utf8' });
      } else {
        spawnSync('node', [path.join(paths.pluginDir, 'hooks/render-board.mjs')], { input: JSON.stringify(payload), env, encoding: 'utf8' });
      }
    }
    const stdout = harness === 'codex' ? `${answer}\n` : `${JSON.stringify({ type: 'result', result: answer })}\n`;
    return { status: 0, stdout, stderr: '' };
  };
}

let cursorNodeLink;

before(async () => {
  sb = sandbox({ scratchDb: SCRATCH_DB });
  await runInit({ env: sb.env, exec: sb.exec });
  // node wearing cursor's bin name: ps `comm=` resolves symlinks, so the impersonation
  // needs a REAL file — hardlink where the filesystem allows, copy where it doesn't.
  cursorNodeLink = path.join(sb.home, 'cursor-agent');
  try {
    fs.linkSync(process.execPath, cursorNodeLink);
  } catch {
    fs.copyFileSync(process.execPath, cursorNodeLink);
    fs.chmodSync(cursorNodeLink, 0o755);
  }
});

after(async () => {
  const s = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await s.close();
  await s.dropDatabase();
});

for (const harness of ['claude', 'codex', 'cursor']) {
  test(`${harness}: a session that fires the documented payload and answers in the documented shape passes`, async () => {
    const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(sb.home, 'proj-')));
    const out = await runLiveContract({
      harness, env: sb.env, projectDir,
      spawn: fakeHarness(harness, harness === 'cursor' ? { viaBin: cursorNodeLink } : {}),
      requireAuthEnv: false,
      traceStatus: () => 'ok',
    });
    assert.equal(out.ok, true, out.render());
    assert.deepEqual(out.checks.map((c) => c.name), ['headless-output', 'hook-captured', 'hook-normalizes', 'board-reached-session', 'session-registered', ...(harness === 'cursor' ? [] : ['transcript-projects'])]);
    assert.match(out.render(), new RegExp(`^live-contract: ${harness} ok`, 'm'));
  });
}

test('a renamed payload field is DRIFT: hook-normalizes fails and names the field diff against the fixture', async () => {
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(sb.home, 'proj-')));
  const drifted = { ...fixturePayload('claude') };
  drifted.transcript_file = drifted.transcript_path; delete drifted.transcript_path; // the next release renames it
  const out = await runLiveContract({
    harness: 'claude', env: sb.env, projectDir, spawn: fakeHarness('claude', { payloadOverride: drifted }), requireAuthEnv: false,
    traceStatus: () => 'ok',
  });
  assert.equal(out.ok, false);
  const failed = out.checks.find((c) => c.name === 'hook-normalizes');
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /transcript_path/);
  assert.match(failed.detail, /transcript_file/);
  assert.match(out.render(), /^live-contract: claude FAILED — hook-normalizes: /m);
});

test('a session whose hook never fires is DRIFT at hook-captured', async () => {
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(sb.home, 'proj-')));
  const out = await runLiveContract({
    harness: 'codex', env: sb.env, projectDir, spawn: fakeHarness('codex', { fireHook: false }), requireAuthEnv: false,
    traceStatus: () => 'ok',
  });
  assert.equal(out.checks.find((c) => c.name === 'hook-captured').ok, false);
  assert.equal(out.ok, false);
});

test('a session that never registered is DRIFT at session-registered — the detail says the hook did not land the row', async () => {
  // The old premise here ("a process NOBODY owns") became environment-dependent the day
  // ownership moved to the nearest harness in the chain: run inside a real Claude session,
  // the test runner's own ancestry is honestly owned, and no payload can fake it unowned.
  // That branch's live guard is the process-identity fixtures + the `surfaces` monitor;
  // THIS pin holds the branch every environment can reach: registration itself failing.
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(sb.home, 'proj-')));
  const sessionsFile = path.join(sb.env.OATHE_HOME, 'sessions.json');
  const saved = fs.existsSync(sessionsFile) ? fs.readFileSync(sessionsFile) : null;
  try {
    fs.rmSync(sessionsFile, { force: true });
    fs.mkdirSync(sessionsFile); // a directory where the registry expects a file — the write fail-softs
    const out = await runLiveContract({
      harness: 'claude', env: sb.env, projectDir,
      spawn: fakeHarness('claude', {
        payloadOverride: { ...fixturePayload('claude'), session_id: `unregistered-${Date.now()}` },
      }),
      requireAuthEnv: false,
      traceStatus: () => 'ok',
    });
    const check = out.checks.find((c) => c.name === 'session-registered');
    assert.equal(check.ok, false);
    assert.match(check.detail, /no sessions\.json row/, 'the detail names exactly what is missing');
    assert.equal(out.ok, false, 'an unregistered session fails the lane loud');
  } finally {
    fs.rmSync(sessionsFile, { recursive: true, force: true });
    if (saved) fs.writeFileSync(sessionsFile, saved);
  }
});

test('a RUNTIME-bound trace store fails loud as the environment, not as harness drift', async () => {
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(sb.home, 'proj-')));
  const out = await runLiveContract({
    harness: 'codex', env: sb.env, projectDir, spawn: fakeHarness('codex'), requireAuthEnv: false,
    traceStatus: () => 'RUNTIME',
  });
  const t = out.checks.find((c) => c.name === 'transcript-projects');
  assert.equal(t.ok, false);
  assert.match(t.detail, /RUNTIME/);
});

test('missing auth is a refusal naming the env var — never a silent skip', async () => {
  const env = { ...sb.env };
  delete env.CURSOR_API_KEY;
  await assert.rejects(runLiveContract({ harness: 'cursor', env, projectDir: sb.home, spawn: fakeHarness('cursor') }),
    (e) => e instanceof LiveContractError && e.code === 'OATHE_LIVE_CONTRACT_AUTH_MISSING' && /CURSOR_API_KEY/.test(e.message));
});
