#!/usr/bin/env node
// oathe — harness docs snapshot. Pulls each harness's official docs into .harness-docs/
// (gitignored) so adapter schema checks and version-drift reviews read a PINNED local snapshot,
// not the live web mid-implementation. The manifest records url + fetched_at + content sha per
// page, so a re-pull diffs cleanly when a harness ships a new version. Failures are collected
// and reported per url — the decision surface, never silently skipped.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Every listed host serves raw markdown when the page url carries a `.md` suffix (probed
// 2026-08-28: code.claude.com, learn.chatgpt.com, claude.com, support.claude.com, cursor.com,
// modelcontextprotocol.io, developers.openai.com all answer text/markdown).
const CC = 'https://code.claude.com/docs/en';
const LC = 'https://learn.chatgpt.com/docs';
export const DOC_SOURCES = Object.freeze([
  // Claude Code — CLI, desktop app, IDE extensions
  { harness: 'claude-code', slug: 'mcp', url: `${CC}/mcp.md` },
  { harness: 'claude-code', slug: 'plugins', url: `${CC}/plugins.md` },
  { harness: 'claude-code', slug: 'plugins-reference', url: `${CC}/plugins-reference.md` },
  { harness: 'claude-code', slug: 'hooks', url: `${CC}/hooks.md` },
  { harness: 'claude-code', slug: 'settings', url: `${CC}/settings.md` },
  { harness: 'claude-code', slug: 'desktop', url: `${CC}/desktop.md` },
  { harness: 'claude-code', slug: 'memory', url: `${CC}/memory.md` },
  { harness: 'claude-code', slug: 'managed-mcp', url: `${CC}/managed-mcp.md` },
  { harness: 'claude-code', slug: 'cli-reference', url: `${CC}/cli-reference.md` },
  { harness: 'claude-code', slug: 'headless', url: `${CC}/headless.md` },
  // Claude Cowork
  { harness: 'cowork', slug: 'overview', url: 'https://claude.com/docs/cowork/overview.md' },
  { harness: 'cowork', slug: 'projects', url: 'https://claude.com/docs/cowork/guide/projects.md' },
  { harness: 'cowork', slug: 'plugins', url: 'https://claude.com/docs/cowork/guide/plugins.md' },
  { harness: 'cowork', slug: 'extensions', url: 'https://claude.com/docs/cowork/3p/extensions.md' },
  { harness: 'cowork', slug: 'architecture', url: 'https://support.claude.com/en/articles/14479288.md' },
  { harness: 'cowork', slug: 'surfaces', url: 'https://support.claude.com/en/articles/15520349.md' },
  { harness: 'cowork', slug: 'use-plugins', url: 'https://support.claude.com/en/articles/13837440.md' },
  // Claude Desktop (chat surface; config the Code tab also reads)
  { harness: 'claude-desktop', slug: 'connect-local-servers', url: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers.md' },
  // Codex host — CLI, IDE extension, ChatGPT desktop app
  { harness: 'codex', slug: 'mcp', url: `${LC}/extend/mcp.md` },
  { harness: 'codex', slug: 'config-reference', url: `${LC}/config-file/config-reference.md` },
  { harness: 'codex', slug: 'environment-variables', url: `${LC}/config-file/environment-variables.md` },
  { harness: 'codex', slug: 'agents-md', url: `${LC}/agent-configuration/agents-md.md` },
  { harness: 'codex', slug: 'hooks', url: `${LC}/hooks.md` },
  { harness: 'codex', slug: 'projects', url: `${LC}/projects.md` },
  { harness: 'codex', slug: 'plugins', url: `${LC}/plugins.md` },
  { harness: 'codex', slug: 'submit-claude-plugin', url: 'https://developers.openai.com/plugins/guides/submit-claude-plugin.md' },
  // Cursor — IDE and CLI
  { harness: 'cursor', slug: 'mcp', url: 'https://cursor.com/docs/mcp.md' },
  { harness: 'cursor', slug: 'mcp-install-links', url: 'https://cursor.com/docs/mcp/install-links.md' },
  { harness: 'cursor', slug: 'hooks', url: 'https://cursor.com/docs/hooks.md' },
  { harness: 'cursor', slug: 'plugins', url: 'https://cursor.com/docs/plugins.md' },
  { harness: 'cursor', slug: 'plugins-reference', url: 'https://cursor.com/docs/reference/plugins.md' },
  { harness: 'cursor', slug: 'third-party-hooks', url: 'https://cursor.com/docs/reference/third-party-hooks.md' },
  { harness: 'cursor', slug: 'rules', url: 'https://cursor.com/docs/rules.md' },
  { harness: 'cursor', slug: 'cli-mcp', url: 'https://cursor.com/docs/cli/mcp.md' },
  { harness: 'cursor', slug: 'cli-configuration', url: 'https://cursor.com/docs/cli/reference/configuration.md' },
  // Cursor CLI (`agent` / `cursor-agent`, installed on the founder machine 2026-08-29): the
  // pages a CI drift lane depends on — install, headless mode, auth, output shape, GitHub Actions.
  { harness: 'cursor', slug: 'cli-overview', url: 'https://cursor.com/docs/cli/overview.md' },
  { harness: 'cursor', slug: 'cli-installation', url: 'https://cursor.com/docs/cli/installation.md' },
  { harness: 'cursor', slug: 'cli-using', url: 'https://cursor.com/docs/cli/using.md' },
  { harness: 'cursor', slug: 'cli-headless', url: 'https://cursor.com/docs/cli/headless.md' },
  { harness: 'cursor', slug: 'cli-authentication', url: 'https://cursor.com/docs/cli/reference/authentication.md' },
  { harness: 'cursor', slug: 'cli-parameters', url: 'https://cursor.com/docs/cli/reference/parameters.md' },
  { harness: 'cursor', slug: 'cli-output-format', url: 'https://cursor.com/docs/cli/reference/output-format.md' },
  { harness: 'cursor', slug: 'cli-slash-commands', url: 'https://cursor.com/docs/cli/reference/slash-commands.md' },
  { harness: 'cursor', slug: 'cli-permissions', url: 'https://cursor.com/docs/cli/reference/permissions.md' },
  { harness: 'cursor', slug: 'cli-github-actions', url: 'https://cursor.com/docs/cli/github-actions.md' },
  { harness: 'cursor', slug: 'cli-shell-mode', url: 'https://cursor.com/docs/cli/shell-mode.md' },
]);

async function defaultFetcher(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'oathe-harness-docs-pull' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return { body: await res.text(), contentType: res.headers.get('content-type') ?? '' };
}

function extensionFor(contentType) {
  return /html/.test(contentType) ? '.html' : '.md';
}

/**
 * Pull every source into outDir; write manifest.json recording exactly what landed.
 * @returns {{written: object[], failed: {harness, slug, url, error}[]}}
 */
export async function pullDocs({ outDir, sources = DOC_SOURCES, fetcher = defaultFetcher, clock = () => new Date().toISOString() }) {
  const written = [];
  const failed = [];
  for (const source of sources) {
    let fetched;
    try {
      fetched = await fetcher(source.url);
    } catch (e) {
      failed.push({ ...source, error: String(e?.message || e) });
      continue;
    }
    const file = path.join(outDir, source.harness, `${source.slug}${extensionFor(fetched.contentType)}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Byte-idempotent on unchanged content: an untouched page keeps its mtime for diffing.
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== fetched.body) {
      fs.writeFileSync(file, fetched.body);
    }
    written.push({
      harness: source.harness,
      slug: source.slug,
      url: source.url,
      file: path.relative(outDir, file),
      fetched_at: clock(),
      sha256: crypto.createHash('sha256').update(fetched.body).digest('hex'),
    });
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'manifest.json'),
    `${JSON.stringify({ format: 1, pulled_at: clock(), sources: written }, null, 2)}\n`);
  return { written, failed };
}

async function run() {
  const outDir = process.argv[2] ?? path.join(path.dirname(path.dirname(fs.realpathSync(process.argv[1]))), '.harness-docs');
  const { written, failed } = await pullDocs({ outDir });
  process.stdout.write(`pull-harness-docs: ${written.length} page(s) into ${outDir}\n`);
  for (const f of failed) process.stderr.write(`pull-harness-docs: FAILED ${f.harness}/${f.slug} ${f.url}: ${f.error}\n`);
  return failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  run().then((code) => process.exit(code));
}
