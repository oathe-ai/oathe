// The W1 exit loop, scripted: fresh sandbox HOME → init → board renders → claim → note →
// pickup (the real successor over stdio) → yield → doctor clean → uninstall byte-restores.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

import { sandbox } from './helpers.mjs';
import { runInit } from '../src/init.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { runUninstall } from '../src/uninstall.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';

const paths = buildPaths({});
const SCRATCH_DB = `oathe_e2e_test_${process.pid}`;

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
function mcpSession() {
  const child = spawn('node', [path.join(paths.packageRoot, 'src/mcp/oathe-tools.mjs')], {
    env: { ...sb.env, OATHE_WORKSPACE_DIR: workDir, OATHE_LAUNCHED_HARNESS: 'claude' },
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
    assert.equal(pickup.isError, false, JSON.stringify(pickup.body));
    assert.equal(pickup.body.mode, 'RECOMPILE');
    assert.ok(pickup.body.attempt_id, 'a real attempt was allocated through the successor path');
    assert.ok(pickup.body.render.length > 0);

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
    env: { ...sb.env, OATHE_LAUNCHED_HARNESS: 'claude' },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /board-task/);
  assert.match(out.stdout, /Show me at SessionStart/);
});

test('doctor is clean over the whole install, then uninstall byte-restores both harness configs', async () => {
  const doctor = await runDoctor({ env: sb.env });
  assert.ok(doctor.rows.every((r) => r.status === 'ok'), JSON.stringify(doctor.rows));

  await runUninstall({ env: sb.env, exec: sb.exec });
  assert.equal(fs.readFileSync(path.join(sb.home, '.claude/settings.json'), 'utf8'), settingsBefore);
  assert.equal(fs.readFileSync(path.join(sb.home, '.codex/config.toml'), 'utf8'), tomlBefore);
});
