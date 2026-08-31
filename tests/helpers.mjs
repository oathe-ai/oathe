// Shared test scaffolding: a sandbox HOME with both harnesses present (codex CLI faked to
// mirror what the real one writes), and scratch-substrate helpers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { notchLabel } from '../src/notch.mjs';

// A sandbox's machine side effects die with the process. A test that runs `oathe init`
// through the REAL bin (cli.test's picker moment, init.test's machine-wide verifier run)
// bootstraps a REAL launchd job for the sandbox home — per-home labels keep it off the
// founder's live notch, but without this sweep the KeepAlive job outlives the temp dir
// forever (nine ghost labels found loaded on 2026-08-31). Every sandbox registers here;
// one exit handler boots them all out, best-effort — a label that never bootstrapped
// errors silently and that is fine.
const sandboxHomes = [];
if (process.platform === 'darwin') {
  process.on('exit', () => {
    for (const home of sandboxHomes) {
      spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${notchLabel(home)}`], { stdio: 'ignore' });
    }
  });
}

/**
 * @param {{scratchDb: string, claudeScript?: string}} o
 *   claudeScript: shell body for the fake `claude` binary (default: print and exit 0)
 */
export function sandbox({ scratchDb, claudeScript = 'echo fake-claude; exit 0', withCursor = true }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-sb-'));
  sandboxHomes.push(home);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.codex'));
  if (withCursor) fs.mkdirSync(path.join(home, '.cursor'));
  fs.writeFileSync(path.join(home, '.claude/settings.json'),
    `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`);
  fs.writeFileSync(path.join(home, '.codex/config.toml'), '# user config\n');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${claudeScript}\n`);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n');
  // A resolvable absolute `oathe` for wiring that must never record a bare name (cursor).
  fs.writeFileSync(path.join(bin, 'oathe'), '#!/bin/sh\n');
  for (const name of ['claude', 'codex', 'oathe']) fs.chmodSync(path.join(bin, name), 0o755);

  const configPath = path.join(home, '.codex/config.toml');
  const registryDir = path.join(home, '.claude/plugins');
  const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);
  const writeJson = (file, doc) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  };
  // One fake per real CLI, each mirroring the files the real one writes so verification has
  // bytes to read: codex -> config.toml stanzas; claude -> the plugins registry.
  const fakes = {
    codex(args) {
      const prior = fs.readFileSync(configPath, 'utf8');
      const stanza = { marketplace: '[marketplaces.oathe]', add: '[plugins."oathe@oathe"]', mcp: '[mcp_servers.oathe]' };
      const key = args[0] === 'mcp' ? 'mcp' : (args[1] === 'marketplace' ? 'marketplace' : 'add');
      const line = stanza[key];
      if (args.includes('remove')) {
        // A marketplace stanza carries its source line (as the real config.toml does).
        const pattern = key === 'marketplace' ? new RegExp(`\\[marketplaces\\.oathe\\]\\n(source = "[^"]*"\\n)?`) : `${line}\n`;
        fs.writeFileSync(configPath, prior.replace(pattern, ''));
        return { status: 0, stdout: '', stderr: '' };
      }
      if (key === 'marketplace') {
        const recorded = prior.match(/\[marketplaces\.oathe\]\nsource = "([^"]*)"/)?.[1];
        if (recorded !== undefined && recorded !== args[3]) {
          return { status: 1, stdout: '', stderr: "Error: marketplace 'oathe' is already added from a different source; remove it before adding this source\n" };
        }
        if (recorded === undefined) fs.writeFileSync(configPath, `${prior}${line}\nsource = "${args[3]}"\n`);
        return { status: 0, stdout: '', stderr: '' };
      }
      if (!prior.includes(line)) fs.writeFileSync(configPath, `${prior}${line}\n`);
      return { status: 0, stdout: '', stderr: '' };
    },
    claude(args) {
      const marketplacesFile = path.join(registryDir, 'known_marketplaces.json');
      const installedFile = path.join(registryDir, 'installed_plugins.json');
      if (args[1] === 'marketplace' && args[2] === 'add') {
        const doc = readJson(marketplacesFile, {});
        doc.oathe = { source: { source: 'directory', path: args[3] } };
        writeJson(marketplacesFile, doc);
      } else if (args[1] === 'marketplace' && args[2] === 'remove') {
        const doc = readJson(marketplacesFile, {});
        delete doc.oathe;
        writeJson(marketplacesFile, doc);
        // The real CLI removes the plugins installed from a removed marketplace (observed 2026-08-29).
        const installed = readJson(installedFile, { version: 2, plugins: {} });
        delete installed.plugins['oathe@oathe'];
        writeJson(installedFile, installed);
      } else if (args[1] === 'install') {
        const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        const doc = readJson(installedFile, { version: 2, plugins: {} });
        doc.plugins[args[2]] = [{ scope: 'user', version: pkg.version }];
        writeJson(installedFile, doc);
      } else if (args[1] === 'uninstall') {
        const doc = readJson(installedFile, { version: 2, plugins: {} });
        delete doc.plugins[args[2]];
        writeJson(installedFile, doc);
      }
    },
  };
  const exec = {
    calls: [],
    run(cmd, args) {
      this.calls.push([cmd, ...args]);
      return fakes[cmd]?.(args) ?? { status: 0, stdout: '', stderr: '' };
    },
  };
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`, // node must stay findable for hooks/cage
    OATHE_HOME: path.join(home, '.oathe'),
    OATHE_DB: scratchDb,
    OATHE_PRINCIPAL: 'founder',
  };
  // The sandbox models a default machine. An outer environment that FORCES a runtime provider
  // (this workstream's own verification protocol runs the suite under OATHE_RUNTIME_PROVIDER)
  // must not leak into the modeled one — spawned CLIs would see the forced value instead of
  // auto-resolving, and fixture-hardcoded expectations like "requested auto" would silently
  // break depending on who happens to be running the tests.
  delete env.OATHE_RUNTIME_PROVIDER;
  // Same rule for the workspace-resolution ladder's inputs: a suite run INSIDE a harness
  // session (Claude Code sets CLAUDE_PROJECT_DIR) would otherwise resolve the developer's real
  // project and ACTIVATE it — fences written into the real tree by a test run.
  delete env.OATHE_WORKSPACE_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CURSOR_PROJECT_DIR;
  return { home, bin, env, exec };
}
