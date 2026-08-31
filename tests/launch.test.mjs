import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { sandbox } from './helpers.mjs';
import { preflight, runHarness, ensureVerifierChoice } from '../src/launch.mjs';
import { runInit } from '../src/init.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';

const paths = buildPaths({});
const SCRATCH_DB = `oathe_launch_test_${process.pid}`;
const VERSION = JSON.parse(fs.readFileSync(path.join(paths.packageRoot, 'package.json'), 'utf8')).version;

let sb;

before(async () => {
  sb = sandbox({ scratchDb: SCRATCH_DB, claudeScript: 'echo interactive-session-ran; exit 0' });
  await runInit({ env: sb.env, exec: sb.exec });
});

after(async () => {
  const substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await substrate.close();
  await substrate.dropDatabase();
});

function projectDir() {
  return fs.mkdtempSync(path.join(sb.home, 'proj-'));
}

test('preflight creates a minimal CLAUDE.md carrying only the fence when none exists, recorded project-scope', async () => {
  const cwd = projectDir();
  const result = await preflight({ harness: 'claude', env: sb.env, cwd });
  const claudeMd = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, new RegExp(`<!-- >>> oathe v${VERSION.replaceAll('.', '\\.')} >>> -->`));
  assert.match(claudeMd, /## Oathe/);
  assert.match(claudeMd, /oathe/);
  const manifest = JSON.parse(fs.readFileSync(path.join(sb.env.OATHE_HOME, 'install-manifest.json'), 'utf8'));
  const row = manifest.rows.find((r) => r.file === path.join(cwd, 'CLAUDE.md'));
  assert.equal(row.kind, 'fence');
  assert.equal(row.scope, 'project');
  assert.ok(result.actions.some((a) => a.action === 'claude-md-fence'));
});

test('preflight appends the fence to an existing CLAUDE.md without touching its content, and is idempotent', async () => {
  const cwd = projectDir();
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# My project\n\nRules here.\n');
  await preflight({ harness: 'claude', env: sb.env, cwd });
  const first = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
  assert.ok(first.startsWith('# My project\n\nRules here.\n'));
  assert.match(first, /## Oathe/);
  await preflight({ harness: 'claude', env: sb.env, cwd });
  assert.equal(fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8'), first);
});

test('preflight writes the AGENTS.md fence too when Codex is detected', async () => {
  const cwd = projectDir();
  await preflight({ harness: 'claude', env: sb.env, cwd });
  const agents = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');
  assert.match(agents, new RegExp(`<!-- >>> oathe v${VERSION.replaceAll('.', '\\.')} >>> -->`));
  assert.ok(agents.length < 600, 'the fence stays tiny — Codex caps project docs at 32KB');
});

test('preflight refuses when the global install is missing (manifest has no claude rows)', async () => {
  const bare = sandbox({ scratchDb: SCRATCH_DB });
  await assert.rejects(
    () => preflight({ harness: 'claude', env: bare.env, cwd: projectDir() }),
    (e) => e.code === 'OATHE_NOT_INSTALLED');
});

for (const providerName of ['auto', 'standalone']) {
  const penv = (env) => ({ ...env, OATHE_RUNTIME_PROVIDER: providerName });

  test(`[${providerName}] runHarness(claude) launches the harness in the cage, proves the scope empty, and the clean exit speaks`, async () => {
    const cwd = projectDir();
    const out = await runHarness({ harness: 'claude', env: penv(sb.env), cwd, args: [], observeIntervalMs: 50 });
    assert.equal(out.exitCode, 0);
    assert.equal(out.teardown.empty, true, 'the cage was proven empty after exit');
    assert.ok(fs.existsSync(path.join(cwd, 'CLAUDE.md')), 'pre-flight ran');
  });

  test(`[${providerName}] runHarness(claude) --hermetic hands the child a REPLACED minimal environment`, async () => {
    const cwd = projectDir();
    const probe = sandbox({ scratchDb: SCRATCH_DB });
    const dump = path.join(probe.home, 'envdump.txt');
    fs.writeFileSync(path.join(probe.bin, 'claude'), `#!/bin/sh\nenv > "${dump}"; exit 0\n`);
    fs.chmodSync(path.join(probe.bin, 'claude'), 0o755);
    await runInit({ env: probe.env, exec: probe.exec });
    const env = penv({ ...probe.env, SUPER_SECRET_TOKEN: 'leak-me' });
    await runHarness({ harness: 'claude', env, cwd, args: [], hermetic: true, observeIntervalMs: 50 });
    const seen = fs.readFileSync(dump, 'utf8');
    assert.ok(!seen.includes('SUPER_SECRET_TOKEN'), 'hermetic env must not leak arbitrary vars');
    assert.match(seen, /OATHE_EXECUTION_ATTEMPT_ID=/, 'the fence stamp reaches the child');
    assert.match(seen, /OATHE_DB=/, 'oathe wiring reaches the child');
    assert.match(seen, /^OATHE_LAUNCHED_HARNESS=claude$/m,
      'the launch marker reaches the child — the plugin only fires in sessions that carry it');
  });

  test(`[${providerName}] runHarness(codex) launches Codex in the same cage with the same host — the deferred-codex premise died in research`, async () => {
    const cwd = projectDir();
    fs.writeFileSync(path.join(sb.bin, 'codex'), '#!/bin/sh\necho codex-session-ran; exit 0\n');
    fs.chmodSync(path.join(sb.bin, 'codex'), 0o755);
    const out = await runHarness({ harness: 'codex', env: penv(sb.env), cwd, args: [], observeIntervalMs: 50 });
    assert.equal(out.exitCode, 0);
    assert.equal(out.teardown.empty, true, 'the cage was proven empty after exit');
    assert.ok(fs.existsSync(path.join(cwd, 'AGENTS.md')), 'pre-flight wrote the Codex surface');
  });
}

test('oathe codex opens with the ANSI splash — no markdown, no pause off-TTY', async () => {
  const cwd = projectDir();
  const printed = [];
  const capture = { isTTY: false, write: (text) => { printed.push(text); return true; } };
  await runHarness({ harness: 'codex', env: sb.env, cwd, args: [], observeIntervalMs: 50, out: capture });
  const all = printed.join('');
  // R-QUIET: no state line to push on a clean board — the splash is the dim scope line only.
  assert.match(all, /\x1b\[2mws-[0-9a-f]{12}\x1b\[0m/, 'the scope line leads');
  assert.doesNotMatch(all, /\u{1F37A}|\u{1F389}|\u{1F512}/u, 'the old celebration states are gone');
  assert.doesNotMatch(all, /##|\*\*/, 'no markdown syntax in the splash');
});

test('oathe claude prints NOTHING before the TUI — its own banner does the talking', async () => {
  const cwd = projectDir();
  const printed = [];
  const capture = { isTTY: false, write: (text) => { printed.push(text); return true; } };
  await runHarness({ harness: 'claude', env: sb.env, cwd, args: [], observeIntervalMs: 50, out: capture });
  assert.equal(printed.join(''), '');
});

test('runHarness(codex) refuses when Codex was never onboarded (no codex rows in the manifest)', async () => {
  const bare = sandbox({ scratchDb: SCRATCH_DB });
  fs.rmSync(path.join(bare.home, '.codex'), { recursive: true }); // codex not installed at init time
  await runInit({ env: bare.env, exec: bare.exec });
  await assert.rejects(
    () => runHarness({ harness: 'codex', env: bare.env, cwd: projectDir(), observeIntervalMs: 50 }),
    (e) => e.code === 'OATHE_NOT_INSTALLED' && /codex/i.test(e.message));
});

// The verifier choice moved to `oathe init` (founder decision): launchers never prompt.
// ensureVerifierChoice reads config — an explicit choice passes silently; a still-default
// value is ANNOUNCED on stderr (never silently assumed), with the pointer to record one.

test('launch never prompts for the verifier — an explicit config choice passes silently', async () => {
  const { OatheConfig } = await import('../src/config.mjs');
  const cwd = projectDir();
  const config = new OatheConfig({ env: sb.env, cwd });
  config.set('verifier', 'codex', { scope: 'workspace' });
  const outWrites = [];
  const errWrites = [];
  const result = await ensureVerifierChoice({
    config,
    harness: 'codex',
    stdin: Object.assign(Object.create(null), { isTTY: true }),
    out: { isTTY: true, write: (t) => outWrites.push(t) },
    err: { write: (t) => errWrites.push(t) },
  });
  assert.equal(result.prompted, false);
  assert.equal(result.chosen, 'codex');
  assert.equal(outWrites.length, 0, 'a TTY gets no prompt either — init owns the question');
  assert.equal(errWrites.length, 0);
});

test('a still-default verifier is announced on stderr — never silently assumed, never prompted', async () => {
  const { OatheConfig } = await import('../src/config.mjs');
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const cwd = projectDir();
  const outWrites = [];
  const errWrites = [];
  // An ISOLATED config home: this sandbox's init already recorded the verifier machine-wide
  // (the new init behavior), so the still-default premise needs a home with no such record.
  const bareHome = fsMod.realpathSync(fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'oathe-vd-')));
  const result = await ensureVerifierChoice({
    config: new OatheConfig({
      env: { HOME: bareHome, OATHE_HOME: pathMod.join(bareHome, '.oathe') }, cwd,
    }),
    harness: 'claude',
    stdin: { isTTY: true },
    out: { isTTY: true, write: (t) => outWrites.push(t) },
    err: { write: (t) => errWrites.push(t) },
  });
  assert.equal(result.prompted, false);
  assert.equal(result.chosen, 'claude');
  assert.equal(outWrites.length, 0, 'stdout stays clean');
  assert.ok(errWrites.some((w) => /verifier: claude \(default/.test(w) && /oathe (init|config)/.test(w)),
    errWrites.join('|'));
});

test('R-PAGER: the codex splash carries the breach digest — a quiet claim anywhere on the machine is paged', async () => {
  const substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  try {
    await substrate.query(`
      INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                             verify_by, claim_mode, created_at)
      VALUES ('oathe', 'splash-quiet', 'founder', 'went quiet', 'minted_at_claim',
              '{"plan_status":"unknown"}'::jsonb, now() + interval '30 days', 'exclusive', now() - interval '2 days')`);
    await substrate.query(
      `SELECT cell.claim_work('oathe', 'splash-quiet', gen_random_uuid(), NULL, NULL, 'athena', 'founder',
              'exclusive', now() + interval '4 hours', $1, now() - interval '2 days', gen_random_uuid())`,
      ['workspace:ws-000000000bbb;contract:oathe/splash-quiet@v1']);
  } finally {
    await substrate.close();
  }
  const cwd = projectDir();
  const printed = [];
  const capture = { isTTY: false, write: (text) => { printed.push(text); return true; } };
  await runHarness({ harness: 'codex', env: sb.env, cwd, args: [], observeIntervalMs: 50, out: capture });
  const all = printed.join('');
  assert.match(all, /BREACHED PROMISES/);
  assert.match(all, /splash-quiet/);
  assert.match(all, /athena/);
});
