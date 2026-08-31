// R1 census (ruling §4.2): NO liveness/code path outside the vendored DDL may
// write cell.work_claim.ownership_valid_until. The horizon is set by the substrate's own
// claim verbs at claim time and moves only through authoritative database verbs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(import.meta.url), '../..');
const ROOTS = ['src', 'plugin', 'bin', 'scripts'];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && full.endsWith('.mjs')) yield full;
  }
}

test('census: no application code writes ownership_valid_until', () => {
  const writers = [];
  for (const top of ROOTS) {
    for (const file of walk(path.join(root, top))) {
      const text = fs.readFileSync(file, 'utf8');
      if (/SET\s+ownership_valid_until/i.test(text)) writers.push(path.relative(root, file));
    }
  }
  assert.deepEqual(writers, [],
    'ownership_valid_until writers found outside the DDL — session/process activity must never extend ownership');
});
