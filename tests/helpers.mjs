// Shared test scaffolding: a sandbox HOME with both harnesses present (codex CLI faked to
// mirror what the real one writes), and scratch-substrate helpers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {{scratchDb: string, claudeScript?: string}} o
 *   claudeScript: shell body for the fake `claude` binary (default: print and exit 0)
 */
export function sandbox({ scratchDb, claudeScript = 'echo fake-claude; exit 0' }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-sb-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.claude/settings.json'),
    `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`);
  fs.writeFileSync(path.join(home, '.codex/config.toml'), '# user config\n');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${claudeScript}\n`);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n');
  for (const name of ['claude', 'codex']) fs.chmodSync(path.join(bin, name), 0o755);

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
      if (args.includes('remove')) fs.writeFileSync(configPath, prior.replace(`${line}\n`, ''));
      else if (!prior.includes(line)) fs.writeFileSync(configPath, `${prior}${line}\n`);
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
      fakes[cmd]?.(args);
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`, // node must stay findable for hooks/cage
    OATHE_HOME: path.join(home, '.oathe'),
    OATHE_DB: scratchDb,
    OATHE_PRINCIPAL: 'firia',
  };
  // The sandbox models a default machine. An outer environment that FORCES a runtime provider
  // (this workstream's own verification protocol runs the suite under OATHE_RUNTIME_PROVIDER)
  // must not leak into the modeled one — spawned CLIs would see the forced value instead of
  // auto-resolving, and fixture-hardcoded expectations like "requested auto" would silently
  // break depending on who happens to be running the tests.
  delete env.OATHE_RUNTIME_PROVIDER;
  return { home, bin, env, exec };
}
