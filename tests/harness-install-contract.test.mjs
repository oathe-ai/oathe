// The install-contract lane (drift monitors P2): against a REAL harness CLI on a fresh runner,
// prove that `oathe init` initializes the directories we depend on in the format we depend on
// — through the doctor's own row verification — that a second init is byte-idempotent, that
// uninstall restores every file, and that the global-fence precedence holds. Here the runner
// is driven with the sandbox's CLI fakes (in-process) so the script itself is pinned; CI runs
// it against the real CLIs, and so does the live proof on a developer machine.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runInstallContract, InstallContractError } from '../scripts/harness-install-contract.mjs';
import { runInit } from '../src/init.mjs';
import { runUninstall } from '../src/uninstall.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';
import { sandbox } from './helpers.mjs';

const paths = buildPaths({});
const dbs = [];

/** An in-process verb runner over the sandbox fakes — what CI replaces with the real bin. */
function fakeRunner(exec) {
  return async ({ verb, args, env }) => {
    if (verb === 'init') {
      const harness = args[args.indexOf('--harness') + 1];
      await runInit({ env, exec, harnessFilter: [harness], assumeYes: true });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (verb === 'uninstall') {
      await runUninstall({ env, exec, purgeDb: args.includes('--purge-db') });
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected verb ${verb}`);
  };
}

/** The prompter over fake TTY streams, Enter to everything — what the lane's pty runner does for real. */
function fakeTty(exec) {
  return async ({ args, env }) => {
    const { EventEmitter } = await import('node:events');
    const writes = [];
    const out = Object.assign(new EventEmitter(), { isTTY: true, write: (x) => { writes.push(x); return true; } });
    const stdin = Object.assign(new EventEmitter(), { isTTY: true, pause: () => {}, resume: () => {} });
    const run = runInit({ env, exec, harnessFilter: args.includes('--harness') ? [args[args.indexOf('--harness') + 1]] : null, stdin, out, err: { write: () => true } });
    const stdinRaw = Object.assign(stdin, { setRawMode: () => {} });
    let pressed = false;
    const timer = setInterval(() => { if (!pressed && /enter install/.test(writes.join(''))) { pressed = true; stdinRaw.emit('data', '\r'); } }, 5);
    try { await run; } finally { clearInterval(timer); }
    return { status: 0, transcript: `${writes.join('')}oathe: init ok\n` };
  };
}

after(async () => {
  for (const db of dbs) {
    const s = new Substrate({ database: db, paths, env: process.env });
    await s.close();
    await s.dropDatabase().catch(() => {});
  }
});

for (const harness of ['claude', 'codex', 'cursor']) {
  test(`${harness}: init → every row ok → idempotent → uninstall restores → ok`, async () => {
    const sb = sandbox({ scratchDb: `oathe_ic_${harness}_${process.pid}` });
    dbs.push(sb.env.OATHE_DB);
    const out = await runInstallContract({ harness, env: sb.env, runVerb: fakeRunner(sb.exec), runTty: fakeTty(sb.exec), versionOf: () => 'fake-1.0' });
    assert.equal(out.ok, true, JSON.stringify(out.checks));
    assert.equal(out.harness, harness);
    assert.equal(out.version, 'fake-1.0');
    const names = out.checks.map((c) => c.name);
    assert.deepEqual(names, ['init', 'rows-ok', ...(harness === 'codex' ? ['global-fence-precedence'] : []), 'idempotent', 'init-tty', 'uninstall-restores']);
    assert.ok(out.checks.every((c) => c.ok));
    assert.match(out.render(), new RegExp(`^install-contract: ${harness} ok \\(fake-1.0\\)$`, 'm'));
  });
}

test('a CLI that stops writing what it wrote before FAILS LOUD, naming the check and the row', async () => {
  const sb = sandbox({ scratchDb: `oathe_ic_broken_${process.pid}` });
  dbs.push(sb.env.OATHE_DB);
  // The next codex release stops writing the mcp_servers stanza its `codex mcp add` used to write.
  const exec = {
    calls: [],
    run(cmd, args) {
      if (cmd === 'codex' && args[0] === 'mcp') return { status: 0, stdout: '', stderr: '' };
      return sb.exec.run(cmd, args);
    },
  };
  const out = await runInstallContract({ harness: 'codex', env: sb.env, runVerb: fakeRunner(exec), runTty: fakeTty(exec), versionOf: () => 'codex-next' });
  assert.equal(out.ok, false);
  const failed = out.checks.find((c) => !c.ok);
  assert.equal(failed.name, 'init');
  assert.match(failed.detail, /CODEX_VERIFICATION_FAILED|mcp_servers/);
  assert.match(out.render(), /^install-contract: codex FAILED — init: /m);
  assert.equal(out.exitCode, 1);
});

test('an unknown harness, or one without an install fact, is a refusal', async () => {
  await assert.rejects(runInstallContract({ harness: 'nope', env: process.env, runVerb: async () => ({ status: 0 }) }),
    (e) => e instanceof InstallContractError && e.code === 'OATHE_INSTALL_CONTRACT_UNKNOWN_HARNESS');
});

test('the REAL lane runs the INSTALLED package: sandboxEnv packs the tree and installs the tarball globally into the sandbox, and the bin it runs is that one', async () => {
  const { sandboxEnv, installedBin } = await import('../scripts/harness-install-contract.mjs');
  const { home, env } = sandboxEnv({ harness: 'cursor', fromTarball: true });
  try {
    const bin = installedBin({ home });
    assert.ok(fs.existsSync(bin), `installed bin at ${bin}`);
    assert.ok(env.PATH.startsWith(path.dirname(bin)), 'the installed bin leads PATH in the sandbox');
    const version = JSON.parse(fs.readFileSync(path.join(paths.packageRoot, 'package.json'), 'utf8')).version;
    const out = spawnSync(bin, ['version'], { env, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.split('\n').includes(version), `oathe version printed ${version}: ${out.stdout}`);
    const real = fs.realpathSync(bin);
    assert.ok(!real.startsWith(paths.packageRoot), 'the bin is NOT the checkout — it is the unpacked tarball');
    assert.ok(fs.existsSync(path.join(path.dirname(path.dirname(real)), '.claude-plugin/marketplace.json')),
      'the installed package carries the marketplace manifest (the tarball-content check the checkout could never fail)');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the transcript rules: a numbered menu, a missing question, or a missing trailer is named — a clean transcript passes', async () => {
  const { ttyTranscriptProblems } = await import('../scripts/harness-install-contract.mjs');
  const clean = 'oathe init — reversible (oathe uninstall)\n  ↑↓ move · space toggle · enter install\n\n  [x] Cursor       (CLI/Desktop App)\n  verifier     claude\noathe init — done\noathe: init ok\n';
  assert.deepEqual(ttyTranscriptProblems(clean, { displayName: 'Cursor' }), []);
  const numbered = clean.replace('[x] Cursor', '[1] cursor').replace('↑↓ move · space toggle · enter install', 'wire which? > ');
  assert.ok(ttyTranscriptProblems(numbered, { displayName: 'Cursor' }).some((p) => /numbered menu/.test(p)));
  assert.ok(ttyTranscriptProblems(numbered, { displayName: 'Cursor' }).some((p) => /\[x\] Cursor/.test(p)));
  assert.ok(ttyTranscriptProblems(clean.replace('[x] Cursor', 'wire Cursor? [Y/n]'), { displayName: 'Cursor' }).some((p) => /conversation/.test(p)));
  assert.ok(ttyTranscriptProblems(clean.replace('oathe: init ok\n', ''), { displayName: 'Cursor' }).some((p) => /trailer/.test(p)));
});

test('the REAL pty runner drives the bin under `script`: stdin and stdout are TTYs, Enter answers every question, the transcript passes the rules', async () => {
  // cursor: the one wiring with no CLI calls, so the real bin can run it against the sandbox.
  const sb = sandbox({ scratchDb: `oathe_ic_tty_${process.pid}` });
  dbs.push(sb.env.OATHE_DB);
  // Only Cursor is installed here: the real bin would otherwise wire Claude/Codex through the
  // sandbox's shell stubs (exit 0, nothing written) and refuse on verification.
  for (const gone of ['.claude', '.codex', 'bin/claude', 'bin/codex']) fs.rmSync(path.join(sb.home, gone), { recursive: true, force: true });
  const { runInstallContract: run } = await import('../scripts/harness-install-contract.mjs');
  const out = await run({ harness: 'cursor', env: sb.env, runVerb: fakeRunner(sb.exec), versionOf: () => 'fake-1.0' });
  const tty = out.checks.find((c) => c.name === 'init-tty');
  assert.equal(tty.ok, true, tty.detail);
});
