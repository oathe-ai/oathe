// oathe uninstall — remove exactly the recorded blocks/entries, restore nothing else, drop
// nothing (the cell database is the durable record; --purge-db is the one exception, asked
// for by name).

import fs from 'node:fs';

import { buildContext } from './context.mjs';
import { FencedBlock, FENCE_STYLES } from './blocks.mjs';

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
    // Project-scope fences (CLAUDE.md/AGENTS.md rows written by launch pre-flights).
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
    manifest.save();

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
