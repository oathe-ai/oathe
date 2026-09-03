#!/usr/bin/env node
// Derive an on-disk trace fixture from a REAL record — sanitized until nothing private
// remains, then marker-scan-gated (any hit → OATHE_FIXTURE_MARKER_HIT, nothing written).
// The produced git diff is the review: a human reads the fixture before it lands.
//
//   derive-trace-fixtures.mjs <harness> --file <record> --name <slug>
//     [--out tests/fixtures/traces] [--max-lines 80] [--from <line>] [--child <child rollout>]...
//     --from cuts the window at a line (the head row — the identity — always rides along):
//     a fixture around the event of interest, not the record's opening. Cut at a boundary
//     the projector can pair (a codex turn, a Claude assistant row): a result whose call is
//     outside the window is a refusal, not a fixture.
//   derive-trace-fixtures.mjs --repin <fixture dir>   — rewrite expected.json from the record
//     (the projector changed on purpose); the record and the sidecar are never touched
//
// Sanitization: ids re-keyed deterministically (uuid shapes preserved — filenames encode
// them), every path re-homed to /Users/dev, every free-text string replaced by a redacted
// hash (exit-code statements preserved — observed facts are the point), exec sources
// rebuilt around their single inner call with string arguments redacted (task ids re-keyed
// so claim events survive), reasoning ciphertext blanked. Structure, roles, types, token
// counts, and timestamps survive — the fixture exercises the SHAPE, never the content.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';

import { byName } from '../src/harnesses/catalog.mjs';
import { ExecCallReader } from '../src/harnesses/codex-rollout.mjs';
import { MARKER_PATTERNS } from './marker-scan.mjs';
import { projectFixture, repin, writeExpected } from './trace-fixtures.mjs';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    file: { type: 'string' },
    name: { type: 'string' },
    out: { type: 'string', default: 'tests/fixtures/traces' },
    'max-lines': { type: 'string', default: '80' },
    from: { type: 'string' },
    child: { type: 'string', multiple: true, default: [] },
    repin: { type: 'string' },
  },
  allowPositionals: true,
});
if (values.repin) {
  try {
    process.stdout.write(`repin: ${await repin(values.repin)} ok\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[${e?.code ?? 'OATHE_FIXTURE_REPIN_FAILED'}] ${String(e?.message ?? e)}\n`);
    process.exit(2);
  }
}
const harness = positionals[0];
if (!harness || !values.file || !values.name) {
  process.stderr.write('usage: derive-trace-fixtures.mjs <claude|codex> --file <record> --name <slug> [--child <rollout>]...\n');
  process.exit(2);
}
const maxLines = Number(values['max-lines']);
const HOME = os.homedir();

/**
 * The corpus tooling per harness — how a record is sanitized row by row, where a fixture lays
 * its record out (the store's own layout, re-homed), how a sanitized record names itself, and
 * whether children ride the directory layout. Keyed by harness name the way the doc-vendoring
 * table is (scripts/pull-harness-docs.mjs): a table, never a branch on the name.
 */
const CORPUS_TOOLING = {
  codex: {
    sanitizeRow: (r) => sanitizeCodexRow(r),
    layout: (name) => path.join('.codex/sessions/2026/01/01', name),
    fileName: (id, stamp) => `rollout-2026-01-01${stamp}-${id}.jsonl`,
    idOf: (lines) => JSON.parse(lines[0]).payload.id,
    subagentDirs: false,
  },
  claude: {
    sanitizeRow: (r) => sanitizeClaudeRow(r),
    layout: (name) => path.join('.claude/projects/-Users-dev-app', name),
    fileName: (id) => `${id}.jsonl`,
    idOf: (lines) => JSON.parse(lines.find((l) => JSON.parse(l).sessionId) ?? '{}').sessionId,
    subagentDirs: true,
  },
};
const tooling = CORPUS_TOOLING[harness];
if (!tooling) {
  process.stderr.write(`[OATHE_FIXTURE_HARNESS_UNKNOWN] no corpus tooling for '${harness}' — one of: ${Object.keys(CORPUS_TOOLING).join(', ')}\n`);
  process.exit(2);
}
const sha8 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
const EXIT_LINE = /[Ee]xit code:?\s+(\d+)/;

// ---- deterministic re-keying: uuid shapes preserved (filenames encode them)
const idMap = new Map();
let idSeq = 0;
const UUIDISH = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
function rekeyUuid(id) {
  if (!idMap.has(id)) {
    idSeq += 1;
    idMap.set(id, `00000000-0000-7000-8000-${String(idSeq).padStart(12, '0')}`);
  }
  return idMap.get(id);
}
const prefixMaps = new Map();
function rekeyPrefixed(id) {
  const prefix = String(id).split('_')[0];
  const map = prefixMaps.get(prefix) ?? new Map();
  prefixMaps.set(prefix, map);
  if (!map.has(id)) map.set(id, `${prefix}_${map.size + 1}`);
  return map.get(id);
}
function rekeyIdsIn(text) {
  return String(text).replace(UUIDISH, (m) => rekeyUuid(m));
}
function repath(text) {
  return rekeyIdsIn(String(text)
    .replaceAll(recordCwd, '/Users/dev/app')
    .replaceAll(HOME, '/Users/dev'));
}
function redactText(text) {
  const s = String(text);
  const exit = s.match(EXIT_LINE);
  return `redacted ${sha8(s)} (len ${s.length})${exit ? `\nExit code ${exit[1]}` : ''}`;
}
// Agent paths (/root/<nickname>…) name the work; re-keyed CONSISTENTLY across spawn
// arguments, thread sources, inter-agent authors/recipients and the item stream.
const agentPaths = new Map();
function rekeyAgentPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/root')) return p;
  if (p === '/root') return p;
  if (!agentPaths.has(p)) agentPaths.set(p, `/root/agent-${agentPaths.size + 1}`);
  return agentPaths.get(p);
}
// An item id is `exec-<uuid>` (the uuid re-keys inside it) or prefixed like the response_item
// ids (`call_…`, `rs_…`, `msg_…`) — the same maps, so the joins survive sanitization.
const rekeyId = (id) => (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(String(id)) ? rekeyIdsIn(id) : rekeyPrefixed(id));

// ---- sanitizers
const reader = new ExecCallReader();
function sanitizeArgs(args, { keepKeys = [] } = {}) {
  if (args === null || typeof args !== 'object') return args;
  return Object.fromEntries(Object.entries(args).map(([k, v]) => {
    if (typeof v !== 'string') return [k, v];
    if (k === 'task_id') return [k, v.replace(/[^a-z0-9:_-]/gi, '-')]; // task ids are already public-shaped slugs; keep them so claim events survive
    if (k === 'workdir' || k === 'cwd' || k === 'file_path') return [k, repath(v)];
    if (keepKeys.includes(k)) return [k, v];
    return [k, `redacted-${sha8(v)}`];
  }));
}
function sanitizeExecInput(input) {
  const calls = reader.read(input);
  const single = calls.length === 1 && calls[0].args !== null ? calls[0] : null;
  // A source the reader cannot reduce to one data call keeps the NAMES of its inner calls
  // (redacted arguments): the item stream joins to a raw source by the tool name it names.
  if (!single) return `/* redacted exec source ${sha8(input)} */ ${calls.map((c) => `tools.${c.tool}(/* redacted */);`).join(' ')}`;
  return `const r = await tools.${single.tool}(${JSON.stringify(sanitizeArgs(single.args))});\nfor (const c of (r.content||[])) if (c.type==="text") text(c.text);\n`;
}
/**
 * An inter-agent message keeps its STRUCTURE — the typed first line and the address headers
 * (agent paths re-keyed) — and loses its payload; the projector reads the type from the first
 * line and the fixture must still say it.
 */
function sanitizeInterAgentText(text) {
  const lines = String(text).split('\n');
  if (!/^Message Type:\s*\S+/.test(lines[0])) return redactText(text);
  const kept = [];
  for (const line of lines) {
    if (/^Message Type:/.test(line)) kept.push(line);
    else if (/^(Task name|Sender):\s*/.test(line)) kept.push(line.replace(/(\S+)$/, (p) => rekeyAgentPath(p)));
    else if (/^Payload:\s*$/.test(line)) { kept.push(line); break; } else break;
  }
  const rest = lines.slice(kept.length).join('\n');
  return `${kept.join('\n')}\n${redactText(rest)}`;
}

function sanitizeParts(content, redact = redactText) {
  if (typeof content === 'string') return redact(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    const out = { ...part };
    if (typeof out.encrypted_content === 'string') out.encrypted_content = 'gAAAA-redacted';
    if (typeof out.text === 'string') out.text = redact(out.text);
    if (typeof out.thinking === 'string') out.thinking = redact(out.thinking);
    if (typeof out.content === 'string' || Array.isArray(out.content)) out.content = sanitizeParts(out.content, redact);
    if (out.tool_use_id) out.tool_use_id = rekeyPrefixed(out.tool_use_id);
    if (out.type === 'tool_use') {
      out.id = rekeyPrefixed(out.id);
      out.input = sanitizeArgs(out.input ?? {});
    }
    for (const k of Object.keys(out)) if (typeof out[k] === 'string' && k !== 'type') out[k] = repath(out[k]);
    return out;
  });
}

/**
 * The typed item stream, per type and deny-by-default: structure survives (ids re-keyed with
 * the same maps the response_item rows use, so the joins survive), content never does. A
 * CommandExecution's command words are redacted with the SAME rule as the exec source's
 * arguments (redacted-<sha8>) so `command` tail == parsed `cmd` still holds in the fixture.
 */
function sanitizeItem(item) {
  const base = { type: item.type, ...(item.id ? { id: rekeyId(item.id) } : {}) };
  switch (item.type) {
    case 'CommandExecution':
      return {
        ...base,
        command: (item.command ?? []).map((word) => `redacted-${sha8(word)}`),
        ...(item.cwd ? { cwd: repath(item.cwd) } : {}),
        status: item.status, exit_code: item.exit_code,
        stdout: redactText(item.stdout ?? ''), stderr: redactText(item.stderr ?? ''),
        ...(item.aggregated_output !== undefined ? { aggregated_output: redactText(item.aggregated_output) } : {}),
        ...(item.duration ? { duration: item.duration } : {}),
      };
    case 'McpToolCall':
      return {
        ...base, server: item.server, tool: item.tool, arguments: sanitizeArgs(item.arguments ?? {}), status: item.status,
        ...(item.result ? { result: { content: sanitizeParts(item.result.content), isError: item.result.isError } } : {}),
        ...(item.error ? { error: redactText(item.error) } : {}),
        ...(item.duration ? { duration: item.duration } : {}),
      };
    case 'FileChange':
      return {
        ...base,
        changes: Object.fromEntries(Object.entries(item.changes ?? {})
          .map(([file, change]) => [repath(file), { type: change?.type, content: redactText(change?.content ?? '') }])),
        status: item.status, stdout: redactText(item.stdout ?? ''), stderr: redactText(item.stderr ?? ''),
      };
    case 'SubAgentActivity':
      return { ...base, kind: item.kind, agent_thread_id: rekeyIdsIn(item.agent_thread_id ?? ''), agent_path: rekeyAgentPath(item.agent_path) };
    case 'Extension':
      return {
        ...base, kind: item.kind, query: redactText(item.query ?? ''),
        action: { type: item.action?.type, ...(item.action?.url ? { url: `https://redacted.invalid/${sha8(item.action.url)}` } : {}) },
        results: (item.results ?? []).map((r) => ({ title: redactText(r.title ?? ''), url: `https://redacted.invalid/${sha8(r.url ?? '')}` })),
      };
    case 'CollabAgentToolCall':
      return { ...base, tool: item.tool, status: item.status };
    default:
      return base; // Reasoning, AgentMessage, UserMessage, ContextCompaction, Plan, DynamicToolCall, ImageView, …
  }
}

function sanitizeCodexRow(row) {
  const out = { ...row, payload: { ...(row.payload ?? {}) } };
  const p = out.payload;
  delete p.internal_chat_message_metadata_passthrough;
  // Deny-by-default for everything projection ignores: the census reads only the TYPE of
  // these rows — their content never earns a place in a public fixture.
  if (out.type === 'world_state' || out.type === 'inter_agent_communication_metadata') {
    out.payload = {};
    return out;
  }
  if (out.type === 'event_msg' && p.type === 'item_completed') {
    out.payload = {
      type: p.type,
      ...(p.thread_id ? { thread_id: rekeyIdsIn(p.thread_id) } : {}),
      ...(p.turn_id ? { turn_id: rekeyIdsIn(p.turn_id) } : {}),
      ...(p.item ? { item: sanitizeItem(p.item) } : {}),
      ...(p.started_at_ms !== undefined ? { started_at_ms: p.started_at_ms } : {}),
      ...(p.completed_at_ms !== undefined ? { completed_at_ms: p.completed_at_ms } : {}),
    };
    return out;
  }
  if (out.type === 'event_msg' && p.type !== 'token_count') {
    out.payload = {
      type: p.type,
      ...(p.turn_id ? { turn_id: rekeyIdsIn(p.turn_id) } : {}),
      ...(p.thread_id ? { thread_id: rekeyIdsIn(p.thread_id) } : {}),
    };
    return out;
  }
  if (out.type === 'event_msg' && p.type === 'token_count') {
    out.payload = { type: 'token_count', info: p.info };
    return out;
  }
  for (const key of ['id']) if (p[key]) p[key] = /-/.test(p[key]) && UUIDISH.test(p[key]) ? rekeyIdsIn(p[key]) : rekeyPrefixed(p[key]);
  if (p.call_id) p.call_id = rekeyPrefixed(p.call_id);
  if (out.type === 'session_meta') {
    if (p.cwd) p.cwd = repath(p.cwd);
    if (p.git) p.git = { branch: 'main', sha: '0'.repeat(40) };
    if (p.originator) p.originator = 'redacted';
    if (p.parent_thread_id) p.parent_thread_id = rekeyIdsIn(p.parent_thread_id);
    if (p.forked_from_id) p.forked_from_id = rekeyIdsIn(p.forked_from_id); // a fork names its parent here too
    if (p.source && typeof p.source === 'object') {
      p.source = JSON.parse(repath(JSON.stringify(p.source)));
      const spawn = p.source.subagent?.thread_spawn;
      if (spawn) {
        if (spawn.agent_path) spawn.agent_path = rekeyAgentPath(spawn.agent_path);
        if (spawn.agent_nickname) spawn.agent_nickname = rekeyAgentPath(`/root/${spawn.agent_nickname}`).slice('/root/'.length);
      }
    }
  } else if (out.type === 'turn_context') {
    if (p.cwd) p.cwd = repath(p.cwd);
    if (p.workspace_roots) p.workspace_roots = p.workspace_roots.map(repath);
    if (p.turn_id) p.turn_id = rekeyIdsIn(p.turn_id);
    delete p.permission_profile;
  } else if (out.type === 'compacted') {
    p.message = p.message ? redactText(p.message) : p.message;
    if (Array.isArray(p.replacement_history)) {
      p.replacement_history = p.replacement_history.map((r) => sanitizeCodexRow({ type: 'response_item', payload: r }).payload);
    }
  } else if (out.type === 'response_item' || out.type === 'event_msg') {
    if (p.role && p.content) p.content = sanitizeParts(p.content);
    else if (p.type === 'agent_message') {
      p.content = sanitizeParts(p.content, p.recipient ? sanitizeInterAgentText : redactText);
      if (p.author) p.author = rekeyAgentPath(repath(p.author));
      if (p.recipient) p.recipient = rekeyAgentPath(repath(p.recipient));
    }
    if (p.type === 'reasoning') {
      if (p.encrypted_content) p.encrypted_content = 'gAAAA-redacted';
      if (p.content) p.content = sanitizeParts(p.content);
      if (Array.isArray(p.summary)) p.summary = sanitizeParts(p.summary);
    }
    if (p.type === 'custom_tool_call' && typeof p.input === 'string') p.input = sanitizeExecInput(p.input);
    if (typeof p.arguments === 'string') {
      try { p.arguments = JSON.stringify(sanitizeArgs(JSON.parse(p.arguments))); } catch { p.arguments = '{}'; }
    }
    if (p.output !== undefined) p.output = sanitizeParts(p.output);
    if (p.tools !== undefined) p.tools = [];
    if (p.turn_id) p.turn_id = rekeyIdsIn(p.turn_id);
    if (p.thread_id) p.thread_id = rekeyIdsIn(p.thread_id);
  }
  return out;
}

const CLAUDE_EVIDENCE_TYPES = new Set(['user', 'assistant', 'system', 'ai-title', 'file-history-snapshot']);
/** The one re-keying of a Claude agent id — the subagent file name, its rows' agentId, and a notification's task-id agree. */
const rekeyAgentId = (id) => rekeyPrefixed(`x_${id}`).replace(/^x_/, 'id');
/**
 * A task-notification keeps its STRUCTURE — the tags, the task-id (an agent id, re-keyed
 * with the subagent's own rule) and the tool-use-id (re-keyed with the call's) — and loses
 * every other tag's text; the projector reads the ids, the fixture must still carry them.
 */
function sanitizeNotification(text) {
  // The wrapper tag is skipped (matching it would swallow its children whole); each child is rewritten.
  return String(text).replace(/<((?!task-notification\b)[a-z-]+)>([\s\S]*?)<\/\1>/g, (whole, tag, inner) => {
    if (tag === 'task-id') return `<task-id>${rekeyAgentId(inner)}</task-id>`;
    if (tag === 'tool-use-id') return `<tool-use-id>${rekeyPrefixed(inner)}</tool-use-id>`;
    if (tag === 'status') return whole;
    return `<${tag}>${redactText(inner)}</${tag}>`;
  });
}
function sanitizeClaudeRow(row) {
  // Deny-by-default for everything projection ignores — the census reads only the type.
  if (!CLAUDE_EVIDENCE_TYPES.has(row.type)) {
    return { type: row.type, ...(row.sessionId ? { sessionId: rekeyUuid(row.sessionId) } : {}) };
  }
  const out = JSON.parse(rekeyIdsIn(JSON.stringify(row)));
  for (const key of ['uuid', 'parentUuid', 'leafUuid', 'messageId']) {
    if (out[key]) out[key] = rekeyPrefixed(`x_${out[key]}`).replace(/^x_/, 'id');
  }
  if (out.agentId) out.agentId = rekeyAgentId(out.agentId);
  if (out.cwd) out.cwd = repath(out.cwd);
  if (out.gitBranch) out.gitBranch = 'main';
  if (out.aiTitle) out.aiTitle = 'Fixture title';
  if (out.snapshot?.trackedFileBackups) {
    out.snapshot.trackedFileBackups = Object.fromEntries(Object.keys(out.snapshot.trackedFileBackups)
      .map((_, i) => [`/Users/dev/app/file-${i + 1}`, `b${i + 1}`]));
  }
  if (out.message) {
    const m = out.message;
    // The harness's own rows (origin.kind) keep their structure; the person's lose their words.
    const redact = out.origin?.kind === 'task-notification' ? sanitizeNotification : redactText;
    if (m.content) m.content = sanitizeParts(m.content, redact);
    if (m.id) m.id = rekeyPrefixed(m.id);
  }
  if (out.type === 'system' && typeof out.content === 'string') out.content = redactText(out.content);
  return out;
}

/** The safety net: any long string the targeted rules missed (signatures, request blobs)
 *  is redacted wholesale — structure survives, content never does. */
function redactLongStrings(node) {
  if (typeof node === 'string') {
    // The sanitizer's own rebuilt shapes — an exec source, an inter-agent message, a
    // task-notification — carry structure the projector reads and no content; they pass.
    const sanitized = node.startsWith('redacted') || node.startsWith('/* redacted')
      || node.startsWith('const r = await tools.') || node.startsWith('Message Type:') || node.startsWith('<task-notification>');
    return node.length >= 100 && !sanitized ? `redacted-${sha8(node)} (len ${node.length})` : node;
  }
  if (Array.isArray(node)) return node.map(redactLongStrings);
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, redactLongStrings(v)]));
  }
  return node;
}

// ---- read, cap, sanitize
const capability = byName(harness).traces;
const store = await capability.store({});
const recordCwd = (() => {
  try { return store.describe(values.file).cwd ?? '/nonexistent-cwd'; } catch { return '/nonexistent-cwd'; }
})();
/** The rows a fixture keeps: the head window, or — cut at `from` — the head row plus the window from there. */
function windowOf(file, { from = 1 } = {}) {
  const rows = store.entries(file);
  return from > 1 ? [rows[0], ...rows.slice(from - 1, from - 1 + maxLines)] : rows.slice(0, maxLines);
}
function sanitizeFile(file, opts = {}) {
  return sanitizeRows(windowOf(file, opts));
}
function sanitizeRows(capped) {
  return capped.map((r) => {
    // the last serialized pass: any residual path or workspace ref, wherever it hid
    let line = JSON.stringify(redactLongStrings(tooling.sanitizeRow(r)));
    line = line.replaceAll(recordCwd, '/Users/dev/app').replaceAll(HOME, '/Users/dev');
    line = line.replace(/ws-[0-9a-f]{12}/g, 'ws-000000000000');
    line = rekeyIdsIn(line); // every uuid-shaped id, whatever field carries it (window ids, session ids, a fork's parent) — one map, first seen first
    return line;
  }).join('\n');
}

// ---- write to staging (fixture layout), gate, then move
const today = new Date().toISOString().slice(0, 10);
const fixtureDir = path.join(values.out, harness, `${today}-${values.name}`);
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-derive-'));
const layoutFor = tooling.layout;

// The window starts after the head row; anything else is a refusal before a byte is written.
const from = values.from === undefined ? 1 : Number(values.from);
const recordLength = store.entries(values.file).length;
if (values.from !== undefined && (!Number.isInteger(from) || from < 2 || from > recordLength)) {
  process.stderr.write(`[OATHE_FIXTURE_FROM_OUT_OF_RANGE] --from ${values.from}: the window starts after the head row — 2..${recordLength} for this record (omit --from for the head window)\n`);
  process.exit(2);
}
const mainWindow = windowOf(values.file, { from });
const mainText = sanitizeRows(mainWindow);
const mainId = tooling.idOf(mainText.split('\n'));
const mainName = tooling.fileName(mainId, 'T00-00-00');
const mainRel = layoutFor(mainName);
fs.mkdirSync(path.join(staging, 'home', path.dirname(mainRel)), { recursive: true });
fs.writeFileSync(path.join(staging, 'home', mainRel), mainText);

if (tooling.subagentDirs) {
  // Claude fan-out rides the directory layout: sanitize each subagent transcript (+ meta) —
  // but only a child the WINDOW launched (its meta.toolUseId names a tool_use in the window);
  // any other would embed with no receipt to carry its ref, a shape no real read produces.
  const launched = new Set(mainWindow.filter((r) => r.type === 'assistant')
    .flatMap((r) => (r.message?.content ?? []).filter((p) => p.type === 'tool_use').map((p) => p.id)));
  for (const sub of store.subagentsFor(values.file)) {
    if (!sub.meta?.toolUseId || !launched.has(sub.meta.toolUseId)) {
      process.stderr.write(`derive: subagent ${sub.agent_id} left out: its launching call ${sub.meta?.toolUseId ?? '(unknown — no meta)'} is outside the window\n`);
      continue;
    }
    const subDir = path.join(staging, 'home', path.dirname(mainRel), mainId, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    // Named by the RE-KEYED agent id — the same key its rows' agentId and the parent's
    // task-notification task-id carry, so the joins survive sanitization.
    const agentId = rekeyAgentId(sub.agent_id);
    fs.writeFileSync(path.join(subDir, `agent-${agentId}.jsonl`), sanitizeFile(sub.path));
    if (sub.meta) {
      fs.writeFileSync(path.join(subDir, `agent-${agentId}.meta.json`), JSON.stringify({
        agentType: sub.meta.agentType ?? null,
        description: 'redacted',
        toolUseId: sub.meta.toolUseId ? rekeyPrefixed(sub.meta.toolUseId) : null,
        spawnDepth: sub.meta.spawnDepth ?? 1,
      }));
    }
  }
}

if (values.child.length > 0) {
  const inserts = [];
  for (const childFile of values.child) {
    const childText = sanitizeFile(childFile);
    const childHead = JSON.parse(childText.split('\n')[0]).payload;
    const childName = tooling.fileName(childHead.id, 'T00-05-00');
    const childRel = layoutFor(childName);
    fs.writeFileSync(path.join(staging, 'home', childRel), childText);
    // The index row names the child the way its own (sanitized) session_meta does — one
    // re-keying of the agent path across the head, the spawn items and the sqlite source.
    const spawn = childHead.source?.subagent?.thread_spawn ?? {};
    inserts.push(
      `INSERT INTO threads (id, rollout_path, cwd, source, created_at) VALUES ('${childHead.id}', `
      + `'<home>/${childRel}', '/Users/dev/app', '${JSON.stringify({ subagent: { thread_spawn: {
        parent_thread_id: mainId, depth: spawn.depth ?? 1,
        agent_path: spawn.agent_path ?? rekeyAgentPath(`/root/child-${inserts.length / 2 + 1}`),
        agent_nickname: spawn.agent_nickname ?? (spawn.agent_path ?? '/root/agent').split('/').at(-1),
        agent_role: spawn.agent_role ?? 'worker',
      } } })}', 1);`,
      `INSERT INTO thread_spawn_edges VALUES ('${mainId}', '${childHead.id}', 'open');`,
    );
  }
  fs.writeFileSync(path.join(staging, 'state.sql'), [
    `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT, title TEXT,
       tokens_used INTEGER, git_sha TEXT, git_branch TEXT, source TEXT, created_at INTEGER);`,
    'CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);',
    ...inserts, ''].join('\n'));
}

// the produced files must scan clean — plus the machine's own identity, never in a fixture
const gate = [...MARKER_PATTERNS, new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), new RegExp(`\\b${process.env.USER}\\b`)];
for (const file of fs.readdirSync(staging, { recursive: true })) {
  const full = path.join(staging, String(file));
  if (!fs.statSync(full).isFile()) continue;
  const text = fs.readFileSync(full, 'utf8');
  for (const pattern of gate) {
    if (pattern.test(text)) {
      process.stderr.write(`[OATHE_FIXTURE_MARKER_HIT] ${file}: matches ${pattern} — nothing written\n`);
      fs.rmSync(staging, { recursive: true, force: true });
      process.exit(1);
    }
  }
}

// expected.json = the projection of the sanitized record, home-normalized — the ONE projection
// `--repin` rewrites later (scripts/trace-fixtures.mjs), so a fixture never drifts from its tool.
const normalized = await projectFixture(staging, { harness, record: mainRel });

fs.mkdirSync(fixtureDir, { recursive: true });
fs.cpSync(staging, fixtureDir, { recursive: true });
writeExpected(path.join(fixtureDir, 'expected.json'), {
  _source: `sanitized from a real ${harness} record by scripts/derive-trace-fixtures.mjs — review this diff before it lands`,
  record: mainRel,
  window: { from, max_lines: maxLines },
  trajectory: normalized,
});
fs.rmSync(staging, { recursive: true, force: true });
process.stdout.write(`derive-trace-fixtures: ${fixtureDir} ok\n`);
