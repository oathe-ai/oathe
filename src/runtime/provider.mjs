// oathe — the runtime seam (Stage 1 ruling: ONE seam, never a fork). Two providers serve the
// same capability surface: FiriaRuntimeProvider binds the estate monorepo (the richer
// semantics), StandaloneRuntimeProvider is what the public package runs on a clean machine —
// every capability an honest implementation or a TYPED, LOUD degradation, never silent.
// Selection is explicit config (`runtimeProvider: auto|firia|standalone`); auto = firia
// exactly when the sanctioned cage address resolves on disk.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export class RuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    this.details = details;
  }
}

export class FiriaRuntimeProvider {
  name = 'firia';

  constructor({ paths }) {
    this.paths = paths;
  }

  capabilities() {
    return { cage: 'acp-cage', settlement: 'firia-acceptance-lane', pickup: 'thin-path' };
  }

  /** The one sanctioned path import — the cage lives outside firia-runtime's exports map. */
  async cage() {
    const { spawnCaged } = await import(pathToFileURL(this.paths.cagePath).href);
    return { spawnCaged };
  }
}

export class StandaloneRuntimeProvider {
  name = 'standalone';

  capabilities() {
    return { cage: 'simple-cage', settlement: 'sql-acceptance-lane', pickup: 'unavailable' };
  }

  async cage() {
    const { spawnCaged } = await import('./simple-cage.mjs');
    return { spawnCaged };
  }
}

/** @returns {FiriaRuntimeProvider | StandaloneRuntimeProvider} */
export function resolveRuntimeProvider({ config, paths }) {
  const requested = config.get('runtimeProvider');
  const firiaResolves = fs.existsSync(paths.cagePath);
  if (requested === 'firia' && !firiaResolves) {
    throw new RuntimeError('OATHE_RUNTIME_FIRIA_UNAVAILABLE',
      `runtimeProvider 'firia' is requested but the monorepo does not resolve `
      + `(no cage at ${paths.cagePath}) — set runtimeProvider to 'standalone' or 'auto', `
      + 'or point OATHE_MONOREPO at a checkout', { cagePath: paths.cagePath });
  }
  const name = requested === 'auto' ? (firiaResolves ? 'firia' : 'standalone') : requested;
  return name === 'firia' ? new FiriaRuntimeProvider({ paths }) : new StandaloneRuntimeProvider();
}
