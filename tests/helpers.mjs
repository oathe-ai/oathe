// Shared test scaffolding: a sandbox HOME with every harness's config home and fake claude/codex
// bins (the codex CLI faked to mirror what the real one writes), and scratch-substrate helpers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { notchLabel } from '../src/notch.mjs';
import { serveLabel } from '../src/serve.mjs';

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
      // Both supervised services: a leaked KeepAlive daemon outlives the temp dir forever.
      spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${notchLabel(home)}`], { stdio: 'ignore' });
      spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${serveLabel(home)}`], { stdio: 'ignore' });
    }
  });
}

/**
 * A minimal Claude transcript (one tool call, one result) in Claude's store layout — a file
 * the claude trace store OWNS and can project (ownership is by path), under a scratch home.
 * @param {{taskId: string, home?: string}} o  home: the HOME to plant it under (default: a scratch dir)
 * @returns {{file: string, sessionId: string}}
 */
export function writeClaudeTranscript({ taskId, home = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-trace-')) }) {
  const dir = path.join(home, '.claude', 'projects', 'fixture');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${taskId}.jsonl`);
  const sessionId = randomUUID();
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId, cwd: dir, message: { role: 'user', content: 'work' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId, cwd: dir,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'make it' } }] } }),
    JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId, cwd: dir,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'made it\nExit code 0' }] } }),
  ].join('\n'));
  return { file, sessionId };
}

/**
 * ONE claim interval's worth of evidence: a minimal Claude transcript (one tool call, one
 * result — what the verifier lane needs to judge at all) in Claude's store layout (ownership
 * is by path), linked to the claim by the same trace-link statement the heartbeat writes.
 * @param {{substrate: {query: Function}, taskId: string, workClaimId: string, principal: string, orgId?: string}} o
 * @returns {Promise<{file: string, sessionId: string}>}
 */
export async function linkClaudeTrace({ substrate, taskId, workClaimId, principal, orgId = 'oathe' }) {
  const { file, sessionId } = writeClaudeTranscript({ taskId });
  await substrate.query(
    `INSERT INTO cell.agent_statement (statement_id, org_id, task_id, work_claim_id,
            execution_actor, claim_principal, statement_type, subject_ref, proposition,
            evidence_refs, epistemic_status, asserted_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'progress', $7, 'trace', $8::jsonb, 'observed', now())`,
    [randomUUID(), orgId, taskId, workClaimId, `session:${sessionId}`, principal, `trace:${sessionId}`,
      JSON.stringify([file])]);
  return { file, sessionId };
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
  // launchd as it answers a wired agent: bootstrap loads the label, bootout drops it, and
  // print names a pid for a loaded job — the running notch init and doctor read from launchd.
  const loaded = new Set();
  const label = (target) => String(target).split('/').at(-1);
  const fakes = {
    launchctl: (args) => {
      if (args[0] === 'bootstrap') { loaded.add(path.basename(args[2], '.plist')); return { status: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'bootout') { loaded.delete(label(args[1])); return { status: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'print') {
        return loaded.has(label(args[1])) ? { status: 0, stdout: '\tstate = running\n\tpid = 4242\n', stderr: '' }
          : { status: 113, stdout: '', stderr: `Could not find service "${label(args[1])}" in domain for user gui: 501\n` };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    codex(args) {
      const prior = fs.readFileSync(configPath, 'utf8');
      const stanza = { marketplace: '[marketplaces.oathe]', add: '[plugins."oathe@oathe"]', mcp: '[mcp_servers.oathe]' };
      const key = args[0] === 'mcp' ? 'mcp' : (args[1] === 'marketplace' ? 'marketplace' : 'add');
      const line = stanza[key];
      if (args.includes('remove')) {
        // A marketplace stanza carries its source line; an mcp stanza its command (as the
        // real config.toml does).
        const pattern = key === 'marketplace' ? new RegExp(`\\[marketplaces\\.oathe\\]\\n(source = "[^"]*"\\n)?`)
          : key === 'mcp' ? new RegExp(`\\[mcp_servers\\.oathe\\]\\n(command = "[^"]*"\\n)?`)
            : `${line}\n`;
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
      if (key === 'mcp') {
        // `codex mcp add <name> -- <command> <args…>` records the command it was handed.
        const command = args[args.indexOf('--') + 1];
        const next = prior.includes(line) ? prior.replace(new RegExp(`(\\[mcp_servers\\.oathe\\]\\n)command = "[^"]*"\\n`), `$1command = "${command}"\n`)
          : `${prior}${line}\ncommand = "${command}"\n`;
        if (next !== prior) fs.writeFileSync(configPath, next);
        return { status: 0, stdout: '', stderr: '' };
      }
      if (!prior.includes(line)) fs.writeFileSync(configPath, `${prior}${line}\n`);
      return { status: 0, stdout: '', stderr: '' };
    },
    claude(args) {
      const marketplacesFile = path.join(registryDir, 'known_marketplaces.json');
      const installedFile = path.join(registryDir, 'installed_plugins.json');
      // `claude mcp add -s user <name> -- <command> <args…>` lands in ~/.claude.json —
      // the user scope's home (claude-code/mcp.md, pinned).
      const claudeJson = path.join(home, '.claude.json');
      if (args[0] === 'mcp' && args[1] === 'add') {
        const doc = readJson(claudeJson, {});
        const sep = args.indexOf('--');
        doc.mcpServers = { ...doc.mcpServers, [args[sep - 1]]: { command: args[sep + 1], args: args.slice(sep + 2) } };
        writeJson(claudeJson, doc);
        return;
      }
      if (args[0] === 'mcp' && args[1] === 'remove') {
        const doc = readJson(claudeJson, {});
        delete doc.mcpServers?.[args[2]];
        writeJson(claudeJson, doc);
        return;
      }
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

/**
 * The codex thread-index lanes need node:sqlite. On any SUPPORTED runtime (engines.node
 * >= 22.13.0, executed at the bin door by src/node-floor.mjs) it exists — so this never
 * fires there; on a below-floor runner the codex lanes go RED with the floor named, never
 * silently green (the silent `{ skip: NO_SQLITE }` hid the whole codex drift net, 2026-08-31).
 */
export function requireSqlite() {
  if (typeof process.getBuiltinModule === 'function' && process.getBuiltinModule('node:sqlite')) return;
  const err = new Error(
    `node ${process.version} has no node:sqlite — oathe supports node >= 22.13.0 (package.json engines.node); `
    + 'the codex trace lanes cannot be skipped on an unsupported runtime, only failed');
  err.code = 'OATHE_TEST_RUNTIME_BELOW_FLOOR';
  throw err;
}
