// oathe — shared-file concurrency: atomic JSON writes plus a bounded advisory lock. Many
// sessions' hooks and MCP servers write ~/.oathe files at once; a reader must never see a torn
// file, and a hook must never deadlock a session on somebody else's lock. Rename is the only
// publish; the lock is a lockdir spin (mkdir is atomic on POSIX) that gives up after the bound
// and proceeds — every caller's mutation is idempotent by contract, so a lost race self-heals.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Write `doc` as pretty JSON + trailing newline via temp-then-rename in the same directory. */
export function atomicWriteJson(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Run `fn` under an advisory lockdir beside `file`. A lockdir older than `staleMs` is broken
 * (its holder died); a live foreign lock is waited on for at most `timeoutMs`, then `fn` runs
 * lock-free rather than blocking the caller.
 */
export async function withFileLock(file, fn, { timeoutMs = 2000, staleMs = 10_000 } = {}) {
  const lockDir = `${file}.lock`;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > staleMs) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch { /* the holder released between stat and rmdir — retry */ }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
  }
  try {
    return await fn();
  } finally {
    if (acquired) fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
