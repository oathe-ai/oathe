// oathe — workspace identity. Every claim minted through oathe records WHICH folder's board it
// belongs to (git-root realpath + origin-remote url when present; plain dir realpath otherwise),
// carried in the claim's contract_ref convention because adding DDL is out of scope for this
// package (the vendored cell DDL owns schema numbering — the additive workspace_ref column is the
// flagged post-episode upstream ask).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Walk up from `dir` to the git root (the directory holding .git), or null. */
function gitRoot(dir) {
  let current = dir;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The url line of [remote "origin"] in .git/config, or null — read, not shelled. */
function originUrl(root) {
  const configPath = path.join(root, '.git/config');
  if (!fs.existsSync(configPath)) return null;
  const lines = fs.readFileSync(configPath, 'utf8').split('\n');
  let inOrigin = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) inOrigin = trimmed === '[remote "origin"]';
    else if (inOrigin && trimmed.startsWith('url')) {
      const eq = trimmed.indexOf('=');
      if (eq !== -1) return trimmed.slice(eq + 1).trim();
    }
  }
  return null;
}

/** @returns {string} `ws-<12hex>` — stable for every path inside one workspace */
export function workspaceRef(cwd) {
  const real = fs.realpathSync(cwd);
  const root = gitRoot(real);
  const identity = root === null
    ? `dir:${real}`
    : `git:${fs.realpathSync(root)}|origin:${originUrl(root) ?? ''}`;
  return `ws-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12)}`;
}
