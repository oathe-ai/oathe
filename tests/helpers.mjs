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
  const exec = {
    calls: [],
    run(cmd, args) {
      this.calls.push([cmd, ...args]);
      const prior = fs.readFileSync(configPath, 'utf8');
      const stanza = { marketplace: '[marketplaces.oathe]', add: '[plugins."oathe@oathe"]', mcp: '[mcp_servers.oathe]' };
      const key = args[0] === 'mcp' ? 'mcp' : (args[1] === 'marketplace' ? 'marketplace' : 'add');
      const line = stanza[key];
      if (args.includes('remove')) fs.writeFileSync(configPath, prior.replace(`${line}\n`, ''));
      else if (!prior.includes(line)) fs.writeFileSync(configPath, `${prior}${line}\n`);
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
  return { home, bin, env, exec };
}
