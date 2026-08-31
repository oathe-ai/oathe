// The ONE workspace-resolution ladder: OATHE_WORKSPACE_DIR → harness project-dir env vars
// (catalog sweep) → MCP roots → cwd → typed refusal. Resolved lazily, never trusted blindly:
// an unexpanded ${...} template or a dangling path SKIPS with a diagnostic instead of crashing
// the server (the ENOENT-at-startup bug this ladder exists to kill), and a home-directory cwd
// REFUSES rather than minting a silently-wrong board.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceResolver, WorkspaceResolveError } from '../src/workspace-resolver.mjs';
import { workspaceRef } from '../src/workspace.mjs';

function scratch() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-resolve-')));
}

test('step 1: a valid OATHE_WORKSPACE_DIR wins with source OATHE_WORKSPACE_DIR', async () => {
  const dir = scratch();
  const r = new WorkspaceResolver({ env: { OATHE_WORKSPACE_DIR: dir } });
  const out = await r.resolve();
  assert.equal(out.dir, dir);
  assert.equal(out.root, dir);
  assert.equal(out.ref, workspaceRef(dir));
  assert.equal(out.source, 'OATHE_WORKSPACE_DIR');
});

test('an unexpanded ${...} template is SKIPPED with a diagnostic naming the literal — never realpathed', async () => {
  const dir = scratch();
  const r = new WorkspaceResolver({
    env: { OATHE_WORKSPACE_DIR: '${CLAUDE_PROJECT_DIR}', CLAUDE_PROJECT_DIR: dir },
  });
  const out = await r.resolve();
  assert.equal(out.dir, dir);
  assert.equal(out.source, 'CLAUDE_PROJECT_DIR');
  assert.ok(out.diagnostics.some((d) => d.includes('${CLAUDE_PROJECT_DIR}') && d.includes('OATHE_WORKSPACE_DIR')),
    `diagnostics name the skipped literal: ${JSON.stringify(out.diagnostics)}`);
});

test('a set-but-nonexistent dir is skipped with its diagnostic', async () => {
  const dir = scratch();
  const r = new WorkspaceResolver({ env: { OATHE_WORKSPACE_DIR: '/no/such/dir', CLAUDE_PROJECT_DIR: dir } });
  const out = await r.resolve();
  assert.equal(out.source, 'CLAUDE_PROJECT_DIR');
  assert.ok(out.diagnostics.some((d) => d.includes('/no/such/dir')));
});

test('step 2 sweeps the catalog env vars in order: CLAUDE_PROJECT_DIR outranks CURSOR_PROJECT_DIR', async () => {
  const a = scratch();
  const b = scratch();
  const r = new WorkspaceResolver({ env: { CLAUDE_PROJECT_DIR: a, CURSOR_PROJECT_DIR: b } });
  assert.equal((await r.resolve()).dir, a);
  const r2 = new WorkspaceResolver({ env: { CURSOR_PROJECT_DIR: b } });
  const out2 = await r2.resolve();
  assert.equal(out2.dir, b);
  assert.equal(out2.source, 'CURSOR_PROJECT_DIR');
});

test('step 3: roots are consulted only when a provider exists; first file:// root wins', async () => {
  const dir = scratch();
  let called = 0;
  const r = new WorkspaceResolver({
    env: {},
    rootsProvider: async () => { called++; return [{ uri: `file://${dir}`, name: 'ws' }]; },
    cwd: () => os.homedir(),
  });
  const out = await r.resolve();
  assert.equal(called, 1);
  assert.equal(out.dir, dir);
  assert.equal(out.source, 'roots');
});

test('a roots provider that fails or times out falls through with a diagnostic', async () => {
  const dir = scratch();
  const failing = new WorkspaceResolver({
    env: {},
    rootsProvider: async () => { throw new Error('roots exploded'); },
    cwd: () => dir,
  });
  const out = await failing.resolve();
  assert.equal(out.source, 'cwd');
  assert.ok(out.diagnostics.some((d) => d.includes('roots exploded')));

  const hanging = new WorkspaceResolver({
    env: {},
    rootsProvider: () => new Promise(() => {}),
    timeoutMs: 50,
    cwd: () => dir,
  });
  const out2 = await hanging.resolve();
  assert.equal(out2.source, 'cwd');
  assert.ok(out2.diagnostics.some((d) => /roots/.test(d) && /timed out/.test(d)));
});

test('no provider means no roots step — the diagnostic says the client offers none', async () => {
  const dir = scratch();
  const r = new WorkspaceResolver({ env: {}, cwd: () => dir });
  const out = await r.resolve();
  assert.equal(out.source, 'cwd');
});

test('step 4 refuses / and the home directory — a home-dir board is silently-wrong, not a default', async () => {
  const home = scratch();
  const r = new WorkspaceResolver({ env: {}, cwd: () => home, home });
  await assert.rejects(r.resolve(), (e) => {
    assert.ok(e instanceof WorkspaceResolveError);
    assert.equal(e.code, 'OATHE_WORKSPACE_UNRESOLVED');
    assert.ok(/home directory/.test(e.message));
    return true;
  });
  const rootR = new WorkspaceResolver({ env: {}, cwd: () => '/', home });
  await assert.rejects(rootR.resolve(), (e) => e.code === 'OATHE_WORKSPACE_UNRESOLVED');
});

test('the refusal names every input received verbatim and the fix', async () => {
  const home = scratch();
  const r = new WorkspaceResolver({
    env: { OATHE_WORKSPACE_DIR: '${CLAUDE_PROJECT_DIR}' },
    cwd: () => home,
    home,
  });
  await assert.rejects(r.resolve(), (e) => {
    assert.equal(e.code, 'OATHE_WORKSPACE_UNRESOLVED');
    assert.ok(e.message.includes('${CLAUDE_PROJECT_DIR}'), 'the unexpanded literal is named');
    assert.ok(e.message.includes(home), 'the rejected cwd is named');
    assert.ok(/OATHE_WORKSPACE_DIR/.test(e.message), 'the fix names the env var to set');
    return true;
  });
});

test('subdirectories resolve to the git root; ref matches workspaceRef', async () => {
  const root = scratch();
  fs.mkdirSync(path.join(root, '.git'));
  const sub = path.join(root, 'a/b');
  fs.mkdirSync(sub, { recursive: true });
  const r = new WorkspaceResolver({ env: { OATHE_WORKSPACE_DIR: sub } });
  const out = await r.resolve();
  assert.equal(out.dir, sub);
  assert.equal(out.root, root);
  assert.equal(out.ref, workspaceRef(root));
});

test('resolution is cached per resolver; invalidate() forces a re-consult', async () => {
  const a = scratch();
  const b = scratch();
  let dir = a;
  let consults = 0;
  const r = new WorkspaceResolver({ env: {}, cwd: () => { consults++; return dir; } });
  assert.equal((await r.resolve()).dir, a);
  dir = b;
  assert.equal((await r.resolve()).dir, a, 'cached — the source is not re-consulted');
  assert.equal(consults, 1);
  r.invalidate();
  assert.equal((await r.resolve()).dir, b);
  assert.equal(consults, 2);
});

// ---------------------------------------------------------------- R-BOARD-SCOPE: synthetic workspaces

test('a resolution knows when its directory is SYNTHETIC — a ChatGPT-desktop staging dir under ~/.codex', async () => {
  const home = scratch();
  const staging = path.join(home, '.codex/.chatgpt-projects/g-p-abc123');
  fs.mkdirSync(staging, { recursive: true });
  const synthetic = await new WorkspaceResolver({ env: { OATHE_WORKSPACE_DIR: staging }, home }).resolve();
  assert.equal(synthetic.synthetic, true);
  const real = await new WorkspaceResolver({ env: { OATHE_WORKSPACE_DIR: scratch() }, home }).resolve();
  assert.equal(real.synthetic, false);
  const sibling = path.join(home, '.codex/sessions/2026');
  fs.mkdirSync(sibling, { recursive: true });
  const notStaging = await new WorkspaceResolver({ env: { OATHE_WORKSPACE_DIR: sibling }, home }).resolve();
  assert.equal(notStaging.synthetic, false, 'only the staging dir is synthetic, not all of ~/.codex');
});

test('describe() refuses / and the home directory — the ONE refusal, shared by the ladder, the hooks, the CLI, and the writer', () => {
  const home = scratch();
  for (const dir of [home, '/']) {
    assert.throws(() => WorkspaceResolver.describe({ dir, home }), (e) => {
      assert.ok(e instanceof WorkspaceResolveError);
      assert.equal(e.code, 'OATHE_WORKSPACE_UNRESOLVED');
      assert.match(e.message, /refused/);
      return true;
    });
  }
  const project = path.join(home, 'proj');
  fs.mkdirSync(project);
  assert.equal(WorkspaceResolver.describe({ dir: project, home }).dir, project);
});
