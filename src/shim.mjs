// oathe — the materialized shim: ONE durable address for the oathe bin, $HOME/.oathe/bin/oathe.
// The connection-lane ruling (launch/2026-09-04-connection-lane-plan.md): harnesses hold an
// ADDRESS, never a recipe. A bare `oathe` resolved from PATH dies in every GUI-launched
// session — launchd hands the harness /usr/bin:/bin, no nvm, no node — and a config carrying
// a raw nvm path is stranded by the next node switch. So init materializes this one address
// with the running node and package baked in (the notch-app pattern applied to the bin: what
// other supervisors run is a MATERIALIZED, oathe-home-owned artifact, re-stamped when the
// world moves, pruned only by uninstall). The plugin's static files may speak this path as
// "$HOME/.oathe/bin/oathe" (shell form) or "${userHome}/…" (cursor interpolation) — which is
// why the shim lives under HOME, the one root every dialect can name machine-independently.

import fs from 'node:fs';
import path from 'node:path';

import { sha256Hex } from './manifest.mjs';

export function shimPath(home) {
  return path.join(home, '.oathe', 'bin', 'oathe');
}

function shimBody({ execPath, packageRoot, version }) {
  const bin = path.join(packageRoot, 'bin/oathe.mjs');
  return '#!/bin/sh\n'
    + `# oathe ${version} — the durable address. Materialized by \`oathe init\`, re-stamped by\n`
    + '# every init/update (a node or package move re-writes this file, never strands it).\n'
    + '# Harness MCP entries and plugin hooks point here; edit nothing — run `oathe init`.\n'
    + `exec "${execPath}" "${bin}" "$@"\n`;
}

/**
 * Materialize (or re-stamp) the shim and record it. Byte-idempotent: an unchanged world
 * writes nothing and says so.
 * @returns {[{action: 'shim-written'|'shim-current', file: string}]}
 */
export function writeShim({ home, manifest, version, packageRoot, execPath = process.execPath }) {
  const file = shimPath(home);
  const body = shimBody({ execPath, packageRoot, version });
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const changed = current !== body;
  if (changed) {
    // The dir mode is explicit (review F8): a predictable path every harness executes must
    // never inherit a permissive umask. The write is temp-then-rename (review F6): a harness
    // spawning mid-re-stamp execs whole bytes, old or new — never a truncated script.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body, { mode: 0o755 });
    fs.renameSync(tmp, file);
  }
  fs.chmodSync(file, 0o755); // a pre-existing file keeps its old mode through the rename path
  // One shim, ONE row (review F1): row identity keys on the full detail, so a node/package
  // move would otherwise mint a second row and doctor would cry user-edited forever on the
  // very nvm-switcher machines this lane serves. A re-stamp replaces.
  manifest.removeWhere((r) => r.kind === 'oathe-shim');
  manifest.upsert({
    harness: 'shim',
    file,
    kind: 'oathe-shim',
    detail: { execPath, packageRoot },
    blockVersion: version,
    sha256: sha256Hex(body),
  });
  return [{ action: changed ? 'shim-written' : 'shim-current', file }];
}

/**
 * Terminate this user's live MCP servers. After an update replaced the tree every running
 * instance serves stale modules; through an uninstall it loses its floor entirely and answers
 * every speech act with raw ENOENT (measured 2026-09-03). "Just get rid of it for them"
 * (founder, 2026-09-04): sweep them; harnesses respawn a fresh server from the shim. The
 * pattern matches both spawn shapes — the shim's `node …/bin/oathe.mjs mcp` and the legacy
 * bare `…/bin/oathe mcp` — and deliberately not `oathe notch --serve`, whose launchd job has
 * its own restart story (0.4.4).
 */
export function sweepMcpServers({ exec }) {
  const uid = process.getuid?.();
  // The pattern cannot match the sweeping process itself: our own cmdline ends in `update`
  // or `uninstall`, never ` mcp`.
  const pgrepArgs = [...(uid === undefined ? [] : ['-u', String(uid)]), '-f', '[/]oathe(\\.mjs)? mcp$'];
  const found = exec.run('pgrep', pgrepArgs);
  // pgrep speaks in exit codes: 1 is "nothing matched"; anything else is "could not look" —
  // and a founder-mandated sweep that cannot look must say so, never shrug (review F4).
  if (found.status === 1) return [{ action: 'mcp-sweep-none' }];
  if (found.status !== 0) {
    return [{ action: 'mcp-sweep-failed', detail: String(found.stderr ?? '').trim().split('\n').at(-1) ?? `pgrep exit ${found.status}` }];
  }
  const pids = found.stdout.split('\n').map((s) => s.trim()).filter(Boolean).map(Number);
  if (pids.length === 0) return [{ action: 'mcp-sweep-none' }];
  for (const pid of pids) {
    // One kill per pid: a target that exited between pgrep and kill (the natural race) must
    // not fail its siblings' sweep (review F5).
    exec.run('kill', [String(pid)]); // result unread: the recheck pgrep below is the read — survivors, not exit codes, are the truth
  }
  const recheck = exec.run('pgrep', pgrepArgs);
  const survivors = recheck.status === 0
    ? recheck.stdout.split('\n').map((s) => s.trim()).filter(Boolean).map(Number)
    : [];
  if (survivors.length > 0) return [{ action: 'mcp-sweep-partial', pids, survivors }];
  return [{ action: 'mcp-swept', pids }];
}

/** Remove exactly what was recorded; absence is a stated action, never silence. */
export function unwireShim({ manifest }) {
  const rows = manifest.removeWhere((r) => r.kind === 'oathe-shim');
  if (rows.length === 0) return [{ action: 'shim-absent' }];
  const actions = [];
  for (const row of rows) {
    fs.rmSync(row.file, { force: true });
    actions.push({ action: 'shim-removed', file: row.file });
  }
  return actions;
}
