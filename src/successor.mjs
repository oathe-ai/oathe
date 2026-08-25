// oathe — the successor sequence, wired to the REAL runtime (pickup is what "continue task-x"
// means; the founder ruling: resuming is what launching means, and picking up happens here).
//
// The verified three-call path: buildProductionDeps → readPriorAttemptStep → reallocateStep —
// the RECOMPILE-vs-RESUME decision happens INSIDE allocate(), fed by the prior attempt.
// buildProductionDeps refuses an injected clock (CLOCK_REFUSED — database time only), and its
// config comes from firia-runtime's own fail-closed loader, so oathe synthesizes the
// FIRIA_RUNTIME_* environment for the LOCAL cell rather than re-implementing validation.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const STRATEGY_VERSION = 'oathe-w1';
const COMPILER_BUDGET_BYTES = 64 * 1024;

/** The runtime config env for the local cell. Secrets are placeholders: the homebrew socket
 *  authenticates by peer, and no Anthropic call is made on this path — the loader just refuses
 *  UNRESOLVED secrets, so they must exist. */
function runtimeEnv(substrate, paths) {
  return {
    FIRIA_RUNTIME_PG_URL: substrate.connectionString(),
    FIRIA_RUNTIME_POOLER: 'direct',
    FIRIA_RUNTIME_APP_VERSION: 'oathe-0.1.0',
    FIRIA_RUNTIME_MODEL: 'claude-fable-5',
    FIRIA_RUNTIME_MAX_BUDGET_USD: '10',
    FIRIA_RUNTIME_EGRESS_CLASS: 'cell_only',
    // The per-attempt work root (<workRoot>/<attempt_id>/...) — the pickup path spawns no
    // attempt, but the loader fail-closes, so oathe declares the dir it owns for that purpose.
    FIRIA_RUNTIME_WORK_ROOT: paths.workRoot,
    FIRIA_RUNTIME_PG_PASSWORD: 'unused-local-socket-auth',
    FIRIA_RUNTIME_ANTHROPIC_API_KEY: 'unused-no-remote-call-on-this-path',
  };
}

/**
 * @returns {Promise<{pickup: (o: {task_id: string, work_claim_id: string}) => Promise<object>,
 *                    close: () => Promise<void>}>}
 */
export async function buildSuccessor({ substrate, identity, paths, env = process.env }) {
  const [{ loadConfig }, { buildProductionDeps }, thinPath, contextCompiler, reader] = await Promise.all([
    import('firia-runtime/config'),
    import('firia-runtime/composition-root'),
    import('firia-runtime/thin-path'),
    import('firia-runtime/context-compiler'),
    import('firia-runtime/company-context-reader'),
  ]);

  const pg = require('pg');
  const pool = new pg.Pool(substrate.connectionConfig());
  const config = loadConfig({ ...runtimeEnv(substrate, paths) });
  const seam = new thinPath.SeamContextCompiler({
    client: pool,
    reader: new reader.CompanyContextReader({ client: pool, orgId: identity.orgId }),
    strategyVersion: STRATEGY_VERSION,
    budget: COMPILER_BUDGET_BYTES,
    artifactStore: contextCompiler.makeArtifactStore({ dir: paths.artifactDir }),
  });
  const deps = await buildProductionDeps({
    pool,
    config,
    runtimeIdentity: {
      harness_version: 'oathe-0.1.0',
      sdk_version: 'oathe-launcher',
      image_digest: 'dev',
    },
    contextCompiler: seam,
  });
  const steps = thinPath.makeThinPathSteps({
    ...deps,
    seam,
    // The identity the compiled package is augmented with — the operator this launcher runs as.
    // (clauseFor/promptFor serve settle/run steps this pickup path never calls.)
    identityFor: () => ({
      org_id: identity.orgId,
      principal_id: identity.principalId,
      department: identity.department,
    }),
  });

  return {
    async pickup({ task_id, work_claim_id }) {
      // The contract was frozen by the claim's own trigger (019) — read it, never re-derive it.
      const { rows } = await pool.query(
        'SELECT contract_hash FROM cell.verification_contract WHERE work_claim_id = $1', [work_claim_id]);
      if (rows.length === 0) {
        const e = new Error(`no frozen verification contract for claim ${work_claim_id} — `
          + 'a claim without its bound contract cannot be picked up');
        e.code = 'OATHE_CONTRACT_UNBOUND';
        throw e;
      }
      const input = {
        work_claim_id,
        principal_id: identity.principalId,
        org_id: identity.orgId,
        frozen_contract_hash: rows[0].contract_hash,
      };
      const prior = await steps.readPriorAttemptStep(input);
      const out = await steps.reallocateStep(input, prior);
      const renderMap = out.context_package?.render ?? {};
      const slot = out.mode === 'RESUME' ? 'resume' : 'recompile';
      return {
        task_id,
        work_claim_id,
        mode: out.mode,
        attempt_id: out.attempt_id,
        session_id: out.session_id,
        prior_attempt_seen: prior !== null,
        render: renderMap[slot] ?? renderMap.initial
          ?? `## Oathe frame (${out.mode})\ncompilation: ${out.context_compilation_ref}`,
      };
    },
    async close() {
      await pool.end();
    },
  };
}
