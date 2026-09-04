#!/usr/bin/env node
// oathe — the subcommand router. Deliberate divergence from the monorepo's env-only bins:
// oathe is a USER tool, so it speaks argv (node:util parseArgs); it keeps the runtime's
// machine-parseable summary line (`oathe: <verb> <status>`) as the last line of every run.

import { parseArgs } from 'node:util';

import { byName, launchable, verifierCapable } from '../src/harnesses/catalog.mjs';

const VERBS = ['init', ...launchable(), 'claim', 'ls', 'note', 'amend', 'done', 'verify', 'trace', 'notch', 'yield', 'config', 'doctor', 'uninstall', 'status', 'version', 'update', 'hook', 'mcp', 'serve'];

const USAGE = `usage: oathe <verb> [args]

verbs:
  init [--harness a,b] [--yes] bring up the local cell substrate + wire the harnesses you pick
${launchable().map((name) => `  ${name.padEnd(6)} [--hermetic] [args…]  ${byName(name).displayName} here as one tracked attempt (what the notch's continue runs; plain ${byName(name).launch.bin} works too)`).join('\n')}
  claim <task-id> [objective]  claim a task (minting it when new — objective required then)
  ls [--all]                   this workspace's board (--all: every workspace)
  note <task-id> <text> [ref]  record a progress statement against your active claim
  amend <task> "<objective>" "<why>"  change what done means, on the record (active claim only)
  done <task-id> <what> [ref]  assert completion (a completion statement + the substrate's terminal)
  verify [task] [--all] [--engine ${verifierCapable().join('|')}]  run the verification lane (non-author seat settles)
  trace <task-id> [--out dir]  export the claim's linked session traces as ATIF trajectories
  notch [--welcome]            the whole machine's board + breach digest, pure JSON (only shows); --welcome replays the one-time welcome on the glass
  yield <task-id> <note>       yield: the task goes back on the board, unowned
  doctor [--surface]           verify every managed surface (--surface: the resolution report only)
  status                       the substrate half of doctor
  version                      the package version on PATH
  update [--yes] [--harness a,b]  the upgrade as one verb: npm i -g @oathe/oathe@latest through this node's npm, then init through the new bin
  config <key> [value] [--global]  read or write a config key (workspace scope by default)
  uninstall [--purge-db]       remove exactly what init recorded (the database stays put)
  hook <name> · mcp · serve    internal: the hook/server entry points and the device daemon (shim-addressed)
`;

function summary(verb, status) {
  process.stdout.write(`oathe: ${verb} ${status}\n`);
}

/**
 * The one line a speech act prints when it RESUMED rejected work first (ruling 2026-09-04:
 * the verdict hands the work back; the act is the principal speaking) — the reclaim is on
 * the record, so is the verdict it answers. Empty when the act spoke against a held claim.
 */
function reclaimLine(out) {
  if (!out.reclaimed) return '';
  const why = out.rejection?.reason ? ` — ${out.rejection.reason}` : '';
  return `reclaimed: ${out.task_id} (lease ${out.lease})${why}\n`;
}

function fail(verb, e) {
  process.stderr.write(`${e?.code ? `[${e.code}] ` : ''}${e?.message || e}\n`);
  // A typed code is a refusal by definition (the OATHE_* vocabulary, docs/PRODUCT.md); the
  // message words are the fallback for untyped refusals the older verbs still raise.
  const status = /^OATHE_/.test(String(e?.code ?? '')) || /refus|REFUSED|already|second|active claim/i.test(String(e?.message)) ? 'refused' : 'error';
  process.stderr.write(`oathe: ${verb} ${status}\n`);
  process.exit(1);
}

// An unknown flag refuses loudly with the verb's usable flags, derived from the same options
// the verb parses with — never a raw parse error (fresh-user-trial ruling, 2026-08-29).
function parseFlags(verb, spec) {
  try {
    return parseArgs(spec);
  } catch (e) {
    if (e?.code !== 'ERR_PARSE_ARGS_UNKNOWN_OPTION') throw e;
    const flags = Object.entries(spec.options ?? {})
      .map(([name, opt]) => `--${name}${opt.type === 'string' ? ' <value>' : ''}`).join(', ');
    const flag = /'(--?[^']*)'/.exec(e.message)?.[1] ?? 'flag';
    const err = new Error(`unknown option '${flag}' refused — ${verb} takes: ${flags || 'no flags'}`);
    err.code = 'OATHE_UNKNOWN_FLAG';
    throw err;
  }
}

async function toolsForCwd(env = process.env) {
  const [{ buildContext }, { createOatheTools }, { WorkspaceResolver }, { WorkspaceRegistry }, { ActivationSeam }, { homeOf }, { resolveSpeaker }, { verifierSeam }] = await Promise.all([
    import('../src/context.mjs'), import('../src/mcp/oathe-tools.mjs'), import('../src/workspace-resolver.mjs'),
    import('../src/registry.mjs'), import('../src/activation.mjs'), import('../src/paths.mjs'),
    import('../src/speaker.mjs'), import('../src/verify-dispatch.mjs'),
  ]);
  const ctx = buildContext({ env });
  // The terminal IS the workspace: its facts (ref, synthetic) come from the one describer, and
  // every verb registers it centrally through the one seam — claim activates (fences included).
  const cwd = process.cwd();
  const place = WorkspaceResolver.describe({ dir: cwd, home: homeOf(env) });
  return {
    ctx,
    tools: createOatheTools({
      client: ctx.substrate,
      identity: ctx.identity,
      config: ctx.config,
      workspace: place.ref,
      synthetic: place.synthetic,
      // A CLI verb run from inside a harness session's shell speaks FOR that session — the
      // ancestry reaches the registered harness pid; a bare terminal resolves to nulls.
      speaker: resolveSpeaker({ sessionsPath: ctx.paths.sessionsPath, devicePath: ctx.paths.devicePath }),
      // ONE verifier seam, every surface: done's auto-dispatch works from the CLI too.
      verifier: verifierSeam({
        orgId: ctx.identity.orgId,
        query: (sql, params) => ctx.substrate.query(sql, params),
        paths: ctx.paths,
        cwd,
      }),
      activation: new ActivationSeam({
        cwd,
        env,
        registry: new WorkspaceRegistry({ registryPath: ctx.paths.registryPath }),
        manifest: ctx.manifest,
        config: ctx.config,
        version: ctx.version,
        synthetic: place.synthetic,
        sourceFor: (tool) => `cli:${tool.replace(/^oathe_/, '')}`,
      }),
    }),
  };
}

const handlers = {
  async init(argv) {
    const { values } = parseFlags('init', {
      args: argv,
      options: { harness: { type: 'string' }, yes: { type: 'boolean', default: false } },
      allowPositionals: false,
    });
    const { runInit } = await import('../src/init.mjs');
    const result = await runInit({
      harnessFilter: values.harness ? values.harness.split(',').map((s) => s.trim()).filter(Boolean) : null,
      assumeYes: values.yes === true,
    });
    process.stdout.write('oathe init — done\n');
    for (const step of result.steps) {
      // Paths were disclosed on the screen before Enter; `oathe doctor` is the audit (ruling 2026-08-29).
      const detail = step.outcome === 'wired' ? 'wired'
        : step.outcome === 'unwired' ? 'unwired'
        : `skipped — ${step.reason}`;
      process.stdout.write(`  ${step.displayName.padEnd(13)} ${detail}\n`);
    }
    process.stdout.write(`  verifier      ${result.verifier_engine.chosen}\n`);
    const s = result.substrate;
    process.stdout.write(`  substrate: db up, ddl ${s.ddl_applied}/${s.ddl_expected} applied `
      + `(source: ${s.ddl_source}), yield cause ${s.yield_cause_registered ? 'registered' : 'MISSING'}\n`);
    process.stdout.write(`  principal: ${result.principal.principal_id} (${result.principal.role})\n`);
    process.stdout.write(`  device: ${result.device.device_id} (${result.device.minted ? 'minted' : 'kept'})\n`);
    // The notch is a surface the person looks at, and the daemon is what every session
    // forwards to: each state is said from launchd, and a dead one is attention, never
    // folded into ok.
    const glass = result.actions.find((a) => a.harness === 'notch' && /^notch-(running|not-running)$/.test(a.action));
    if (glass) {
      process.stdout.write(glass.action === 'notch-running'
        ? `  notch: running (pid ${glass.pid})\n`
        : `  notch: NOT RUNNING — launchd: ${glass.detail} (${glass.label}); run \`oathe init\` again, or \`oathe doctor\`\n`);
    }
    const dmn = result.actions.find((a) => a.harness === 'serve' && /^serve-(running|not-running)$/.test(a.action));
    if (dmn) {
      process.stdout.write(dmn.action === 'serve-running'
        ? `  daemon: running (pid ${dmn.pid})\n`
        : `  daemon: NOT RUNNING — launchd: ${dmn.detail} (${dmn.label}); run \`oathe init\` again, or \`oathe doctor\`\n`);
    }
    // The surface note lives here, once: the screen showed only the row.
    for (const surface of result.surfaces.filter((x) => x.detected)) {
      process.stdout.write(`\n${surface.displayName} — detected; nothing to wire:\n${surface.steps.split('\n').map((l) => `  ${l}`).join('\n')}\n`);
    }
    // The moment after init (live polish #7): what to do next, coloured only on a TTY.
    const tty = process.stdout.isTTY === true;
    const [B, R] = tty ? ['\x1b[1m', '\x1b[0m'] : ['', ''];
    // The harness itself is the way in — the plugin rides every session (the launcher is the notch's).
    const bins = launchable().map((name) => byName(name).launch.bin);
    process.stdout.write(`\n  Next: ${B}${bins.slice(0, -1).join(', ')} or ${bins.at(-1)}${R} in any project — the board rides every session.\n`);
    summary('init', glass?.action === 'notch-not-running' ? 'attention' : 'ok');
  },


  async hook(argv) {
    const scripts = {
      'render-board': 'render-board.mjs', heartbeat: 'heartbeat.mjs', 'frame-note': 'frame-note.mjs',
    };
    const script = scripts[argv[0]];
    if (!script) throw new Error(`usage: oathe hook <${Object.keys(scripts).join('|')}>`);
    const { buildPaths } = await import('../src/paths.mjs');
    // The hook module runs on import (reads stdin, writes its frame, exits 0 itself).
    await import(`${buildPaths(process.env).pluginDir}/hooks/${script}`);
  },

  async mcp() {
    const { main } = await import('../src/mcp/oathe-tools.mjs');
    await main();
  },

  // The device daemon (connection-lane phase 2): launchd runs this through the shim; every
  // `oathe mcp` forwards to it when it answers. Long-running like mcp — no trailer on the
  // happy path; a refusal (a daemon already serving) throws typed and trails as error.
  async serve() {
    const [{ OatheDaemon }, { serveSocketPath }, { OatheConfig }, { buildPaths }] = await Promise.all([
      import('../src/mcp/daemon.mjs'), import('../src/serve.mjs'), import('../src/config.mjs'), import('../src/paths.mjs'),
    ]);
    const config = OatheConfig.global({});
    const daemon = new OatheDaemon({
      env: process.env,
      socketPath: serveSocketPath(buildPaths(process.env), config),
    });
    await daemon.start();
    // launchd ends the daemon with SIGTERM on bootout — close the connections and the
    // socket cleanly; forwarders' pipes end with us and their sessions respawn.
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => { daemon.close().finally(() => process.exit(0)); });
    }
  },

  async claim(argv) {
    const [taskId, objective] = argv;
    if (!taskId) throw new Error('usage: oathe claim <task-id> [objective]');
    const { ctx, tools } = await toolsForCwd();
    try {
      const out = await tools.oathe_claim({ task_id: taskId, objective });
      process.stdout.write(`claimed: ${out.task_id} (lease ${out.lease}) — ${out.note}${out.lineage ? ` — spawned under ${out.lineage.parent}` : ''}\n`);
      // An admitted session-less claim (a surface with no hooks) says so, and the run is attention.
      const unattributed = out.spoken_from?.session === null && out.trace_link?.why;
      if (unattributed) process.stdout.write(`unattributed: ${out.trace_link.why}\n`);
      summary('claim', unattributed ? 'attention' : 'ok');
    } finally {
      await ctx.substrate.close();
    }
  },

  async ls(argv) {
    const { values } = parseFlags('ls', {
      args: argv, options: { all: { type: 'boolean', default: false } }, allowPositionals: true,
    });
    const { ctx, tools } = await toolsForCwd();
    try {
      const { sections, workspace } = await tools.oathe_board({ all: values.all === true });
      process.stdout.write(`board${workspace ? ` (${workspace})` : ' (all workspaces)'}:\n`);
      const listed = [...sections.mine, ...sections.open, ...sections.asserted, ...sections.held];
      if (listed.length === 0) process.stdout.write('  (none — a clean slate)\n');
      const { JUDGMENT } = await import('../src/breach-digest.mjs');
      for (const r of listed) {
        // An asserted row says which judgment it awaits (UX rule 22) — the one table's word.
        const holder = r.state === 'active' ? `${r.principal_id}, lease until ${r.lease_until}`
          : r.judgment ? JUDGMENT[r.judgment].word : (r.state ?? 'open');
        process.stdout.write(`  [${(r.state ?? 'open').padEnd(8)}] ${r.task_id} — ${r.objective} (${holder})\n`);
      }
      // UX rule 18: the terminal is the uncapped pull — every breached promise on the machine,
      // one line per task or sibling group (a group's children under it), no flag: the models
      // that script the CLI look here when a `+N more` points them at it.
      const [{ Pager }, { WorkspaceRegistry }, { rowLine }, { MACHINE_SCOPE_LABEL }] = await Promise.all([
        import('../src/pager.mjs'), import('../src/registry.mjs'), import('../src/breach-digest.mjs'), import('../src/board-render.mjs'),
      ]);
      const registry = new WorkspaceRegistry({ registryPath: ctx.paths.registryPath });
      const digest = await new Pager({ client: ctx.substrate, identity: ctx.identity, config: ctx.config, registry }).digest();
      if (digest.total > 0) {
        process.stdout.write(`breached (${MACHINE_SCOPE_LABEL}):\n`);
        for (const g of digest.groups) {
          process.stdout.write(`  [${g.kind_word}] ${g.task_id} — ${g.objective} (${rowLine(g)} · ${g.home})\n`);
          if (g.group) for (const line of g.detail.split('\n')) process.stdout.write(`    ${line}\n`);
        }
      }
      summary('ls', 'ok');
    } finally {
      await ctx.substrate.close();
    }
  },

  async amend(argv) {
    const [taskId, objective, why] = argv;
    if (!taskId || !objective || !why) throw new Error('usage: oathe amend <task-id> "<new objective>" "<why>"');
    const { ctx, tools } = await toolsForCwd();
    try {
      const out = await tools.oathe_amend({ task_id: taskId, objective, why });
      process.stdout.write(`${reclaimLine(out)}amended to v${out.version} — ${out.note}\n`);
      summary('amend', 'ok');
    } finally {
      await ctx.substrate.close();
    }
  },

  async note(argv) {
    const [taskId, proposition, evidenceRef] = argv;
    if (!taskId || !proposition) throw new Error('usage: oathe note <task-id> <text> [evidence-ref]');
    const { ctx, tools } = await toolsForCwd();
    try {
      const out = await tools.oathe_statement({ task_id: taskId, proposition, evidence_ref: evidenceRef });
      process.stdout.write(`${reclaimLine(out)}statement recorded (${out.note})\n`);
      summary('note', 'ok');
    } finally {
      await ctx.substrate.close();
    }
  },

  async done(argv) {
    const [taskId, proposition, evidenceRef] = argv;
    if (!taskId || !proposition) throw new Error('usage: oathe done <task-id> <what-was-done> [evidence-ref]');
    const { ctx, tools } = await toolsForCwd();
    try {
      const out = await tools.oathe_done({ task_id: taskId, proposition, evidence_ref: evidenceRef });
      process.stdout.write(`done: ${out.task_id} — ${out.note}\n`);
      // The blocked verdict, for the human (ruling 2026-08-31: locally, done owes its answer).
      const v = out.verification;
      if (v?.verdict) {
        process.stdout.write(`verdict: ${v.verdict} — ${v.reason}\n`);
        // A rejection handed the work back in this exchange (ruling 2026-09-04).
        process.stdout.write(reclaimLine(out));
        if (v.your_options) process.stdout.write(`next: ${v.your_options}\n`);
      } else if (v?.failed) {
        process.stdout.write(`verification failed: ${v.reason}\n`);
      }
      summary('done', v?.verdict === 'rejected' || v?.failed ? 'attention' : 'ok');
    } finally {
      await ctx.substrate.close();
    }
  },

  async verify(argv) {
    const { values, positionals } = parseFlags('verify', {
      args: argv,
      options: { all: { type: 'boolean', default: false }, engine: { type: 'string' }, detach: { type: 'boolean', default: false } },
      allowPositionals: true,
    });
    const [{ buildContext }, { Verifier }, { workspaceRef }] = await Promise.all([
      import('../src/context.mjs'), import('../src/verifier.mjs'), import('../src/workspace.mjs'),
    ]);
    const ctx = buildContext({});
    // --detach: the judgment survives its terminal — one dispatcher, same as MCP and the
    // glass; closing the window can never orphan a verify claim again.
    if (values.detach === true) {
      if (!positionals[0]) throw new Error('usage: oathe verify --detach <task-id>');
      const [{ dispatchVerification }, { emit }] = await Promise.all([
        import('../src/verify-dispatch.mjs'), import('../src/wire.mjs'),
      ]);
      try {
        const out = await dispatchVerification({
          taskId: positionals[0], engine: values.engine ?? null, orgId: ctx.identity.orgId,
          query: (sql, params) => ctx.substrate.query(sql, params),
          paths: ctx.paths, cwd: process.cwd(), env: process.env,
        });
        // The glass hears the dispatch (a silent nudge — the judgment's own claim turns the
        // row verifying); a retry launched from a terminal never leaves the glass stale.
        await emit(ctx.substrate, { kind: 'verify_dispatched', task_id: positionals[0] });
        process.stdout.write(`dispatched — the verdict lands on the glass. Log: ${out.log}\n`);
        summary('verify', 'ok');
      } finally {
        await ctx.substrate.close();
      }
      return;
    }
    const verifier = new Verifier({
      substrate: ctx.substrate, paths: ctx.paths, config: ctx.config,
      workspace: workspaceRef(process.cwd()),
      operatorPrincipal: ctx.identity.principalId,
    });
    try {
      const targets = values.all === true ? await verifier.pending() : [positionals[0]];
      if (!targets[0]) throw new Error('usage: oathe verify <task-id> | --all');
      let attention = false;
      for (const target of targets) {
        const out = await verifier.verify({ taskId: target, engine: values.engine });
        const mark = out.verdict === 'accepted' ? '✓ settled' : '✗ rejected — task reopened';
        process.stdout.write(`${out.task_id}: ${mark} (${out.engine}) — ${out.reason}\n`);
        if (out.verdict !== 'accepted') attention = true;
      }
      summary('verify', attention ? 'attention' : 'ok');
    } finally {
      await verifier.close();
      await ctx.substrate.close();
    }
  },

  async trace(argv) {
    const { values, positionals } = parseFlags('trace', {
      args: argv, options: { out: { type: 'string' }, pure: { type: 'boolean', default: false } }, allowPositionals: true,
    });
    const [taskId] = positionals;
    if (!taskId) throw new Error('usage: oathe trace <task-id> [--out <dir>] [--pure]');
    const [{ buildContext }, { workspaceRef }, { projectAnnotated }, { projectorFor }, fs, path] = await Promise.all([
      import('../src/context.mjs'), import('../src/workspace.mjs'), import('../src/oathe-annotator.mjs'),
      import('../src/harnesses/catalog.mjs'), import('node:fs'), import('node:path'),
    ]);
    const ctx = buildContext({});
    try {
      const { rows: claims } = await ctx.substrate.query(
        `SELECT work_claim_id, contract_ref FROM cell.work_claim
          WHERE org_id = $1 AND task_id = $2 ORDER BY claimed_at DESC LIMIT 1`,
        [ctx.identity.orgId, taskId]);
      if (claims.length === 0) throw new Error(`no claim on '${taskId}' — nothing to trace`);
      const claim = claims[0];
      const { rows: verdicts } = await ctx.substrate.query(
        `SELECT result, verifier_principal, verification_id FROM cell.verification
          WHERE org_id = $1 AND task_id = $2 ORDER BY recorded_at DESC LIMIT 1`,
        [ctx.identity.orgId, taskId]);
      // The export reads the same evidence the verifier judges: recorded links ∪ fingerprint
      // discovery (src/evidence-discovery.mjs) — a traceless surface's work still exports.
      const { EvidenceDiscovery } = await import('../src/evidence-discovery.mjs');
      const { traces: gathered, unreadable } = await new EvidenceDiscovery({ client: ctx.substrate, orgId: ctx.identity.orgId })
        .read({ taskId });
      // stdout is the JSON; what the scan could not read is said on stderr, never swallowed.
      for (const u of unreadable) process.stderr.write(`trace: unreadable store file skipped: ${u.path} (${u.code})\n`);
      const files = gathered.map((t) => t.path);
      if (files.length === 0) throw new Error(`no evidence for '${taskId}' — no linked traces and no discovery hits`);
      const trajectories = [];
      // The export is the annotated read with the OBLIGATION stamped on the root — what this
      // trajectory is evidence for, in the annotator's own slot. --pure exports the
      // converter's output alone (no oathe key anywhere): what a Harbor converter could also
      // emit, for a cross-implementation check against their validator and converters.
      for (const file of files) {
        trajectories.push(values.pure
          ? (await projectorFor(file)).project(file)
          : await projectAnnotated(file, {
            obligation: {
              org_id: ctx.identity.orgId,
              task_id: taskId,
              work_claim_id: claim.work_claim_id,
              contract_ref: claim.contract_ref,
              workspace: workspaceRef(process.cwd()),
              ...(verdicts[0] ? { verdict: verdicts[0] } : {}),
            },
          }));
      }
      if (values.out) {
        fs.mkdirSync(values.out, { recursive: true });
        for (const [at, trajectory] of trajectories.entries()) {
          const file = path.join(values.out, `${taskId.replaceAll(/[^a-zA-Z0-9_-]/g, '_')}-${at + 1}.atif.json`);
          fs.writeFileSync(file, `${JSON.stringify(trajectory, null, 2)}\n`);
          process.stdout.write(`${file}\n`);
        }
      } else {
        // stdout is PURE JSON here; the machine summary rides stderr instead.
        process.stdout.write(`${JSON.stringify(trajectories, null, 2)}\n`);
      }
      process.stderr.write('oathe: trace ok\n');
    } finally {
      await ctx.substrate.close();
    }
  },

  // The notch feed: machine board + breach digest, pure JSON on stdout (trailer on stderr,
  // the trace precedent). Workspace-less by construction — buildContext({cwd: null}) is the
  // global bootstrap — and seamless: no activation, no registry write; it only SHOWS
  // (R-PAGER kinship: resurfacing is fact-paged; this verb is the facts, not a dashboard).
  // One flag: --serve LISTENs on the wire and streams one ndjson frame per speech act
  // (receipts ride the frame that caused them), plus a heartbeat frame as drift guard;
  // it exits when the supervisor (the notch app) closes stdin.
  async notch(argv) {
    const { values } = parseFlags('notch', {
      args: argv, options: { serve: { type: 'boolean', default: false }, welcome: { type: 'boolean', default: false } }, allowPositionals: false,
    });
    if (values.welcome && values.serve) {
      const err = new Error('--welcome with --serve refused — the feed consumes the welcome; the flag plants it for a live feed to play');
      err.code = 'OATHE_NOTCH_WELCOME_SERVE';
      throw err;
    }
    const [{ buildContext }, { createOatheTools }, { Pager }, { WorkspaceRegistry }, { WIRE_CHANNEL, noticeFor, emit }, { plantWelcome, consumeWelcome }] = await Promise.all([
      import('../src/context.mjs'), import('../src/mcp/oathe-tools.mjs'),
      import('../src/pager.mjs'), import('../src/registry.mjs'), import('../src/wire.mjs'),
      import('../src/welcome.mjs'),
    ]);
    const ctx = buildContext({ cwd: null });
    if (values.welcome) {
      // The demo/replay lever: plant the one-shot marker, nudge the wire. Same path as the
      // real first run — a live feed consumes it on its very next frame; with no feed up,
      // the marker waits for the next serve start. emit is fail-soft by the wire's ruling.
      plantWelcome({ paths: ctx.paths, by: 'cli' });
      try {
        await emit(ctx.substrate, { kind: 'welcome' });
      } finally {
        await ctx.substrate.close().catch(() => {});
      }
      process.stdout.write('welcome queued — a live glass plays it now; otherwise on its next start\n');
      process.stderr.write('oathe: notch ok\n');
      return;
    }
    const registry = new WorkspaceRegistry({ registryPath: ctx.paths.registryPath });
    const [{ NotchFrame }, { SessionRegistry }, { homeOf }] = await Promise.all([
      import('../src/notch-frame.mjs'), import('../src/sessions.mjs'), import('../src/paths.mjs'),
    ]);
    const sessionsReg = new SessionRegistry({ sessionsPath: ctx.paths.sessionsPath });
    // The frame (src/notch-frame.mjs) decides what the glass shows and every word of it;
    // this verb fetches and serves. A broken sessions file costs the frame its session
    // refs, never the frame.
    const notchFrame = new NotchFrame({
      registry,
      sessions: () => {
        try { return sessionsReg.load().sessions; } catch (e) {
          process.stderr.write(`oathe notch: sessions ${String(e?.message || e).slice(0, 120)}\n`);
          return {};
        }
      },
      defaultAgent: ctx.config.get('defaultAgent'),
      motionWindowMs: ctx.config.get('notchMotionMinutes') * 60_000,
      operatorHome: homeOf(),
    });
    const pager = new Pager({ client: ctx.substrate, identity: ctx.identity, config: ctx.config, registry });
    // The machine board, classified once by the tools (attention:false — the digest is the
    // frame's own read, and no response channel is served here).
    const tools = createOatheTools({ client: ctx.substrate, identity: ctx.identity, workspace: null, config: ctx.config, attention: false });
    const frame = async () => {
      const [digest, { sections }] = await Promise.all([pager.digest(), tools.oathe_board({ all: true })]);
      return notchFrame.build({ digest, sections });
    };
    if (!values.serve) {
      try {
        process.stdout.write(`${JSON.stringify(await frame())}\n`);
        process.stderr.write('oathe: notch ok\n');
      } finally {
        await ctx.substrate.close();
      }
      return;
    }
    const { default: pg } = await import('pg');
    const write = (f) => process.stdout.write(`${JSON.stringify(f)}\n`);
    // The one-shot welcome rides the next frame after a SUCCESSFUL build — consume-on-emit,
    // never on failure, so a broken frame cannot eat the shot (and a KeepAlive restart
    // cannot replay it: the marker is gone the moment it is spoken).
    const serveFrame = async () => {
      const f = await frame();
      const welcome = consumeWelcome({ paths: ctx.paths });
      if (welcome) f.welcome = welcome;
      return f;
    };
    const listener = new pg.Client(ctx.substrate.connectionConfig());
    await listener.connect();
    await listener.query(`LISTEN ${WIRE_CHANNEL}`);
    let beat = null;
    let closing = false;
    // The trailer tells the truth (fail loud): only a clean stdin-close is ok; a lost
    // wire or dead substrate exits nonzero so the supervisor's restart means something.
    const shutdown = async (status = 'ok', code = 0) => {
      if (closing) return;
      closing = true;
      if (beat) clearInterval(beat);
      await listener.end().catch(() => {});
      await ctx.substrate.close().catch(() => {});
      process.stderr.write(`oathe: notch ${status}\n`);
      process.exit(code);
    };
    // A TRANSIENT substrate failure (a Postgres restart, a locked table) must never kill
    // the feed — the error is a typed stderr note and the next event/heartbeat retries.
    // A DEAD CONNECTION is fatal-but-clean: exit nonzero; the app's backoff restart is
    // the recovery.
    const guarded = (label, fn) => async (...args) => {
      try {
        await fn(...args);
      } catch (e) {
        process.stderr.write(`oathe notch: ${label} failed (${String(e?.message || e).slice(0, 160)}) — serving continues\n`);
      }
    };
    listener.on('notification', guarded('wire frame', async (msg) => {
      let ev = null;
      try { ev = JSON.parse(msg.payload); } catch { /* a foreign payload nudges, it does not speak */ }
      if (ev?.task_id) notchFrame.hear(ev.task_id, { at: Date.now(), via: ev.via ?? null, app: ev.app ?? null }); // the wire IS liveness
      const f = await serveFrame();
      // The event's own notice rides the frame it caused — the glass PULSES its tone and
      // keeps the words for the sheet (never expanding the bar; founder ruling 2026-08-31).
      const notice = ev?.task_id ? noticeFor(ev.kind, ev.task_id, ev.via) : null;
      if (notice) f.notice = notice;
      write(f);
    }));
    listener.on('error', (e) => {
      process.stderr.write(`oathe notch: wire lost (${String(e?.message || e).slice(0, 120)})\n`);
      shutdown('error', 1);
    });
    beat = setInterval(guarded('heartbeat frame', async () => write(await serveFrame())), ctx.config.get('notchHeartbeatSeconds') * 1000);
    write(await serveFrame());
    // The glass speaks acts UP the same pipe — one ndjson line, the mirror of a frame
    // (ruling 2026-09-04: a judgment needs no terminal). `{act:'verify', task_id, cwd}`
    // runs the ONE dispatcher the CLI and MCP run; the judgment's own claim then wakes the
    // frame (verify_started on the wire). A refusal other than "already in flight" rides
    // the next frame as an amber notice — the glass never learns of a failure by silence.
    const { dispatchVerification } = await import('../src/verify-dispatch.mjs');
    const act = guarded('act', async (req) => {
      if (req?.act !== 'verify' || typeof req.task_id !== 'string') {
        process.stderr.write(`oathe notch: unknown act ${JSON.stringify(req).slice(0, 120)} — ignored\n`);
        return;
      }
      try {
        await dispatchVerification({
          taskId: req.task_id, orgId: ctx.identity.orgId,
          query: (sql, params) => ctx.substrate.query(sql, params),
          paths: ctx.paths, cwd: typeof req.cwd === 'string' ? req.cwd : homeOf(), env: process.env,
        });
      } catch (e) {
        if (e?.code === 'OATHE_VERIFY_IN_FLIGHT') return; // the row already says verifying
        const f = await serveFrame();
        f.notice = { text: `✗ verify '${req.task_id}' not dispatched — [${e?.code ?? 'error'}] ${String(e?.message ?? e).slice(0, 160)}`, tone: 'amber' };
        write(f);
      }
    });
    let inbound = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      inbound += chunk;
      let nl;
      while ((nl = inbound.indexOf('\n')) >= 0) {
        const line = inbound.slice(0, nl).trim();
        inbound = inbound.slice(nl + 1);
        if (line === '') continue;
        let req = null;
        try { req = JSON.parse(line); } catch { process.stderr.write(`oathe notch: act line is not JSON — ignored\n`); continue; }
        act(req);
      }
    });
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  },

  async yield(argv) {
    const [taskId, note] = argv;
    // A missing note is the tool's typed refusal (OATHE_YIELD_NOTE_REQUIRED), one implementation.
    if (!taskId) throw new Error('usage: oathe yield <task-id> <note>');
    const { ctx, tools } = await toolsForCwd();
    try {
      const out = await tools.oathe_yield({ task_id: taskId, note });
      process.stdout.write(`${reclaimLine(out)}yielded: ${out.task_id} — ${out.note}\n`);
      summary('yield', 'ok');
    } finally {
      await ctx.substrate.close();
    }
  },

  async config(argv) {
    const { values, positionals } = parseFlags('config', {
      args: argv, options: { global: { type: 'boolean', default: false } }, allowPositionals: true,
    });
    const [key, raw] = positionals;
    if (!key) throw new Error('usage: oathe config <key> [value] [--global]');
    const { OatheConfig } = await import('../src/config.mjs');
    const cfg = new OatheConfig({});
    if (raw === undefined) {
      process.stdout.write(`${key} = ${JSON.stringify(cfg.get(key)).replaceAll('"', '')}\n`);
    } else {
      // Each key's OWN coercion (booleans, numbers, null) — set() still validates typed.
      const value = OatheConfig.coerce(key, raw);
      const out = cfg.set(key, value, { scope: values.global ? 'global' : 'workspace' });
      process.stdout.write(`${key} = ${raw} (${out.file})\n`);
    }
    summary('config', 'ok');
  },

  async version() {
    const [{ buildPaths }, { packageVersion }] = await Promise.all([import('../src/paths.mjs'), import('../src/context.mjs')]);
    process.stdout.write(`${packageVersion(buildPaths(process.env))}\n`);
    summary('version', 'ok');
  },

  async update(argv) {
    const { values } = parseFlags('update', {
      args: argv, options: { yes: { type: 'boolean', default: false }, harness: { type: 'string' } }, allowPositionals: false,
    });
    const [{ runUpdate }, { buildPaths }] = await Promise.all([import('../src/update.mjs'), import('../src/paths.mjs')]);
    const initArgs = [...(values.yes ? ['--yes'] : []), ...(values.harness ? ['--harness', values.harness] : [])];
    const out = runUpdate({ packageRoot: buildPaths(process.env).packageRoot, args: initArgs });
    if (out.initStatus !== 0) {
      const e = new Error(`update installed ${out.after} but the new bin's init exited ${out.initStatus} — read its output above and run \`oathe init\` again`);
      e.code = 'OATHE_UPDATE_INIT_FAILED';
      throw e;
    }
    summary('update', (out.notch && out.notch.pid === null) || (out.daemon && out.daemon.pid === null) ? 'attention' : 'ok');
  },

  async doctor(argv) {
    const { values } = parseFlags('doctor', {
      args: argv, options: { surface: { type: 'boolean', default: false } }, allowPositionals: false,
    });
    if (values.surface) {
      // The per-surface resolution report: no substrate contact — this must answer on ANY
      // machine, from ANY harness's spawn environment, exactly as the MCP server would see it.
      const { runSurfaceReport } = await import('../src/doctor.mjs');
      const report = await runSurfaceReport({});
      for (const [name, value] of Object.entries(report.env_slice)) {
        process.stdout.write(`  env ${name.padEnd(22)} ${value === null ? '(unset)' : value}\n`);
      }
      process.stdout.write(`  cwd ${process.cwd()}\n`);
      if (report.resolved) {
        const r = report.resolution;
        process.stdout.write(`workspace: ${r.ref} via ${r.source}\n  dir  ${r.dir}\n  root ${r.root}\n`);
        for (const d of r.diagnostics) process.stdout.write(`  note ${d}\n`);
        process.stdout.write(`registry: ${report.registered === null ? 'unreadable'
          : report.registered ? 'registered' : 'not yet registered (first use registers it)'}\n`);
      } else {
        process.stdout.write(`workspace: UNRESOLVED\n${report.refusal}\n`);
      }
      summary('doctor', report.resolved ? 'ok' : 'attention');
      if (!report.resolved) process.exit(1);
      return;
    }
    const { runDoctor } = await import('../src/doctor.mjs');
    const result = await runDoctor({});
    const caches = Object.entries(result.version.plugin).map(([name, v]) => `${name} ${v ?? 'none'}`).join('; ');
    process.stdout.write(`version: ${result.version.package} (plugin cache: ${caches})\n`);
    const s = result.substrate;
    process.stdout.write(`substrate: ${s.reachable ? 'reachable' : 'UNREACHABLE'}, `
      + `db ${s.database_exists ? 'present' : 'ABSENT'}, ddl ${s.ddl_applied}/${s.ddl_expected}, `
      + `ddl source: ${s.ddl_source}, yield cause ${s.yield_cause_registered ? 'ok' : 'MISSING'}\n`);
    process.stdout.write(`plugin: ${result.plugin.resolves ? 'resolves' : `BROKEN (${result.plugin.detail})`}\n`);
    const rt = result.runtime;
    process.stdout.write(!rt.provider
      ? `runtime: UNRESOLVED (requested ${rt.requested}) — ${rt.error}\n`
      : rt.probe && !rt.probe.ok
        ? `runtime: ${rt.provider} (requested ${rt.requested}) — UNLINKED: run npm run link-runtime\n`
        : `runtime: ${rt.provider} (requested ${rt.requested}) — cage ${rt.capabilities.cage}, `
          + `settlement ${rt.capabilities.settlement}, pickup ${rt.capabilities.pickup}\n`);
    for (const [harness, trace] of Object.entries(result.traces)) {
      process.stdout.write(`traces: ${harness.padEnd(8)} ${trace.status}`
        + `${trace.status === 'DRIFT' ? ` — ${trace.detail} (${trace.newest})` : ''}\n`);
    }
    // The daemon's answer is a health fact wherever serve is WIRED: launchd holding the
    // agent while nothing answers the socket means every session forwards into nothing.
    process.stdout.write(result.daemon.answering
      ? `daemon: answering (${result.daemon.server.name} ${result.daemon.server.version}) @ ${result.daemon.socket}\n`
      : `daemon: NOT ANSWERING @ ${result.daemon.socket ?? '(unresolved socket)'}\n`);
    for (const row of result.rows) {
      process.stdout.write(`  ${row.status.padEnd(12)} ${row.harness.padEnd(8)} ${row.kind.padEnd(12)} ${row.file}\n`);
    }
    const serveWired = result.rows.some((r) => r.harness === 'serve' && r.kind === 'launch-agent');
    const healthy = s.reachable && s.database_exists && s.ddl_applied === s.ddl_expected
      && s.ddl_source !== 'ABSENT'
      && result.plugin.resolves && result.runtime.provider !== null
      && result.runtime.probe?.ok !== false
      && result.rows.every((r) => r.status === 'ok')
      && Object.values(result.traces).every((t) => t.status !== 'DRIFT')
      && (!serveWired || result.daemon.answering);
    summary('doctor', healthy ? 'ok' : 'attention');
    if (!healthy) process.exit(1);
  },

  async status() {
    const { buildContext } = await import('../src/context.mjs');
    const ctx = buildContext({});
    try {
      const s = await ctx.substrate.status();
      process.stdout.write(`database: ${ctx.substrate.database} — `
        + `${s.reachable ? 'reachable' : 'UNREACHABLE'}, ${s.database_exists ? 'present' : 'absent'}, `
        + `ddl ${s.ddl_applied}/${s.ddl_expected}, ddl source: ${s.ddl_source}, `
        + `yield cause ${s.yield_cause_registered ? 'ok' : 'missing'}\n`);
      summary('status', 'ok');
    } finally {
      await ctx.substrate.close();
    }
  },

  async uninstall(argv) {
    const { values } = parseFlags('uninstall', {
      args: argv, options: { 'purge-db': { type: 'boolean', default: false } }, allowPositionals: true,
    });
    const { runUninstall } = await import('../src/uninstall.mjs');
    const result = await runUninstall({ purgeDb: values['purge-db'] === true });
    for (const a of result.actions) process.stdout.write(`  ${a.action}${a.file ? ` ${a.file}` : ''}\n`);
    process.stdout.write(`database: ${result.database_dropped ? 'DROPPED (--purge-db)' : 'kept'}\n`);
    summary('uninstall', 'ok');
  },
};

/**
 * Everything after the verb is the HARNESS's, verbatim — flags included. oathe consumes only
 * its own `--hermetic` (first occurrence) and one `--` separator; `oathe claude -- --hermetic`
 * hands the harness a literal --hermetic.
 */
function splitLaunchArgs(argv) {
  const args = [];
  let hermetic = false;
  let passthrough = false;
  for (const a of argv) {
    if (!passthrough && a === '--') { passthrough = true; continue; }
    if (!passthrough && !hermetic && a === '--hermetic') { hermetic = true; continue; }
    args.push(a);
  }
  return { hermetic, args };
}

async function launchHarness(harness, argv) {
  const { hermetic, args } = splitLaunchArgs(argv);
  const { runHarness } = await import('../src/launch.mjs');
  const out = await runHarness({ harness, args, hermetic });
  if (!out.teardown.empty) {
    process.stderr.write(`cage not proven empty: ${out.teardown.detail}\n`);
    summary(harness, 'cage-unclean');
    process.exit(out.exitCode || 1);
  }
  summary(harness, `exit ${out.exitCode}`);
  process.exit(out.exitCode);
}

const [verb, ...rest] = process.argv.slice(2);
if (!verb || !VERBS.includes(verb)) {
  process.stderr.write(USAGE);
  process.exit(2);
}
try {
  // The engines floor, executed at the door (R-NODE-FLOOR): npm only warns on engines, so the
  // bin itself refuses a runtime that cannot read the codex thread index (node:sqlite).
  const [{ assertNodeFloor }, { buildPaths }] = await Promise.all([
    import('../src/node-floor.mjs'), import('../src/paths.mjs')]);
  assertNodeFloor({ packageRoot: buildPaths(process.env).packageRoot });
  // Launch verbs come from the catalog (every adapter with a `launch` capability), not a handler each.
  const handler = launchable().includes(verb) ? (argv) => launchHarness(verb, argv) : handlers[verb];
  await handler(rest);
} catch (e) {
  fail(verb, e);
}
