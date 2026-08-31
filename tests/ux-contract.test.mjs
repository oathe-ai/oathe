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
