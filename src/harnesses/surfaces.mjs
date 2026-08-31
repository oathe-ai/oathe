// oathe — detect-only surfaces: places oathe can be USED but not WIRED by an installer. They are
// adapters like any other — same hierarchy, same structured detection, same docs pins — with
// `wiring: null` and a NOTE of manual steps instead of writes: detection plus honest
// instructions is the whole contract. (Cowork is a mode of the Claude Desktop app, running in a
// cloud sandbox; ChatGPT web has no local wiring at all — its desktop app rides the codex host.)
// Notes are dated: they describe the surfaces as pinned in .harness-docs.

import fs from 'node:fs';
import path from 'node:path';

import { Harness } from './harness.mjs';

export class CoworkSurface extends Harness {
  static harnessName = 'cowork';
  static displayName = 'Claude Cowork';
  static clientNames = Object.freeze([]);
  // The Claude Desktop app hosts Cowork (a mode beside Chat); its manual steps are dated
  // against these pages, so the docs-drift lane names this surface when one changes.
  static docs = Object.freeze([
    'cowork/overview', 'cowork/projects', 'cowork/plugins', 'cowork/extensions', 'cowork/architecture',
    'cowork/surfaces', 'cowork/use-plugins', 'claude-desktop/connect-local-servers',
  ]);
  static note = [
    'Claude desktop detected. Cowork sessions run in a cloud sandbox with a Linux-VM shell:',
    'an attached folder\'s fence (AGENTS.md/CLAUDE.md) reaches them, but the local board —',
    'MCP server, CLI, Postgres — does not (canary-confirmed 2026-08-28). Nothing to wire',
    'today; a remote board surface is the tracked path.',
  ].join('\n');

  constructor({ home, platform = process.platform, envPath = '', paths = null, exec } = {}) {
    super({ name: 'cowork', home, envPath, paths, exec });
    this.platform = platform;
  }

  static installedFrom(presence) {
    return presence.app === true;
  }

  detect() {
    const appSupport = path.join(this.home, 'Library/Application Support/Claude');
    const app = this.platform === 'darwin' && (fs.existsSync('/Applications/Claude.app') || fs.existsSync(appSupport));
    const presence = { app, cli: false, configHome: app ? appSupport : null };
    return { name: this.name, presence, installed: this.constructor.installedFrom(presence) };
  }
}

export class ChatGptWebSurface extends Harness {
  static harnessName = 'chatgpt-web';
  static displayName = 'ChatGPT web';
  static clientNames = Object.freeze([]);
  static docs = Object.freeze([]); // no local wiring, no page we depend on
  static note = [
    'ChatGPT web has no local wiring — remote MCP only. The ChatGPT desktop app shares the',
    'codex host wiring above; from the web, use the oathe CLI verbs in a terminal against',
    'the same board.',
  ].join('\n');

  constructor({ home, platform = process.platform, envPath = '', paths = null, exec } = {}) {
    super({ name: 'chatgpt-web', home, envPath, paths, exec });
    this.platform = platform;
  }

  static installedFrom() {
    return false; // nothing local marks ChatGPT web; listed for honesty, never auto-detected
  }

  detect() {
    const presence = { app: null, cli: false, configHome: null };
    return { name: this.name, presence, installed: false };
  }
}
