import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { sandbox } from './helpers.mjs';
import { preflight, runClaude } from '../src/launch.mjs';
import { runInit } from '../src/init.mjs';
import { Substrate } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';

const paths = buildPaths({});
const SCRATCH_DB = `oathe_launch_test_${process.pid}`;

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
  const result = await preflight({ env: sb.env, cwd });
  const claudeMd = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /<!-- >>> oathe v0\.1\.0 >>> -->/);
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
  await preflight({ env: sb.env, cwd });
  const first = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
  assert.ok(first.startsWith('# My project\n\nRules here.\n'));
  assert.match(first, /## Oathe/);
  await preflight({ env: sb.env, cwd });
  assert.equal(fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8'), first);
});

test('preflight writes the AGENTS.md fence too when Codex is detected', async () => {
  const cwd = projectDir();
  await preflight({ env: sb.env, cwd });
  const agents = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');
  assert.match(agents, /<!-- >>> oathe v0\.1\.0 >>> -->/);
  assert.ok(agents.length < 600, 'the fence stays tiny — Codex caps project docs at 32KB');
});

test('preflight refuses when the global install is missing (manifest has no claude rows)', async () => {
  const bare = sandbox({ scratchDb: SCRATCH_DB });
  await assert.rejects(
    () => preflight({ env: bare.env, cwd: projectDir() }),
    (e) => e.code === 'OATHE_NOT_INSTALLED');
});

test('runClaude launches the harness in the cage, proves the scope empty, and the clean exit speaks', async () => {
  const cwd = projectDir();
  const out = await runClaude({ env: sb.env, cwd, args: [], renewIntervalMs: 50 });
  assert.equal(out.exitCode, 0);
  assert.equal(out.teardown.empty, true, 'the cage was proven empty after exit');
  assert.ok(fs.existsSync(path.join(cwd, 'CLAUDE.md')), 'pre-flight ran');
});

test('runClaude --hermetic hands the child a REPLACED minimal environment', async () => {
  const cwd = projectDir();
  const probe = sandbox({ scratchDb: SCRATCH_DB });
  const dump = path.join(probe.home, 'envdump.txt');
  fs.writeFileSync(path.join(probe.bin, 'claude'), `#!/bin/sh\nenv > "${dump}"; exit 0\n`);
  fs.chmodSync(path.join(probe.bin, 'claude'), 0o755);
  await runInit({ env: probe.env, exec: probe.exec });
  const env = { ...probe.env, SUPER_SECRET_TOKEN: 'leak-me' };
  await runClaude({ env, cwd, args: [], hermetic: true, renewIntervalMs: 50 });
  const seen = fs.readFileSync(dump, 'utf8');
  assert.ok(!seen.includes('SUPER_SECRET_TOKEN'), 'hermetic env must not leak arbitrary vars');
  assert.match(seen, /FIRIA_EXECUTION_ATTEMPT_ID=/, 'the fence stamp reaches the child');
  assert.match(seen, /OATHE_DB=/, 'oathe wiring reaches the child');
});
