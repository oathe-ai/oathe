// Stop — the turn-end heartbeat. A session that is still talking is still alive: renew the
// lease on this workspace's active claims held by this principal. Silent on any failure —
// lease expiry is the substrate telling the truth, not this hook's emergency.

import { failSoft } from './lib.mjs';

const LEASE = "interval '4 hours'";

await failSoft(async ({ substrate, workspace, identity }) => {
  await substrate.query(
    `UPDATE cell.work_claim
        SET ownership_valid_until = now() + ${LEASE}
      WHERE org_id = $1 AND principal_id = $2 AND state = 'active'
        AND contract_ref LIKE $3`,
    [identity.orgId, identity.principalId, `workspace:${workspace};%`]);
});
