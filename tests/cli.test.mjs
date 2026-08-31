import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { sandbox } from './helpers.mjs';
import { runInit } from '../src/init.mjs';
import { Substrate, DDL_FILES } from '../src/substrate.mjs';
import { buildPaths } from '../src/paths.mjs';

const paths = buildPaths({});
const SCRATCH_DB = `oathe_cli_test_${process.pid}`;
const BIN = path.join(paths.packageRoot, 'bin/oathe.mjs');

let sb;
let project;

// The terminal IS the workspace: every verb runs from a project folder inside the sandbox home
// (a home-directory cwd is refused — a board minted there would be silently wrong).
function oathe(args, env = sb.env, cwd = project) {
  return spawnSync('node', [BIN, ...args], { encoding: 'utf8', env, cwd });
}

before(async () => {
  sb = sandbox({ scratchDb: SCRATCH_DB });
  project = fs.realpathSync(fs.mkdtempSync(path.join(sb.home, 'proj-')));
  await runInit({ env: sb.env, exec: sb.exec });
});

after(async () => {
  const substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  await substrate.close();
  await substrate.dropDatabase();
});

test('oathe with no verb prints usage and the verb list', () => {
  const out = oathe([]);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /usage/i);
  for (const verb of ['init', 'claude', 'codex', 'claim', 'ls', 'note', 'done', 'verify', 'yield', 'config', 'doctor', 'uninstall', 'status']) {
    assert.match(out.stderr, new RegExp(`\\b${verb}\\b`));
  }
});

test('an unknown flag is a typed refusal naming the verb\'s usable flags — not a raw parse error', () => {
  // Found at the fresh-user trial (2026-08-29): `oathe verify --help` died with
  // ERR_PARSE_ARGS_UNKNOWN_OPTION and the trailer said `error`. The ruling: fail loud,
  // print the flags that CAN be used.
  const out = oathe(['verify', '--help']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /\[OATHE_UNKNOWN_FLAG\]/);
  assert.match(out.stderr, /--help/);
  assert.match(out.stderr, /--all/);
  assert.match(out.stderr, /--engine/);
  assert.doesNotMatch(out.stderr, /ERR_PARSE_ARGS/);
  assert.match(out.stderr, /^oathe: verify refused$/m);

  const ls = oathe(['ls', '--bogus']);
  assert.equal(ls.status, 1);
  assert.match(ls.stderr, /\[OATHE_UNKNOWN_FLAG\]/);
  assert.match(ls.stderr, /--all/);
  assert.match(ls.stderr, /^oathe: ls refused$/m);
});

test('claim → ls → note → yield: the play loop, productized, with the machine-parseable ready line', () => {
  const claim = oathe(['claim', 'cli-task', 'Prove the CLI loop']);
  assert.equal(claim.status, 0, claim.stderr);
  assert.match(claim.stdout, /claimed: cli-task/);
  assert.match(claim.stdout, /^oathe: claim ok$/m);

  const ls = oathe(['ls']);
  assert.equal(ls.status, 0);
  assert.match(ls.stdout, /cli-task/);
  assert.match(ls.stdout, /active/);

  const note = oathe(['note', 'cli-task', 'progress happened', 'ref:test']);
  assert.equal(note.status, 0, note.stderr);
  assert.match(note.stdout, /statement recorded/);

  const yieldOut = oathe(['yield', 'cli-task', 'handing off']);
  assert.equal(yieldOut.status, 0, yieldOut.stderr);
  assert.match(yieldOut.stdout, /back on the board/);
});

test('claim → done closes the loop from the CLI', () => {
  const claim = oathe(['claim', 'done-cli-task', 'Close me properly']);
  assert.equal(claim.status, 0, claim.stderr);
  const done = oathe(['done', 'done-cli-task', 'closed properly', 'ref:cli-test']);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /completion ASSERTED, not settled/);
  // The sandbox's fake engine can never produce a verdict — a BLOCKING done says so
  // loudly (ruling 2026-08-31: locally, done owes its answer).
  assert.match(done.stdout, /verification failed: engine /);
  assert.match(done.stdout, /^oathe: done attention$/m);
});

test('everything after claude/codex passes through VERBATIM — flags included; only --hermetic (and one --) is ours', () => {
  const argsFile = path.join(sb.home, 'claude-args.txt');
  fs.writeFileSync(path.join(sb.bin, 'claude'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 0\n`);
  fs.chmodSync(path.join(sb.bin, 'claude'), 0o755);
  const out = oathe(['claude', '--hermetic', '-p', 'hello world', '--model', 'haiku', '--', '--hermetic']);
  assert.equal(out.status, 0, out.stderr);
  const got = fs.readFileSync(argsFile, 'utf8').split('\n').filter((l) => l !== '');
  assert.deepEqual(got, ['-p', 'hello world', '--model', 'haiku', '--hermetic']);
});

test('oathe trace exports the linked traces of a claim as VALID ATIF on stdout', async () => {
  // a claim with a real (fixture) linked trace, wired the way the heartbeat does it
  const claim = oathe(['claim', 'trace-cli-task', 'Export me as a trajectory']);
  assert.equal(claim.status, 0, claim.stderr);
  const fixDir = path.join(sb.home, '.claude/projects/-fixture');
  fs.mkdirSync(fixDir, { recursive: true });
  const sessionId = '99999999-8888-7777-6666-555555555555';
  const transcript = path.join(fixDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId, message: { role: 'user', content: 'work' } }),
    JSON.stringify({
      type: 'assistant', uuid: 'a1', sessionId,
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_t1', name: 'mcp__oathe__oathe_statement',
          input: { task_id: 'trace-cli-task', proposition: 'progress' } },
        { type: 'text', text: 'worked' }] },
    }),
    JSON.stringify({
      type: 'user', uuid: 'r1', parentUuid: 'a1', sessionId,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_t1', content: 'ok' }] },
    }),
  ].join('\n'));
  const hook = spawnSync('node', [BIN, 'hook', 'heartbeat'], {
    input: JSON.stringify({
      cwd: project, hook_event_name: 'Stop', session_id: sessionId, transcript_path: transcript,
    }),
    encoding: 'utf8', env: sb.env,
  });
  assert.equal(hook.status, 0, hook.stderr);

  const out = spawnSync('node', [BIN, 'trace', 'trace-cli-task'], { encoding: 'utf8', env: sb.env, cwd: project });
  assert.equal(out.status, 0, out.stderr);
  const trajectories = JSON.parse(out.stdout);
  assert.equal(trajectories.length, 1);
  const { AtifValidator } = await import('../src/atif.mjs');
  assert.equal(new AtifValidator().validate(trajectories[0]).ok, true);
  // the export carries the full claim linkage in extra.oathe
  assert.equal(trajectories[0].extra.oathe.task_id, 'trace-cli-task');
  assert.ok(trajectories[0].extra.oathe.work_claim_id);
  assert.match(out.stderr, /^oathe: trace ok$/m, 'summary rides stderr — stdout stays pure JSON');
  oathe(['yield', 'trace-cli-task', 'export test done']);
});

test('oathe hook render-board runs the SessionStart hook through the bin', () => {
  const out = spawnSync('node', [BIN, 'hook', 'render-board'], {
    input: JSON.stringify({ cwd: project, hook_event_name: 'SessionStart' }),
    encoding: 'utf8', env: sb.env,
  });
  assert.equal(out.status, 0, out.stderr);
  const payload = JSON.parse(out.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
});

test('oathe mcp serves the stdio JSON-RPC loop through the bin', () => {
  const out = spawnSync('node', [BIN, 'mcp'], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
    encoding: 'utf8', env: sb.env, timeout: 15000,
  });
  const line = out.stdout.trim().split('\n')[0];
  const msg = JSON.parse(line);
  assert.equal(msg.result.protocolVersion, '2025-06-18');
});

test('the config verb speaks every key\'s OWN type — booleans, numbers, and null all settable from the CLI', () => {
  // The review's AUTOACTIVATE finding: docs/PRIVACY.md documents `oathe config
  // autoActivate false --global` and the digits-only coercion refused it.
  const off = oathe(['config', 'autoActivate', 'false']);
  assert.equal(off.status, 0, off.stderr);
  const read = oathe(['config', 'autoActivate']);
  assert.match(read.stdout, /autoActivate = false/);
  const on = oathe(['config', 'autoActivate', 'true']);
  assert.equal(on.status, 0, on.stderr);
  // A nullable key takes the word null as null — never the string 'null'.
  const cleared = oathe(['config', 'notchApp', 'null']);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(oathe(['config', 'notchApp']).stdout, /notchApp = null/);
  // A wrong word is still the typed refusal.
  const bogus = oathe(['config', 'verifier', 'gemini']);
  assert.notEqual(bogus.status, 0);
  assert.match(bogus.stderr, /OATHE_CONFIG_VALUE_INVALID/);
});

test('oathe config gets and sets known keys, refuses unknown ones', () => {
  const get = oathe(['config', 'verifier']);
  assert.equal(get.status, 0, get.stderr);
  assert.match(get.stdout, /verifier = claude/);
  const set = oathe(['config', 'verifier', 'codex']);
  assert.equal(set.status, 0, set.stderr);
  const reread = oathe(['config', 'verifier']);
  assert.match(reread.stdout, /verifier = codex/);
  const bad = oathe(['config', 'made-up-key']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown config key/);
});

test('a second claim is the substrate refusal, faithfully non-zero', () => {
  oathe(['claim', 'twice-task', 'claim me once']);
  const second = oathe(['claim', 'twice-task', 'claim me twice']);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /oathe: claim refused/);
});

test('doctor prints per-row verdicts and the substrate summary', () => {
  const out = oathe(['doctor']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /substrate.*reachable/i);
  assert.match(out.stdout, new RegExp(`ddl.*${DDL_FILES.length}/${DDL_FILES.length}`, 'i'));
  assert.match(out.stdout, /ddl source: (vendor|monorepo|OATHE_DDL_DIR)/);
  assert.match(out.stdout, /ok/);
  assert.match(out.stdout, /^runtime: (oathe|standalone) \(requested auto\)/m,
    'the doctor names which runtime provider is active');
  assert.match(out.stdout, /^oathe: doctor ok$/m);
});

test('doctor --surface prints the resolution report without touching the substrate', () => {
  const workDir = fs.mkdtempSync(path.join(sb.home, 'surface-'));
  const out = spawnSync('node', [BIN, 'doctor', '--surface'], {
    encoding: 'utf8', cwd: workDir,
    env: { ...sb.env, OATHE_WORKSPACE_DIR: '${CLAUDE_PROJECT_DIR}', OATHE_DB: 'oathe_never_created' },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /env OATHE_WORKSPACE_DIR\s+\$\{CLAUDE_PROJECT_DIR\}/, 'inputs shown as received');
  assert.match(out.stdout, /workspace: ws-[0-9a-f]{12} via cwd/);
  assert.match(out.stdout, /note .*unexpanded template/);
  assert.match(out.stdout, /^oathe: doctor ok$/m);
});

test('doctor --surface on an unresolvable spawn is a visible attention, still exit-coded', () => {
  const out = spawnSync('node', [BIN, 'doctor', '--surface'], {
    encoding: 'utf8', cwd: sb.home, env: sb.env,
  });
  assert.equal(out.status, 1);
  assert.match(out.stdout, /workspace: UNRESOLVED/);
  assert.match(out.stdout, /home directory/);
  assert.match(out.stdout, /^oathe: doctor attention$/m);
});

test('the surface canary dumps argv/cwd/stdin/env and ALWAYS exits 0 — a probe, never a blocker', () => {
  const out = spawnSync('node', [path.join(paths.packageRoot, 'scripts/surface-canary.mjs'), '--surface', 'test-run'], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: sb.home }),
    encoding: 'utf8', env: sb.env, cwd: sb.home,
  });
  assert.equal(out.status, 0, out.stderr);
  const file = out.stderr.match(/surface-canary: (.+)$/m)?.[1];
  assert.ok(file, `the dump path is announced: ${out.stderr}`);
  const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(dump.surface, 'test-run');
  assert.equal(dump.stdin_payload.hook_event_name, 'SessionStart');
  assert.ok('CLAUDE_PROJECT_DIR' in dump.env_slice);
  assert.ok(file.startsWith(path.join(sb.env.OATHE_HOME, 'canary')));
});

test('status is the doctor substrate half', () => {
  const out = oathe(['status']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /database.*oathe_cli_test/i);
  assert.match(out.stdout, /^oathe: status ok$/m);
});

test('ls --all widens beyond the workspace', () => {
  const out = oathe(['ls', '--all']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^oathe: ls ok$/m);
});

test('oathe claim ACTIVATES the folder through the one writer: fences on disk, project rows recorded', () => {
  const claim = oathe(['claim', 'fence-cli-task', 'a claim writes the fence']);
  assert.equal(claim.status, 0, claim.stderr);
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    assert.match(fs.readFileSync(path.join(project, file), 'utf8'), /## Oathe/, `${file} carries the fence`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(sb.env.OATHE_HOME, 'install-manifest.json'), 'utf8'));
  assert.ok(manifest.rows.some((r) => r.kind === 'fence' && r.scope === 'project' && r.file === path.join(project, 'CLAUDE.md')));
  oathe(['yield', 'fence-cli-task', 'done with the fixture']);
});

test('oathe notch is PURE JSON on stdout — push, breaches, sections, workspace null; the trailer rides stderr', () => {
  const claim = oathe(['claim', 'notch-cli-task', 'Feed the glass']);
  assert.equal(claim.status, 0, claim.stderr);
  const out = oathe(['notch']);
  assert.equal(out.status, 0, out.stderr);
  const frame = JSON.parse(out.stdout); // pure JSON or this throws — the whole point
  assert.equal(frame.workspace, null, 'the machine frame has no folder lens');
  assert.ok(Array.isArray(frame.breaches), 'the breach digest rides the frame');
  assert.ok(frame.sections.mine.some((r) => r.task_id === 'notch-cli-task'), 'sections are the one classification');
  if (frame.breaches.length === 0) assert.equal(frame.push, null, 'breaches-or-silence');
  else assert.match(frame.push, /to fix|to verify|gone quiet/, 'the founder-worded push — person words, two buckets');
  assert.match(out.stderr, /^oathe: notch ok$/m, 'the trailer rides stderr — stdout stays machine-safe');
  oathe(['yield', 'notch-cli-task', 'fixture done']);
});

test('oathe notch answers from ANYWHERE — the home directory included — no workspace is resolved', () => {
  const out = oathe(['notch'], sb.env, sb.home);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).workspace, null);
});

test('oathe notch only SHOWS — the registry file is byte-identical after the run (R-PAGER kinship)', () => {
  const registryPath = path.join(sb.env.OATHE_HOME, 'workspaces.json');
  const before = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, 'utf8') : null;
  const out = oathe(['notch']);
  assert.equal(out.status, 0, out.stderr);
  const after = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, 'utf8') : null;
  assert.equal(after, before, 'a surface that only shows writes nothing');
});

test('the frame carries MOTION — live claims only, each with holder, last word, and a home path for the glass', () => {
  // This pin's premise is a BARE claim — no registered session. Earlier hook tests register
  // fixture sessions keyed to this very process's pid (the speaker primitive would truthfully
  // attribute to them), so the premise is made true, not assumed.
  fs.rmSync(path.join(sb.env.OATHE_HOME, 'sessions.json'), { force: true });
  const claim = oathe(['claim', 'motion-task', 'prove liveness']);
  assert.equal(claim.status, 0, claim.stderr);
  const out = oathe(['notch']);
  assert.equal(out.status, 0, out.stderr);
  const frame = JSON.parse(out.stdout);
  assert.ok(Array.isArray(frame.motion), 'motion rides the frame');
  const row = frame.motion.find((r) => r.task_id === 'motion-task');
  assert.ok(row, 'a just-claimed task is in motion — its claim is its first word');
  assert.equal(row.holder, 'founder');
  assert.match(row.last_word_at, /Z$/, 'UTC basis for the age the glass shows');
  assert.ok(row.home_path, 'home resolved to a path, not a ws-ref');
  assert.ok('surface' in row, 'the glass row names the surface when one is known');
  assert.equal(row.surface, null, 'a bare CLI claim has no known surface yet');
  assert.equal(row.session, null, 'no live session row — the liveness join is honest about absence');
  assert.equal(row.resume.kind, 'spawn-terminal',
    'an onboarded machine ALWAYS has a resumption — init recorded the default agent');
  assert.ok(frame.sections.mine.some((r) => r.task_id === 'motion-task'), 'sections stay intact');
  assert.ok(Array.isArray(frame.idle), 'idle-held claims ride separately — the sheet shows them after motion');
  assert.ok(!frame.idle.some((r) => r.task_id === 'motion-task'), 'a moving task is never also idle');
  oathe(['yield', 'motion-task', 'fixture done']);
});

test('resume is the package\'s call: a chosen default agent turns continue into a terminal spawn at the task\'s home', () => {
  fs.rmSync(path.join(sb.env.OATHE_HOME, 'sessions.json'), { force: true }); // bare-claim premise, made true
  const claim = oathe(['claim', 'resume-task', 'take me back']);
  assert.equal(claim.status, 0, claim.stderr);
  const out = oathe(['notch'], { ...sb.env, OATHE_DEFAULT_AGENT: 'claude' });
  assert.equal(out.status, 0, out.stderr);
  const row = JSON.parse(out.stdout).motion.find((r) => r.task_id === 'resume-task');
  assert.equal(row.resume.kind, 'spawn-terminal');
  assert.match(row.resume.command, /^oathe claude 'continue resume-task'$/, 'the launcher IS the resumption');
  assert.equal(row.resume.cwd, row.home_path);
  assert.ok(row.resume.terminal_bundle.endsWith('.app'), 'a terminal to open it in — the session\'s own, else the system one');
  oathe(['yield', 'resume-task', 'fixture done']);
});

test('a breach row carries its clock and its ACT — the glass renders an age and a button, never a truncated sentence', async () => {
  const substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
  try {
    await substrate.query(`
      INSERT INTO cell.task (org_id, task_id, department, objective, origin, verification_plan,
                             verify_by, claim_mode, created_at)
      VALUES ('oathe', 'quiet-breach-cli', 'founder', 'gone quiet', 'minted_at_claim',
              '{"plan_status":"unknown"}'::jsonb, now() + interval '7 days', 'exclusive', now())`);
    await substrate.query(
      `SELECT cell.claim_work('oathe', 'quiet-breach-cli', gen_random_uuid(), NULL, NULL, 'founder', 'founder',
              'exclusive', now() + interval '4 hours', $1, now() - interval '2 hours', gen_random_uuid())`,
      [`workspace:${(await import('../src/workspace.mjs')).workspaceRef(project)};contract:oathe/quiet-breach-cli@v1`]);
    const out = oathe(['notch'], { ...sb.env, OATHE_PAGER_QUIET_HOURS: '1' });
    assert.equal(out.status, 0, out.stderr);
    const breach = JSON.parse(out.stdout).breaches.find((b) => b.task_id === 'quiet-breach-cli');
    assert.ok(breach, 'the quiet claim pages');
    assert.match(breach.at, /Z$/, 'the breach clock rides the row');
    assert.equal(breach.act.kind, 'spawn-terminal', 'a quiet claim\'s act is the resumption');
    assert.match(breach.act.command, /'continue quiet-breach-cli'/);
  } finally {
    await substrate.close();
  }
});

test('oathe notch --serve streams ndjson frames — a write in another process lands a fresh frame within seconds', async () => {
  const { spawn } = await import('node:child_process');
  const readline = await import('node:readline');
  const child = spawn('node', [BIN, 'notch', '--serve'], { env: sb.env, cwd: project });
  const lines = [];
  let resolveNext = null;
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    lines.push(JSON.parse(l));
    resolveNext?.();
  });
  const nextFrame = (why) => Promise.race([
    new Promise((res) => { resolveNext = res; }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`no frame: ${why}`)), 8000)),
  ]);
  try {
    if (lines.length === 0) await nextFrame('initial frame never arrived');
    assert.equal(lines[0].workspace, null, 'the feed serves the machine frame');
    const woke = nextFrame('the wire carried nothing after a claim');
    const claim = oathe(['claim', 'serve-task', 'wake the feed']);
    assert.equal(claim.status, 0, claim.stderr);
    await woke;
    assert.ok(lines.at(-1).sections.mine.some((r) => r.task_id === 'serve-task'),
      'the pushed frame carries the new claim — no polling involved');
    // The verifier's verdict SPEAKS on the glass (founder ruling 2026-08-30): a rejected
    // settle rides the wire and the frame carries an amber NOTICE — the temporary bar line.
    const substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
    try {
      const verdict = nextFrame('the wire carried no rejection');
      await substrate.query(`SELECT pg_notify('oathe_wire', '{"kind":"rejected","task_id":"serve-task"}')`);
      await verdict;
      const { notice } = lines.at(-1);
      assert.equal(notice?.tone, 'amber', 'a rejection is amber — deviant, not celebratory');
      assert.match(notice?.text ?? '', /serve-task.+reopened/, 'the notice names the task and the consequence');
      // The act carries its living app on the wire (founder ruling 2026-08-30): a HOMELESS
      // claim heard from ChatGPT still resolves to "switch to that app" — never a shrug.
      const spoke = nextFrame('the wire carried no app-stamped act');
      await substrate.query('SELECT pg_notify($1, $2)', ['oathe_wire', JSON.stringify({
        kind: 'progress', task_id: 'serve-task', via: 'chatgpt',
        app: { bundle: '/Applications/ChatGPT.app', pid: process.pid }, // a genuinely live pid
      })]);
      await spoke;
      const row = lines.at(-1).motion.find((r) => r.task_id === 'serve-task');
      assert.ok(row, 'a heard task is motion');
      assert.equal(row.session?.surface, 'chatgpt', 'the heard app identity serves as the session ref');
      assert.equal(row.session?.alive, true);
      assert.deepEqual(row.resume, { kind: 'activate', app_pid: process.pid, bundle: '/Applications/ChatGPT.app' },
        'continue on a live heard app ACTIVATES it — homelessness never demotes a living speaker to copied');
    } finally {
      await substrate.close();
    }
    // THE MID-TURN PIN (founder bug, round 7): a claim spoken by a live registered session
    // must carry that session — and an activate resume — in the very next frame, with no
    // turn-end heartbeat involved. Attribution rides the speech act itself.
    {
      const { SessionRegistry } = await import('../src/sessions.mjs');
      fs.rmSync(path.join(sb.env.OATHE_HOME, 'sessions.json'), { force: true }); // exactly ONE live session
      await new SessionRegistry({ sessionsPath: path.join(sb.env.OATHE_HOME, 'sessions.json') }).ensure({
        sessionId: 'sess-mid-turn', pid: process.pid, // the CLI child's real parent IS this test process
        facts: () => ({
          ancestry: [{ pid: process.pid, exec: '/usr/local/bin/claude' }, { pid: 1, exec: '/sbin/launchd' }],
          app: { bundle: '/Applications/iTerm.app', pid: process.pid },
          transcriptPath: path.join(sb.home, '.claude', 'projects', 'x', 'mid.jsonl'),
          workspace: null,
        }),
      });
      const spoke = nextFrame('no frame after the mid-turn claim');
      const claim = oathe(['claim', 'mid-turn-task', 'attributed at the act']);
      assert.equal(claim.status, 0, claim.stderr);
      await spoke;
      const row = lines.at(-1).motion.find((r) => r.task_id === 'mid-turn-task');
      assert.ok(row, 'a fresh claim is motion');
      if (process.platform === 'darwin') {
        assert.equal(row.session?.surface, 'claude', 'the claim knows its session the moment it lands');
        assert.equal(row.session?.alive, true);
        assert.equal(row.resume?.kind, 'activate', 'continue mid-turn ACTIVATES the living session — never a duplicate terminal');
        assert.equal(row.resume?.app_pid, process.pid);
      } else {
        // Act attribution matches the caller's REAL ancestry against the registry — a
        // darwin fact (processAncestry). Elsewhere the claim still lands as motion, unowned.
        assert.ok(!row.session?.surface, 'off darwin the claim lands unattributed — the recorded degradation');
      }
    }
  } finally {
    child.kill();
    // The fixture session row is keyed to THIS runner's pid with a GHOST transcript —
    // left behind, the speaker primitive faithfully attributes every later CLI write in
    // this file to it, and the verifier then dies on the unreadable path. Facts out.
    fs.rmSync(path.join(sb.env.OATHE_HOME, 'sessions.json'), { force: true });
    oathe(['yield', 'serve-task', 'fixture done']);
    oathe(['yield', 'mid-turn-task', 'fixture done']);
  }
});

test('oathe notch --welcome plants + nudges — a LIVE serve rides the four lines on its very next frame, once', async () => {
  const { spawn } = await import('node:child_process');
  const readline = await import('node:readline');
  const { WELCOME_LINES } = await import('../src/welcome.mjs');
  const marker = path.join(sb.env.OATHE_HOME, 'welcome-pending.json');
  const child = spawn('node', [BIN, 'notch', '--serve'], { env: sb.env, cwd: project });
  const lines = [];
  let resolveNext = null;
  readline.createInterface({ input: child.stdout }).on('line', (l) => { lines.push(JSON.parse(l)); resolveNext?.(); });
  const nextFrame = (why) => Promise.race([
    new Promise((res) => { resolveNext = res; }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`no frame: ${why}`)), 8000)),
  ]);
  try {
    if (lines.length === 0) await nextFrame('initial frame never arrived');
    // The suite's init created the scratch DB fresh, so an earlier serve may already have
    // consumed that plant — this test asserts the demo lever, not the leftover.
    const woke = nextFrame('the wire carried no welcome nudge');
    const out = oathe(['notch', '--welcome']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /welcome queued/);
    assert.match(out.stderr, /^oathe: notch ok$/m, 'the notch trailer rides stderr in every mode');
    await woke;
    assert.deepEqual(lines.at(-1).welcome, { lines: [...WELCOME_LINES] }, 'the frame carries the founder copy');
    assert.ok(!fs.existsSync(marker), 'consumed on emit — one shot');
    const again = nextFrame('the wire carried no second nudge');
    const substrate = new Substrate({ database: SCRATCH_DB, paths, env: process.env });
    try {
      await substrate.query(`SELECT pg_notify('oathe_wire', '{"kind":"progress","task_id":"welcome-x"}')`);
      await again;
    } finally {
      await substrate.close();
    }
    assert.equal(lines.at(-1).welcome, undefined, 'the shot does not repeat');
  } finally {
    child.kill();
  }
});

test('bare oathe notch never consumes the welcome — the SHOW verb stays read-only', async () => {
  const { plantWelcome } = await import('../src/welcome.mjs');
  const sbPaths = buildPaths(sb.env);
  plantWelcome({ paths: sbPaths, by: 'cli' });
  try {
    const out = oathe(['notch']);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(!('welcome' in JSON.parse(out.stdout)), 'SHOW never carries the one-shot');
    assert.ok(fs.existsSync(sbPaths.welcomePath), 'and never eats it');
  } finally {
    fs.rmSync(sbPaths.welcomePath, { force: true });
  }
});

test('oathe notch --welcome with --serve is a typed refusal — the feed consumes, the flag plants', () => {
  const out = oathe(['notch', '--serve', '--welcome']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /\[OATHE_NOTCH_WELCOME_SERVE\]/);
  assert.match(out.stderr, /^oathe: notch refused$/m);
});

test('oathe notch --welcome with no live feed still plants — the next serve start plays it', () => {
  const marker = path.join(sb.env.OATHE_HOME, 'welcome-pending.json');
  fs.rmSync(marker, { force: true });
  const out = oathe(['notch', '--welcome']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /welcome queued/);
  assert.match(out.stderr, /^oathe: notch ok$/m);
  assert.ok(fs.existsSync(marker), 'planted for the next feed start');
  fs.rmSync(marker, { force: true });
});

test('oathe verify --detach dispatches and returns — the judgment survives its terminal', () => {
  const claim = oathe(['claim', 'detach-verify-task', 'judged in the background']);
  assert.equal(claim.status, 0, claim.stderr);
  const doneOut = oathe(['done', 'detach-verify-task', 'asserted']);
  assert.match(doneOut.stdout, /verification failed: engine /, 'done BLOCKED through its judgment and told the human');
  const out = oathe(['verify', '--detach', 'detach-verify-task']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /dispatched — the verdict lands on the glass/, 'the terminal is closable instantly');
  assert.match(out.stdout, /Log: .*verify-detach-verify-task\.log/, 'the run is inspectable');
  assert.match(out.stdout, /^oathe: verify ok$/m, 'the trailer rides stdout as on every verb');
});

test('a verb run from the HOME directory is REFUSED — nothing is written into ~', () => {
  const out = oathe(['claim', 'home-task', 'never'], sb.env, sb.home);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /OATHE_WORKSPACE_UNRESOLVED|home directory/);
  assert.match(out.stderr, /^oathe: claim refused$/m);
  assert.ok(!fs.existsSync(path.join(sb.home, 'CLAUDE.md')) && !fs.existsSync(path.join(sb.home, 'AGENTS.md')));
});

test('oathe version prints the package version with the trailer, and usage lists it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(paths.packageRoot, 'package.json'), 'utf8'));
  const out = oathe(['version']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`^${pkg.version.replaceAll('.', '\\.')}$`, 'm'));
  assert.match(out.stdout, /^oathe: version ok$/m);
  assert.match(oathe([]).stderr, /\bversion\b/);
});

test('doctor prints the version line: package version and the cached plugin versions', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(paths.packageRoot, 'package.json'), 'utf8'));
  const out = oathe(['doctor']);
  assert.match(out.stdout, new RegExp(`^version: ${pkg.version.replaceAll('.', '\\.')} \\(plugin cache: claude ${pkg.version.replaceAll('.', '\\.')}`, 'm'));
});

test('oathe init ends with the Next line (live polish #7) — the picker output kept the moment', () => {
  const out = oathe(['init', '--yes']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Next: oathe claude \(or codex, cursor\) in any project/,
    'the Next line names every launchable — cursor joined the primitive');
});
