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

export const NOTCH_LABEL = 'ai.oathe.notch';

/** The launchd label NAMES the installation, and installations are per-home — EVERY home,
 *  the real one included, gets a home-hashed label. There is deliberately no bare-label
 *  special case: "am I the default home" cannot be judged from inside an environment
 *  (os.homedir() follows $HOME, so a sandboxed child believes its sandbox is home — the
 *  self-reference that let a full-suite run kill the founder's live island through the
 *  shared fixed label, 2026-08-31, twice). The uid's launchd domain is shared across
 *  homes; only the hash keeps installations apart. */
export function notchLabel(home) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  return `${NOTCH_LABEL}.${sha256Hex(real(home)).slice(0, 12)}`;
}

export function launchAgentPath(home) {
  return path.join(home, 'Library', 'LaunchAgents', `${notchLabel(home)}.plist`);
}

export function launchAgentPlist(appPath, { label = NOTCH_LABEL, nodeBinDir = path.dirname(process.execPath) } = {}) {
  // launchd spawns with a bare PATH and a login shell never sources .zshrc — but init IS
  // oathe running, so it knows exactly where the bin lives: the running node's own bin dir
  // (the global npm bin) leads the agent's PATH. The app resolves `oathe` from this, no
  // shell guessing. KeepAlive: the notch is a viewer with no side effects — a dead viewer
  // is a silent breach surface, so launchd owns its liveness (crash, kill, or a replaced
  // binary all end in a restart, never in quiet absence).
  const agentPath = [nodeBinDir, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${appPath}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${agentPath}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
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

/** @returns {object[]} action rows for the init report; [] only off-darwin */
export function wireNotch({ home, manifest, config, version, exec = defaultExec, uid = process.getuid(), packageRoot }) {
  if (process.platform !== 'darwin') return [];
  const source = config.get('notchApp') ?? packagedNotchApp(packageRoot);
  if (!fs.existsSync(source)) return [{ action: 'notch-binary-missing', file: source }];

  const app = materializeNotchApp({ home, appBinary: source, version });
  const label = notchLabel(home);
  const file = launchAgentPath(home);
  const content = launchAgentPlist(app.binary, { label });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);

  // Replaced wholesale on every wire: the manifest rows say what exists NOW (upsert keys on
  // detail, so a moved app path would otherwise accumulate rows instead of replacing them).
  // A replaced agent under a DIFFERENT name (a legacy bare label, a moved home) is booted
  // out and removed here — otherwise the old job lingers loaded beside the new one.
  for (const row of manifest.removeWhere((r) => r.kind === 'launch-agent' || r.kind === 'notch-app')) {
    if (row.kind === 'launch-agent' && row.file !== file) {
      exec.run('launchctl', ['bootout', `gui/${uid}/${path.basename(row.file, '.plist')}`]);
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
  exec.run('launchctl', ['bootout', `gui/${uid}/${label}`]);
  for (const key of fs.readdirSync(materializedNotchRoot(home))) {
    const stale = path.join(materializedNotchRoot(home), key);
    if (stale !== app.dir) fs.rmSync(stale, { recursive: true, force: true });
  }
  exec.run('launchctl', ['bootstrap', `gui/${uid}`, file]);
  return [{ action: 'launch-agent-written', file }];
}

/** @returns {object[]} action rows for the uninstall report */
export function unwireNotch({ manifest, exec = defaultExec, uid = process.getuid() }) {
  const actions = [];
  for (const row of manifest.removeWhere((r) => r.kind === 'launch-agent')) {
    // The label rides the recorded file name — unwire boots out exactly what wire named.
    exec.run('launchctl', ['bootout', `gui/${uid}/${path.basename(row.file, '.plist')}`]);
    if (fs.existsSync(row.file)) fs.rmSync(row.file);
    actions.push({ action: 'launch-agent-removed', file: row.file });
  }
  for (const row of manifest.removeWhere((r) => r.kind === 'notch-app')) {
    if (fs.existsSync(row.file)) fs.rmSync(row.file, { recursive: true, force: true });
    actions.push({ action: 'notch-app-removed', file: row.file });
  }
  return actions;
}
