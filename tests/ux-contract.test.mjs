// The docs hold the tree: docs/UX.md is the UX contract and every rule in it names the test
// that holds it; PRODUCT.md §3 names every file a wiring adapter says init writes. A rule
// without a test, or a write the handoff does not mention, fails here — the gap is visible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildContext } from '../src/context.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('docs/UX.md: every rule is held by a named, existing test file — a rule nobody tests is not a rule', () => {
  const ux = fs.readFileSync(path.join(root, 'docs/UX.md'), 'utf8');
  // A rule is its numbered line plus the indented continuation lines under it; a blank line
  // or a heading closes it. Bullets under "Words" are vocabulary, not rules.
  const rules = [];
  let open = false;
  for (const line of ux.split('\n')) {
    if (/^\d+\.\s/.test(line)) { rules.push(line); open = true; }
    else if (open && /^\s+\S/.test(line)) rules[rules.length - 1] += ` ${line.trim()}`;
    else open = false;
  }
  assert.ok(rules.length >= 10, `the contract lists its rules as a numbered list (found ${rules.length})`);
  for (const rule of rules) {
    const held = rule.match(/held by `([^`]+)`/);
    assert.ok(held, `rule has a "held by" pointer: ${rule.slice(0, 80)}`);
    for (const file of held[1].split(',').map((f) => f.trim())) {
      assert.ok(fs.existsSync(path.join(root, file)), `${file} exists (cited by: ${rule.slice(0, 60)})`);
    }
  }
  assert.doesNotMatch(ux, /\[\d+\]/, 'the contract itself shows no numbered menu');
  assert.ok(rules.length >= 20, `the breach rules (17–20) are in the contract (found ${rules.length})`);
});

test('UX rule 16 applied: the copy promises what the code does — verify blocks on its verdict, the handoff names the digest', () => {
  const verify = fs.readFileSync(path.join(root, 'plugin/commands/verify.md'), 'utf8');
  assert.match(verify, /verdict/, 'the command copy names the verdict the call returns');
  assert.doesNotMatch(verify, /returns immediately/, 'the seam blocks and answers; the copy must not say it returns immediately');
  const product = fs.readFileSync(path.join(root, 'docs/PRODUCT.md'), 'utf8');
  assert.match(product, /BreachDigest/, 'the handoff names the one budget');
  assert.match(product, /\+N more/, 'and the pull pointer');
  assert.match(product, /src\/notch-frame\.mjs/, 'and the frame builder');
});

test('UX rule 16 applied to the trust boundary (ruling 2026-09-04): the copy says what is measured and what is taken on the forwarder\'s word — never that identity is not client-asserted', () => {
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { recursive: true })
    .filter((f) => /\.(mjs|md)$/.test(f)).map((f) => path.join(root, dir, f));
  for (const file of [...walk('src'), ...walk('docs'), ...walk('plugin')]) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /never client-asserted|asserts nothing the daemon cannot check|never taken on the client's word/,
      `${path.relative(root, file)}: the starting pid IS the client's word — the copy may not say otherwise`);
  }
  const privacy = fs.readFileSync(path.join(root, 'docs/PRIVACY.md'), 'utf8');
  assert.match(privacy, /unix socket/, 'PRIVACY names the daemon and its socket');
  assert.match(privacy, /0600/, 'and the permission that IS the boundary');
  assert.match(privacy, /device\.json/, 'and the device identity file');
  assert.doesNotMatch(privacy, /no telemetry, no server/, 'there is a local server now — the sentence must say so');
});

test('PRODUCT.md §3 names every file a wiring adapter says init writes — the handoff cannot lag describe()', async () => {
  const product = fs.readFileSync(path.join(root, 'docs/PRODUCT.md'), 'utf8');
  const section3 = product.slice(product.indexOf('\n## 3.'), product.indexOf('\n## 4.'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-ux-'));
  for (const d of ['.claude', '.codex', '.cursor']) fs.mkdirSync(path.join(home, d));
  const ctx = buildContext({ env: { HOME: home, OATHE_HOME: path.join(home, '.oathe'), PATH: path.dirname(process.execPath) } });
  await ctx.substrate.close();
  for (const adapter of ctx.harnesses.filter((h) => h.constructor.wiring !== null)) {
    for (const line of adapter.describe()) {
      const files = [...line.matchAll(/~?\/[^\s:,()]+\.(?:json|toml|md)/g)].map((m) => path.basename(m[0]));
      const own = files.filter((f) => line.includes(path.join(home, '')) || line.includes('~/'));
      for (const file of own) {
        assert.ok(section3.includes(file), `${adapter.name}: §3 names ${file} (from: ${line.slice(0, 70)})`);
      }
    }
  }
});
