// oathe — the runtime seam (Stage 1 ruling: ONE seam, never a fork). Two providers serve the
// same capability surface: FiriaRuntimeProvider binds the estate monorepo (the richer
// semantics), StandaloneRuntimeProvider is what the public package runs on a clean machine —
// every capability an honest implementation or a TYPED, LOUD degradation, never silent.
// Selection is explicit config (`runtimeProvider: auto|firia|standalone`); auto = firia
// exactly when the sanctioned cage address resolves on disk.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { standardPlan } from '../plans.mjs';
import { applyRecordedVerdict, RECORDED_VERDICT_CHECKER } from './discharge.mjs';

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

  /** The estate's acceptance lane, composed here behind the seam — verbatim from the verifier. */
  async acceptanceRuntime({ pool }) {
    const [composition, checkers, lane] = await Promise.all([
      import('firia-runtime/composition-root'),
      import('firia-runtime/checkers'),
      import('firia-runtime/acceptance-lane'),
    ]);
    const specs = standardPlan().clause_spec;
    const base = checkers.clauseChecker({ specs });
    const oatheVerdict = (statement, clause) => applyRecordedVerdict(base(statement, clause), clause);
    const registry = checkers.runtimeRegistry({ specs, extra: { [RECORDED_VERDICT_CHECKER]: oatheVerdict } });
    return {
      SETTLE: lane.SETTLE,
      laneFor: (seatPrincipal) => composition.buildProductionAcceptanceLane({ pool, seatPrincipal, registry }),
    };
  }

  /** The thin-path pickup, served only where the firia runtime resolves. */
  async successor({ substrate, identity, paths }) {
    const { buildSuccessor } = await import('../successor.mjs');
    return buildSuccessor({ substrate, identity, paths });
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

  /** The standalone package's own settlement path — the SQL-equivalent lane, lazily imported
   *  to keep this module from cycling with sql-acceptance-lane.mjs (which imports RuntimeError
   *  from here). */
  async acceptanceRuntime({ pool, orgId }) {
    const { SqlAcceptanceLane, SETTLE } = await import('./sql-acceptance-lane.mjs');
    const specs = standardPlan().clause_spec;
    return {
      SETTLE,
      laneFor: (seatPrincipal) => new SqlAcceptanceLane({ pool, orgId, seatPrincipal, specs }),
    };
  }

  /** Pickup degrades TYPED and LOUD: same {pickup, close} shape, the refusal inside pickup().
   *  Takes no args — the typed refusal never touches substrate/identity/paths, so there is
   *  nothing here to accept. */
  async successor() {
    return {
      pickup: async () => {
        throw new RuntimeError('OATHE_PICKUP_UNAVAILABLE',
          'the successor sequence needs the firia runtime, which does not resolve on this '
          + 'machine (runtime provider: standalone) — pickup cannot pretend; this is a preview '
          + 'limitation', { provider: 'standalone' });
      },
      close: async () => {},
    };
  }
}

/** @returns {FiriaRuntimeProvider | StandaloneRuntimeProvider} */
export function resolveRuntimeProvider({ config, paths }) {
  const requested = config.get('runtimeProvider');
  const firiaResolves = paths.cagePath !== null && fs.existsSync(paths.cagePath);
  if (requested === 'firia' && !firiaResolves) {
    throw new RuntimeError('OATHE_RUNTIME_FIRIA_UNAVAILABLE',
      `runtimeProvider 'firia' is requested but the monorepo does not resolve `
      + `(no cage at ${paths.cagePath}) — set runtimeProvider to 'standalone' or 'auto', `
      + 'or point OATHE_MONOREPO at a checkout', { cagePath: paths.cagePath, monorepo: paths.monorepo });
  }
  const name = requested === 'auto' ? (firiaResolves ? 'firia' : 'standalone') : requested;
  return name === 'firia' ? new FiriaRuntimeProvider({ paths }) : new StandaloneRuntimeProvider();
}
