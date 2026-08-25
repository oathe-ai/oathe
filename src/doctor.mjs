// oathe doctor — verify every manifest row against the world as it is NOW. A user edit inside
// an owned surface is REPORTED, never overwritten: the manifest records what oathe wrote, the
// doctor says whether it still stands, and the user's hand outranks ours.

import fs from 'node:fs';
import path from 'node:path';

import { buildContext } from './context.mjs';
import { FencedBlock, FENCE_STYLES, JsonEntries } from './blocks.mjs';
import { sha256Hex } from './manifest.mjs';

function verifyJsonRow(row) {
  if (!fs.existsSync(row.file)) return 'file-missing';
  const text = fs.readFileSync(row.file, 'utf8');
  const engine = new JsonEntries();
  const entries = [];
  for (const p of row.detail?.paths ?? []) {
    const value = engine.read(text, p);
    if (value === undefined) return 'removed';
    entries.push({ path: p, value });
  }
  return sha256Hex(JSON.stringify(entries)) === row.sha256 ? 'ok' : 'user-edited';
}

function verifyFenceRow(row) {
  if (!fs.existsSync(row.file)) return 'file-missing';
  const block = new FencedBlock({ style: FENCE_STYLES[row.detail?.style ?? 'hash'] });
  const seen = block.read(fs.readFileSync(row.file, 'utf8'));
  if (!seen.present) return 'removed';
  return sha256Hex(seen.blockText) === row.sha256 ? 'ok' : 'user-edited';
}

function verifyCliRow(row) {
  if (!fs.existsSync(row.file)) return 'file-missing';
  return fs.readFileSync(row.file, 'utf8').includes(row.detail?.proof) ? 'ok' : 'removed';
}

const VERIFIERS = { 'json-path': verifyJsonRow, fence: verifyFenceRow, 'cli-managed': verifyCliRow };

/** @returns {Promise<{rows: object[], substrate: object, plugin: {resolves: boolean, detail: string|null}}>} */
export async function runDoctor({ env = process.env } = {}) {
  const ctx = buildContext({ env });
  const { manifest, substrate, paths } = ctx;
  try {
    const rows = manifest.rows.map((row) => ({
      harness: row.harness,
      file: row.file,
      kind: row.kind,
      block_version: row.block_version,
      status: (VERIFIERS[row.kind] ?? (() => 'unknown-kind'))(row),
    }));
    // The trace-contract monitor: both vendors disclaim transcript-schema stability, so the
    // doctor validates the NEWEST live record in each store against docs/traces.md and
    // reports DRIFT loudly. An absent store is a distinct, visible status — never a silent skip.
    const { ClaudeTraceStore, CodexTraceStore } = await import('./traces.mjs');
    const home = ctx.home;
    const traces = {};
    for (const [name, store] of Object.entries({
      claude: new ClaudeTraceStore({ home }),
      codex: new CodexTraceStore({ home }),
    })) {
      const newest = name === 'claude' ? store.newestTranscript() : store.newestRollout();
      if (!newest) {
        traces[name] = { status: 'store-absent', newest: null, detail: 'no session records found' };
        continue;
      }
      const seen = store.validate(newest);
      traces[name] = {
        status: seen.ok ? 'ok' : 'DRIFT',
        newest,
        detail: seen.detail,
      };
    }

    let plugin;
    try {
      const manifestDoc = JSON.parse(
        fs.readFileSync(path.join(paths.pluginDir, '.claude-plugin/plugin.json'), 'utf8'));
      plugin = manifestDoc.name === 'oathe'
        ? { resolves: true, detail: null }
        : { resolves: false, detail: `plugin.json names '${manifestDoc.name}', not 'oathe'` };
    } catch (e) {
      plugin = { resolves: false, detail: String(e?.message || e) };
    }
    return { rows, substrate: await substrate.status(), plugin, traces };
  } finally {
    await substrate.close();
  }
}
