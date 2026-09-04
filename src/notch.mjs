// oathe — the notch lifecycle (darwin): always-on as part of init, gone with uninstall,
// and SHIPPED WITH THE PACKAGE for everyone (founder rulings, 2026-08-30). The packaged
// app (notch/Oathe Notch.app, built at pack time) is the SOURCE; what launchd runs is a
// MATERIALIZED copy under the oathe home, keyed by version + binary content. The package
// tree is mutable — npm replaces it on upgrade, and replacing a signed binary under a
// running process gets it killed by the kernel — so the agent never points there: a new
// binary materializes a NEW key, the agent is re-stamped and restarted, and the old key is
// pruned only after launchd is off it. `oathe config notchApp <path> --global` overrides
// the source; init writes the LaunchAgent as a manifest-owned file and bootstraps it NOW;
// uninstall boots it out and removes exactly what was recorded; a source checkout without
// the built app gets a fact row naming what is missing.

import fs from 'node:fs';
import path from 'node:path';

import { defaultExec } from './harnesses/harness.mjs';
import { sha256Hex } from './manifest.mjs';
import {
  serviceLabel, agentPathFor, launchAgentPlistFor, launchdJob as launchdJobOf,
  bootstrapWithRetry, blockingSleep,
} from './launchd.mjs';

export const NOTCH_LABEL = 'ai.oathe.notch';

/** The notch's per-home label — the mechanism (and its 2026-08-31 scar story) lives in
 *  src/launchd.mjs, ONE implementation for every oathe service. */
export function notchLabel(home) {
  return serviceLabel(home, NOTCH_LABEL);
}

export function launchAgentPath(home) {
  return agentPathFor(home, notchLabel(home));
}

/** The notch's plist: the app binary as the one program argument. KeepAlive rationale — a
 *  dead viewer is a silent breach surface — rides the shared writer. */
export function launchAgentPlist(appPath, { label = NOTCH_LABEL, nodeBinDir = path.dirname(process.execPath) } = {}) {
  return launchAgentPlistFor({ label, programArguments: [appPath], nodeBinDir });
}

/** The app the npm package ships — built by prepack, the SOURCE every machine materializes from. */
export function packagedNotchApp(packageRoot) {
  return path.join(packageRoot, 'notch', 'Oathe Notch.app', 'Contents', 'MacOS', 'OatheNotch');
}

/** ~/.oathe/notch — every materialized key lives under here and nowhere else. */
export function materializedNotchRoot(home) {
  return path.join(home, '.oathe', 'notch');
}

/**
 * Copy the whole app bundle to `~/.oathe/notch/<version>-<sha12>/Oathe Notch.app`.
 * Content-keyed: identical bytes land on the identical key (idempotent, no churn); changed
 * bytes land on a FRESH key (a running copy is never overwritten in place). Materializing
 * never deletes prior keys — pruning is wireNotch's job, after launchd has moved.
 * @returns {{dir: string, binary: string, sha256: string}}
 */
export function materializeNotchApp({ home, appBinary, version }) {
  const sha = sha256Hex(fs.readFileSync(appBinary));
  const dir = path.join(materializedNotchRoot(home), `${version}-${sha.slice(0, 12)}`);
  // Only a real bundle (…/<Name>.app/Contents/MacOS/<bin>) is copied as one; a bare binary
  // (`notchApp` pointed at a plain executable) materializes as just the file — walking three
  // levels up from an arbitrary path would copy an unrelated ancestor into itself.
  const bundleSource = path.dirname(path.dirname(path.dirname(appBinary)));
  const isBundle = bundleSource.endsWith('.app')
    && path.basename(path.dirname(appBinary)) === 'MacOS'
    && path.basename(path.dirname(path.dirname(appBinary))) === 'Contents';
  const binary = isBundle
    ? path.join(dir, path.basename(bundleSource), 'Contents', 'MacOS', path.basename(appBinary))
    : path.join(dir, path.basename(appBinary));
  if (!fs.existsSync(binary)) {
    fs.mkdirSync(dir, { recursive: true });
    if (isBundle) fs.cpSync(bundleSource, path.join(dir, path.basename(bundleSource)), { recursive: true });
    else fs.cpSync(appBinary, binary);
  }
  return { dir, binary, sha256: sha };
}

/** launchd's word on one label — the implementation lives in src/launchd.mjs; re-exported
 *  here for its standing consumers (doctor's liveness row). */
export const launchdJob = launchdJobOf;

/** The same word for this home's notch agent. */
export function notchStatus({ home, exec = defaultExec, uid = process.getuid() }) {
  return launchdJob({ label: notchLabel(home), exec, uid });
}

export function wireNotch({ home, manifest, config, version, exec = defaultExec, uid = process.getuid(), packageRoot, sleep = blockingSleep }) {
  if (process.platform !== 'darwin') return [];
  const source = config.get('notchApp') ?? packagedNotchApp(packageRoot);
  if (!fs.existsSync(source)) return [{ action: 'notch-binary-missing', file: source }];

  const app = materializeNotchApp({ home, appBinary: source, version });
  const label = notchLabel(home);
  // The bin FACT rides the install: any launch mode — launchd, a hand-started app, a dev
  // double-click — reads the same answer Node stamped at wire time. The login-shell probe
  // stays a last resort (it never sources .zshrc, so nvm setups don't answer there). ONE
  // nodeBinDir feeds both the stamp and the agent's PATH — they can never disagree.
  const nodeBinDir = path.dirname(process.execPath);
  fs.writeFileSync(path.join(app.dir, 'oathe-bin'), `${path.join(nodeBinDir, 'oathe')}\n`);
  const file = launchAgentPath(home);
  const content = launchAgentPlist(app.binary, { label, nodeBinDir });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);

  // Replaced wholesale on every wire: the manifest rows say what exists NOW (upsert keys on
  // detail, so a moved app path would otherwise accumulate rows instead of replacing them).
  // A replaced agent under a DIFFERENT name (a legacy bare label, a moved home) is booted
  // out and removed here — otherwise the old job lingers loaded beside the new one. The
  // sweep is scoped to the NOTCH'S OWN rows (phase 2): the serve daemon's launch agent is
  // another owner's — a kind-wide sweep would boot it out on every init.
  for (const row of manifest.removeWhere((r) => r.harness === 'notch' && (r.kind === 'launch-agent' || r.kind === 'notch-app'))) {
    if (row.kind === 'launch-agent' && row.file !== file) {
      exec.run('launchctl', ['bootout', `gui/${uid}/${path.basename(row.file, '.plist')}`]); // result unread: a legacy label that is not loaded answers 'Could not find service' — nothing to do either way
      if (fs.existsSync(row.file)) fs.rmSync(row.file);
    }
  }
  manifest.upsert({
    harness: 'notch', file, kind: 'launch-agent', scope: 'user',
    detail: { app: app.binary }, blockVersion: version, sha256: sha256Hex(content),
  });
  manifest.upsert({
    harness: 'notch', file: app.dir, kind: 'notch-app', scope: 'user',
    detail: { binary: app.binary }, blockVersion: version, sha256: app.sha256,
  });

  // A re-run is the restart: bootout is allowed to fail (not loaded), bootstrap must land.
  // Prune stale keys BETWEEN the two — launchd is off the old copy, the new one not yet up.
  exec.run('launchctl', ['bootout', `gui/${uid}/${label}`]); // result unread: a first install has no job to boot out; whether the OLD job is gone is asked below, by retrying bootstrap until launchd takes the new one
  for (const key of fs.readdirSync(materializedNotchRoot(home))) {
    const stale = path.join(materializedNotchRoot(home), key);
    if (stale !== app.dir) fs.rmSync(stale, { recursive: true, force: true });
  }
  // The restart, asked not raced — the shared bootstrapWithRetry (src/launchd.mjs) carries
  // the 0.4.3 lesson: retry the refused bootstrap inside the budget, read the pid back from
  // launchd, and past the budget answer with launchd's own last word.
  const took = bootstrapWithRetry({
    label, file, uid, exec, sleep,
    deadlineMs: config.get('notchRestartSeconds') * 1000,
    pollMs: config.get('notchRestartPollMs'),
  });
  const outcome = took.pid !== null
    ? { action: 'notch-running', pid: took.pid, label }
    : { action: 'notch-not-running', file, label, detail: took.detail };
  return [{ action: 'launch-agent-written', file }, outcome];
}

/** @returns {object[]} action rows for the uninstall report — the NOTCH'S rows only; the
 *  serve daemon unwires through its own owner (src/serve.mjs). */
export function unwireNotch({ manifest, exec = defaultExec, uid = process.getuid() }) {
  const actions = [];
  for (const row of manifest.removeWhere((r) => r.harness === 'notch' && r.kind === 'launch-agent')) {
    // The label rides the recorded file name — unwire boots out exactly what wire named.
    exec.run('launchctl', ['bootout', `gui/${uid}/${path.basename(row.file, '.plist')}`]); // result unread: an agent already gone answers 'Could not find service'; the removal below is what uninstall promises
    if (fs.existsSync(row.file)) fs.rmSync(row.file);
    actions.push({ action: 'launch-agent-removed', file: row.file });
  }
  for (const row of manifest.removeWhere((r) => r.kind === 'notch-app')) {
    if (fs.existsSync(row.file)) fs.rmSync(row.file, { recursive: true, force: true });
    actions.push({ action: 'notch-app-removed', file: row.file });
  }
  return actions;
}
