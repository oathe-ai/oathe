// oathe — the launchd machinery, ONE implementation (connection-lane phase 2, generalized
// out of src/notch.mjs where 0.4.4 hardened it): per-home hashed labels (the uid's launchd
// domain is shared across homes — only the hash keeps installations apart; there is
// deliberately no bare-label special case), a plist writer that ESCAPES its interpolations
// and takes arbitrary ProgramArguments, the bootstrap retried inside a budget with the pid
// read back from launchd (bootout is asynchronous; a bootstrap in its window is refused
// "5: Input/output error" — the unread refusal that shipped 0.4.3's dead notch), and the
// job probe. Two consumers: the notch (src/notch.mjs) and the serve daemon (src/serve.mjs).
// The scar rules travel with the code: the proof is always the SUPERVISOR's answer, and a
// poll never sleeps past its deadline (Greptile P1 on #34).

import fs from 'node:fs';
import path from 'node:path';

import { defaultExec } from './harnesses/harness.mjs';
import { sha256Hex } from './manifest.mjs';

const xmlEscape = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** base + '.' + 12 hex of the REAL home path — the label NAMES the installation. */
export function serviceLabel(home, base) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  return `${base}.${sha256Hex(real(home)).slice(0, 12)}`;
}

/** The plist file is NAMED BY ITS LABEL — doctor derives the label back from the filename. */
export function agentPathFor(home, label) {
  return path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

/**
 * The agent plist: RunAtLoad + KeepAlive (a dead oathe service is a silent breach surface —
 * launchd owns liveness), the running node's bin dir leading PATH (launchd spawns with a
 * bare PATH and a login shell never sources .zshrc — but this IS oathe running, so it knows
 * where the bin lives), every interpolation XML-escaped.
 */
export function launchAgentPlistFor({ label, programArguments, nodeBinDir = path.dirname(process.execPath) }) {
  const agentPath = [nodeBinDir, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':');
  const args = programArguments.map((a) => `<string>${xmlEscape(a)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key><array>${args}</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xmlEscape(agentPath)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

/** launchd's word on one label: loaded, and the pid it runs — the only "running" oathe reports. */
export function launchdJob({ label, exec = defaultExec, uid = process.getuid() }) {
  const r = exec.run('launchctl', ['print', `gui/${uid}/${label}`]);
  const pid = r.status === 0 ? Number(/^\s*pid = (\d+)/m.exec(r.stdout)?.[1] ?? NaN) : NaN;
  return { label, loaded: r.status === 0, pid: Number.isFinite(pid) ? pid : null };
}

/** A synchronous pause — init is a straight line, and launchd is asked, not raced. */
export const blockingSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const lastLine = (text) => String(text ?? '').trim().split('\n').filter((l) => l && !/^Try re-running/.test(l)).at(-1) ?? '';

/**
 * The restart, asked not raced: retry the refused bootstrap inside the budget, then confirm
 * from launchd itself that the job has a pid. Past the budget the answer is launchd's own
 * last word — a silent "written" over a dead service is what shipped in 0.4.3.
 * @returns {{pid: number|null, loaded: boolean, detail: string|null}}
 */
export function bootstrapWithRetry({
  label, file, uid = process.getuid(), exec = defaultExec,
  deadlineMs, pollMs, sleep = blockingSleep, now = Date.now,
}) {
  const deadline = now() + deadlineMs;
  // A poll never sleeps past the deadline — the budget is the budget (Greptile P1 on #34).
  const poll = () => Math.max(0, Math.min(pollMs, deadline - now()));
  let last = exec.run('launchctl', ['bootstrap', `gui/${uid}`, file]);
  while (last.status !== 0 && now() < deadline) {
    sleep(poll());
    last = exec.run('launchctl', ['bootstrap', `gui/${uid}`, file]);
  }
  let job = launchdJob({ label, exec, uid });
  while (last.status === 0 && job.pid === null && now() < deadline) {
    sleep(poll());
    job = launchdJob({ label, exec, uid });
  }
  return {
    pid: job.pid,
    loaded: job.loaded,
    detail: job.pid !== null ? null
      : (lastLine(last.stderr) || (job.loaded ? 'loaded, no pid yet' : 'not loaded')),
  };
}
