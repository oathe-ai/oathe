// SessionStart — activation + the board. Opening a session on a folder ACTIVATES its
// workspace (central registry row + the context-file fences, through the ONE writer in
// src/activation.mjs, disclosed in the render) and then delivers the board twice over: the
// full list as additional context for the MODEL, one visible line for the USER — each in the
// session's own dialect. Activation failing must never cost the session its board: the
// failure is reported on stderr and the render proceeds (hooks are the sanctioned fail-soft).

import { failSoft, emitSessionStart, ensureSessionRegistered } from './lib.mjs';
import { renderBoard } from '../../src/board-render.mjs';
import { WorkspaceRegistry } from '../../src/registry.mjs';

await failSoft(async ({ substrate, workspace, synthetic, identity, config, cwd, dialect, paths, env, session }) => {
  const registry = new WorkspaceRegistry({ registryPath: paths.registryPath });
  let disclosed = null;
  try {
    const [{ activateWorkspace }, { InstallManifest }, { packageVersion }] = await Promise.all([
      import('../../src/activation.mjs'), import('../../src/manifest.mjs'), import('../../src/context.mjs'),
    ]);
    const manifest = InstallManifest.load({ manifestPath: paths.manifestPath, backupsDir: paths.backupsDir });
    const out = await activateWorkspace({
      cwd, env, manifest, registry, config, version: packageVersion(paths), source: 'hook:session-start',
    });
    // Disclose only when something was actually written — an unchanged fence needs no line,
    // and autoActivate=false registers quietly (the user's own explicit choice).
    disclosed = out.actions.some((a) => a.changed) ? out.disclosed : null;
  } catch (e) {
    process.stderr.write(`oathe hook: activation ${String(e?.message || e)}\n`);
  }
  // Session liveness: the hook's ppid IS the harness process — the shared convergence
  // signal registers its facts so the notch can meet the living process behind a claim.
  await ensureSessionRegistered({ session, paths, workspace });
  // R-PAGER: the breach digest is computed apart from the board, and a failure there is
  // reported on stderr while the board still renders — the digest is a courtesy, the board
  // is the session's contract.
  let digest = null;
  try {
    const { Pager } = await import('../../src/pager.mjs');
    digest = await new Pager({ client: substrate, identity, config, registry }).digest();
  } catch (e) {
    process.stderr.write(`oathe hook: pager ${String(e?.message || e)}\n`);
  }
  const { context, message } = await renderBoard({ client: substrate, identity, workspace, config, synthetic, digest });
  // R-QUIET: the board message is breaches-or-silence; a real write's disclosure still speaks
  // (a receipt, printed once) even when the board itself has nothing to push.
  const visible = [message, disclosed].filter(Boolean).join('\n') || null;
  emitSessionStart({
    context: disclosed ? `${context}\n\n_${disclosed}_` : context,
    message: visible,
    dialect,
  });
}, { quietNote: 'Oathe board unavailable — substrate not initialized; run `oathe init`' });
