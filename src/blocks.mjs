// oathe — the managed-write engines. Every byte oathe puts in a user file goes through one of
// these two classes, so "replace own block only, never touch outside" is a property of the type,
// not a discipline each call site re-implements.
//
// Two styles exist because the surfaces do: fenced TEXT for files with comments (CLAUDE.md,
// AGENTS.md, config.toml — the long-standing zprofile `>>> <<<` precedent), and owned KEY PATHS for
// JSON files, where ownership is recorded in the install manifest rather than as in-file marker
// keys (Claude Code validates settings.json and warns on unknown keys, so the file stays clean
// and the manifest carries the version + sha).

import fs from 'node:fs';

const FENCE_NAME = 'oathe';

export const FENCE_STYLES = Object.freeze({
  hash: { open: (v) => `# >>> ${FENCE_NAME} v${v} >>>`, close: `# <<< ${FENCE_NAME} <<<` },
  html: { open: (v) => `<!-- >>> ${FENCE_NAME} v${v} >>> -->`, close: `<!-- <<< ${FENCE_NAME} <<< -->` },
});

/**
 * The opening marker split around its version slot, so locate matches ANY version. NUL is
 * the sentinel because it is the one character no rendered marker can contain.
 */
function openMarkerPattern(style) {
  const probe = style.open('\u0000');
  const [before, after] = probe.split('\u0000');
  return { before, after };
}

export class DuplicateFenceError extends Error {
  constructor(count) {
    super(`duplicate oathe fences: found ${count} managed blocks in one file; refusing to edit `
      + 'rather than guess which one is ours — remove the extras by hand or run `oathe doctor`');
    this.name = 'DuplicateFenceError';
    this.code = 'OATHE_DUPLICATE_FENCE';
  }
}

export class FencedBlock {
  /** @param {{style: {open: (v:string)=>string, close: string}}} o */
  constructor({ style }) {
    this.style = style;
  }

  /** The complete block text (no trailing newline) — also what the manifest hashes. */
  render(version, body) {
    return `${this.style.open(version)}\n${body}\n${this.style.close}`;
  }

  /**
   * Every managed block in `content`, located by scanning lines for the open/close markers.
   * @returns {{start: number, end: number, version: string, body: string}[]} index ranges cover
   *          the block text exactly (no surrounding newlines).
   */
  #locate(content) {
    const { before, after } = openMarkerPattern(this.style);
    const found = [];
    let from = 0;
    for (;;) {
      const start = content.indexOf(before, from);
      if (start === -1) break;
      const openEnd = content.indexOf('\n', start);
      if (openEnd === -1) break;
      const openLine = content.slice(start, openEnd);
      if (!openLine.endsWith(after)) { from = start + before.length; continue; }
      const version = openLine.slice(before.length, openLine.length - after.length);
      const closeAt = content.indexOf(this.style.close, openEnd);
      if (closeAt === -1) break;
      const end = closeAt + this.style.close.length;
      found.push({ start, end, version, body: content.slice(openEnd + 1, closeAt - 1) });
      from = end;
    }
    return found;
  }

  #single(content) {
    const found = this.#locate(content);
    if (found.length > 1) throw new DuplicateFenceError(found.length);
    return found[0] ?? null;
  }

  /** @returns {{present: boolean, version: string|null, body: string|null, blockText: string|null}} */
  read(content) {
    const block = this.#single(content);
    if (!block) return { present: false, version: null, body: null, blockText: null };
    return {
      present: true,
      version: block.version,
      body: block.body,
      blockText: content.slice(block.start, block.end),
    };
  }

  /**
   * Create or replace THE managed block. Content outside the fence is preserved byte-for-byte.
   * @returns {{content: string, changed: boolean}}
   */
  apply(content, { version, body }) {
    const rendered = this.render(version, body);
    const existing = this.#single(content);
    if (existing) {
      const next = content.slice(0, existing.start) + rendered + content.slice(existing.end);
      return { content: next, changed: next !== content };
    }
    if (content === '') return { content: `${rendered}\n`, changed: true };
    const sep = content.endsWith('\n') ? '\n' : '\n\n';
    return { content: `${content}${sep}${rendered}\n`, changed: true };
  }

  /** Delete the managed block and the separating blank line `apply` introduced. Idempotent. */
  remove(content) {
    const existing = this.#single(content);
    if (!existing) return { content, changed: false };
    let head = content.slice(0, existing.start);
    let tail = content.slice(existing.end);
    if (tail.startsWith('\n')) tail = tail.slice(1);
    if (head.endsWith('\n\n')) head = head.slice(0, -1);
    return { content: head + tail, changed: true };
  }
}

export class JsonTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JsonTargetError';
    this.code = 'OATHE_JSON_TARGET_INVALID';
  }
}

function parseJsonTarget(text) {
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new JsonTargetError(`the target file is not valid JSON, so oathe refuses to rewrite it: ${e.message}`);
  }
}

function stringifyJsonTarget(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export class JsonEntries {
  #parse(text) {
    return parseJsonTarget(text);
  }

  #stringify(doc) {
    return stringifyJsonTarget(doc);
  }

  /** @returns {*} the value at `path`, or undefined */
  read(text, path) {
    let node = this.#parse(text);
    for (const key of path) {
      if (node === null || typeof node !== 'object' || !(key in node)) return undefined;
      node = node[key];
    }
    return node;
  }

  /**
   * Set every {path, value} entry, creating intermediate objects. Keys oathe does not own are
   * untouched (the whole document is re-serialized, but no other key's VALUE changes).
   * @returns {{content: string, changed: boolean}}
   */
  apply(text, entries) {
    const doc = this.#parse(text);
    for (const { path, value } of entries) {
      let node = doc;
      for (const key of path.slice(0, -1)) {
        if (node[key] === null || typeof node[key] !== 'object') node[key] = {};
        node = node[key];
      }
      node[path.at(-1)] = value;
    }
    const content = this.#stringify(doc);
    return { content, changed: content !== text };
  }

  /**
   * Delete the owned paths; a parent object emptied by the deletion is pruned (it existed for
   * our key), while a parent still holding someone else's keys stays.
   * @returns {{content: string, changed: boolean}}
   */
  remove(text, paths) {
    const doc = this.#parse(text);
    for (const path of paths) {
      const parents = [];
      let node = doc;
      let missing = false;
      for (const key of path.slice(0, -1)) {
        if (node === null || typeof node !== 'object' || !(key in node)) { missing = true; break; }
        parents.push({ node, key });
        node = node[key];
      }
      if (missing || node === null || typeof node !== 'object') continue;
      delete node[path.at(-1)];
      for (let i = parents.length - 1; i >= 0; i -= 1) {
        const { node: parent, key } = parents[i];
        const child = parent[key];
        if (child !== null && typeof child === 'object' && Object.keys(child).length === 0) {
          delete parent[key];
        } else break;
      }
    }
    const content = this.#stringify(doc);
    return { content, changed: content !== text };
  }
}

/**
 * Owned ELEMENTS inside JSON arrays (Cursor's hooks.json shape: event name → array of hook
 * definitions the user may also populate). Ownership is a predicate over the element —
 * recorded in the manifest as the matchable detail — so apply never duplicates and remove
 * takes exactly ours, leaving user elements byte-preserved.
 */
export class JsonArrayEntries {
  /** @param {string} text @param {Array<{path: string[], element: object, owns: (el: any) => boolean}>} entries */
  apply(text, entries) {
    const doc = parseJsonTarget(text);
    for (const { path, element, owns } of entries) {
      let node = doc;
      for (const key of path.slice(0, -1)) {
        if (node[key] === null || typeof node[key] !== 'object') node[key] = {};
        node = node[key];
      }
      const leaf = path.at(-1);
      if (!Array.isArray(node[leaf])) node[leaf] = [];
      if (!node[leaf].some(owns)) node[leaf].push(element);
    }
    const content = stringifyJsonTarget(doc);
    return { content, changed: content !== text };
  }

  /** Remove OUR elements; an array (or created parent) emptied by that is pruned. */
  remove(text, entries) {
    const doc = parseJsonTarget(text);
    for (const { path, owns } of entries) {
      const parents = [];
      let node = doc;
      let missing = false;
      for (const key of path.slice(0, -1)) {
        if (node === null || typeof node !== 'object' || !(key in node)) { missing = true; break; }
        parents.push({ node, key });
        node = node[key];
      }
      const leaf = path.at(-1);
      if (missing || !Array.isArray(node?.[leaf])) continue;
      node[leaf] = node[leaf].filter((el) => !owns(el));
      if (node[leaf].length === 0) delete node[leaf];
      for (let i = parents.length - 1; i >= 0; i -= 1) {
        const { node: parent, key } = parents[i];
        const child = parent[key];
        if (child !== null && typeof child === 'object' && Object.keys(child).length === 0) {
          delete parent[key];
        } else break;
      }
    }
    const content = stringifyJsonTarget(doc);
    return { content, changed: content !== text };
  }
}

/**
 * Is this the RESIDUE of managed writes — a file with nothing of substance left once oathe's
 * own entries are gone? Whitespace; JSON whose every leaf is an empty container ({} / [] /
 * {"hooks":{}}); TOML/INI text that is only blank lines and comments. Uninstall deletes a file
 * that init created (absent before) when this is true, and never otherwise — the fence rule
 * ("created by us and empty after removal → remove"), applied to every managed-write engine.
 */
/**
 * Remove the files WE created (absent before our first write) that now hold nothing of
 * substance — the rule uninstall applies machine-wide, and an init unwire applies to one
 * harness's files. One implementation; both callers pass the backups they mean.
 * @returns {Array<{action: string, file: string}>}
 */
export function sweepCreatedResidue({ backups, fs: fsImpl = fs }) {
  const actions = [];
  for (const b of backups.filter((x) => x.absent_before && fsImpl.existsSync(x.file))) {
    if (!isEmptyResidue(fsImpl.readFileSync(b.file, 'utf8'))) continue;
    fsImpl.rmSync(b.file);
    actions.push({ action: 'created-file-removed', file: b.file });
  }
  return actions;
}

export function isEmptyResidue(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return true;
  try {
    const hollow = (v) => (Array.isArray(v) ? v.every(hollow)
      : (v !== null && typeof v === 'object') ? Object.values(v).every(hollow) : false);
    return hollow(JSON.parse(trimmed));
  } catch { /* not JSON */ }
  return trimmed.split('\n').every((line) => /^\s*(#.*)?$/.test(line));
}
