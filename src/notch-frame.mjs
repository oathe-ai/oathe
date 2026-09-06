// oathe — the notch frame: the glass's one truth, assembled from fetched facts. `oathe notch`
// fetches (the board, the pager's digest, the device session registry) and serves; this
// module decides what the glass shows and every word it shows (UX rule 20): the digest's
// rows with their kind words and act words, the count beyond the budget, work in motion
// with its resumption, the objective and the children line for the card. The glass reads
// no config and composes no sentence — tests/notch-frame.test.mjs holds a frame built here
// to Feed.swift's own decoder.
//
// MOTION (founder ruling, 2026-08-30): a row on the glass means a LIVE session — a claim
// whose last word is younger than notchMotionMinutes, or one the wire just heard (hear(),
// ephemeral by design). Idle-held work is `oathe ls`'s business.

import { appResumable, displayFor, launchable, ownerOfTracePath, surfaceForSession, updatable } from './harnesses/catalog.mjs';
import { HomeError, Place } from './home.mjs';
import { pidAlive } from './sessions.mjs';
import { KINDS, CONTINUE_ACT, JUDGMENT, UPDATE_ACT, OPEN_APP_FLASH } from './breach-digest.mjs';
import { shimPath } from './shim.mjs';
import { systemTaskOf } from './plans.mjs';

/** The system terminal — an OS fact, the fallback when no session names its own. */
export const TERMINAL_FALLBACK = '/System/Applications/Utilities/Terminal.app';

const shellQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
/** The one line that resumes a task — typed into a terminal by the spawn, or pasted into an app. */
const continueLine = (taskId) => `continue ${taskId}`;
/** A kind whose one act is a judgment (never-judged, engine-failed) rather than a resumption. */
const judges = (kind) => KINDS[kind].act !== CONTINUE_ACT;

export class NotchFrame {
  #heard = new Map(); // task → {at, via, app}: what the wire heard, ephemeral by design
  #launchables = launchable();

  /**
   * @param {{registry: {rootOf: Function}, sessions: () => object, defaultAgent: string|null,
   *          motionWindowMs: number, operatorHome: string, now?: () => number}} o
   *   sessions — the device session registry, read per frame (its failure is the caller's
   *   fail-soft: an empty map costs the frame its session refs, never the frame);
   *   operatorHome — where a judgment of work residing in an app runs.
   */
  constructor({ registry, sessions, defaultAgent, motionWindowMs, operatorHome, now = () => Date.now() }) {
    this.registry = registry;
    this.sessions = sessions;
    this.defaultAgent = this.#launchables.includes(defaultAgent) ? defaultAgent : null;
    this.motionWindowMs = motionWindowMs;
    this.operatorHome = operatorHome;
    // The acts run in a FRESH terminal the glass opens — same spawn class as a GUI harness,
    // so the same durable address (connection-lane plan, 2026-09-04): never a bare `oathe`.
    this.oatheBin = shimPath(operatorHome);
    this.now = now;
  }

  /** The wire IS liveness: a task heard on the wire is in motion until the window passes. */
  hear(taskId, { at, via, app }) {
    this.#heard.set(taskId, { at, via, app });
  }

  moving(row) {
    const since = this.now() - this.motionWindowMs;
    return (this.#heard.get(row.task_id)?.at ?? 0) > since
      || (row.last_word_at && Date.parse(row.last_word_at) > since);
  }

  /**
   * Continue goes WHERE THE WORK LIVES (founder rulings 2026-08-30, 2026-09-05): activate the
   * living app; else spawn the agent at the folder the task resides in; else open the app it
   * resides in (the recorded place — durable, so a feed restart forgets nothing); else there
   * is nothing to resume into and the row offers NO act — never a clipboard dressed as one.
   * The package decides — the glass executes.
   * @returns {object|null}
   */
  resumeFor(base, ref) {
    const word = CONTINUE_ACT;
    if (ref?.alive && ref.app_pid !== null && ref.app_pid !== undefined) {
      // The bundle rides along: macOS may deny a background app's activate (cooperative
      // activation) — opening the bundle is the permission-free fallback that still switches.
      return { kind: 'activate', app_pid: ref.app_pid, bundle: ref.bundle ?? null, word };
    }
    const surface = ref?.surface ?? base.surface;
    const agent = this.#launchables.includes(surface) ? surface : this.defaultAgent;
    if (agent && typeof base.home_path === 'string' && base.home_path.startsWith('/')) {
      return {
        kind: 'spawn-terminal',
        command: `"${this.oatheBin}" ${agent} ${shellQuote(continueLine(base.task_id))}`,
        cwd: base.home_path,
        terminal_bundle: ref?.bundle ?? base.place_app ?? TERMINAL_FALLBACK, // the terminal it was spoken from, when known
        word,
      };
    }
    // An APP residence opens — only when its adapter says that app is a place to resume into
    // (appResumable); a recorded terminal bundle is not one.
    const residence = Place.parseOrNull(base.place ?? null);
    const appSurface = residence !== null && !residence.isFolder ? residence.ref : surface;
    const bundle = ref?.bundle ?? base.place_app ?? null;
    if (bundle && appResumable(appSurface)) {
      // Opening the app IS the resumption; the line rides the clipboard and the row says so
      // (ruling 2026-09-05) — the app cannot be opened to a thread, so the person pastes.
      return { kind: 'open-app', bundle, word, paste: continueLine(base.task_id), flash: OPEN_APP_FLASH(displayFor(appSurface) ?? appSurface) };
    }
    return null;
  }

  /** The word a place wears on the glass: the folder path, or the app's display word. A row on
   *  the glass is a claim's, and every claim has a place — none is a broken record, said loudly. */
  #homePath(place) {
    const residence = Place.parseOrNull(place ?? null);
    if (residence === null) {
      throw new HomeError('OATHE_PLACE_UNKNOWN', 'a claim on the glass has no recorded place — the record is broken (every pickup records one)');
    }
    if (residence.isFolder) return this.registry.rootOf(residence.ref) ?? residence.ref;
    return displayFor(residence.ref) ?? residence.ref;
  }

  /**
   * Where a task can be resumed INTO: the durable registry row outranks the wire's ephemeral
   * word; either way the ref carries surface + the focusable app, so a task heard from a
   * living app (ChatGPT's embedded codex — no hooks, no registry row) still resolves to a
   * switch. One resolver for a moving row and a breach row alike.
   */
  #refFor(taskId, traceSessionId, sess) {
    const row = (traceSessionId && sess[traceSessionId]) || null;
    if (row !== null) {
      return {
        surface: surfaceForSession({ ancestry: row.ancestry, app: row.app, transcriptPath: row.transcript_path }),
        app_pid: row.app?.pid ?? null,
        bundle: row.app?.bundle ?? null,
        alive: pidAlive(row.pid),
      };
    }
    const heard = this.#heard.get(taskId);
    if (!heard?.app) return null;
    return {
      surface: heard.via ?? null,
      app_pid: heard.app.pid ?? null,
      bundle: heard.app.bundle ?? null,
      alive: heard.app.pid !== null && heard.app.pid !== undefined && pidAlive(heard.app.pid),
    };
  }

  glassRow(r, sess) {
    const heard = this.#heard.get(r.task_id);
    const ref = this.#refFor(r.task_id, r.trace_session_id, sess);
    const residence = Place.parseOrNull(r.place ?? null);
    const base = {
      task_id: r.task_id, objective: r.objective, holder: r.principal_id, state: r.state,
      last_word_at: r.last_word_at, last_progress: r.last_progress,
      children_line: r.children?.line ?? null,
      home_path: this.#homePath(r.place),
      place: r.place ?? null, place_app: r.place_app ?? null, place_dir: r.place_dir ?? null,
      // The surface speaking on the claim: the wire's live word wins; then the latest trace
      // link's transcript, mapped by its owning store; then the app it resides in (durable).
      surface: heard?.via ?? (r.trace_path ? ownerOfTracePath(r.trace_path) : null)
        ?? (residence !== null && !residence.isFolder ? residence.ref : null),
    };
    return { ...base, session: ref, resume: this.resumeFor(base, ref) };
  }

  /**
   * A breach row carries the ONE act that can change its truth (ruling 2026-08-31): never-
   * judged and engine-failed → dispatch the judgment, HEADLESS and detached (the feed runs
   * the dispatcher; no window to close, nothing to orphan) — for a sibling group, on its
   * oldest idle child (children ride in breach order); judged-rejected and gone-quiet →
   * CONTINUE into the work in a terminal (a session needs one; a judgment does not), at the parent
   * for a group (the reclaim bundle carries the verdict — re-judging a judged assertion is
   * the one act that can never help). The act's WORD is the kinds table's; the act's KIND is
   * decided here, from the environment. Home is the ONE resolver's answer; a judgment of work
   * residing in an app runs from the operator's home.
   */
  glassBreach(b, sess = {}) {
    // A judgment in flight offers NO act (ruling 2026-09-04): the glass never offers an act it
    // would refuse (a re-dispatch is OATHE_VERIFY_IN_FLIGHT) — the row says verifying instead.
    if (b.busy) return { ...b, act: null };
    const home = typeof b.home === 'string' && b.home.startsWith('/') ? b.home : null;
    const word = KINDS[b.kind].act;
    if (judges(b.kind)) {
      const target = b.group ? b.group.retry : b.task_id;
      if (target === null) return { ...b, act: null }; // every child of the group is being judged
      // A judgment needs no terminal (ruling 2026-09-04): the act names the task and the feed
      // dispatches it through the one dispatcher (src/verify-dispatch.mjs) — detached, so it
      // still outlives everything; the judgment's own claim then wakes the frame. The command
      // rides for the clipboard: the terminal form of the same act, for a person who wants it.
      // The glass relays `act` and `harness` up the pipe and decides nothing (ruling 2026-09-05).
      const dispatch = (extra) => ({ ...b, act: { kind: 'dispatch', task_id: target, cwd: home ?? this.operatorHome, ...extra } });
      // A stall whose cause is an OUT-OF-DATE engine the adapter can update: retry cannot help,
      // so the one act is the update — the child claims update:<engine> and re-verifies.
      if (b.kind === 'stalled' && b.cause === 'outdated' && updatable(b.engine)) {
        return dispatch({ act: 'update', harness: b.engine, word: UPDATE_ACT, command: `"${this.oatheBin}" engine update ${b.engine} --then-verify` });
      }
      return dispatch({ act: 'verify', word, command: `"${this.oatheBin}" verify --detach ${shellQuote(target)}` });
    }
    // A resumption climbs the one ladder a moving row's continue climbs (#refFor + resumeFor):
    // the living app that spoke the task, else the agent at the folder it resides in, else the
    // app it resides in — else no act (ruling 2026-09-05: nothing known offers nothing).
    const base = {
      task_id: b.task_id, home_path: home ?? this.#homePath(b.place), place: b.place ?? null, place_app: b.place_app ?? null, place_dir: b.place_dir ?? null,
      surface: this.#heard.get(b.task_id)?.via ?? null,
    };
    return { ...b, act: this.resumeFor(base, this.#refFor(b.task_id, b.trace_session_id ?? null, sess)) };
  }

  /**
   * The frame: the digest's rows and the count beyond them (the bar is color + count; the
   * sheet's rows carry the words), work in motion (anyone's active claim with a recent word,
   * or heard live), your idle-held claims after it, the one classification, and the machine's
   * chosen agent (the glass reads no config; null when onboarding never chose one).
   */
  build({ digest, sections }) {
    const sess = this.sessions();
    const row = (r) => this.glassRow(r, sess);
    // The judge's own `verify:<task>` claim is never a row: one row per task (R-GROUP-ROWS),
    // and that task's row already says verifying while the judge holds it.
    const work = (rows) => rows.filter((r) => systemTaskOf(r.task_id) === null); // a system task (verify:, update:) is never a work row
    // An asserted claim is never invisible (ruling 2026-09-04): between done and verdict its
    // row says which judgment it awaits — the JUDGMENT table's word, the spinner on `busy`
    // (the key a breach already spins on), no act (nothing a person does moves a judgment;
    // the fork lands in the asserter's session). A breached task is its breach row alone.
    const breached = new Set(digest.rows.map((b) => b.task_id));
    const judged = (r) => ({ ...row(r), resume: null, judgment: JUDGMENT[r.judgment].word, busy: JUDGMENT[r.judgment].busy });
    return {
      breaches: digest.rows.map((b) => this.glassBreach(b, sess)),
      more: digest.more,
      motion: work([...sections.mine, ...sections.held]).filter((r) => this.moving(r)).map(row),
      judged: work(sections.asserted).filter((r) => !breached.has(r.task_id)).map(judged),
      idle: work(sections.mine).filter((r) => !this.moving(r)).map(row),
      sections,
      default_agent: this.defaultAgent,
    };
  }
}
