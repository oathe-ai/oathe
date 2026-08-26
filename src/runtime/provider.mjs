// oathe — the runtime seam (Stage 1 ruling: ONE seam, never a fork). Two providers serve the
// same capability surface: OatheRuntimeProvider binds the estate monorepo (the richer
// semantics), StandaloneRuntimeProvider is what the public package runs on a clean machine —
// every capability an honest implementation or a TYPED, LOUD degradation, never silent.
// Selection is explicit config (`runtimeProvider: auto|oathe|standalone`); auto = oathe
// exactly when the sanctioned cage address resolves on disk.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import { standardPlan } from '../plans.mjs';

export class RuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    this.details = details;
  }
}

/** The default resolvability probe: does `oathe-runtime` actually resolve from THIS module's
 *  location, independent of whether the monorepo checkout (and thus the cage path) is present?
 *  A monorepo file being present says nothing about whether `npm run link-runtime` was ever run. */
function defaultResolve(specifier) {
  return createRequire(import.meta.url).resolve(specifier);
}

export class OatheRuntimeProvider {
  name = 'oathe';

  #resolve;
  #probeResult;

  constructor({ paths, resolve = defaultResolve }) {
    this.paths = paths;
    this.#resolve = resolve;
  }

  capabilities() {
    return { cage: 'acp-cage', settlement: 'oathe-acceptance-lane', pickup: 'thin-path' };
  }

  /** Computed ONCE per instance and cached — a raw ERR_MODULE_NOT_FOUND from oathe-runtime
   *  failing to resolve (e.g. a forgotten `npm run link-runtime` on an estate machine) is turned
   *  into a typed, loud fact here instead of leaking out of acceptanceRuntime()/successor().
   *  @returns {{ok: boolean, error?: string}} */
  probe() {
    if (this.#probeResult === undefined) {
      try {
        this.#resolve('oathe-runtime/seam');
        this.#probeResult = { ok: true };
      } catch (e) {
        this.#probeResult = { ok: false, error: String(e?.message || e) };
      }
    }
    return this.#probeResult;
  }

  #assertResolves() {
    const result = this.probe();
    if (!result.ok) {
      throw new RuntimeError('OATHE_RUNTIME_UNLINKED',
        'the oathe runtime does not resolve from this checkout — run `npm run link-runtime` '
        + `(the monorepo is at ${this.paths.monorepo}, but node_modules/oathe-runtime is missing)`,
        { monorepo: this.paths.monorepo });
    }
  }

  /** The one sanctioned path import — the cage lives outside oathe-runtime's exports map.
   *  Stays path-based (no probe): the cage address is resolved off paths.cagePath directly,
   *  never through oathe-runtime's package resolution. */
  async cage() {
    const { spawnCaged } = await import(pathToFileURL(this.paths.cagePath).href);
    return { spawnCaged };
  }

  /** THIN WRAPPER (Stage 1 ruling, 2026-08-26): no composition logic lives here. The runtime
   *  package owns the whole acceptance build — including the recorded-verdict checker wiring
   *  that previously lived in this method — and lands as `oathe-runtime/seam` exporting
   *  `buildAcceptanceRuntime({ pool }) → { SETTLE, laneFor(seatPrincipal) }`. */
  async acceptanceRuntime({ pool }) {
    this.#assertResolves();
    const seam = await import('oathe-runtime/seam');
    return seam.buildAcceptanceRuntime({ pool });
  }

  /** The thin-path pickup, served only where the oathe runtime resolves. */
  async successor({ substrate, identity, paths }) {
    this.#assertResolves();
    const { buildSuccessor } = await import('../successor.mjs');
    return buildSuccessor({ substrate, identity, paths });
  }
}

export class StandaloneRuntimeProvider {
  name = 'standalone';

  capabilities() {
    return { cage: 'simple-cage', settlement: 'sql-acceptance-lane', pickup: 'unavailable' };
  }

  /** The standalone package never depends on oathe-runtime — always resolvable by definition. */
  probe() {
    return { ok: true };
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
          'the successor sequence needs the oathe runtime, which does not resolve on this '
          + 'machine (runtime provider: standalone) — pickup cannot pretend; this is a preview '
          + 'limitation', { provider: 'standalone' });
      },
      close: async () => {},
    };
  }
}

/** @returns {OatheRuntimeProvider | StandaloneRuntimeProvider} */
export function resolveRuntimeProvider({ config, paths }) {
  const requested = config.get('runtimeProvider');
  const runtimeResolves = paths.cagePath !== null && fs.existsSync(paths.cagePath);
  if (requested === 'oathe' && !runtimeResolves) {
    throw new RuntimeError('OATHE_RUNTIME_UNAVAILABLE',
      `runtimeProvider 'oathe' is requested but the monorepo does not resolve `
      + `(no cage at ${paths.cagePath}) — set runtimeProvider to 'standalone' or 'auto', `
      + 'or point OATHE_MONOREPO at a checkout', { cagePath: paths.cagePath, monorepo: paths.monorepo });
  }
  const name = requested === 'auto' ? (runtimeResolves ? 'oathe' : 'standalone') : requested;
  return name === 'oathe' ? new OatheRuntimeProvider({ paths }) : new StandaloneRuntimeProvider();
}
