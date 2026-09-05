// The exit loop, scripted: fresh sandbox HOME → init → board renders → claim → note →
// pickup (the real successor over stdio) → yield → doctor clean → uninstall byte-restores.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { createRequire } from 'node:module';

import { sandbox, linkClaudeTrace, writeClaudeTranscript } from './helpers.mjs';
import { buildContext } from '../src/context.mjs';
import { createOatheTools } from '../src/mcp/oathe-tools.mjs';
import { JUDGMENT, KINDS } from '../src/breach-digest.mjs';
import { runInit } from '../src/init.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { runUninstall } from '../src/uninstall.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';

const paths = buildPaths({});
const SCRATCH_DB = `oathe_e2e_test_${process.pid}`;

// The pickup leg branches on a machine truth: with oathe-runtime resolvable the successor
// sequence runs for real; without it the server refuses TYPED — both are the contract.
const RUNTIME_LINKED = (() => {
  try { createRequire(import.meta.url).resolve('oathe-runtime/seam'); return true; }
  catch { return false; }
})();

let sb;
let workDir;
let settingsBefore;
let tomlBefore;

before(async () => {
  // The fake engine answers whatever `$HOME/.fake-verdict` holds (the claude adapter's
  // `--output-format json` shape); with no file it is the plain fake every other test knows.
  sb = sandbox({ scratchDb: SCRATCH_DB, claudeScript: 'if [ -f "$HOME/.fake-verdict" ]; then cat "$HOME/.fake-verdict"; else echo fake-claude; fi; exit 0' });
  // The gate (ruling 2026-09-04): a claim needs a session behind it. The stdio server and the
  // hooks this file spawns sit under THIS process — registered as a store-less harness session
  // the way SessionStart registers one, so their claims resolve it by ancestry.
  {
    const { SessionRegistry } = await import('../src/sessions.mjs');
    await new SessionRegistry({ sessionsPath: path.join(sb.env.OATHE_HOME, 'sessions.json') }).ensure({
      sessionId: 'sess-integration', pid: process.pid,
      facts: () => ({ ancestry: [{ pid: process.pid, exec: '/usr/local/bin/claude' }], app: null, transcriptPath: null, workspace: null }),
    });
  }
  settingsBefore = fs.readFileSync(path.join(sb.home, '.claude/settings.json'), 'utf8');
  tomlBefore = fs.readFileSync(path.join(sb.home, '.codex/config.toml'), 'utf8');
  workDir = fs.mkdtempSync(path.join(sb.home, 'work-'));
  await runInit({ env: sb.env, exec: sb.exec });
});

after(async () => {
  const substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await substrate.close();
  await substrate.dropDatabase();
});

/** Drive the stdio MCP server with newline-delimited JSON-RPC, collecting responses by id. */
function mcpSession(envOverrides = {}) {
  const child = spawn('node', [path.join(paths.packageRoot, 'src/mcp/oathe-tools.mjs')], {
    env: { ...sb.env, OATHE_WORKSPACE_DIR: workDir, ...envOverrides },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    } catch { /* not a frame */ }
  });
  let nextId = 1;
  return {
    child,
    request(method, params) {
      const id = nextId++;
      const wait = new Promise((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => reject(new Error(`timeout waiting for ${method} (id ${id})`)), 30_000);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return wait;
    },
    async call(name, args) {
      const out = await this.request('tools/call', { name, arguments: args });
      const body = JSON.parse(out.result.content[0].text);
      return { isError: out.result.isError, body };
    },
    close() { child.stdin.end(); child.kill(); },
  };
}

test('the full loop over the real stdio server: initialize → claim → note → pickup → yield', async () => {
  const mcp = mcpSession();
  try {
    const init = await mcp.request('initialize', {});
    assert.equal(init.result.protocolVersion, '2025-06-18');

    const claim = await mcp.call('oathe_claim', { task_id: 'loop-task', objective: 'Run the whole loop' });
    assert.equal(claim.isError, false, JSON.stringify(claim.body));
    assert.equal(claim.body.claimed, true);

    const note = await mcp.call('oathe_statement', { task_id: 'loop-task', proposition: 'half way' });
    assert.equal(note.isError, false);

    const pickup = await mcp.call('oathe_pickup', { task_id: 'loop-task' });
    if (RUNTIME_LINKED) {
      assert.equal(pickup.isError, false, JSON.stringify(pickup.body));
      assert.equal(pickup.body.mode, 'RECOMPILE');
      assert.ok(pickup.body.attempt_id, 'a real attempt was allocated through the successor path');
      assert.ok(pickup.body.render.length > 0);
    } else {
      assert.equal(pickup.isError, true, 'standalone pickup must refuse, never pretend');
      assert.equal(pickup.body.error_code, 'OATHE_PICKUP_UNAVAILABLE');
      assert.match(pickup.body.reason, /preview limitation/);
    }

    const yielded = await mcp.call('oathe_yield', { task_id: 'loop-task', note: 'done for tonight' });
    assert.equal(yielded.isError, false);

    const second = await mcp.call('oathe_yield', { task_id: 'loop-task', note: 'again' });
    assert.equal(second.isError, true, 'yielding twice is refused, loudly');
    assert.equal(second.body.error_code, 'OATHE_NO_ACTIVE_CLAIM');
  } finally {
    mcp.close();
  }
});

test('the SessionStart hook renders the board for the workspace with a live claim in it', async () => {
  const mcp = mcpSession();
  try {
    await mcp.call('oathe_claim', { task_id: 'board-task', objective: 'Show me at SessionStart' });
  } finally {
    mcp.close();
  }
  const out = spawnSync('node', [path.join(paths.pluginDir, 'hooks/render-board.mjs')], {
    input: JSON.stringify({ cwd: workDir, hook_event_name: 'SessionStart' }),
    encoding: 'utf8',
    env: sb.env,
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /board-task/);
  assert.match(out.stdout, /Show me at SessionStart/);
});

// ------------------------------------------------ the desktop-surface bug, pinned end-to-end

test('THE ORIGINAL REPRO: an unexpanded ${CLAUDE_PROJECT_DIR} does not kill the server — the ladder resolves', async () => {
  // The exact env the Claude desktop surface delivered: the literal template, never expanded.
  // The old server realpath'd it at startup and died with ENOENT before answering anything.
  const mcp = mcpSession({ OATHE_WORKSPACE_DIR: '${CLAUDE_PROJECT_DIR}' });
  const stderrChunks = [];
  mcp.child.stderr.on('data', (chunk) => stderrChunks.push(String(chunk)));
  try {
    const init = await mcp.request('initialize', { capabilities: {} });
    assert.equal(init.result.protocolVersion, '2025-06-18', 'the server answered initialize');
    const board = await mcp.call('oathe_board', {});
    assert.equal(board.isError, false, JSON.stringify(board.body));
    assert.ok(board.body.workspace, 'a board resolved via the ladder (cwd rung)');
    assert.match(stderrChunks.join(''), /\$\{CLAUDE_PROJECT_DIR\}/,
      'the skipped template is NOTED on stderr, never silently swallowed');
  } finally {
    mcp.close();
  }
});

test('an EMPTY env (the codex allowlist posture) still serves: no inherited variable is load-bearing', async () => {
  const child = spawn('node', [path.join(paths.packageRoot, 'src/mcp/oathe-tools.mjs')], {
    cwd: workDir,
    env: {
      PATH: sb.env.PATH,
      HOME: sb.home,
      OATHE_HOME: sb.env.OATHE_HOME,
      OATHE_DB: SCRATCH_DB,
      OATHE_PRINCIPAL: 'founder',
      // Postgres TRANSPORT belongs to the machine, not oathe: the local socket auths by
      // trust, CI's service by password — every PG* rides through, and the pin stays what
      // it claims: no OATHE variable is load-bearing.
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('PG'))),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => { try { lines.push(JSON.parse(line)); } catch { /* not a frame */ } });
  const waitFor = (id, ms = 30_000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const hit = lines.find((m) => m.id === id);
      if (hit) return resolve(hit);
      if (Date.now() - started > ms) return reject(new Error(`timeout waiting for id ${id}`));
      return setTimeout(poll, 10);
    };
    poll();
  });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'oathe_board', arguments: {} } })}\n`);
    const init = await waitFor(1);
    assert.equal(init.result.protocolVersion, '2025-06-18');
    const board = await waitFor(2);
    assert.equal(board.result.isError, false, board.result.content?.[0]?.text);
    const body = JSON.parse(board.result.content[0].text);
    assert.ok(body.workspace, 'the board resolved from the spawn cwd alone');
  } finally {
    child.stdin.end();
    child.kill();
  }
});

test('doctor is clean over the whole install, then uninstall byte-restores every harness config', async () => {
  const doctor = await runDoctor({ env: sb.env, exec: sb.exec });
  assert.ok(doctor.rows.every((r) => r.status === 'ok'), JSON.stringify(doctor.rows));
  if (process.platform === 'darwin') { // the notch is a darwin surface; off it there is no agent row at all
    assert.ok(doctor.rows.some((r) => r.kind === 'launch-agent' && r.status === 'ok'), 'the notch agent row is ok only because launchd RUNS it');
  }

  const cursorMcpBefore = fs.readFileSync(path.join(sb.home, '.cursor/mcp.json'), 'utf8');
  assert.ok(cursorMcpBefore.includes('oathe'), 'cursor was wired by init');
  await runUninstall({ env: sb.env, exec: sb.exec });
  assert.equal(fs.readFileSync(path.join(sb.home, '.claude/settings.json'), 'utf8'), settingsBefore);
  assert.equal(fs.readFileSync(path.join(sb.home, '.codex/config.toml'), 'utf8'), tomlBefore);
  // init CREATED ~/.cursor/mcp.json in this sandbox (absent before); once our entry is gone
  // nothing of substance remains, so uninstall removes the file itself — not a husk.
  assert.ok(!fs.existsSync(path.join(sb.home, '.cursor/mcp.json')), 'the file init created is gone with uninstall');
});

test('the real stdio server speaks as the session the hook registered LAST — a /clear needs no context rebuild', { skip: process.platform !== 'darwin' && 'the ancestry walk reads ps on darwin' }, async () => {
  const { SessionRegistry } = await import('../src/sessions.mjs');
  const sessionsPath = path.join(sb.env.OATHE_HOME, 'sessions.json');
  const tA = path.join(sb.home, 'clear-A.jsonl'); fs.writeFileSync(tA, '');
  const tB = path.join(sb.home, 'clear-B.jsonl'); fs.writeFileSync(tB, '');
  // The server's parent is THIS process: register it as the harness session, as SessionStart does.
  const facts = (transcriptPath) => () => ({ ancestry: [{ pid: process.pid, exec: '/usr/local/bin/claude' }], app: null, transcriptPath, workspace: 'ws-abcdef123456' });
  let t = 0;
  const registry = new SessionRegistry({ sessionsPath, clock: () => new Date(1_800_000_000_000 + (t++) * 1000).toISOString() });
  await registry.ensure({ sessionId: 'sess-clear-A', pid: process.pid, facts: facts(tA) });
  const mcp = mcpSession();
  try {
    await mcp.request('initialize', {});
    const claim = await mcp.call('oathe_claim', { task_id: 'clear-task', objective: 'survive a /clear' });
    assert.equal(claim.isError, false, JSON.stringify(claim.body));
    assert.equal(claim.body.spoken_from.session, 'sess-clear-A');
    await registry.ensure({ sessionId: 'sess-clear-B', pid: process.pid, facts: facts(tB) }); // the /clear hook, between two calls
    const note = await mcp.call('oathe_statement', { task_id: 'clear-task', proposition: 'after the clear' });
    assert.equal(note.isError, false, JSON.stringify(note.body));
    assert.equal(note.body.spoken_from.session, 'sess-clear-B', 'no roots change, no config change — the act still speaks as the new session');
    await mcp.call('oathe_yield', { task_id: 'clear-task', note: 'fixture done' });
  } finally {
    mcp.close();
  }
});

test('PHASE-2 PIN: through the DAEMON, the speaker stays MEASURED — the forwarder\'s pid resolves to {surface, session} and the claim carries them', { skip: process.platform !== 'darwin' && 'the ancestry walk reads ps on darwin' }, async () => {
  // The deepest stdio assumption (reuse-map, 2026-09-04): resolveSpeaker rests on process
  // ancestry — the server being a child of the harness. The daemon keeps it true by proxy:
  // `oathe mcp` stays the per-session child, sends its pid in the hello, and the daemon
  // WALKS THAT PID's ancestry on this same machine. A raw-URL client could assert anything;
  // a pid can be measured. This is the pin the plan named as phase 2's verification.
  const { OatheDaemon } = await import('../src/mcp/daemon.mjs');
  const { SessionRegistry } = await import('../src/sessions.mjs');
  const socketPath = path.join(sb.env.OATHE_HOME, 'serve-pin.sock');
  const daemon = new OatheDaemon({ env: { ...sb.env, OATHE_WORKSPACE_DIR: workDir }, socketPath, err: process.stderr });
  await daemon.start();
  const tF = path.join(sb.home, 'forwarded.jsonl'); fs.writeFileSync(tF, '');
  const mcp = mcpSession({ OATHE_SERVE_SOCKET: socketPath });
  try {
    // Register the FORWARDER as the harness session — exactly what SessionStart does for a
    // real harness child; the daemon must find this row from the pid it was handed.
    const registry = new SessionRegistry({ sessionsPath: path.join(sb.env.OATHE_HOME, 'sessions.json') });
    await registry.ensure({
      sessionId: 'sess-forwarded',
      pid: mcp.child.pid,
      facts: () => ({ ancestry: [{ pid: mcp.child.pid, exec: '/usr/local/bin/claude' }], app: null, transcriptPath: tF, workspace: 'ws-abcdef123456' }),
    });
    await mcp.request('initialize', {});
    const claim = await mcp.call('oathe_claim', { task_id: 'forwarded-task', objective: 'spoken through the daemon' });
    assert.equal(claim.isError, false, JSON.stringify(claim.body));
    assert.equal(claim.body.spoken_from.session, 'sess-forwarded',
      'the daemon MEASURED the forwarder\'s ancestry — the linkTrace lane is intact over the socket');
    assert.equal(claim.body.spoken_from.surface, 'claude', 'the surface resolves from the measured chain');
    await mcp.call('oathe_yield', { task_id: 'forwarded-task', note: 'fixture done' });
  } finally {
    mcp.close();
    await daemon.close();
  }
});

// ---------------------------------------------------------------- the rejection loop, on every surface

/** What the fake engine says next — the claude adapter's own output shape. */
function engineSays(home, verdict, reason) {
  fs.writeFileSync(path.join(home, '.fake-verdict'), `${JSON.stringify({ result: JSON.stringify({ verdict, reason }) })}\n`);
}

/** One frame from the real feed path (`oathe notch`: pager + board + NotchFrame), as the glass would read it. */
function frameNow() {
  const out = spawnSync('node', [path.join(paths.packageRoot, 'bin/oathe.mjs'), 'notch'], { env: sb.env, cwd: workDir, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.split('\n').find((l) => l.startsWith('{')));
}

test('THE REJECTION LOOP ON EVERY SURFACE (plan 2026-09-04): the blocking exchange over the real stdio server re-seats the asserter; an unjudged assertion reads awaiting, verifying while a judge holds it; a verdict rendered elsewhere pages rejected · continue and the next act resumes it; acceptance takes it off the board', async () => {
  const ctx = buildContext({ env: sb.env, cwd: workDir });
  const substrate = ctx.substrate;
  const T = 'walk-task';
  const BIN = path.join(paths.packageRoot, 'bin/oathe.mjs');
  const judgeEnv = { ...sb.env, OATHE_VERIFIER: 'claude', OATHE_VERIFIER_EVIDENCE_BUDGET: '80000' };
  const walkRows = (frame) => ({
    mine: frame.sections.mine.filter((r) => r.task_id === T),
    open: frame.sections.open.filter((r) => r.task_id === T),
    judged: frame.judged.filter((r) => r.task_id === T),
    breaches: frame.breaches.filter((b) => b.task_id === T),
  });
  // The server's parent is THIS process; the session it speaks as is the one registered LAST
  // for it (the /clear pin above leaves one behind whose transcript no store owns, stamped on
  // a 2027 clock). Register this walk's own session, later, over a transcript the claude store
  // owns — the production shape: every act links the speaker's transcript, and the verifier
  // reads it as evidence.
  const { SessionRegistry } = await import('../src/sessions.mjs');
  const spoken = writeClaudeTranscript({ taskId: T, home: sb.home });
  await new SessionRegistry({ sessionsPath: ctx.paths.sessionsPath, clock: () => new Date(1_800_000_000_000 + 60_000).toISOString() }).ensure({
    sessionId: 'sess-walk', pid: process.pid,
    facts: () => ({ ancestry: [{ pid: process.pid, exec: '/usr/local/bin/claude' }], app: null, transcriptPath: spoken.file, workspace: 'ws-abcdef123456' }),
  });
  const mcp = mcpSession({ OATHE_VERIFIER: 'claude', OATHE_VERIFIER_EVIDENCE_BUDGET: '80000' });
  try {
    await mcp.request('initialize', {});
    // 1. claim → held, in motion, nothing judged.
    const claim = await mcp.call('oathe_claim', { task_id: T, objective: 'walk the loop end to end' });
    assert.equal(claim.isError, false, JSON.stringify(claim.body));
    await linkClaudeTrace({ substrate, taskId: T, workClaimId: claim.body.work_claim_id, principal: ctx.identity.principalId, orgId: ctx.identity.orgId });
    let f = walkRows(frameNow());
    assert.equal(f.mine.length, 1, 'held');
    assert.deepEqual([f.judged.length, f.breaches.length], [0, 0]);

    // 2. THE BLOCKING EXCHANGE: done waits for the verdict; the rejection hands the work back in-result.
    engineSays(sb.home, 'rejected', 'the walk is missing');
    const done = await mcp.call('oathe_done', { task_id: T, proposition: 'walked', evidence_ref: 'note:session' });
    assert.equal(done.isError, false, JSON.stringify(done.body));
    assert.equal(done.body.verification?.verdict, 'rejected', JSON.stringify(done.body.verification));
    assert.equal(done.body.reclaimed, true, 'the rejection re-seated the asserter inside the done response');
    assert.equal(done.body.judged_claim_id, claim.body.work_claim_id);
    assert.notEqual(done.body.work_claim_id, claim.body.work_claim_id);
    assert.match(done.body.rejection.reason, /rejected: the walk is missing/);
    f = walkRows(frameNow());
    assert.equal(f.mine.length, 1, 'held again — the owner is on it');
    assert.deepEqual([f.open.length, f.judged.length, f.breaches.length], [0, 0, 0], 'no breach while its holder redoes it');

    // 3. The next statement lands against the new interval — no refusal, no second reclaim.
    const note = await mcp.call('oathe_statement', { task_id: T, proposition: 'redoing the walk' });
    assert.equal(note.isError, false, JSON.stringify(note.body));
    assert.equal(note.body.work_claim_id, done.body.work_claim_id);
    assert.equal(note.body.reclaimed, undefined);

    // 4. THE REMOTE SHAPE: asserted without blocking (the seam elsewhere) — never invisible:
    //    `judged`, awaiting; verifying (spinning) while a judge holds the verify task; awaiting again when released.
    const unwired = createOatheTools({ client: substrate, identity: ctx.identity, workspace: claim.body.home, config: ctx.config, attention: false });
    const asserted = await unwired.oathe_done({ task_id: T, proposition: 'walked again', evidence_ref: 'note:session' });
    assert.equal(asserted.done, true);
    f = walkRows(frameNow());
    assert.equal(f.judged.length, 1, 'the asserted claim has a row');
    assert.deepEqual([f.judged[0].judgment, f.judged[0].busy, f.judged[0].resume], [JUDGMENT.awaiting.word, false, null]);
    assert.deepEqual([f.mine.length, f.breaches.length], [0, 0]);
    const bench = createOatheTools({
      client: substrate, identity: { ...ctx.identity, principalId: ctx.config.get('verifierPrincipal'), department: 'verification' },
      workspace: claim.body.home, config: ctx.config, attention: false,
    });
    await bench.oathe_claim({ task_id: `verify:${T}` });
    f = walkRows(frameNow());
    assert.deepEqual([f.judged[0].judgment, f.judged[0].busy], [JUDGMENT.verifying.word, true], 'the glass spins while a judge holds it');
    await bench.oathe_yield({ task_id: `verify:${T}`, note: 'bench fixture' });
    assert.deepEqual([walkRows(frameNow()).judged[0].judgment], [JUDGMENT.awaiting.word]);

    // 5. The verdict rendered ELSEWHERE (a terminal's `oathe verify`): rejected → the glass pages rejected · continue.
    engineSays(sb.home, 'rejected', 'the second walk is missing too');
    const judged = spawnSync('node', [BIN, 'verify', T], { env: judgeEnv, cwd: workDir, encoding: 'utf8' });
    assert.equal(judged.status, 0, `${judged.stdout}\n${judged.stderr}`);
    assert.match(judged.stdout, /rejected/);
    f = walkRows(frameNow());
    assert.equal(f.breaches.length, 1, 'one breach row');
    assert.equal(f.breaches[0].kind, 'reopened');
    assert.equal(f.breaches[0].kind_word, KINDS.reopened.word);
    assert.equal(f.breaches[0].act?.word, KINDS.reopened.act, 'continue is the act');
    assert.match(f.breaches[0].detail, /the second walk is missing too/, 'the verdict\'s words ride the row');
    assert.deepEqual([f.mine.length, f.judged.length], [0, 0], 'one row per task — the breach is it');

    // 6. THE ASYNC FALLBACK: the owner's next act resumes it, carrying the bundle; the breach clears.
    const back = await mcp.call('oathe_statement', { task_id: T, proposition: 'back on the walk' });
    assert.equal(back.isError, false, JSON.stringify(back.body));
    assert.equal(back.body.reclaimed, true, 'the act reclaimed');
    assert.match(back.body.rejection.reason, /the second walk is missing too/);
    f = walkRows(frameNow());
    assert.deepEqual([f.mine.length, f.breaches.length, f.judged.length], [1, 0, 0]);

    // 7. Acceptance closes the episode in the blocking exchange: verified, settled, off the board — nothing reclaims.
    engineSays(sb.home, 'accepted', 'the walk is complete');
    const closed = await mcp.call('oathe_done', { task_id: T, proposition: 'walked, complete', evidence_ref: 'note:session' });
    assert.equal(closed.isError, false, JSON.stringify(closed.body));
    assert.equal(closed.body.verification?.verdict, 'accepted', JSON.stringify(closed.body.verification));
    assert.equal(closed.body.reclaimed, undefined);
    f = walkRows(frameNow());
    assert.deepEqual([f.mine.length, f.open.length, f.judged.length, f.breaches.length], [0, 0, 0, 0], 'off the board');
    const { rows } = await substrate.query(
      'SELECT settled_at FROM cell.work_claim WHERE org_id = $1 AND work_claim_id = $2', [ctx.identity.orgId, closed.body.work_claim_id]);
    assert.ok(rows[0]?.settled_at, 'the accepted interval is settled (014: a stamp)');
  } finally {
    mcp.close();
    fs.rmSync(path.join(sb.home, '.fake-verdict'), { force: true });
    await substrate.close();
  }
});
