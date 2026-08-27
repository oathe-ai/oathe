// oathe — the launched-session contract. The plugin installs at USER scope, so its hooks and
// MCP server reach every session on the machine; only a session started by `oathe <harness>`
// has opted into the board. The launcher stamps that opt-in into the caged child's environment,
// and everything plugin-side asks ONE predicate before touching the substrate. Named once here:
// the launcher writes the block, the hooks and the server read it.

import fs from 'node:fs';
import path from 'node:path';

export const LAUNCHED_HARNESS_ENV = 'OATHE_LAUNCHED_HARNESS';

// The env marker crosses the cage boundary for harnesses that pass their environment to MCP
// children (Claude Code). Codex builds MCP child environments from its own config, so the
// marker dies at that boundary — the SESSION MARKER FILE is the harness-agnostic transport:
// the launcher writes <oatheHome>/launched/<workspace>.<pid>.json while it supervises, the
// gate honors any marker for its workspace whose supervisor is still alive, and teardown
// (or the supervisor dying) retires it. Stale markers fail the liveness probe and are inert.

export function sessionMarkerPath(oatheHome, workspace, pid = process.pid) {
  return path.join(oatheHome, 'launched', `${workspace}.${pid}.json`);
}

/** @returns {string} the marker file path (hand it to clearSessionMarker at teardown).
 *  `wiring` is the launchSessionEnv block: harnesses that strip the environment on the way
 *  to their MCP children (Codex) get it back from here, identity included. */
export function writeSessionMarker({ oatheHome, workspace, harness, cwd, wiring = {}, pid = process.pid }) {
  const file = sessionMarkerPath(oatheHome, workspace, pid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    harness, supervisor_pid: pid, cwd, wiring, started_at: new Date().toISOString(),
  })}\n`);
  return file;
}

export function clearSessionMarker(file) {
  fs.rmSync(file, { force: true });
}

/** The full LIVE launch marker for this workspace ({harness, wiring, …}), or null.
 *  Dead and unreadable markers are retired on sight. */
export function liveSessionMarker({ oatheHome, workspace }) {
  const dir = path.join(oatheHome, 'launched');
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const name of names) {
    if (!name.startsWith(`${workspace}.`) || !name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
      process.kill(marker.supervisor_pid, 0); // throws when the supervisor is gone
      return marker;
    } catch {
      fs.rmSync(file, { force: true }); // stale or unreadable: retire it
    }
  }
  return null;
}

/** The harness ('claude' | 'codex') that launched this session, or null when unlaunched. */
export function launchedHarness(env = process.env) {
  const value = String(env[LAUNCHED_HARNESS_ENV] ?? '').trim();
  return value === '' ? null : value;
}

/** The env block the launcher hands the caged child — the oathe wiring plus the opt-in marker. */
export function launchSessionEnv({ config, identity, cwd, harness }) {
  return {
    OATHE_DB: config.get('db'),
    OATHE_ORG: identity.orgId,
    OATHE_PRINCIPAL: identity.principalId,
    OATHE_DEPARTMENT: identity.department,
    OATHE_WORKSPACE_DIR: cwd,
    [LAUNCHED_HARNESS_ENV]: harness,
  };
}
