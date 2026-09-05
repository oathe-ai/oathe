// oathe — the materialized shim: ONE durable address for the oathe bin. A bare `oathe` on
// PATH dies in every GUI-launched session (launchd's PATH carries no nvm — measured
// 2026-09-04: claims that never landed while the notch honestly showed 0). The shim is the
// notch-app pattern applied to the bin: init materializes $HOME/.oathe/bin/oathe with the
// running node and package baked in, re-stamps it on every init/update (node moves never
// strand it), and uninstall removes exactly what was recorded. Harness MCP entries and the
// plugin's shell-form hooks all point HERE — an address, never a recipe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { shimPath, writeShim, unwireShim, sweepMcpServers } from '../src/shim.mjs';
import { InstallManifest } from '../src/manifest.mjs';
import { buildPaths } from '../src/paths.mjs';

const { packageRoot } = buildPaths({});

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-shim-')); }

function manifestIn(home) {
  return new InstallManifest({
    manifestPath: path.join(home, '.oathe', 'install-manifest.json'),
    backupsDir: path.join(home, '.oathe', 'backups'),
  });
}

test('shimPath is the ONE durable address: $HOME/.oathe/bin/oathe — the string the static plugin files carry', () => {
  assert.equal(shimPath('/Users/x'), '/Users/x/.oathe/bin/oathe');
});

test('writeShim materializes an executable that execs THIS node on THIS package bin, and records it', () => {
  const home = tmp();
  try {
    const manifest = manifestIn(home);
    const actions = writeShim({ home, manifest, version: '9.9.9', packageRoot });
    const file = shimPath(home);
    assert.deepEqual(actions, [{ action: 'shim-written', file }]);
    assert.ok(fs.statSync(file).mode & 0o100, 'owner-executable');
    const body = fs.readFileSync(file, 'utf8');
    assert.ok(body.startsWith('#!/bin/sh\n'), 'a shell script — sh exists on every mac and linux');
    assert.ok(body.includes(`exec "${process.execPath}" "${path.join(packageRoot, 'bin/oathe.mjs')}" "$@"`),
      'the running node and the package bin, absolute, args passed through');
    const row = manifest.rows.find((r) => r.kind === 'oathe-shim');
    assert.equal(row?.file, file, 'the manifest records the shim for uninstall');
    assert.equal(row.harness, 'shim');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a second writeShim is byte-idempotent; a shim from a MOVED node is re-stamped', () => {
  const home = tmp();
  try {
    const manifest = manifestIn(home);
    writeShim({ home, manifest, version: '9.9.9', packageRoot });
    const bytes = fs.readFileSync(shimPath(home), 'utf8');
    const again = writeShim({ home, manifest, version: '9.9.9', packageRoot });
    assert.deepEqual(again, [{ action: 'shim-current', file: shimPath(home) }]);
    assert.equal(fs.readFileSync(shimPath(home), 'utf8'), bytes, 'unchanged world, unchanged bytes');
    // The nvm switch: a new node path is a NEW shim — the exact staleness that stranded the
    // v22-bin machines (2026-09-04) must re-stamp, never survive.
    const moved = writeShim({ home, manifest, version: '9.9.9', packageRoot, execPath: '/elsewhere/node' });
    assert.deepEqual(moved, [{ action: 'shim-written', file: shimPath(home) }]);
    assert.ok(fs.readFileSync(shimPath(home), 'utf8').includes('"/elsewhere/node"'));
    // Review F1 (2026-09-04): row identity keys on the FULL detail, so a node move minted a
    // SECOND oathe-shim row and doctor cried user-edited forever — on exactly the nvm-switcher
    // machines this lane serves. A re-stamp REPLACES the row.
    assert.equal(manifest.rows.filter((r) => r.kind === 'oathe-shim').length, 1,
      'one shim, one row — a re-stamp replaces, never accumulates');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------- the sweep, unit-pinned
// Review F4/F5 (2026-09-04): a function that kills processes by regex had only a happy-path
// test; pgrep's exit codes conflated "none matched" with "could not look" (a silent defer of
// a founder-mandated sweep), and one already-gone pid misreported the whole sweep as partial.

function sweepExec(script) {
  const calls = [];
  return {
    calls,
    run(cmd, args) {
      calls.push([cmd, ...args]);
      return script(cmd, args, calls);
    },
  };
}

test('sweep: pgrep finding nothing is mcp-sweep-none and no kill runs', () => {
  const exec = sweepExec((cmd) => (cmd === 'pgrep' ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: '', stderr: '' }));
  assert.deepEqual(sweepMcpServers({ exec }), [{ action: 'mcp-sweep-none' }]);
  assert.ok(!exec.calls.some(([c]) => c === 'kill'), 'nothing found, nothing killed');
});

test('sweep: a pgrep that CANNOT look is mcp-sweep-failed with its words — never a silent none', () => {
  const exec = sweepExec((cmd) => (cmd === 'pgrep'
    ? { status: 2, stdout: '', stderr: 'pgrep: invalid expression' }
    : { status: 0, stdout: '', stderr: '' }));
  const [out] = sweepMcpServers({ exec });
  assert.equal(out.action, 'mcp-sweep-failed');
  assert.match(out.detail, /invalid expression/, "the tool's own last word rides the report");
});

test('sweep: found pids are killed INDIVIDUALLY and the recheck decides — all gone is swept, even when one kill misses its already-dead target', () => {
  let pgreps = 0;
  const exec = sweepExec((cmd, args) => {
    if (cmd === 'pgrep') {
      pgreps += 1;
      return pgreps === 1 ? { status: 0, stdout: '111\n222\n', stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    // 222 exited between pgrep and kill — the natural race; the recheck, not this exit
    // code, is the truth about the sweep.
    return args[0] === '222' ? { status: 1, stdout: '', stderr: 'kill: 222: No such process' } : { status: 0, stdout: '', stderr: '' };
  });
  const [out] = sweepMcpServers({ exec });
  assert.deepEqual(out, { action: 'mcp-swept', pids: [111, 222] });
  assert.deepEqual(exec.calls.filter(([c]) => c === 'kill'), [['kill', '111'], ['kill', '222']], 'one kill per pid');
  assert.equal(exec.calls.filter(([c]) => c === 'pgrep').length, 2, 'the recheck ran');
});

test('sweep: a SURVIVOR after the kills is mcp-sweep-partial naming it', () => {
  let pgreps = 0;
  const exec = sweepExec((cmd) => {
    if (cmd === 'pgrep') {
      pgreps += 1;
      return { status: 0, stdout: pgreps === 1 ? '111\n222\n' : '222\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  const [out] = sweepMcpServers({ exec });
  assert.equal(out.action, 'mcp-sweep-partial');
  assert.deepEqual(out.pids, [111, 222]);
  assert.deepEqual(out.survivors, [222], 'the report names who survived — restart THAT session');
});

test('the shim answers under a BARE PATH — the environment every GUI-launched session actually gets', () => {
  const home = tmp();
  try {
    writeShim({ home, manifest: manifestIn(home), version: '9.9.9', packageRoot });
    // PATH=/usr/bin:/bin is launchd's world: no nvm, no node. The shim must not need either.
    const out = spawnSync(shimPath(home), ['version'], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home },
    });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stderr + out.stdout, /oathe: version ok/, 'the trailer proves the real bin ran');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('THE GATE: the shim answers the MCP handshake under a bare PATH — the exact spawn every harness config makes', () => {
  // This is the executable form of the 2026-09-04 failure: a GUI-launched harness spawns the
  // configured command with PATH=/usr/bin:/bin and either gets an MCP server or silently has
  // no board. Startup is crash-proof by construction (nothing beyond the transport before the
  // first tools/call), so initialize must answer with no Postgres and no nvm in sight.
  const home = tmp();
  try {
    writeShim({ home, manifest: manifestIn(home), version: '9.9.9', packageRoot });
    const init = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bare-path-gate', version: '0' } },
    });
    const out = spawnSync(shimPath(home), ['mcp'], {
      input: `${init}\n`, encoding: 'utf8', timeout: 15000,
      env: { PATH: '/usr/bin:/bin', HOME: home },
    });
    const reply = JSON.parse(out.stdout.split('\n').find(Boolean) ?? 'null');
    assert.equal(reply?.id, 1, `no initialize answer: stdout=${out.stdout} stderr=${out.stderr}`);
    assert.equal(reply.result.serverInfo.name, 'oathe-tools', 'the real server answered, not a wrapper');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('unwireShim removes exactly what was recorded — file gone, rows gone, absence is a stated action', () => {
  const home = tmp();
  try {
    const manifest = manifestIn(home);
    writeShim({ home, manifest, version: '9.9.9', packageRoot });
    const gone = unwireShim({ manifest });
    assert.deepEqual(gone, [{ action: 'shim-removed', file: shimPath(home) }]);
    assert.ok(!fs.existsSync(shimPath(home)));
    assert.equal(manifest.rows.filter((r) => r.kind === 'oathe-shim').length, 0);
    assert.deepEqual(unwireShim({ manifest }), [{ action: 'shim-absent' }],
      'a second unwire states the absence rather than inventing work');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
