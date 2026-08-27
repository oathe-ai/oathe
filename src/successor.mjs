// oathe — the successor sequence seam (pickup is what "continue task-x" means; the founder
// ruling: resuming is what launching means, and picking up happens here).
//
// THIN WRAPPER (Stage 1 ruling, 2026-08-26): no execution logic lives in this tree. The real
// three-call sequence — buildProductionDeps → readPriorAttemptStep → reallocateStep, with the
// RECOMPILE-vs-RESUME decision inside allocate() — ships with the `oathe-runtime` package and
// lands behind `oathe-runtime/seam`, which must export
//   buildSuccessor({ substrate, identity, paths }) →
//     { pickup({ task_id, work_claim_id }) → object, close() → void }
// The runtime-env synthesis and compiler wiring that previously lived here move into that
// package (they are its concern, not the interface's); this file only delegates or refuses
// TYPED and LOUD.

import { RuntimeError } from './runtime/provider.mjs';

/**
 * @returns {Promise<{pickup: (o: {task_id: string, work_claim_id: string}) => Promise<object>,
 *                    close: () => Promise<void>}>}
 */
export async function buildSuccessor({ substrate, identity, paths }) {
  let seam;
  try {
    seam = await import('oathe-runtime/seam');
  } catch (e) {
    throw new RuntimeError('OATHE_PICKUP_UNAVAILABLE',
      'the successor sequence needs the oathe runtime, which does not resolve on this machine '
      + '— pickup cannot pretend; this is a preview limitation until oathe-runtime lands.'
      + ' Continue the task directly instead: its objective and recorded progress are on the board (oathe_board), so inspect the workspace, keep working, record progress with oathe_statement, and assert completion with oathe_done — the claim is already yours.',
      { cause: String(e?.message || e) });
  }
  return seam.buildSuccessor({ substrate, identity, paths });
}
