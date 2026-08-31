#!/usr/bin/env node
// oathe — the surface canary (dev-only; not shipped). One question, asked empirically on the
// surfaces whose docs are silent: WHAT does this harness actually hand a spawned process?
// It dumps argv, cwd, the stdin payload (if piped), and the resolution-relevant env slice to
// ~/.oathe/canary/<surface>-<timestamp>.json and ALWAYS exits 0 — a probe, never a blocker.
//
// How to run it per unknown surface:
//   Cowork (the docs dispute whether plugin hooks fire at all):
//     1. add a throwaway hook entry running:  node <abs>/scripts/surface-canary.mjs --surface cowork
//     2. open one LOCAL desktop Cowork session and one CLI (`claude`) session in the same folder
//     3. diff the two dumps in ~/.oathe/canary/ — if no cowork dump appears, hooks did not fire.
//   ChatGPT desktop / Codex (hook trust re-arms on every hook change):
//     1. register the same command as a Codex hook; walk the /hooks trust flow once (CLI),
//        then check whether the Desktop app honors it (Settings → Hooks) — capture both.
//   Cursor (once wired):
//     point a sessionStart hook at `oathe doctor --surface`, or at this script for the raw dump.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { projectDirEnvVars } from '../src/harnesses/catalog.mjs';

const ENV_KEYS = ['OATHE_WORKSPACE_DIR', ...projectDirEnvVars().map(([, envVar]) => envVar),
  'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'PLUGIN_ROOT', 'PLUGIN_DATA',
  'OATHE_LAUNCHED_HARNESS', 'PATH', 'HOME', 'SHELL'];

async function readStdinIfPiped(timeoutMs = 1500) {
  if (process.stdin.isTTY) return null;
  let raw = '';
  const read = (async () => { for await (const chunk of process.stdin) raw += chunk; return raw; })();
  const timer = new Promise((resolve) => { setTimeout(() => resolve(raw), timeoutMs); });
  return Promise.race([read, timer]);
}

try {
  const surfaceAt = process.argv.indexOf('--surface');
  const surface = (surfaceAt !== -1 ? process.argv[surfaceAt + 1] : null) ?? 'unknown';
  const stdinRaw = await readStdinIfPiped();
  let payload = null;
  try { payload = stdinRaw ? JSON.parse(stdinRaw) : null; } catch { payload = { unparsed: stdinRaw }; }
  const dump = {
    surface,
    captured_at: new Date().toISOString(),
    argv: process.argv,
    cwd: process.cwd(),
    stdin_payload: payload,
    env_slice: Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k] ?? null])),
    node: process.version,
  };
  const dir = path.join(process.env.OATHE_HOME || path.join(os.homedir(), '.oathe'), 'canary');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${surface}-${Date.now()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(dump, null, 2)}\n`);
  process.stderr.write(`surface-canary: ${file}\n`);
} catch (e) {
  process.stderr.write(`surface-canary: ${String(e?.message || e)}\n`);
}
process.exit(0);
