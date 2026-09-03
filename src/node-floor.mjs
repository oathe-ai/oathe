// R-NODE-FLOOR (2026-08-31): the engines.node floor, EXECUTED. npm treats `engines` as a
// warning — a below-floor node installs and runs, until the codex trace lane asks for
// node:sqlite (unflagged only from 22.13.0 / 23.4.0) and every verify on the machine stalls.
// The bin refuses first, reading the one declaration in package.json — a rule that is not
// executed is a rule that drifts.

import fs from 'node:fs';
import path from 'node:path';

export class NodeFloorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** The floor package.json declares, parsed or refused — never guessed. */
export function nodeFloor({ packageRoot }) {
  const raw = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))?.engines?.node;
  const m = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(raw ?? '');
  if (!m) {
    throw new NodeFloorError('OATHE_ENGINES_UNREADABLE',
      `engines.node '${raw}' is not a '>=x.y.z' floor — the runtime gate cannot read it`, { raw });
  }
  return { raw, parts: m.slice(1, 4).map(Number) };
}

/** The gate at the bin door: the running node meets the declared floor, or the run is refused. */
export function assertNodeFloor({ version = process.version, packageRoot }) {
  const floor = nodeFloor({ packageRoot });
  const v = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1, 4).map(Number);
  if (!v) {
    throw new NodeFloorError('OATHE_ENGINES_UNREADABLE',
      `node version '${version}' cannot be read against the floor`, { version });
  }
  if ((v[0] - floor.parts[0] || v[1] - floor.parts[1] || v[2] - floor.parts[2]) < 0) {
    throw new NodeFloorError('ERROR_NODE_VERSION',
      `node ${version} refused — oathe needs node ${floor.raw} (package.json engines.node): below it `
      + 'node:sqlite is unavailable and the codex thread index cannot be read. Upgrade node '
      + '(nvm: `nvm install 24 && nvm alias default 24`) and re-run.',
      { version, floor: floor.raw });
  }
}
