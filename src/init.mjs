// oathe init — census → plan → (substrate reachable?) → ask everything → do everything → summary.
// The order is the promise: the questions come from the census and each adapter's own
// description of its writes (src/setup.mjs); nothing is asked of a world whose substrate cannot
// come up; nothing is written before the last answer; nothing is recorded that was not
// verified. On a TTY the plan is a conversation; with --yes or off-TTY the plan's defaults are
// applied and ANNOUNCED — never a silent assumption, never a hang.

import { buildContext } from './context.mjs';
import { census, detectOnlySurfaces } from './harnesses/catalog.mjs';
import { OatheConfig } from './config.mjs';
import { standardPlan } from './plans.mjs';
import { OatheInitError, SetupPlan, SetupPrompter } from './setup.mjs';

export { OatheInitError };

/**
 * @returns {Promise<{plan: SetupPlan, census: object[], surfaces: object[], substrate: object,
 *                    principal: object, verifier: object, verifier_engine: object, wired: string[],
 *                    actions: object[], steps: object[]}>}
 */
export async function runInit({
  env = process.env, exec, stdin = process.stdin, out = process.stdout, err = process.stderr,
  harnessFilter = null, assumeYes = false,
} = {}) {
  const ctx = buildContext({ env, exec });
  const { manifest, harnesses, substrate, identity, version } = ctx;
  try {
    const wired = harnesses.filter((h) => h.constructor.wiring !== null);
    const seen = census(wired); // what an installer can wire
    const surfaces = detectOnlySurfaces({ home: ctx.home });
    // The verifier is a MACHINE-WIDE choice: only the global layer decides whether it was made.
    // A per-folder .oathe.json in the cwd init runs from must not silence the question (it did,
    // 2026-08-29).
    const machine = OatheConfig.global({ env: ctx.config.env });
    // DECLARATIVE: the screen shows the wiring state and Enter makes the machine match it.
    const wiredNow = new Set(manifest.rows.map((r) => r.harness).filter((h) => wired.some((a) => a.name === h)));
    const plan = SetupPlan.from({
      adapters: wired, census: seen, surfaces, machine, home: ctx.home, paths: ctx.paths, fallbackVerifier: ctx.config.get('verifier'), wiredNow,
    });
    if (harnessFilter) plan.narrow(harnessFilter);

    // The substrate is checked BEFORE any question: nobody answers a setup that cannot come up.
    const detect = await substrate.detect();
    if (!detect.reachable) {
      throw new OatheInitError('OATHE_SUBSTRATE_UNREACHABLE',
        'Postgres is not reachable, so there is no substrate to onboard onto. Install and start '
        + 'it first ('
        + (process.platform === 'darwin'
          ? 'macOS: `brew install postgresql@17 && brew services start postgresql@17`'
          : 'Debian/Ubuntu: `apt install postgresql && service postgresql start`')
        + ', or point PGHOST/OATHE_PG_HOST at your server), '
        + `then re-run \`oathe init\`. Detail: ${detect.detail}`,
        { detail: detect.detail });
    }
    // Same preflight block as detect(): a missing DDL source is caught here too, before any
    // database is created — never a half-onboarded world.
    substrate.assertDdlSource();

    // Ask everything…
    if (assumeYes) plan.applyDefaults('assume-yes');
    else if (SetupPrompter.isInteractive({ stdin, out })) await new SetupPrompter({ stdin, out }).ask(plan);
    else plan.applyDefaults('no-tty');
    if (plan.defaultsReason !== null) {
      const label = { 'assume-yes': '--yes', 'no-tty': 'no TTY' }[plan.defaultsReason] ?? plan.defaultsReason;
      const stream = assumeYes ? out : err; // --yes was asked for: stdout; a pipe hears it on stderr
      stream?.write?.(`init: ${label} — applying defaults: ${plan.announceLines().join('; ')}\n`);
    }

    // …then do everything.
    const db = await substrate.ensureDatabase();
    // A database made for the FIRST time plants the one-shot welcome — the glass plays it
    // on its next frame. Planted here, not with the actions: a failed later step must not
    // cost the eventual successful init its welcome.
    let welcomePlanted = null;
    if (db.created) {
      const { plantWelcome } = await import('./welcome.mjs');
      welcomePlanted = plantWelcome({ paths: ctx.paths });
    }
    await substrate.applyDdl();
    await substrate.seed({
      orgId: identity.orgId, principalId: identity.principalId, department: identity.department,
    });
    await substrate.registerYieldCause();

    // The verification lane: a non-author verifier principal (FC010) and the acceptance-seat
    // roster, registered through the substrate's own governed verb. Seat order matters — the
    // producer picks the first NON-AUTHOR seat, so the verifier leads and the operator backs
    // it up (for settling the verification tasks the verifier itself authors).
    const verifierPrincipal = ctx.config.get('verifierPrincipal');
    await substrate.seedVerifier({
      orgId: identity.orgId,
      verifierPrincipal,
      operatorPrincipal: identity.principalId,
      department: 'verification',
    });
    const seats = [verifierPrincipal, identity.principalId];
    await substrate.registerAcceptanceAuthority({
      orgId: identity.orgId,
      seats,
      clauseSpecs: standardPlan().clause_spec,
      checkerRefs: { 'checker://acceptance_package': 'verification-clause' },
      registeredBy: 'oathe-init',
    });

    const v = plan.verifier;
    // Record when there was no machine-wide choice, or the screen changed it — re-running init IS the switch.
    const record = v.alreadyChosen === null || v.chosen !== v.alreadyChosen.value;
    if (record) ctx.config.set('verifier', v.chosen, { scope: 'global' });
    const a = plan.agent;
    if (a.chosen !== null && (a.alreadyChosen === null || a.chosen !== a.alreadyChosen.value)) {
      ctx.config.set('defaultAgent', a.chosen, { scope: 'global' });
    }

    const actions = [];
    if (welcomePlanted) actions.push({ harness: 'notch', action: 'welcome-planted', file: welcomePlanted.file });
    // The screen's unchecks first: unwire exactly those harnesses through their own offboard.
    // (The codex global fence rides uninstall, not a per-harness unwire.)
    for (const name of plan.toUnwire) {
      const harness = wired.find((h) => h.name === name);
      const files = new Set(manifest.rows.filter((r) => r.harness === name).map((r) => r.file));
      for (const action of harness.offboard({ manifest })) actions.push({ harness: name, ...action });
      const { sweepCreatedResidue } = await import('./blocks.mjs');
      for (const action of sweepCreatedResidue({ backups: manifest.backups.filter((b) => files.has(b.file)) })) {
        actions.push({ harness: name, ...action });
      }
    }
    // The shim FIRST: every adapter's wiring, the plugin's hooks, and the notch-frame acts
    // address $HOME/.oathe/bin/oathe — the one durable address (connection-lane plan,
    // 2026-09-04). Re-stamped every init, so node moves never strand a harness config.
    const { writeShim } = await import('./shim.mjs');
    for (const action of writeShim({ home: ctx.home, manifest, version, packageRoot: ctx.paths.packageRoot })) {
      actions.push({ harness: 'shim', ...action });
    }
    // The device identity (ruling 2026-09-04): minted once, kept forever, one row — the
    // trust unit anything outside this machine will sign against (src/device.mjs).
    const { writeDevice } = await import('./device.mjs');
    const [deviceAction] = writeDevice({ devicePath: ctx.paths.devicePath, manifest, version });
    actions.push({ harness: 'device', ...deviceAction });
    for (const step of plan.steps) {
      if (!step.installed) {
        actions.push({ harness: step.name, action: 'skipped-not-installed' });
        continue;
      }
      if (step.selected !== true) {
        actions.push({ harness: step.name, action: plan.toUnwire.includes(step.name) ? 'unwired' : 'skipped-not-selected' });
        continue;
      }
      const harness = wired.find((h) => h.name === step.name);
      for (const action of [...harness.onboard({ manifest, version }), ...harness.installGlobalFence({ manifest, version })]) {
        actions.push({ harness: harness.name, ...action });
      }
    }
    // The notch (the quiet glass): shipped with the package for everyone — the packaged
    // app is the default, notchApp the override, a missing build a stated fact.
    const { wireNotch } = await import('./notch.mjs');
    for (const action of wireNotch({ home: ctx.home, manifest, config: ctx.config, version, packageRoot: ctx.paths.packageRoot, ...(exec ? { exec } : {}) })) {
      actions.push({ harness: 'notch', ...action });
    }
    // The serve daemon (connection-lane phase 2): launchd runs the shim written above; every
    // `oathe mcp` forwards to it when it answers, and the device holds ONE substrate presence.
    const { wireServe } = await import('./serve.mjs');
    for (const action of wireServe({ home: ctx.home, manifest, config: ctx.config, version, ...(exec ? { exec } : {}) })) {
      actions.push({ harness: 'serve', ...action });
    }
    // This run took as long as its CLI calls did; a hook or a server may have saved a row in
    // the meantime. Under the lock, merge what landed on disk, then record this run — never a
    // snapshot over a living file (B4, 2026-09-03).
    const { withFileLock } = await import('./fslock.mjs');
    await withFileLock(manifest.manifestPath, async () => { manifest.refresh({ merge: true }); manifest.save(); });

    return {
      plan,
      census: seen,
      surfaces,
      substrate: await substrate.status(),
      device: { device_id: deviceAction.device_id, minted: deviceAction.action === 'device-minted' },
    principal: { org_id: identity.orgId, principal_id: identity.principalId, role: 'ceo' },
      verifier: { principal_id: verifierPrincipal, seats },
      verifier_engine: {
        chosen: v.chosen,
        candidates: v.candidates,
        asked: v.asked,
        recorded: record,
        reason: v.alreadyChosen
          ? `already chosen machine-wide (${v.alreadyChosen.file}); switch with \`oathe config verifier <name> --global\``
          : null,
      },
      wired: plan.wired,
      actions,
      steps: plan.outcomes(actions),
    };
  } finally {
    await substrate.close();
  }
}
