// oathe — the machine surface is ONE map (zero legacy, founder 2026-09-05): every manifest kind a
// writer records has a doctor verifier and an undo, and docs/PRODUCT.md §3 lists exactly those
// kinds. A kind added to one place without the others fails here — rules become gates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERIFIERS } from '../src/doctor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const srcFiles = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? srcFiles(path.join(dir, e.name)) : e.name.endsWith('.mjs') ? [path.join(dir, e.name)] : []));
const src = srcFiles('src').map((f) => read(f)).join('\n');

test('every kind the doctor verifies is written by some writer, undone by some remover, and listed in PRODUCT §3 — and nothing else is', () => {
  const kinds = Object.keys(VERIFIERS).sort();
  const written = kinds.filter((k) => src.includes(`kind: '${k}'`) || src.includes(`CLI_ADDRESS_KIND`) && k === 'cli-address');
  assert.deepEqual(written, kinds, 'a verifier for a kind nobody writes is dead code');
  // Undo: adapter-owned kinds leave with takeWiringRows (offboard); the rest are removed by name.
  const adapterOwned = new Set(['json-path', 'cli-managed', 'json-array']);
  for (const k of kinds) {
    assert.ok(adapterOwned.has(k) || src.includes(`r.kind === '${k}'`), `${k}: some remover names it`);
  }
  const doc = read('docs/PRODUCT.md');
  const section = doc.split('## The machine surface')[1]?.split('\n## ')[0] ?? '';
  const listed = [...section.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(listed, kinds, 'PRODUCT §3 "The machine surface" lists exactly the kinds the doctor knows');
});
