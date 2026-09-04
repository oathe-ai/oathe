// oathe — `oathe update`: the documented upgrade, `npm i -g @oathe/oathe@latest && oathe init`,
// as one verb (founder's word, 2026-09-03). Three facts it holds:
//   - the npm it calls is the one BESIDE the node running this bin (process.execPath), never
//     PATH's — on an nvm machine PATH can lead to another node's npm, and then the upgrade lands
//     somewhere this bin never looks (the trap the 0.4.1 trial hit);
//   - init runs through the NEW bin — the one under npm's global PREFIX (`npm prefix -g`),
//     which is node's own directory by default but not with `npm config set prefix …` (a
//     Greptile P1 on PR #33 caught the execPath-sibling shortcut) — as a child with the terminal
//     attached: this process still holds the old modules, and init's one screen needs the TTY;
//   - a checkout is refused typed — it updates by git — and npm's failure is refused with npm's
//     own last word, never a bland "done".

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { defaultExec } from './harnesses/harness.mjs';
import { notchStatus } from './notch.mjs';
import { homeOf } from './paths.mjs';

export class UpdateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'UpdateError';
    this.code = code;
    this.details = details;
  }
}

/** A sibling of the node that runs this process — npm ships with node, so this is npm's own home. */
export function siblingBin(name, { execPath = process.execPath } = {}) {
  return path.join(path.dirname(execPath), name);
}

/** One npm query, refused typed when npm cannot answer it. */
function npmQuery(exec, npm, args, code) {
  const r = exec.run(npm, args);
  if (r.status !== 0) {
    throw new UpdateError(code, `update refused — \`${npm} ${args.join(' ')}\` failed: ${lastLine(r.stderr) || `exit ${r.status}`}`, { npm, args });
  }
  return r.stdout.trim();
}

/** The new bin, with the terminal attached — init's screen must reach the person. */
function defaultHandoff(bin, args, { env }) {
  const r = spawnSync(bin, args, { stdio: 'inherit', env });
  return { status: r.status ?? 1 };
}

/** launchd's word on the notch after init — darwin only; elsewhere there is no notch to report. */
function defaultNotch({ env }) {
  return process.platform === 'darwin' ? notchStatus({ home: homeOf(env) }) : null;
}

const lastLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '';
const realpathOrSelf = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

/**
 * @param {{packageRoot: string, execPath?: string, exec?: {run: Function}, handoff?: Function,
 *          env?: NodeJS.ProcessEnv, args?: string[], out?: {write: Function}, tag?: string,
 *          notch?: Function}} o
 * @returns {{before: string, after: string, initStatus: number,
 *            notch: {label: string, loaded: boolean, pid: number|null}|null}}
 */
export function runUpdate({
  packageRoot, execPath = process.execPath, exec = defaultExec, handoff = defaultHandoff,
  env = process.env, args = [], out = process.stdout, tag = 'latest', notch = defaultNotch,
}) {
  const readPkg = () => JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const pkg = readPkg();
  const npm = siblingBin('npm', { execPath });
  const globalRoot = path.join(npmQuery(exec, npm, ['root', '-g'], 'OATHE_UPDATE_NPM_UNAVAILABLE'), ...pkg.name.split('/'));
  if (realpathOrSelf(globalRoot) !== realpathOrSelf(packageRoot)) {
    throw new UpdateError('OATHE_UPDATE_NOT_GLOBAL',
      `update refused — this oathe runs from ${packageRoot}, not from npm's global install `
      + `(${globalRoot}); a checkout updates with git, and \`npm i -g ${pkg.name}@${tag}\` installs the published package`,
      { packageRoot, globalRoot });
  }
  const before = pkg.version;
  out.write(`update: ${pkg.name} ${before} → @${tag} (${npm})\n`);
  const install = exec.run(npm, ['i', '-g', `${pkg.name}@${tag}`]);
  if (install.status !== 0) {
    throw new UpdateError('OATHE_UPDATE_FAILED',
      `update refused — \`npm i -g ${pkg.name}@${tag}\` failed (exit ${install.status}): ${lastLine(install.stderr) || lastLine(install.stdout)}`,
      { status: install.status });
  }
  if (lastLine(install.stdout)) out.write(`update: ${lastLine(install.stdout)}\n`);
  const after = readPkg().version; // npm replaced the files under this same root
  out.write(`update: ${before} → ${after}${after === before ? ' (already current)' : ''} — running init through the new bin\n`);
  // The new bin lives under npm's global prefix — node's directory by default, elsewhere with a
  // custom prefix — never assumed from where node is.
  const prefix = npmQuery(exec, npm, ['prefix', '-g'], 'OATHE_UPDATE_NPM_UNAVAILABLE');
  const init = handoff(path.join(prefix, 'bin', 'oathe'), ['init', ...args], { env });
  if (init.status !== 0) return { before, after, initStatus: init.status, notch: null };
  // The last word is the one the person needs: the version live NOW, and whether the notch
  // they look at is the new one — read from launchd after init re-wired it, never assumed.
  const glass = notch({ env });
  if (glass === null) out.write(`update successful — oathe v${after}\n`);
  else if (glass.pid !== null) out.write(`update successful — oathe v${after} · notch running (pid ${glass.pid})\n`);
  else out.write(`update installed oathe v${after} — but the notch is NOT running (launchd: ${glass.loaded ? 'loaded, no pid' : 'not loaded'}); run \`oathe init\` and read its notch line\n`);
  return { before, after, initStatus: init.status, notch: glass };
}
