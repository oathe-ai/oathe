import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FencedBlock, JsonEntries, FENCE_STYLES } from '../src/blocks.mjs';

// ---------------------------------------------------------------- text fences

test('hash-style fence renders the estate convention: >>> oathe v<version> >>> … <<< oathe <<<', () => {
  const block = new FencedBlock({ style: FENCE_STYLES.hash });
  const text = block.render('0.1.0', 'board = true');
  assert.match(text, /^# >>> oathe v0\.1\.0 >>>\n/);
  assert.match(text, /\n# <<< oathe <<<$/);
  assert.match(text, /\nboard = true\n/);
});

test('html-style fence wraps markers in HTML comments for CLAUDE.md/AGENTS.md', () => {
  const block = new FencedBlock({ style: FENCE_STYLES.html });
  const text = block.render('0.1.0', '## Oathe\nrun `oathe` tools for claims');
  assert.match(text, /^<!-- >>> oathe v0\.1\.0 >>> -->\n/);
  assert.match(text, /\n<!-- <<< oathe <<< -->$/);
});

test('apply appends the fence to content that has none, separated by a blank line', () => {
  const block = new FencedBlock({ style: FENCE_STYLES.hash });
  const { content, changed } = block.apply('existing = 1\n', { version: '0.1.0', body: 'x = 2' });
  assert.equal(changed, true);
  assert.equal(content, 'existing = 1\n\n# >>> oathe v0.1.0 >>>\nx = 2\n# <<< oathe <<<\n');
});

test('apply on empty content produces just the fence', () => {
  const block = new FencedBlock({ style: FENCE_STYLES.html });
  const { content } = block.apply('', { version: '0.1.0', body: '## Oathe' });
  assert.equal(content, '<!-- >>> oathe v0.1.0 >>> -->\n## Oathe\n<!-- <<< oathe <<< -->\n');
});

test('apply replaces ONLY its own block and never touches content outside the fences', () => {
  const block = new FencedBlock({ style: FENCE_STYLES.hash });
  const v1 = block.apply('above = 1\n', { version: '0.1.0', body: 'old' }).content;
  const withBelow = `${v1}below = 2\n`;
  const { content, changed } = block.apply(withBelow, { version: '0.2.0', body: 'new' });
  assert.equal(changed, true);
  assert.ok(content.startsWith('above = 1\n'));
  assert.ok(content.includes('below = 2\n'));
  assert.ok(content.includes('# >>> oathe v0.2.0 >>>\nnew\n# <<< oathe <<<'));
  assert.ok(!content.includes('old'));
  assert.ok(!content.includes('v0.1.0'));
});

test('apply is byte-idempotent: applying the same version+body twice changes nothing', () => {
  const block = new FencedBlock({ style: FENCE_STYLES.hash });
  const once = block.apply('a = 1\n', { version: '0.1.0', body: 'x' });
  const twice = block.apply(once.content, { version: '0.1.0', body: 'x' });
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once.content);
});

test('read reports presence, version, and the exact block text for manifest hashing', () => {
  const block = new FencedBlock({ style: FENCE_STYLES.hash });
  assert.deepEqual(block.read('no fence here\n'), { present: false, version: null, body: null, blockText: null });
  const applied = block.apply('', { version: '0.3.1', body: 'line1\nline2' }).content;
  const seen = block.read(applied);
  assert.equal(seen.present, true);
  assert.equal(seen.version, '0.3.1');
  assert.equal(seen.body, 'line1\nline2');
  assert.equal(seen.blockText, block.render('0.3.1', 'line1\nline2'));
});

test('remove deletes exactly the fence (and its separating blank line) and is idempotent', () => {
  const block = new FencedBlock({ style: FENCE_STYLES.hash });
  const original = 'above = 1\n';
  const applied = block.apply(original, { version: '0.1.0', body: 'x' }).content;
  const removed = block.remove(applied);
  assert.equal(removed.changed, true);
  assert.equal(removed.content, original);
  const again = block.remove(removed.content);
  assert.equal(again.changed, false);
});

test('a second fence in the same file is refused loudly rather than half-edited', () => {
  const block = new FencedBlock({ style: FENCE_STYLES.hash });
  const one = block.render('0.1.0', 'a');
  const doubled = `${one}\n${one}\n`;
  assert.throws(() => block.apply(doubled, { version: '0.2.0', body: 'b' }), /duplicate/i);
});

// ---------------------------------------------------------------- JSON entries

test('JsonEntries sets owned paths in a JSON document and leaves everything else alone', () => {
  const engine = new JsonEntries();
  const source = JSON.stringify({ theme: 'dark', enabledPlugins: { 'other@mp': true } }, null, 2);
  const { content, changed } = engine.apply(source, [
    { path: ['extraKnownMarketplaces', 'oathe'], value: { source: { source: 'local', path: '/pkg' } } },
    { path: ['enabledPlugins', 'oathe@oathe'], value: true },
  ]);
  assert.equal(changed, true);
  const parsed = JSON.parse(content);
  assert.equal(parsed.theme, 'dark');
  assert.equal(parsed.enabledPlugins['other@mp'], true);
  assert.equal(parsed.enabledPlugins['oathe@oathe'], true);
  assert.deepEqual(parsed.extraKnownMarketplaces.oathe, { source: { source: 'local', path: '/pkg' } });
});

test('JsonEntries apply is byte-idempotent', () => {
  const engine = new JsonEntries();
  const entries = [{ path: ['a', 'b'], value: 1 }];
  const once = engine.apply('{}', entries);
  const twice = engine.apply(once.content, entries);
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once.content);
});

test('JsonEntries apply on an empty/absent file starts from an empty object', () => {
  const engine = new JsonEntries();
  const { content } = engine.apply('', [{ path: ['k'], value: 'v' }]);
  assert.deepEqual(JSON.parse(content), { k: 'v' });
});

test('JsonEntries read returns the value at a path, or undefined', () => {
  const engine = new JsonEntries();
  const doc = JSON.stringify({ a: { b: 42 } });
  assert.equal(engine.read(doc, ['a', 'b']), 42);
  assert.equal(engine.read(doc, ['a', 'missing']), undefined);
});

test('JsonEntries remove deletes owned paths, prunes emptied parents it created, and is idempotent', () => {
  const engine = new JsonEntries();
  const source = JSON.stringify({ theme: 'dark' }, null, 2);
  const applied = engine.apply(source, [
    { path: ['extraKnownMarketplaces', 'oathe'], value: { x: 1 } },
    { path: ['enabledPlugins', 'oathe@oathe'], value: true },
  ]).content;
  const removed = engine.remove(applied, [
    ['extraKnownMarketplaces', 'oathe'],
    ['enabledPlugins', 'oathe@oathe'],
  ]);
  assert.equal(removed.changed, true);
  const parsed = JSON.parse(removed.content);
  assert.equal(parsed.theme, 'dark');
  assert.equal('extraKnownMarketplaces' in parsed, false);
  assert.equal('enabledPlugins' in parsed, false);
  const again = engine.remove(removed.content, [['extraKnownMarketplaces', 'oathe']]);
  assert.equal(again.changed, false);
});

test('JsonEntries remove keeps a parent that still holds keys others own', () => {
  const engine = new JsonEntries();
  const source = JSON.stringify({ enabledPlugins: { 'other@mp': true } }, null, 2);
  const applied = engine.apply(source, [{ path: ['enabledPlugins', 'oathe@oathe'], value: true }]).content;
  const removed = engine.remove(applied, [['enabledPlugins', 'oathe@oathe']]);
  const parsed = JSON.parse(removed.content);
  assert.deepEqual(parsed.enabledPlugins, { 'other@mp': true });
});

test('JsonEntries refuses a file that is not valid JSON rather than clobbering it', () => {
  const engine = new JsonEntries();
  assert.throws(() => engine.apply('{ not json', [{ path: ['k'], value: 1 }]), /json/i);
});
