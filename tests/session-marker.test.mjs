// The launched-session marker: the harness-agnostic transport for the opt-in and its wiring
// (Codex builds MCP child environments from config, so the launcher's env block dies at that
// boundary — found live on 2026-08-26 when a real `oathe codex` session's yield was refused
// OATHE_NOT_LAUNCHED).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeSessionMarker, clearSessionMarker, liveSessionMarker } from '../src/launch-env.mjs';
import { withLaunchGate } from '../src/mcp/oathe-tools.mjs';

const WS = 'ws-abcabcabcabc';

test('a LIVE marker carries harness and wiring back across a stripped-env boundary', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-marker-'));
  try {
    const file = writeSessionMarker({
      oatheHome: home, workspace: WS, harness: 'codex', cwd: '/w',
      wiring: { OATHE_DB: 'oathe_local', OATHE_PRINCIPAL: 'founder' },
    });
    const marker = liveSessionMarker({ oatheHome: home, workspace: WS });
    assert.equal(marker.harness, 'codex');
    assert.equal(marker.wiring.OATHE_PRINCIPAL, 'founder', 'identity rides the marker, not luck');
    clearSessionMarker(file);
    assert.equal(liveSessionMarker({ oatheHome: home, workspace: WS }), null, 'teardown retires it');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a DEAD supervisor makes the marker inert — and it is retired on sight', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-marker-dead-'));
  try {
    const file = writeSessionMarker({
      oatheHome: home, workspace: WS, harness: 'codex', cwd: '/w', pid: 2 ** 31 - 5 });
    assert.equal(liveSessionMarker({ oatheHome: home, workspace: WS }), null,
      'a marker whose launcher died must not open the board');
    assert.equal(fs.existsSync(file), false, 'stale markers are cleaned, not accumulated');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the gate honors env, honors the marker verdict, and refuses TYPED otherwise', async () => {
  const tools = { oathe_yield: async () => 'ok' };
  assert.equal(await withLaunchGate(tools, { OATHE_LAUNCHED_HARNESS: 'claude' }).oathe_yield(), 'ok');
  assert.equal(await withLaunchGate(tools, {}, { launched: true }).oathe_yield(), 'ok');
  await assert.rejects(() => withLaunchGate(tools, {}, { launched: false }).oathe_yield(),
    (e) => e.code === 'OATHE_NOT_LAUNCHED');
});
