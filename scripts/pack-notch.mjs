#!/usr/bin/env node
// oathe — prepack: the tarball ships the notch for everyone (founder ruling 2026-08-30).
// Build the app and verify the binary landed; a machine that cannot build it cannot pack
// the release — fail loud, never a tarball that silently lacks the glass.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const notchDir = path.join(packageRoot, 'notch');

if (process.platform !== 'darwin') {
  process.stderr.write('pack-notch: refused — the notch is a darwin app and the tarball must carry it; pack on a Mac\n');
  process.exit(1);
}
const build = spawnSync('./make-app.sh', [], { cwd: notchDir, encoding: 'utf8' });
if (build.status !== 0) {
  process.stderr.write(`pack-notch: build failed\n${build.stderr || build.stdout}`);
  process.exit(1);
}
const binary = path.join(notchDir, 'Oathe Notch.app', 'Contents', 'MacOS', 'OatheNotch');
if (!fs.existsSync(binary)) {
  process.stderr.write(`pack-notch: build reported success but ${binary} is absent\n`);
  process.exit(1);
}
process.stdout.write(`pack-notch: ${binary} ready\n`);
