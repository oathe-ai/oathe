// oathe — the serve daemon's install lifecycle (connection-lane phase 2): the second
// consumer of the ONE launchd machinery (src/launchd.mjs). launchd runs THE SHIM
// (`~/.oathe/bin/oathe serve`) — the durable address is the program, so a node or package
// move re-stamps one file and the daemon follows on its KeepAlive restart; the daemon
// itself (src/mcp/daemon.mjs) owns the socket. Wire on init after the shim lands, unwire on
// uninstall beside the notch; each service owns exactly its own manifest rows.

import fs from 'node:fs';
import path from 'node:path';

import { defaultExec } from './harnesses/harness.mjs';
import { sha256Hex } from './manifest.mjs';
import {
  serviceLabel, agentPathFor, launchAgentPlistFor, launchdJob, bootstrapWithRetry, blockingSleep,
} from './launchd.mjs';
import { shimPath } from './shim.mjs';

export const SERVE_LABEL = 'ai.oathe.serve';

export function serveLabel(home) {
  return serviceLabel(home, SERVE_LABEL);
}

/** The daemon's address: the config key wins; the default lives under the oathe home. */
export function serveSocketPath(paths, config) {
  return config.get('serveSocket') ?? path.join(paths.oatheHome, 'serve.sock');
}

/** launchd's word on this home's daemon. */
export function serveStatus({ home, exec = defaultExec, uid = process.getuid() }) {
  return launchdJob({ label: serveLabel(home), exec, uid });
}

/** @returns {object[]} action rows for the init report; [] only off-darwin */
export function wireServe({ home, manifest, config, version, exec = defaultExec, uid = process.getuid(), sleep = blockingSleep }) {
  if (process.platform !== 'darwin') return [];
  const shim = shimPath(home);
  if (!fs.existsSync(shim)) return [{ action: 'serve-shim-missing', file: shim }];

  const label = serveLabel(home);
  const file = agentPathFor(home, label);
  const content = launchAgentPlistFor({ label, programArguments: [shim, 'serve'] });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);

  // Replaced wholesale on every wire, scoped to THIS service's rows (the notch's are
  // another owner's); a replaced agent under a different name is booted out and removed.
  for (const row of manifest.removeWhere((r) => r.harness === 'serve' && r.kind === 'launch-agent')) {
    if (row.file !== file) {
      exec.run('launchctl', ['bootout', `gui/${uid}/${path.basename(row.file, '.plist')}`]); // result unread: a legacy label that is not loaded answers 'Could not find service' — nothing to do either way
      if (fs.existsSync(row.file)) fs.rmSync(row.file);
    }
  }
  manifest.upsert({
    harness: 'serve', file, kind: 'launch-agent', scope: 'user',
    detail: { program: shim }, blockVersion: version, sha256: sha256Hex(content),
  });

  // A re-run is the restart: bootout may fail (not loaded); whether the OLD job is gone is
  // asked by retrying bootstrap until launchd takes the new one (the 0.4.4 lesson).
  exec.run('launchctl', ['bootout', `gui/${uid}/${label}`]); // result unread: a first install has no job to boot out; the bootstrapWithRetry below reads launchd's answer
  const took = bootstrapWithRetry({
    label, file, uid, exec, sleep,
    deadlineMs: config.get('serveRestartSeconds') * 1000,
    pollMs: config.get('serveRestartPollMs'),
  });
  const outcome = took.pid !== null
    ? { action: 'serve-running', pid: took.pid, label }
    : { action: 'serve-not-running', file, label, detail: took.detail };
  return [{ action: 'serve-agent-written', file }, outcome];
}

/** @returns {object[]} action rows for the uninstall report — the SERVE rows only. */
export function unwireServe({ manifest, exec = defaultExec, uid = process.getuid() }) {
  const actions = [];
  for (const row of manifest.removeWhere((r) => r.harness === 'serve' && r.kind === 'launch-agent')) {
    exec.run('launchctl', ['bootout', `gui/${uid}/${path.basename(row.file, '.plist')}`]); // result unread: an agent already gone answers 'Could not find service'; the removal below is what uninstall promises
    if (fs.existsSync(row.file)) fs.rmSync(row.file);
    actions.push({ action: 'serve-agent-removed', file: row.file });
  }
  return actions;
}
