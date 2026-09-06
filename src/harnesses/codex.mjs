// oathe — the OpenAI Codex adapter (one host serves the CLI, the IDE extension, and the
// ChatGPT desktop app): three sanctioned CLIs register the install, and the config.toml
// stanza each one writes is the proof (its stanzas are Codex-managed bookkeeping — writing
// them by hand is how two managers end up owning one file). Every Codex-specific fact is a
// named member HERE. Codex allowlist-filters the env it hands MCP servers and documents no
// project-dir variable — the resolution ladder's cwd/refusal steps carry this harness.

import fs from 'node:fs';
import path from 'node:path';

import { Harness, HarnessOnboardError } from './harness.mjs';
import { cwdDialect } from './dialects.mjs';
import { CODEX_ROLLOUT_ROSTER, CODEX_CALL_TYPES, CORRELATABLE_ITEMS, CODEX_ROOT_AGENT_PATH, codexKindOf } from './codex-roster.mjs';
import { makeFidelity } from './fidelity.mjs';
import { CodexTraceStore } from '../traces.mjs';
import { shimPath } from '../shim.mjs';

/** The raw call payloads of a rollout — the fidelity extractors' one reading of actions. */
const codexRawCalls = (entries) => entries
  .filter((r) => r.type === 'response_item' && CODEX_CALL_TYPES.has(r.payload?.type))
  .map((r) => r.payload);
import { sha256Hex } from '../manifest.mjs';

// The id Codex knows the plugin by (plugin@marketplace) — the registrations install it and
// Codex keys its own hook-trust bookkeeping under it.
const PLUGIN_ID = 'oathe@oathe';

/** realpath when the path exists (macOS aliases /var → /private/var), else the normalized path. */
function realpathOr(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

export class CodexHarness extends Harness {
  static harnessName = 'codex';
  static displayName = 'Codex';
  static covers = 'CLI/Desktop App'; // ChatGPT desktop rides the same ~/.codex wiring
  static bin = 'codex';
  static clientNames = Object.freeze(['codex']);
  static contextFiles = Object.freeze(['AGENTS.md']);
  static projectDirEnvVar = null;
  static wiring = Object.freeze({ needsCli: true });
  static hooks = Object.freeze({ dialect: cwdDialect });
  // Codex buries hook output in its ctrl+T transcript overlay, unrendered — the launcher's
  // ANSI splash into terminal scrollback is this harness's quirk.
  static launch = Object.freeze({ splash: true, bin: 'codex' });
  // The ChatGPT desktop app embeds codex (…/ChatGPT.app/Contents/Resources/codex, live
  // trace 2026-08-30) — the SURFACE is chatgpt there, codex in a terminal.
  static surfaces = Object.freeze({
    ownsExec: (exec) => path.basename(exec) === 'codex',
    name: ({ appBundle }) => (appBundle !== null && path.basename(appBundle) === 'ChatGPT.app' ? 'chatgpt' : 'codex'),
    // The word each surface wears where work lives, and which of them is an app the glass
    // resumes INTO by opening it (ruling 2026-09-05): the desktop app has no folder — it IS
    // the place; a codex terminal is a folder's session.
    display: Object.freeze({ codex: 'Codex', chatgpt: 'ChatGPT' }),
    resumable: Object.freeze(['chatgpt']),
  });
  // Codex reads its global instructions before any work, in EVERY session — the one channel
  // that reaches a ChatGPT-desktop session, whose staging cwd carries no folder fence. Its
  // rule (docs, agents-md): AGENTS.override.md if it exists, otherwise AGENTS.md.
  static globalContextFiles = Object.freeze(['AGENTS.override.md', 'AGENTS.md']);
  // The ChatGPT desktop app runs every conversation from a directory it stages — not a project
  // folder — and it stages TWO ways (measured): a ChatGPT project under the config home
  // (`.chatgpt-projects/g-p-<id>`), and a "Codex work" conversation (rollout originator
  // codex_work_desktop, codex 0.153.4, 2026-09-06) under ~/Documents/Codex/<date>/<slug> with
  // outputs/ and work/ inside. Sessions there serve the FULL board and are never activated
  // (R-BOARD-SCOPE); these members are the only place the staging paths are spelled. A claim from
  // one is picked up by the app and says so in its place statement (the dir rides as evidence).
  // `originators` names the desktop in a rollout's session_meta so doctor can say when the app
  // moves again (traces.stagingDrift) — the day this list is stale, doctor says DRIFT, not a
  // claim silently picked up as a folder (B1, launch/2026-09-06-0.4.5-release-review.md).
  static synthetic = Object.freeze({
    dirs: (home) => [path.join(CodexHarness.configHomeFor(home), '.chatgpt-projects'), path.join(home, 'Documents', 'Codex')],
    originators: Object.freeze(['codex_work_desktop']),
  });

  static isSyntheticWorkspaceDir({ dir, home }) {
    const real = realpathOr(dir);
    return this.synthetic.dirs(home).some((parent) => real.startsWith(`${realpathOr(parent)}${path.sep}`));
  }

  // The CLI registers through hooks; the ChatGPT desktop app embeds codex and runs NONE —
  // its claims are admitted on discovery (the measured app bundle names the surface).
  static attestation = Object.freeze({ codex: 'hooks', chatgpt: 'hookless' });
  // The blocking exchange declared to the transport (ruling 2026-09-05): codex — and the
  // ChatGPT desktop app, which reads this same config.toml — caps a tool call at
  // `tool_timeout_sec` (default 60, codex/mcp.md:178; no documented maximum), and a `done`
  // waits minutes for its verdict. `codex mcp add` has no timeout flag and a re-add drops a
  // hand-written key (probed live, codex-cli 0.150.0), so onboard STAMPS the line into the
  // stanza after every add and the proof carries it.
  static mcpToolTimeout = Object.freeze({ key: 'tool_timeout_sec', unit: 'sec' });
  // `codex update` — "Update Codex to the latest version" (codex --help, 0.150.0, 2026-09-05).
  static install = Object.freeze({ npm: '@openai/codex', bin: 'codex', versionArgs: ['--version'], update: (address) => [address, ['update']] });
  // Non-interactive auth: CODEX_API_KEY "provides an API key to a non-interactive Codex
  // process" (codex/environment-variables.md:49, pinned 2026-08-29).
  static headless = Object.freeze({
    auth: ['CODEX_API_KEY'],
    command: (prompt, model = null) => ['codex', ['exec', '--skip-git-repo-check', ...(model ? ['-m', model] : []), prompt]],
    extract: (stdout) => stdout,
    // Live 2026-09-05 (codex-cli 0.150.0): "The 'gpt-6-astra' model requires a newer version of
    // Codex. Please upgrade to the latest app or CLI and try again." — the one cause we act on.
    diagnose: (stderrTail) => (/requires a newer version of Codex/i.test(String(stderrTail ?? '')) ? 'outdated' : null),
  });
  static traces = Object.freeze({
    store: ({ home } = {}) => new CodexTraceStore({ home, harness: this.harnessName }),
    newest: (store) => store.newestRollout(),
    projector: async ({ store }) => new (await import('./codex-rollout.mjs')).CodexAtifProjector({ store }),
    ownsPath: (file) => String(file).includes(`${path.sep}.codex${path.sep}`),
    // The gate on the staging convention: a desktop rollout (session_meta.originator names the
    // desktop) that ran from a dir this adapter does not know as staging is DRIFT, named — read
    // by doctor over the newest rollout. Null for a terminal session (it runs anywhere) or a
    // known staging dir.
    stagingDrift: (described, { home }) => (CodexHarness.synthetic.originators.includes(described.originator)
      && !CodexHarness.isSyntheticWorkspaceDir({ dir: described.cwd ?? '', home })
      ? `desktop rollout ${described.path} ran from ${described.cwd} — not a staging dir this adapter knows (synthetic.dirs): ChatGPT moved its staging convention; measure it and add it`
      : null),
    roster: CODEX_ROLLOUT_ROSTER,
    kindOf: codexKindOf,
    recent: (store, { days, maxFiles }) => store.recentRollouts({ days, maxFiles }),
    // Harbor's converter for this harness (AgentName 'codex') reads a trial's rollouts from
    // <logs_dir>/sessions — the mirror of ~/.codex/sessions (harbor 0.22.0, measured 2026-09-01).
    harbor: Object.freeze({ agent: 'codex', sessions: Object.freeze({ home: '.codex/sessions', logs: 'sessions' }) }),
    fidelity: makeFidelity({
      // hasSource judges what the raw record actually ARGUES: a legitimately empty argument
      // set (list_agents "{}" — and a single inner tools.x({}) call in exec source) projects
      // empty faithfully; only a record that carries content demands the projection carry it.
      rawCalls: async (entries) => {
        const { ExecCallReader } = await import('./codex-rollout.mjs');
        const reader = new ExecCallReader();
        const hasContent = (v) => {
          if (v == null) return false;
          if (typeof v === 'string') return !['', '{}', '[]', 'null'].includes(v.trim());
          return typeof v === 'object' ? Object.keys(v).length > 0 : Boolean(v);
        };
        return codexRawCalls(entries).map((p) => {
          if (p.type === 'custom_tool_call' && typeof p.input === 'string' && p.input.trim() !== '') {
            const inner = reader.read(p.input);
            const single = inner.length === 1 && inner[0].args !== null ? inner[0] : null;
            const argful = single
              ? (typeof single.args === 'object' ? Object.keys(single.args).length > 0 : true)
              : true; // multi-call or unparseable source projects as {input: raw} — never empty
            return { id: p.call_id, hasSource: argful };
          }
          return { id: p.call_id, hasSource: hasContent(p.arguments) || hasContent(p.action) };
        });
      },
      // Usage the record actually CARRIES: a token_count with info: null (a documented vendor
      // state) owes the projection nothing.
      hasRawTokens: (entries) => entries.some((r) => r.type === 'event_msg' && r.payload?.type === 'token_count' && r.payload.info?.last_token_usage),
      // Applicability is a REAL act, not chatter: only an inner tools.<oathe verb>(...) call
      // (or a composed function_call name) counts — a grep ABOUT oathe_claim is not a claim.
      hasOatheActs: async (entries) => {
        const [{ ExecCallReader }, { oatheVerbFor }] = await Promise.all([
          import('./codex-rollout.mjs'), import('../oathe-annotator.mjs')]);
        const reader = new ExecCallReader();
        return codexRawCalls(entries).some((p) => {
          if (p.type === 'custom_tool_call' && typeof p.input === 'string') {
            return reader.read(p.input).some((call) => oatheVerbFor(call.tool) !== null);
          }
          if (!p.name) return false;
          const composed = p.namespace ? `${p.namespace}__${String(p.name).replace(/^_/, '')}` : p.name;
          return oatheVerbFor(composed) !== null;
        });
      },
      childIds: (entries, trajectory, { store }) => store.childThreads(trajectory.session_id).map((c) => c.thread_id),
      // The items that complete a call — the second source the cross-source probe checks.
      rawItems: (entries) => entries
        .filter((r) => r.type === 'event_msg' && r.payload?.type === 'item_completed' && CORRELATABLE_ITEMS.has(r.payload.item?.type))
        .map((r) => ({ type: r.payload.item.type, id: r.payload.item.id })),
      // Messages addressed TO this thread on the inter-agent bus (self = the spawn's agent
      // path, else the root) — never this agent's own words.
      inboundTexts: (entries) => {
        const self = entries[0]?.payload?.source?.subagent?.thread_spawn?.agent_path ?? CODEX_ROOT_AGENT_PATH;
        return entries
          .filter((r) => r.type === 'response_item' && r.payload?.type === 'agent_message' && r.payload.recipient === self)
          .map((r) => (r.payload.content ?? []).map((p) => p?.text ?? '').join('\n'));
      },
    }),
  });
  static docs = Object.freeze([
    'codex/mcp', 'codex/config-reference', 'codex/environment-variables', 'codex/agents-md', 'codex/hooks',
    'codex/projects', 'codex/plugins', 'codex/submit-claude-plugin',
  ]);

  constructor(o) {
    super({ ...o, name: 'codex' });
  }

  get configPath() {
    return path.join(this.configHome, 'config.toml');
  }

  /** The budget line the mcp stanza carries — valued from config, never a literal second. */
  #timeoutLine() {
    if (!this.config) {
      throw new HarnessOnboardError('CODEX_CONFIG_REQUIRED',
        `the codex MCP stanza carries ${this.constructor.mcpToolTimeout.key} from config (mcpToolTimeoutSec) — `
        + 'this adapter was built without one', {});
    }
    return `${this.constructor.mcpToolTimeout.key} = ${this.config.get('mcpToolTimeoutSec')}`;
  }

  /**
   * The sanctioned registrations, each with the CLI that makes it, the config.toml lines that
   * prove it landed (every one must be present — doctor checks each), the CLI that undoes it,
   * and, for the MCP server, the line the adapter stamps after the CLI's write.
   */
  #registrations() {
    return [
      {
        id: 'marketplace',
        add: ['plugin', 'marketplace', 'add', this.paths.packageRoot],
        proofs: ['[marketplaces.oathe]'],
        undo: ['plugin', 'marketplace', 'remove', 'oathe'],
      },
      {
        id: 'plugin',
        add: ['plugin', 'add', PLUGIN_ID],
        proofs: [`[plugins."${PLUGIN_ID}"]`],
        undo: ['plugin', 'remove', PLUGIN_ID],
      },
      {
        id: 'mcp-server',
        // The shim, literal: config.toml has no interpolation (codex/config-reference.md,
        // pinned), and the ChatGPT desktop app reads this same config (codex/mcp.md) — one
        // write serves both. A bare `oathe` died on every GUI PATH (2026-09-04). The proofs
        // are the COMMAND LINE, not the stanza (review F3): a re-add that drops the address
        // back to bare must read as drift in doctor, never as ok over a dead lane — and the
        // timeout line, because a re-add drops it (2026-09-05).
        add: ['mcp', 'add', 'oathe', '--', shimPath(this.home), 'mcp'],
        proofs: [`command = "${shimPath(this.home)}"`, this.#timeoutLine()],
        stamp: this.#timeoutLine(),
        undo: ['mcp', 'remove', 'oathe'],
      },
    ];
  }

  /** What init writes — from the registrations the CLI makes and the global fence target. */
  describe() {
    const globals = this.constructor.globalContextFiles.map((f) => path.join(this.configHome, f)).join(' (or ');
    const regs = this.#registrations();
    const mcp = regs.find((r) => r.id === 'mcp-server');
    return [
      `${this.configPath}: ${regs.flatMap((r) => r.proofs).join(', ')} via the codex CLI (marketplace, plugin, MCP server → ${mcp.add.slice(mcp.add.indexOf('--') + 1).join(' ')}; `
        + `${mcp.stamp} stamped into the stanza — the budget a blocking done waits inside, config mcpToolTimeoutSec)`,
      `${globals}${this.constructor.globalContextFiles.length > 1 ? ')' : ''}: the standing Oathe rule for every Codex session — ChatGPT desktop reads it too`,
    ];
  }

  onboard({ manifest, version }) {
    manifest.backupOnce(this.configPath);
    for (const reg of this.#registrations()) {
      let result = this.exec.run('codex', reg.add);
      // UPGRADE PATH: the package root MOVED (an nvm node switch, npm link) — the CLI refuses a
      // marketplace "already added from a different source". Re-register from this root: the
      // undo the manifest already records, then the add again, proof-checked below.
      if (result.status !== 0 && /already added from a different source/.test(result.stderr)) {
        this.exec.run('codex', reg.undo); // result unread: the add that follows is the proof — its failure is the typed refusal below, and the config's proof string is checked after it
        result = this.exec.run('codex', reg.add);
      }
      if (result.status !== 0) {
        throw new HarnessOnboardError('CODEX_CLI_FAILED',
          `codex ${reg.add.join(' ')} exited ${result.status}: ${result.stderr.trim()}`, { reg: reg.id });
      }
      if (reg.stamp) this.#stampInStanza('[mcp_servers.oathe]', reg.stamp);
      const config = fs.existsSync(this.configPath) ? fs.readFileSync(this.configPath, 'utf8') : '';
      const missing = reg.proofs.find((p) => !config.includes(p));
      if (missing !== undefined) {
        throw new HarnessOnboardError('CODEX_VERIFICATION_FAILED',
          `verification failed: codex ${reg.add.join(' ')} reported success but ${this.configPath} `
          + `carries no ${missing} line — refusing to record an install that cannot be proven`,
          { reg: reg.id });
      }
      manifest.upsert({
        harness: this.name,
        file: this.configPath,
        kind: 'cli-managed',
        detail: { id: reg.id, proofs: reg.proofs, undo: reg.undo },
        blockVersion: version,
        sha256: sha256Hex(reg.proofs.join('\n')),
      });
    }
    return this.#registrations().map((r) => ({ action: `codex-${r.id}` }));
  }

  /**
   * Converge ONE `key = value` line inside a stanza the CLI owns: replace the key's line if the
   * stanza has one, else append it at the stanza's end; every other line stays byte-identical.
   * The one hand-write on this file besides the hooks-state sweep, for the one key the CLI
   * cannot be told and does not keep.
   */
  #stampInStanza(header, line) {
    const key = line.split('=')[0].trim();
    const lines = fs.readFileSync(this.configPath, 'utf8').split('\n');
    const start = lines.findIndex((l) => l.trim() === header);
    if (start === -1) return; // no stanza: the proof check below names the failure
    let end = lines.findIndex((l, i) => i > start && l.trimStart().startsWith('['));
    if (end === -1) end = lines.length;
    const existing = lines.findIndex((l, i) => i > start && i < end && l.split('=')[0].trim() === key);
    if (existing !== -1) {
      lines[existing] = line;
    } else {
      // Insert after the stanza's last non-blank line, keeping any trailing blank spacing.
      let at = end;
      while (at > start + 1 && lines[at - 1].trim() === '') at -= 1;
      lines.splice(at, 0, line);
    }
    if (lines.at(-1) !== '') lines.push(''); // a toml file ends in a newline, whatever the CLI left
    fs.writeFileSync(this.configPath, lines.join('\n'));
  }

  offboard({ manifest }) {
    const rows = this.takeWiringRows(manifest);
    const actions = [];
    // Undo in reverse install order, so the plugin is gone before its marketplace is.
    for (const row of rows.reverse()) {
      const undo = row.detail?.undo;
      if (!undo) continue;
      const result = this.exec.run('codex', undo);
      actions.push({ action: `codex-undo-${row.detail.id}`, status: result.status });
    }
    // Codex keys hook-trust records under our plugin id; the undo CLIs orphan them, and an
    // orphan carrying 'oathe' is still an oathe entry on this surface (ruling 2026-08-29:
    // delete exactly the keys prefixed by our id, touch nothing else).
    if (this.#clearHooksState() > 0) actions.push({ action: 'codex-hooks-state-cleared', status: 0 });
    return actions;
  }

  /** Remove the `[hooks.state."<PLUGIN_ID>:…"]` tables from config.toml; every other line stays. */
  #clearHooksState() {
    if (!fs.existsSync(this.configPath)) return 0;
    const prefix = `[hooks.state."${PLUGIN_ID}:`;
    const kept = [];
    let removed = 0;
    let skipping = false;
    for (const line of fs.readFileSync(this.configPath, 'utf8').split('\n')) {
      if (line.trimStart().startsWith('[')) {
        skipping = line.trimStart().startsWith(prefix);
        if (skipping) removed += 1;
      }
      if (!skipping) kept.push(line);
    }
    if (removed > 0) fs.writeFileSync(this.configPath, kept.join('\n'));
    return removed;
  }
}
