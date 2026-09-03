// oathe — the launched-session env block. The launcher hands the caged child the oathe wiring
// plus OATHE_LAUNCHED_HARNESS, the custody marker naming which harness `oathe <harness>`
// launched — a marker and nothing more: hooks fire in every session, and tool access is gated
// by workspace resolution (src/workspace-resolver.mjs), never by who spawned the session.
// Named once here: the launcher writes the block.

export const LAUNCHED_HARNESS_ENV = 'OATHE_LAUNCHED_HARNESS';

/** The name of the launch-capable harness (catalog `launchable()`) that launched this session, or null when unlaunched. */
export function launchedHarness(env = process.env) {
  const value = String(env[LAUNCHED_HARNESS_ENV] ?? '').trim();
  return value === '' ? null : value;
}

/** The env block the launcher hands the caged child — the oathe wiring plus the opt-in marker. */
export function launchSessionEnv({ config, identity, cwd, harness }) {
  return {
    OATHE_DB: config.get('db'),
    OATHE_ORG: identity.orgId,
    OATHE_PRINCIPAL: identity.principalId,
    OATHE_DEPARTMENT: identity.department,
    OATHE_WORKSPACE_DIR: cwd,
    [LAUNCHED_HARNESS_ENV]: harness,
  };
}
