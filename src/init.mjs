// oathe init — census → substrate → per-harness onboarding → manifest. The order is the
// promise: nothing is onboarded onto a world whose substrate could not come up, and nothing
// is recorded that was not verified.

import { buildContext } from './context.mjs';
import { census } from './harness.mjs';

export class OatheInitError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OatheInitError';
    this.code = code;
    this.details = details;
  }
}

/**
 * @returns {Promise<{census: object[], substrate: object, principal: object, actions: object[]}>}
 */
export async function runInit({ env = process.env, exec } = {}) {
  const ctx = buildContext({ env, exec });
  const { manifest, harnesses, substrate, identity, version } = ctx;
  try {
    const seen = census(harnesses);

    const detect = await substrate.detect();
    if (!detect.reachable) {
      throw new OatheInitError('OATHE_SUBSTRATE_UNREACHABLE',
        'Postgres is not reachable, so there is no substrate to onboard onto. Install and start '
        + 'it first (macOS: `brew install postgresql@17 && brew services start postgresql@17`), '
        + `then re-run \`oathe init\`. Detail: ${detect.detail}`,
        { detail: detect.detail });
    }
    await substrate.ensureDatabase();
    await substrate.applyDdl();
    await substrate.seed({
      orgId: identity.orgId, principalId: identity.principalId, department: identity.department,
    });
    await substrate.registerYieldCause();

    const actions = [];
    for (const harness of harnesses) {
      const detection = seen.find((s) => s.name === harness.name);
      if (!detection.installed) {
        actions.push({ harness: harness.name, action: 'skipped-not-installed' });
        continue;
      }
      for (const action of harness.onboard({ manifest, version })) {
        actions.push({ harness: harness.name, ...action });
      }
    }
    manifest.save();

    return {
      census: seen,
      substrate: await substrate.status(),
      principal: { org_id: identity.orgId, principal_id: identity.principalId, role: 'ceo' },
      actions,
    };
  } finally {
    await substrate.close();
  }
}
