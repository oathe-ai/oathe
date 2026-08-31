// oathe — the managed fence, owned once: the two bodies (a folder's, and the GLOBAL one an
// adapter's instructions file carries for sessions that open with no folder at all) and THE
// write that puts a block into a file — backup once, apply, manifest row. activateWorkspace
// (folder fences) and Harness.installGlobalFence (`oathe init`) both write through here, so
// the bytes on disk and the manifest rows that make them reversible can never drift apart.

import fs from 'node:fs';

import { FencedBlock, FENCE_STYLES } from './blocks.mjs';
import { sha256Hex } from './manifest.mjs';

/** The rule, in one sentence, everywhere it is spoken (fences, the board render). */
export const SPEECH_ACT_RULE = 'Claims are speech acts: claim before you build, record progress as statements, '
  + 'yield what you cannot finish — via the `oathe_*` MCP tools.';

/** The folder fence: an H2 inside HTML-comment fences (the `>>> <<<` shell-profile convention,
 *  in a form Markdown renders as nothing). Surface-neutral by design: hooks may not fire on every harness, so the fence promises
 *  only what every surface delivers. (Byte-stable: every activated folder carries it.) */
export function fenceBody(workspace) {
  return [
    '## Oathe',
    '',
    `This folder has an Oathe board (workspace \`${workspace}\`). Claims are speech acts:`,
    'claim before you build, record progress as statements, yield what you cannot finish —',
    'via the `oathe_*` MCP tools. Where your session opens on this folder, the board loads',
    'with it; `continue <task>` picks work back up.',
  ].join('\n');
}

/**
 * The GLOBAL fence (R-BOARD-SCOPE follow-up): an adapter's global instructions file is read
 * by every one of its sessions — including those that open on a staging directory with no
 * project folder (ChatGPT desktop), where no folder fence can exist. It must be true in a
 * folder session too, so it describes both cases and names no workspace.
 */
export function globalFenceBody() {
  return [
    '## Oathe',
    '',
    wrap(`Every session on this machine has an Oathe board. ${SPEECH_ACT_RULE} Where a session opens `
      + 'on a project folder, that folder\'s board loads with it. A session with no project folder '
      + '(ChatGPT desktop runs from a staging directory) sees the machine-wide board, and a task '
      + 'claimed there is homeless until a real folder claims it — which adopts it onto that '
      + 'folder\'s board. `continue <task>` picks work back up.'),
  ].join('\n');
}

/** Word-wrap one paragraph to `width` columns — the fence files are read by people too. */
function wrap(paragraph, width = 90) {
  const lines = [];
  let line = '';
  for (const word of paragraph.split(' ')) {
    if (line !== '' && `${line} ${word}`.length > width) { lines.push(line); line = word; }
    else line = line === '' ? word : `${line} ${word}`;
  }
  if (line !== '') lines.push(line);
  return lines.join('\n');
}

/**
 * THE fence write: put the managed block into `file` and record it. Idempotent — an unchanged
 * block writes nothing; the manifest row is keyed so a re-run replaces its own.
 * @param {{manifest: object, file: string, version: string, body: string, scope: 'project'|'user',
 *          harness?: string}} o  harness — the row's owner label ('project' for folder fences,
 *          'global' for an adapter's instructions file; never an adapter name, so an adapter's
 *          offboard cannot drop the row without stripping the block)
 * @returns {{file: string, changed: boolean}}
 */
export function writeFence({ manifest, file, version, body, scope, harness = 'project' }) {
  const block = new FencedBlock({ style: FENCE_STYLES.html });
  manifest.backupOnce(file);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const { content, changed } = block.apply(before, { version, body });
  if (changed) fs.writeFileSync(file, content);
  manifest.upsert({
    harness,
    file,
    kind: 'fence',
    scope,
    detail: { style: 'html' },
    blockVersion: version,
    sha256: sha256Hex(block.read(content).blockText),
  });
  return { file, changed };
}
