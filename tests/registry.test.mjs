// The central workspace registry (~/.oathe/workspaces.json): the one machine-wide record of
// which folders carry a board. Hooks, the MCP server, CLI verbs, and launchers all upsert it;
// the picker and doctor read it. Registration is idempotent and concurrency-safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkspaceRegistry, RegistryError } from '../src/registry.mjs';
import { workspaceRef } from '../src/workspace.mjs';

function scratch(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function fixture() {
  const home = scratch('oathe-reg-home-');
  const registryPath = path.join(home, '.oathe/workspaces.json');
  const root = scratch('oathe-reg-ws-');
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'sub/dir'), { recursive: true });
  const clockValues = ['2026-08-28T10:00:00.000Z', '2026-08-28T11:00:00.000Z', '2026-08-28T12:00:00.000Z'];
  let tick = 0;
  const registry = new WorkspaceRegistry({ registryPath, clock: () => clockValues[Math.min(tick++, 2)] });
  return { registryPath, root, registry };
}

test('register() creates workspaces.json with format 1 and the full row shape', async () => {
  const { registryPath, root, registry } = fixture();
  const row = await registry.register({ cwd: root, source: 'hook:session-start', harness: 'claude' });
  const doc = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.equal(doc.format, 1);
  const ref = workspaceRef(root);
  assert.equal(row.ref, ref);
  assert.deepEqual(doc.workspaces[ref], {
    root,
    identity: `git:${root}|origin:`,
    registered_at: '2026-08-28T10:00:00.000Z',
    registered_by: 'hook:session-start',
    last_seen_at: '2026-08-28T10:00:00.000Z',
    harnesses_seen: { claude: '2026-08-28T10:00:00.000Z' },
    fences: {},
    workspace_config: false,
  });
});

test('register() from a subdirectory collapses to the git root — same ref, root realpath', async () => {
  const { root, registry } = fixture();
  const row = await registry.register({ cwd: path.join(root, 'sub/dir'), source: 'mcp:oathe_claim' });
  assert.equal(row.ref, workspaceRef(root));
  assert.equal(registry.get(row.ref).root, root);
});

test('re-register updates last_seen_at and harnesses_seen only; first-writer facts stay', async () => {
  const { root, registry } = fixture();
  const first = await registry.register({ cwd: root, source: 'hook:session-start', harness: 'claude' });
  const second = await registry.register({ cwd: root, source: 'mcp:oathe_board', harness: 'codex' });
  assert.equal(second.ref, first.ref);
  const row = registry.get(first.ref);
  assert.equal(row.registered_at, '2026-08-28T10:00:00.000Z');
  assert.equal(row.registered_by, 'hook:session-start');
  assert.equal(row.last_seen_at, '2026-08-28T11:00:00.000Z');
  assert.deepEqual(row.harnesses_seen, {
    claude: '2026-08-28T10:00:00.000Z',
    codex: '2026-08-28T11:00:00.000Z',
  });
});

test('workspace_config reflects <root>/.oathe.json presence at each register', async () => {
  const { root, registry } = fixture();
  const { ref } = await registry.register({ cwd: root, source: 'cli:claim' });
  assert.equal(registry.get(ref).workspace_config, false);
  fs.writeFileSync(path.join(root, '.oathe.json'), '{}\n');
  await registry.register({ cwd: root, source: 'cli:claim' });
  assert.equal(registry.get(ref).workspace_config, true);
});

test('recordFence stamps the written file version on the row', async () => {
  const { root, registry } = fixture();
  const { ref } = await registry.register({ cwd: root, source: 'launcher:preflight' });
  await registry.recordFence(ref, 'CLAUDE.md', '0.3.0');
  assert.deepEqual(registry.get(ref).fences, { 'CLAUDE.md': '0.3.0' });
});

test('list() renders every row with its ref; get() of an unknown ref is null', async () => {
  const { root, registry } = fixture();
  await registry.register({ cwd: root, source: 'cli:ls' });
  const rows = registry.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ref, workspaceRef(root));
  assert.equal(registry.get('ws-000000000000'), null);
});

test('two concurrent register() calls from separate processes both land — no lost update', async () => {
  const { registryPath } = fixture();
  const wsA = scratch('oathe-reg-a-');
  const wsB = scratch('oathe-reg-b-');
  const child = `
    import { WorkspaceRegistry } from ${JSON.stringify(fileURLToPath(new URL('../src/registry.mjs', import.meta.url)))};
    const [registryPath, cwd, source] = process.argv.slice(1);
    await new WorkspaceRegistry({ registryPath }).register({ cwd, source });
  `;
  const run = (cwd, source) => new Promise((resolve) => {
    spawn(process.execPath, ['--input-type=module', '-e', child, registryPath, cwd, source])
      .on('exit', resolve);
  });
  const codes = await Promise.all([run(wsA, 'cli:a'), run(wsB, 'cli:b')]);
  assert.deepEqual(codes, [0, 0]);
  const doc = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.equal(Object.keys(doc.workspaces).length, 2, 'both concurrent registrations landed');
});

test('a malformed registry file refuses loudly with OATHE_REGISTRY_MALFORMED naming the file', async () => {
  const { registryPath, root, registry } = fixture();
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, 'not json{');
  await assert.rejects(
    registry.register({ cwd: root, source: 'cli:claim' }),
    (e) => e instanceof RegistryError && e.code === 'OATHE_REGISTRY_MALFORMED'
      && e.message.includes(registryPath),
  );
});
