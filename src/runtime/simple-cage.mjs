// oathe — SimpleCage: the standalone provider's cage, a CLEAN-ROOM implementation of the
// contract the launcher consumes (documented in docs/PRODUCT.md and the Stage 1 plan; no
// upstream code was read). The contract: synchronous spawnCaged({unit, env, cmd, args, cwd,
// stdio}) → {child, enumerate(), teardownProvenEmpty()}; the child environment is REPLACED
// (never merged) and the cage itself stamps OATHE_EXECUTION_ATTEMPT_ID; the child leads a
// fresh process group (setsid) so enumerate() is a kernel read of the whole scope and
// teardown is SIGTERM → grace → SIGKILL with the emptiness RE-OBSERVED, never assumed.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const DEFAULT_GRACE_MS = 2000;
const POLL_MS = 100;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export function spawnCaged({ unit, env, cmd, args, cwd, stdio, graceMs = DEFAULT_GRACE_MS }) {
  const attemptId = `${unit}-${crypto.randomUUID()}`;
  const child = spawn(cmd, args, {
    cwd,
    stdio,
    detached: true, // setsid: the child leads a NEW process group, enumerable and killable as one
    env: { ...env, OATHE_EXECUTION_ATTEMPT_ID: attemptId }, // REPLACED env + the cage's own stamp
  });
  const pgid = child.pid;

  /** Liveness of the group as a kernel signal probe — kill(-pgid, 0) costs nanoseconds and
   *  spawns nothing. True while ANY member (stopped and zombie included) exists. This is the
   *  hot-path check: a full `ps -A` here made every poll a whole-system process-table scan,
   *  and concurrent cages contending on that scan wedged macOS's proc subsystem (measured:
   *  `ps` latency >45s while the test suite ran — the suite was DDoSing itself). */
  const alive = () => {
    try { process.kill(-pgid, 0); return true; } catch { return false; }
  };

  /** Kernel read of the group — live pids, [] once the scope is empty. Full-table scan:
   *  COLD PATH ONLY (the final proof and its failure detail), never inside a poll loop. */
  const enumerate = () => {
    const ps = spawnSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' });
    if (ps.status !== 0) {
      throw new Error(`SimpleCage cannot enumerate: ps exited ${ps.status}: ${ps.stderr}`);
    }
    return ps.stdout.split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([pid, group]) => Number.isInteger(pid) && group === pgid)
      .map(([pid]) => pid);
  };

  const signalGroup = (sig) => {
    try { process.kill(-pgid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  };

  const drainUntil = async (deadline) => {
    while (Date.now() < deadline && alive()) await sleep(POLL_MS);
  };

  /** SIGTERM → grace → SIGKILL, then RE-ENUMERATE: the emptiness is proof, not assumption.
   *  Polling rides the signal probe; the one authoritative ps scan is the closing proof. */
  const teardownProvenEmpty = async () => {
    if (alive()) {
      signalGroup('SIGTERM');
      await drainUntil(Date.now() + graceMs);
      if (alive()) {
        signalGroup('SIGKILL');
        await drainUntil(Date.now() + graceMs);
      }
    }
    const survivors = enumerate();
    return {
      empty: survivors.length === 0,
      detail: survivors.length === 0
        ? `process group ${pgid} re-enumerated empty`
        : `live pids remain in group ${pgid}: ${survivors.join(', ')}`,
    };
  };

  return { child, alive, enumerate, teardownProvenEmpty };
}
