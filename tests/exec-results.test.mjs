// oathe — the rule that shipped 0.4.3 without a notch, executed (rules become gates):
// EVERY result of a process the code runs is READ. `launchctl bootstrap` was called as a bare
// statement in wireNotch; its refusal (5: Input/output error — bootout is asynchronous) went
// unread, and every re-wire left the notch unloaded until the next login, silently. A result
// the code chooses not to act on is still SAID: the statement carries a trailing
// `// result unread: <why>` on the same line, and this test lists every one of those choices so
// a reviewer reads the reason, never the absence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = ['src', 'bin', 'plugin/hooks', 'scripts'];
const BARE = /^\s*(?:[A-Za-z_$][\w$]*\.)?(?:exec\.run|run|spawnSync|execSync|execFileSync)\((?!.*\/\/ result unread: \S)/;

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') yield* files(p); }
    else if (/\.mjs$/.test(entry.name)) yield p;
  }
}

test('no process result is discarded: every bare exec.run/spawnSync statement carries `// result unread: <why>` (the unread launchctl bootstrap of 0.4.3)', () => {
  const offenders = [];
  const accepted = [];
  for (const dir of SCAN) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of files(abs)) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(?:[A-Za-z_$][\w$]*\.)?(?:exec\.run|spawnSync|execSync|execFileSync)\(/.test(line)) {
          const where = `${path.relative(ROOT, file)}:${i + 1}`;
          if (BARE.test(line)) offenders.push(`${where}: ${line.trim()}`);
          else accepted.push(where);
        }
      });
    }
  }
  assert.deepEqual(offenders, [], `a process was run and its answer thrown away:\n${offenders.join('\n')}`);
  // The accepted list is the review surface: a new entry here is a conscious choice, read in the diff.
  assert.deepEqual(accepted.sort(), [
    'src/harnesses/codex.mjs:198',
    'src/notch.mjs:137',
    'src/notch.mjs:152',
    'src/notch.mjs:188',
  ]);
});
