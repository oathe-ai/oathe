// oathe — the launched-session contract. The plugin installs at USER scope, so its hooks and
// MCP server reach every session on the machine; only a session started by `oathe <harness>`
// has opted into the board. The launcher stamps that opt-in into the caged child's environment,
// and everything plugin-side asks ONE predicate before touching the substrate. Named once here:
// the launcher writes the block, the hooks and the server read it.

export const LAUNCHED_HARNESS_ENV = 'OATHE_LAUNCHED_HARNESS';

/** The harness ('claude' | 'codex') that launched this session, or null when unlaunched. */
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
