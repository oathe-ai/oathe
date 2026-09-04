// oathe — `oathe update`: the documented upgrade (`npm i -g @oathe/oathe@latest && oathe init`)
// as one verb, on the founder's word (2026-09-03). Pinned here: the npm it calls is the one
// BESIDE the node running this bin (never PATH's — an nvm machine's PATH can lead to another
// node's npm, the trap that bit the 0.4.1 trial); init runs through the NEW bin (this process
// still holds the old modules); a checkout is refused typed (it updates by git); npm's failure
// is a typed refusal carrying npm's own last word.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runUpdate, UpdateError } from '../src/update.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'oathe.mjs');

/** A fake npm prefix: <prefix>/bin/{node,npm,oathe} and <prefix>/lib/node_modules/@oathe/oathe. */
function globalInstall({ version = '0.4.1' } = {}) {
  const prefix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-update-')));
  const packageRoot = path.join(prefix, 'lib', 'node_modules', '@oathe', 'oathe');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@oathe/oathe', version }));
  return { prefix, packageRoot, execPath: path.join(prefix, 'bin', 'node') };
}

/** An exec seam that records every call; `onInstall` plays npm's part (rewrites package.json). */
function fakeExec({ rootG, prefixG = path.dirname(path.dirname(rootG)), onInstall = () => ({ status: 0, stdout: 'changed 15 packages in 1s\n', stderr: '' }) }) {
  const calls = [];
  return {
    calls,
    run(cmd, args) {
      calls.push([cmd, args]);
      if (args[0] === 'root' && args[1] === '-g') return { status: 0, stdout: `${rootG}\n`, stderr: '' };
      if (args[0] === 'prefix' && args[1] === '-g') return { status: 0, stdout: `${prefixG}\n`, stderr: '' };
      if (args[0] === 'i' && args[1] === '-g') return onInstall();
      return { status: 1, stdout: '', stderr: `unexpected: ${cmd} ${args.join(' ')}` };
    },
  };
}

test('update installs @latest through the npm BESIDE this node, then runs init through the NEW bin with the caller\'s flags', () => {
  const { prefix, packageRoot, execPath } = globalInstall({ version: '0.4.1' });
  const exec = fakeExec({
    rootG: path.join(prefix, 'lib', 'node_modules'),
    onInstall: () => {
      fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@oathe/oathe', version: '0.4.2' }));
      return { status: 0, stdout: 'changed 15 packages in 1s\n', stderr: '' };
    },
  });
  const handoffs = [];
  const lines = [];
  const out = runUpdate({
    packageRoot, execPath, exec, args: ['--yes'],
    handoff: (bin, args) => { handoffs.push([bin, args]); return { status: 0 }; },
    out: { write: (s) => lines.push(s) },
  });
  assert.equal(out.before, '0.4.1');
  assert.equal(out.after, '0.4.2');
  assert.deepEqual(exec.calls[0], [path.join(prefix, 'bin', 'npm'), ['root', '-g']], 'the sibling npm, never PATH\'s');
  assert.ok(exec.calls.some(([, a]) => a[0] === 'i' && a[1] === '-g' && a[2] === '@oathe/oathe@latest'), 'the install, through the same npm');
  assert.ok(exec.calls.every(([cmd]) => cmd === path.join(prefix, 'bin', 'npm')), 'every npm call is the sibling npm');
  assert.deepEqual(handoffs, [[path.join(prefix, 'bin', 'oathe'), ['init', '--yes']]], 'init runs through the new bin, flags passed through');
  assert.match(lines.join(''), /0\.4\.1 → 0\.4\.2/, 'the version before and after is said');
});

test('an oathe that is not npm\'s global install is refused typed — a checkout updates by git, and nothing runs', () => {
  const { prefix, execPath } = globalInstall();
  const checkout = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-checkout-')));
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: '@oathe/oathe', version: '0.4.1' }));
  const exec = fakeExec({ rootG: path.join(prefix, 'lib', 'node_modules') });
  const handoffs = [];
  assert.throws(() => runUpdate({ packageRoot: checkout, execPath, exec, handoff: (...a) => { handoffs.push(a); return { status: 0 }; }, out: { write() {} } }), (e) => {
    assert.ok(e instanceof UpdateError);
    assert.equal(e.code, 'OATHE_UPDATE_NOT_GLOBAL');
    assert.match(e.message, /refused/);
    assert.match(e.message, /npm i -g @oathe\/oathe@latest/, 'names the way in for a published install');
    return true;
  });
  assert.equal(exec.calls.length, 1, 'only `npm root -g` ran');
  assert.deepEqual(handoffs, [], 'init never ran');
});

test('npm failing is a typed refusal carrying npm\'s last word, and init never runs', () => {
  const { prefix, packageRoot, execPath } = globalInstall();
  const exec = fakeExec({
    rootG: path.join(prefix, 'lib', 'node_modules'),
    onInstall: () => ({ status: 1, stdout: '', stderr: 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org failed\n' }),
  });
  const handoffs = [];
  assert.throws(() => runUpdate({ packageRoot, execPath, exec, handoff: (...a) => { handoffs.push(a); return { status: 0 }; }, out: { write() {} } }), (e) => {
    assert.equal(e.code, 'OATHE_UPDATE_FAILED');
    assert.match(e.message, /network request to https:\/\/registry\.npmjs\.org failed/);
    return true;
  });
  assert.deepEqual(handoffs, []);
});

test('the bin wires the verb: from a checkout, `oathe update` is the typed refusal with the refused trailer, and usage names it', () => {
  const usage = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.match(usage.stderr, /^\s+update \[--yes\]/m, 'usage lists the verb');
  const out = spawnSync(process.execPath, [BIN, 'update'], { encoding: 'utf8' });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /\[OATHE_UPDATE_NOT_GLOBAL\]/);
  assert.match(out.stderr, /oathe: update refused/);
});

test("a custom npm prefix (npm config set prefix …): the package lands under npm's prefix, and so does the bin init runs through — never beside node (Greptile P1 on #33)", () => {
  // node lives in one place (an nvm dir); npm's global prefix is elsewhere (~/.npm-global).
  const nodeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-node-')));
  fs.mkdirSync(path.join(nodeHome, 'bin'), { recursive: true });
  const { prefix, packageRoot } = globalInstall({ version: '0.4.1' });
  const exec = fakeExec({
    rootG: path.join(prefix, 'lib', 'node_modules'), prefixG: prefix,
    onInstall: () => {
      fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@oathe/oathe', version: '0.4.2' }));
      return { status: 0, stdout: 'changed 15 packages in 1s\n', stderr: '' };
    },
  });
  const handoffs = [];
  const out = runUpdate({
    packageRoot, execPath: path.join(nodeHome, 'bin', 'node'), exec, args: [],
    handoff: (bin, args) => { handoffs.push([bin, args]); return { status: 0 }; },
    out: { write() {} },
  });
  assert.equal(out.after, '0.4.2');
  assert.ok(exec.calls.every(([cmd]) => cmd === path.join(nodeHome, 'bin', 'npm')), 'npm is still the one beside node — npm ships with node');
  assert.deepEqual(handoffs, [[path.join(prefix, 'bin', 'oathe'), ['init']]], "init runs through the bin under npm's prefix, where the install landed");
});

test('update ends with the word the person needs: the version that is live now and the notch launchd runs — or that it does not', () => {
  const { prefix, packageRoot, execPath } = globalInstall({ version: '0.4.1' });
  const exec = fakeExec({
    rootG: path.join(prefix, 'lib', 'node_modules'),
    onInstall: () => {
      fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@oathe/oathe', version: '0.4.4' }));
      return { status: 0, stdout: 'changed 15 packages in 1s\n', stderr: '' };
    },
  });
  const lines = [];
  const up = runUpdate({
    packageRoot, execPath, exec, handoff: () => ({ status: 0 }), out: { write: (s) => lines.push(s) },
    notch: () => ({ label: 'ai.oathe.notch.x', loaded: true, pid: 31337 }),
  });
  assert.deepEqual(up.notch, { label: 'ai.oathe.notch.x', loaded: true, pid: 31337 });
  assert.match(lines.at(-1), /^update successful — oathe v0\.4\.4 · notch running \(pid 31337\)\n$/);

  const down = [];
  const dn = runUpdate({
    packageRoot, execPath, exec, handoff: () => ({ status: 0 }), out: { write: (s) => down.push(s) },
    notch: () => ({ label: 'ai.oathe.notch.x', loaded: false, pid: null }),
  });
  assert.equal(dn.notch.loaded, false);
  assert.match(down.at(-1), /^update installed oathe v0\.4\.4 — but the notch is NOT running/, 'a dead notch is never folded into "successful"');

  const none = [];
  const off = runUpdate({ packageRoot, execPath, exec, handoff: () => ({ status: 0 }), out: { write: (s) => none.push(s) }, notch: () => null });
  assert.equal(off.notch, null, 'off darwin there is no notch to report');
  assert.match(none.at(-1), /^update successful — oathe v0\.4\.4\n$/);
});
