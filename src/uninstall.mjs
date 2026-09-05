// oathe uninstall — remove exactly the recorded blocks/entries, restore nothing else, drop
// nothing (the cell database is the durable record; --purge-db is the one exception, asked
// for by name).

import fs from 'node:fs';

import { buildContext } from './context.mjs';
import { FencedBlock, FENCE_STYLES, sweepCreatedResidue } from './blocks.mjs';

/** @returns {Promise<{actions: object[], database_dropped: boolean}>} */
export async function runUninstall({ env = process.env, exec, purgeDb = false } = {}) {
  const ctx = buildContext({ env, exec });
  const { manifest, harnesses, substrate } = ctx;
  try {
    const actions = [];
    for (const harness of harnesses) {
      if (!manifest.rows.some((r) => r.harness === harness.name)) continue;
      for (const action of harness.offboard({ manifest })) {
        actions.push({ harness: harness.name, ...action });
      }
    }
    // Every fence: the folder ones (CLAUDE.md/AGENTS.md written by activation) and the global
    // one in an adapter's instructions file (written by init) — one row shape, one removal.
    for (const row of manifest.removeWhere((r) => r.kind === 'fence')) {
      if (!fs.existsSync(row.file)) continue;
      const block = new FencedBlock({ style: FENCE_STYLES[row.detail?.style ?? 'hash'] });
      const { content, changed } = block.remove(fs.readFileSync(row.file, 'utf8'));
      if (!changed) continue;
      const createdByUs = manifest.backups.find((b) => b.file === row.file)?.absent_before === true;
      if (createdByUs && content.trim() === '') fs.rmSync(row.file);
      else fs.writeFileSync(row.file, content);
      actions.push({ action: 'fence-removed', file: row.file });
    }
    // Files init CREATED (absent before) and that hold nothing of substance now are removed —
    // the fence rule above, applied to every managed-write engine. A file the user or the
    // harness wrote anything else into stays, minus our entries.
    actions.push(...sweepCreatedResidue({ backups: manifest.backups }));
    // The notch LaunchAgent: booted out and removed exactly as recorded (src/notch.mjs).
    const { unwireNotch } = await import('./notch.mjs');
    actions.push(...unwireNotch({ manifest, ...(exec ? { exec } : {}) }));
    // The serve daemon goes the same way — its bootout ends the process, and every
    // forwarder's pipe ends with it.
    const { unwireServe } = await import('./serve.mjs');
    actions.push(...unwireServe({ manifest, ...(exec ? { exec } : {}) }));
    // Live MCP servers would keep answering from a tree whose wiring is now gone — sweep them
    // ("just get rid of it for them", founder 2026-09-04), then remove the durable address
    // last: the offboard CLIs above may still have run through it.
    const { unwireShim, sweepMcpServers } = await import('./shim.mjs');
    actions.push(...sweepMcpServers({ exec: exec ?? (await import('./harnesses/harness.mjs')).defaultExec }));
    actions.push(...unwireShim({ manifest }));
    const { unwireDevice } = await import('./device.mjs');
    actions.push(...unwireDevice({ manifest }));
    // Same rule as init (B4): rows that landed while the undo CLIs ran are kept, this run's
    // removals hold, and the save happens under the lock against the file as it is now.
    const { withFileLock } = await import('./fslock.mjs');
    await withFileLock(manifest.manifestPath, async () => { manifest.refresh({ merge: true }); manifest.save(); });

    let databaseDropped = false;
    if (purgeDb) {
      await substrate.close();
      await substrate.dropDatabase();
      databaseDropped = true;
    }
    return { actions, database_dropped: databaseDropped };
  } finally {
    await substrate.close();
  }
}
