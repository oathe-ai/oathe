#!/usr/bin/env node
// oathe — the subcommand router. Deliberate divergence from the monorepo's env-only bins:
// oathe is a USER tool, so it speaks argv (node:util parseArgs); it keeps the estate's
// machine-parseable summary line (`oathe: <verb> <status>`) as the last line of every run.

import { parseArgs } from 'node:util';

const VERBS = ['init', 'claude', 'codex', 'claim', 'ls', 'note', 'done', 'verify', 'trace', 'yield', 'config', 'doctor', 'uninstall', 'status', 'hook', 'mcp'];

const USAGE = `usage: oathe <verb> [args]

verbs:
  init                         onboard installed harnesses + bring up the local cell substrate
  claude [--hermetic] [args…]  launch interactive Claude Code inside the cage, board attached
  codex  [--hermetic] [args…]  launch interactive Codex inside the cage, board attached
  claim <task-id> [objective]  claim a task (minting it when new — objective required then)
  ls [--all]                   this workspace's board (--all: every workspace)
  note <task-id> <text> [ref]  record a progress statement against your active claim
  done <task-id> <what> [ref]  assert completion (a completion statement + the substrate's terminal)
  verify [task] [--all] [--engine claude|codex]  run the verification lane (non-author seat settles)
  trace <task-id> [--out dir]  export the claim's linked session traces as ATIF trajectories
  yield <task-id> <note>       yield: the task goes back on the board, unowned
  doctor                       verify every managed surface against the install manifest
  status                       the substrate half of doctor
  config <key> [value] [--global]  read or write a config key (workspace scope by default)
  uninstall [--purge-db]       remove exactly what init recorded (the database stays put)
  hook <name> · mcp            internal: the plugin's hook/server entry points (bin-addressed)
`;

function summary(verb, status) {
  process.stdout.write(`oathe: ${verb} ${status}\n`);
}

function fail(verb, e) {
  process.stderr.write(`${e?.code ? `[${e.code}] ` : ''}${e?.message || e}\n`);
  const status = /refus|REFUSED|already|second|active claim/i.test(String(e?.message)) ? 'refused' : 'error';
  process.stderr.write(`oathe: ${verb} ${status}\n`);
  process.exit(1);
}

async function toolsForCwd(env = process.env) {
  const [{ buildContext }, { createOatheTools }, { workspaceRef }] = await Promise.all([
    import('../src/context.mjs'), import('../src/mcp/oathe-tools.mjs'), import('../src/workspace.mjs'),
  ]);
  const ctx = buildContext({ env });
  return {
    ctx,
    tools: createOatheTools({
      client: ctx.substrate,
      identity: ctx.identity,
      config: ctx.config,
      workspace: workspaceRef(process.cwd()),
    }),
  };
}

const handlers = {
  async init() {
    const { runInit } = await import('../src/init.mjs');
    const result = await runInit({});
    const tty = process.stdout.isTTY === true;
    const B = tty ? '\x1b[1m' : '';
    const D = tty ? '\x1b[2m' : '';
    const G = tty ? '\x1b[32m' : '';
    const R = tty ? '\x1b[0m' : '';
    const ok = `${G}✓${R}`;
    const s = result.substrate;
    const lines = ['', `  ${B}⚡ Oathe is up${R}`, ''];
    lines.push(`  ${ok} ${B}substrate${R}   ${D}db up · ${s.ddl_applied}/${s.ddl_expected} schema applied · verification lane ready${R}`);
    if (!s.yield_cause_registered) {
      lines.push(`  ${B}! yield cause MISSING${R} — run \`oathe doctor\` before claiming work`);
    }
    for (const c of result.census) {
      const wired = result.actions.filter((a) => a.harness === c.name).length;
      lines.push(c.installed
        ? `  ${ok} ${B}${c.name.padEnd(9)}${R} ${D}onboarded (${wired} surface${wired === 1 ? '' : 's'} wired, reversible)${R}`
        : `  ${D}– ${c.name.padEnd(9)} not installed — skipped${R}`);
    }
    lines.push(`  ${ok} ${B}you${R}         ${D}${result.principal.principal_id}${R}`);
    lines.push('');
    lines.push(`  Next: ${B}oathe claude${R} ${D}(or codex)${R} in any project — the board rides every session.`);
    lines.push(`        Claim before you build: ${B}oathe claim <task> "what done means"${R}`);
    lines.push('');
    process.stdout.write(`${lines.join('\n')}\n`);
    summary('init', 'ok');
  },

  async claude(argv) {
    return launchHarness('claude', argv);
  },

  async codex(argv) {
    return launchHarness('codex', argv);
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

  async claim(argv) {
    const [taskId, objective] = argv;
    if (!taskId) throw new Error('usage: oathe claim <task-id> [objective]');
    const { ctx, tools } = await toolsForCwd();
    try {
      const out = await tools.oathe_claim({ task_id: taskId, objective });
      process.stdout.write(`claimed: ${out.task_id} (lease ${out.lease}) — ${out.note}\n`);
      summary('claim', 'ok');
    } finally {
      await ctx.substrate.close();
    }
  },

  async ls(argv) {
    const { values } = parseArgs({
      args: argv, options: { all: { type: 'boolean', default: false } }, allowPositionals: true,
    });
    const { ctx, tools } = await toolsForCwd();
    try {
      const { sections, workspace } = await tools.oathe_board({ all: values.all === true });
      process.stdout.write(`board${workspace ? ` (${workspace})` : ' (all workspaces)'}:\n`);
      const listed = [...sections.mine, ...sections.open, ...sections.asserted, ...sections.held];
      if (listed.length === 0) process.stdout.write('  (none — a clean slate)\n');
      for (const r of listed) {
        const holder = r.state === 'active' ? `${r.principal_id}, lease until ${r.lease_until}` : (r.state ?? 'open');
        process.stdout.write(`  [${(r.state ?? 'open').padEnd(8)}] ${r.task_id} — ${r.objective} (${holder})\n`);
      }
      summary('ls', 'ok');
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
      process.stdout.write(`statement recorded (${out.note})\n`);
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
      summary('done', 'ok');
    } finally {
      await ctx.substrate.close();
    }
  },

  async verify(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { all: { type: 'boolean', default: false }, engine: { type: 'string' } },
      allowPositionals: true,
    });
    const [{ buildContext }, { Verifier }, { workspaceRef }] = await Promise.all([
      import('../src/context.mjs'), import('../src/verifier.mjs'), import('../src/workspace.mjs'),
    ]);
    const ctx = buildContext({});
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
    const { values, positionals } = parseArgs({
      args: argv, options: { out: { type: 'string' } }, allowPositionals: true,
    });
    const [taskId] = positionals;
    if (!taskId) throw new Error('usage: oathe trace <task-id> [--out <dir>]');
    const [{ buildContext }, { projectorFor }, { workspaceRef }, fs, path] = await Promise.all([
      import('../src/context.mjs'), import('../src/atif.mjs'), import('../src/workspace.mjs'),
      import('node:fs'), import('node:path'),
    ]);
    const ctx = buildContext({});
    try {
      const { rows: claims } = await ctx.substrate.query(
        `SELECT work_claim_id, contract_ref FROM cell.work_claim
          WHERE org_id = $1 AND task_id = $2 ORDER BY claimed_at DESC LIMIT 1`,
        [ctx.identity.orgId, taskId]);
      if (claims.length === 0) throw new Error(`no claim on '${taskId}' — nothing to trace`);
      const claim = claims[0];
      const { rows: traceRows } = await ctx.substrate.query(
        `SELECT evidence_refs FROM cell.agent_statement
          WHERE org_id = $1 AND work_claim_id = $2 AND subject_ref LIKE 'trace:%'`,
        [ctx.identity.orgId, claim.work_claim_id]);
      const { rows: verdicts } = await ctx.substrate.query(
        `SELECT result, verifier_principal, verification_id FROM cell.verification
          WHERE org_id = $1 AND task_id = $2 ORDER BY recorded_at DESC LIMIT 1`,
        [ctx.identity.orgId, taskId]);
      const files = traceRows.flatMap((r) => r.evidence_refs);
      if (files.length === 0) throw new Error(`'${taskId}' has no linked traces — nothing to export`);
      const trajectories = files.map((file) => {
        const trajectory = projectorFor(file).project(file);
        Object.assign(trajectory.extra.oathe, {
          org_id: ctx.identity.orgId,
          task_id: taskId,
          work_claim_id: claim.work_claim_id,
          contract_ref: claim.contract_ref,
          workspace: workspaceRef(process.cwd()),
          ...(verdicts[0] ? { verdict: verdicts[0] } : {}),
        });
        return trajectory;
      });
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

  async yield(argv) {
    const [taskId, note] = argv;
    if (!taskId || !note) throw new Error('usage: oathe yield <task-id> <note>');
    const { ctx, tools } = await toolsForCwd();
    try {
      const out = await tools.oathe_yield({ task_id: taskId, note });
      process.stdout.write(`yielded: ${out.task_id} — ${out.note}\n`);
      summary('yield', 'ok');
    } finally {
      await ctx.substrate.close();
    }
  },

  async config(argv) {
    const { values, positionals } = parseArgs({
      args: argv, options: { global: { type: 'boolean', default: false } }, allowPositionals: true,
    });
    const [key, raw] = positionals;
    if (!key) throw new Error('usage: oathe config <key> [value] [--global]');
    const { OatheConfig, CONFIG_KEYS } = await import('../src/config.mjs');
    const cfg = new OatheConfig({});
    if (raw === undefined) {
      process.stdout.write(`${key} = ${JSON.stringify(cfg.get(key)).replaceAll('"', '')}\n`);
    } else {
      const value = /^\d+$/.test(raw) ? Number(raw) : raw;
      const out = cfg.set(key, value, { scope: values.global ? 'global' : 'workspace' });
      process.stdout.write(`${key} = ${raw} (${out.file})\n`);
    }
    summary('config', 'ok');
  },

  async doctor() {
    const { runDoctor } = await import('../src/doctor.mjs');
    const result = await runDoctor({});
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
    for (const row of result.rows) {
      process.stdout.write(`  ${row.status.padEnd(12)} ${row.harness.padEnd(8)} ${row.kind.padEnd(12)} ${row.file}\n`);
    }
    const healthy = s.reachable && s.database_exists && s.ddl_applied === s.ddl_expected
      && s.ddl_source !== 'ABSENT'
      && result.plugin.resolves && result.runtime.provider !== null
      && result.runtime.probe?.ok !== false
      && result.rows.every((r) => r.status === 'ok')
      && Object.values(result.traces).every((t) => t.status !== 'DRIFT');
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
    const { values } = parseArgs({
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
  await handlers[verb](rest);
} catch (e) {
  fail(verb, e);
}
