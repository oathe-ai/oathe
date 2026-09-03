#!/usr/bin/env node
// oathe — the install-contract lane (drift monitors P2). The suite's CLI fakes mirror what we
// BELIEVE each harness writes; this lane proves it against the REAL CLI on a fresh machine:
// a throwaway HOME, a scratch database, `oathe init --harness <h>`, and then the doctor's own
// row verification (the manifest rows ARE the "directories initialized, format preserved"
// assertions), a byte-idempotent second init, an uninstall that restores every file, and the
// global-fence precedence. Fails loud naming the harness, its version, the check, the row.
// `runInstallContract` takes an already-sandboxed env and an injectable verb runner so the
// suite can drive it over the fakes; `main` builds the sandbox and spawns the real bin.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { HARNESS_CLASSES, byName } from '../src/harnesses/catalog.mjs';
import { FencedBlock, FENCE_STYLES } from '../src/blocks.mjs';
import { InstallManifest } from '../src/manifest.mjs';
import { buildPaths, homeOf } from '../src/paths.mjs';

import { LaneReport, EXIT_REFUSED } from './lane-report.mjs';

export { EXIT_FAILED, EXIT_REFUSED } from './lane-report.mjs';

export class InstallContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InstallContractError';
    this.code = code;
  }
}

const packageRoot = () => path.dirname(path.dirname(fs.realpathSync(new URL(import.meta.url).pathname)));

/** Where a tarball installed into a sandbox puts its bin. */
export function installedBin({ home }) {
  return path.join(home, '.npm-global', 'bin', 'oathe');
}

/**
 * The throwaway world a real run lives in: its own HOME (with the harness's config home so
 * detection sees it — a first launch would create it anyway), OATHE_HOME, a scratch database.
 * With `fromTarball`, the tree is PACKED and the tarball installed globally into the sandbox —
 * the lane then runs what a user would run, not the checkout: a file missing from the tarball
 * cannot pass here.
 */
export function sandboxEnv({ harness, base = process.env, fromTarball = false }) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `oathe-install-contract-${harness}-`)));
  fs.mkdirSync(byName(harness).configHomeFor(home), { recursive: true });
  const env = {
    ...base,
    HOME: home,
    OATHE_HOME: path.join(home, '.oathe'),
    OATHE_DB: `oathe_install_contract_${harness}_${process.pid}`,
    OATHE_PRINCIPAL: 'install-contract',
  };
  for (const k of ['OATHE_WORKSPACE_DIR', 'CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'OATHE_RUNTIME_PROVIDER']) delete env[k];
  if (fromTarball) {
    const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', home], { cwd: packageRoot(), env: base, encoding: 'utf8' });
    if (pack.status !== 0) throw new InstallContractError('OATHE_INSTALL_CONTRACT_PACK_FAILED', `npm pack failed: ${pack.stderr.trim().split('\n').at(-1)}`);
    const tarball = path.join(home, JSON.parse(pack.stdout)[0].filename);
    const prefix = path.join(home, '.npm-global');
    const install = spawnSync('npm', ['install', '-g', '--ignore-scripts', '--prefix', prefix, tarball], { env: base, encoding: 'utf8' });
    if (install.status !== 0) throw new InstallContractError('OATHE_INSTALL_CONTRACT_INSTALL_FAILED', `npm install -g ${path.basename(tarball)} failed: ${install.stderr.trim().split('\n').at(-1)}`);
    env.PATH = `${path.join(prefix, 'bin')}:${base.PATH ?? ''}`;
  }
  return { home, env };
}

/** Run an oathe verb: the bin on the sandbox PATH when one was installed there, else the checkout's. */
function defaultRunVerb({ verb, args, env }) {
  const installed = path.join((env.PATH ?? '').split(':')[0] ?? '', 'oathe');
  const useInstalled = installed.includes('.npm-global') && fs.existsSync(installed);
  const r = useInstalled
    ? spawnSync(installed, [verb, ...args], { env, encoding: 'utf8' })
    : spawnSync(process.execPath, [path.join(packageRoot(), 'bin/oathe.mjs'), verb, ...args], { env, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : (r.stderr ?? '') };
}

/**
 * A verb under a REAL pty, answering Enter to every question — the UX contract's rule 15
 * (docs/UX.md): the interactive `oathe init` a person meets is replayed on every PR — the
 * one-screen checklist, Enter = install everything detected. `script`
 * is the pty allocator both platforms ship (BSD: `script -q /dev/null <cmd…>`; util-linux:
 * `script -qec "<cmd>" /dev/null`); Node cannot allocate a pty itself. Its stdin is an
 * anonymous pipe whose writer presses Enter every 0.3s until `script` exits (SIGPIPE ends it):
 * BSD script sends EOF to the pty the moment its own stdin is at EOF — before forwarding what it
 * read — so a file or a closed pipe hands the child a closed stdin before the first question;
 * a FIFO is socket-backed on macOS and `script` refuses it ("tcgetattr/ioctl: Operation not
 * supported on socket"), as it refuses node's socketpair stdio — hence the transcript file.
 * (All three recorded 2026-08-29.)
 */
const TTY_DRIVER = `
o="$1"; shift
( while printf '\\n'; do sleep 0.3; done ) 2>/dev/null | if [ "$(uname)" = Darwin ]; then script -q /dev/null "$@"; else script -qec "$OATHE_TTY_CMD" /dev/null; fi > "$o" 2>&1
`;

export function defaultRunTty({ verb, args, env }) {
  const installed = installedBin({ home: homeOf(env) });
  const argv = fs.existsSync(installed) ? [installed, verb, ...args] : [process.execPath, path.join(packageRoot(), 'bin/oathe.mjs'), verb, ...args];
  const transcriptFile = path.join(homeOf(env), '.oathe-init-transcript');
  const quoted = argv.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(' ');
  try {
    const r = spawnSync('sh', ['-c', TTY_DRIVER, 'oathe-tty', transcriptFile, ...argv],
      { env: { ...env, OATHE_TTY_CMD: quoted }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 180000 });
    const transcript = `${readOrNull(transcriptFile) ?? ''}${r.stderr ?? ''}`.replaceAll('\r', '');
    return { status: r.status ?? 1, transcript };
  } finally {
    fs.rmSync(transcriptFile, { force: true });
  }
}

/** The UX-contract rules a pty transcript of `oathe init` must satisfy; [] when it does. */
export function ttyTranscriptProblems(transcript, { displayName }) {
  const plain = transcript.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const problems = [];
  if (!plain.includes(`[x] ${displayName}`)) problems.push(`no pre-selected "[x] ${displayName}" row`);
  if (!/↑↓ move · space toggle · enter install/.test(plain)) problems.push('no key legend — not the one-screen checklist');
  if (/\[\d+\]/.test(plain)) problems.push('a numbered menu');
  if (/\[Y\/n\]/.test(plain)) problems.push('a question-by-question conversation');
  if (!/reversible \(oathe uninstall\)/.test(plain)) problems.push('no opening line saying the install is reversible');
  if (!/verifier/.test(plain)) problems.push('no verifier row');
  if (!/oathe: init ok/.test(plain)) problems.push('no "oathe: init ok" trailer');
  return problems;
}

function defaultVersionOf({ bin, versionArgs, env }) {
  const r = spawnSync(bin, versionArgs, { env, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new InstallContractError('OATHE_INSTALL_CONTRACT_BIN_MISSING',
      `\`${bin} ${versionArgs.join(' ')}\` did not run (${r.error?.message ?? `exit ${r.status}`}) — is the CLI installed on PATH?`);
  }
  return `${r.stdout}${r.stderr}`.trim().split('\n')[0];
}

const readOrNull = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const failure = (e) => `${e?.code ? `[${e.code}] ` : ''}${String(e?.message || e).split('\n')[0]}`;

/**
 * @param {{harness: string, env: NodeJS.ProcessEnv, runVerb?: Function, versionOf?: Function}} o
 *   env — an ALREADY sandboxed environment (see sandboxEnv); runVerb({verb, args, env}) runs an
 *   oathe verb in it; versionOf({bin, versionArgs, env}) answers the CLI's version line.
 * @returns {Promise<LaneReport>}
 */
export async function runInstallContract({ harness, env, runVerb = defaultRunVerb, runTty = defaultRunTty, versionOf = defaultVersionOf }) {
  const Adapter = HARNESS_CLASSES.find((C) => C.harnessName === harness);
  if (!Adapter || Adapter.install === null) {
    throw new InstallContractError('OATHE_INSTALL_CONTRACT_UNKNOWN_HARNESS',
      `no installable harness '${harness}' — known: ${HARNESS_CLASSES.filter((C) => C.install !== null).map((C) => C.harnessName).join(', ')}`);
  }
  const { bin, versionArgs } = Adapter.install;
  const report = new LaneReport({ lane: 'install-contract', harness, version: await versionOf({ bin, versionArgs, env }) });
  const paths = buildPaths(env);
  const home = homeOf(env);
  const configHome = Adapter.configHomeFor(home);
  const globalFiles = Adapter.globalContextFiles.map((f) => path.join(configHome, f));
  const override = globalFiles.length > 1 ? globalFiles[0] : null;
  if (override) fs.writeFileSync(override, '# the operator\'s own instructions\n');

  const verb = async (name, args) => {
    try {
      const r = await runVerb({ verb: name, args, env });
      return r.status === 0 ? null : `exit ${r.status}: ${(r.stderr || r.stdout).trim().split('\n').at(-1) ?? ''}`;
    } catch (e) {
      return failure(e);
    }
  };
  const manifest = () => InstallManifest.load({ manifestPath: paths.manifestPath, backupsDir: paths.backupsDir });
  const rowsOf = (m) => m.rows.filter((r) => r.harness === harness || r.harness === 'global');

  // 1. init
  const initError = await verb('init', ['--harness', harness, '--yes']);
  if (!report.add('init', initError === null, initError ?? '')) return report;

  // 2. every row the doctor can see verifies ok
  const { runDoctor } = await import('../src/doctor.mjs');
  const doctor = await runDoctor({ env });
  const rows = doctor.rows.filter((r) => r.harness === harness || r.harness === 'global');
  const bad = rows.filter((r) => r.status !== 'ok');
  report.add('rows-ok', rows.length > 0 && bad.length === 0,
    rows.length === 0 ? 'the manifest has no rows for this harness — init wrote nothing?'
      : bad.map((r) => `${r.kind} ${r.file}: ${r.status}`).join('; '));

  // 3. the global fence landed where the harness reads it
  if (override) {
    const block = new FencedBlock({ style: FENCE_STYLES.html });
    const inOverride = block.read(readOrNull(override) ?? '').present;
    const last = globalFiles.at(-1);
    const inDefault = block.read(readOrNull(last) ?? '').present;
    report.add('global-fence-precedence', inOverride && !inDefault,
      inOverride ? (inDefault ? `a dead fence was also written to ${last}` : '') : `no fence in ${override}`);
  }

  // 4. a second init changes no bytes
  const files = [...new Set(rowsOf(manifest()).map((r) => r.file))];
  const before = new Map(files.map((f) => [f, readOrNull(f)]));
  const again = await verb('init', ['--harness', harness, '--yes']);
  const changed = files.filter((f) => readOrNull(f) !== before.get(f));
  report.add('idempotent', again === null && changed.length === 0,
    again ?? (changed.length ? `bytes changed on re-run: ${changed.join(', ')}` : ''));

  // 5. the interactive init a person meets, under a real pty, Enter throughout — held to docs/UX.md.
  // Un-narrowed on purpose: --harness decides the step (stated, not asked); the sandbox has only
  // this harness installed, so the conversation asks exactly its question.
  let tty;
  try {
    tty = await runTty({ verb: 'init', args: [], env });
  } catch (e) {
    tty = { status: 1, transcript: failure(e) };
  }
  const problems = tty.status === 0 ? ttyTranscriptProblems(tty.transcript, { displayName: Adapter.displayName }) : [`exit ${tty.status}`];
  report.add('init-tty', problems.length === 0,
    problems.length ? `${problems.join('; ')} — transcript tail: ${tty.transcript.trim().split('\n').slice(-6).join(' | ')}` : '');

  // 6. uninstall restores every file to its pre-init bytes
  const backups = manifest().backups.filter((b) => files.includes(b.file));
  const uninstallError = await verb('uninstall', ['--purge-db']);
  const notRestored = backups.filter((b) => (b.absent_before ? fs.existsSync(b.file)
    : readOrNull(b.file) !== readOrNull(b.backup)));
  report.add('uninstall-restores', uninstallError === null && notRestored.length === 0,
    uninstallError ?? notRestored.map((b) => `${b.file} (${b.absent_before ? 'should be absent' : 'differs from backup'})`).join('; '));
  return report;
}

async function main(argv) {
  const harness = argv[0];
  if (!harness) {
    process.stderr.write(`install-contract: refused — usage: harness-install-contract.mjs <${HARNESS_CLASSES.filter((C) => C.install !== null).map((C) => C.harnessName).join('|')}>\n`);
    return EXIT_REFUSED;
  }
  let sandbox;
  try {
    sandbox = sandboxEnv({ harness, fromTarball: true });
    const report = await runInstallContract({ harness, env: sandbox.env });
    process.stdout.write(`install-contract: ${harness} ${report.version} in ${sandbox.home} (installed from the packed tarball)\n${report.render()}`);
    if (report.ok) fs.rmSync(sandbox.home, { recursive: true, force: true });
    else process.stderr.write(`install-contract: sandbox kept for inspection at ${sandbox.home}\n`);
    return report.exitCode;
  } catch (e) {
    process.stderr.write(`install-contract: refused — ${failure(e)}\n`);
    return EXIT_REFUSED;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
