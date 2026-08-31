// The exit loop, scripted: fresh sandbox HOME → init → board renders → claim → note →
// pickup (the real successor over stdio) → yield → doctor clean → uninstall byte-restores.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { createRequire } from 'node:module';

import { sandbox } from './helpers.mjs';
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
  sb = sandbox({ scratchDb: SCRATCH_DB });
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

test('THE ORIGINAL REPRO: an unexpanded ${CLAUDE_PROJECT_DIR} no longer kills the server — the ladder resolves', async () => {
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
  const doctor = await runDoctor({ env: sb.env });
  assert.ok(doctor.rows.every((r) => r.status === 'ok'), JSON.stringify(doctor.rows));

  const cursorMcpBefore = fs.readFileSync(path.join(sb.home, '.cursor/mcp.json'), 'utf8');
  assert.ok(cursorMcpBefore.includes('oathe'), 'cursor was wired by init');
  await runUninstall({ env: sb.env, exec: sb.exec });
  assert.equal(fs.readFileSync(path.join(sb.home, '.claude/settings.json'), 'utf8'), settingsBefore);
  assert.equal(fs.readFileSync(path.join(sb.home, '.codex/config.toml'), 'utf8'), tomlBefore);
  // init CREATED ~/.cursor/mcp.json in this sandbox (absent before); once our entry is gone
  // nothing of substance remains, so uninstall removes the file itself — not a husk.
  assert.ok(!fs.existsSync(path.join(sb.home, '.cursor/mcp.json')), 'the file init created is gone with uninstall');
});
