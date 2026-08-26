import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { workspaceRef } from '../src/workspace.mjs';

function scratchDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-ws-')));
}

test('a plain directory gets a stable ws-<12hex> ref from its realpath', () => {
  const dir = scratchDir();
  const ref = workspaceRef(dir);
  assert.match(ref, /^ws-[0-9a-f]{12}$/);
  assert.equal(workspaceRef(dir), ref);
  assert.notEqual(workspaceRef(scratchDir()), ref);
});

test('inside a git repo, every subdirectory maps to the ROOT ref', () => {
  const root = scratchDir();
  fs.mkdirSync(path.join(root, '.git'));
  const sub = path.join(root, 'a/b');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(workspaceRef(sub), workspaceRef(root));
});

test('the origin remote participates in the identity', () => {
  const a = scratchDir();
  fs.mkdirSync(path.join(a, '.git'));
  const bare = workspaceRef(a);
  fs.writeFileSync(path.join(a, '.git/config'),
    '[remote "origin"]\n\turl = git@github.com:oathe-ai/oathe.git\n');
  const withOrigin = workspaceRef(a);
  assert.notEqual(withOrigin, bare);
  assert.match(withOrigin, /^ws-[0-9a-f]{12}$/);
});
