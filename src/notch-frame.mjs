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

import { launchable, ownerOfTracePath, surfaceForSession } from './harnesses/catalog.mjs';
import { pidAlive } from './sessions.mjs';
import { KINDS, CONTINUE_ACT } from './breach-digest.mjs';

/** The system terminal — an OS fact, the fallback when no session names its own. */
export const TERMINAL_FALLBACK = '/System/Applications/Utilities/Terminal.app';

const shellQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
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
   *   operatorHome — where a homeless judgment runs.
   */
  constructor({ registry, sessions, defaultAgent, motionWindowMs, operatorHome, now = () => Date.now() }) {
    this.registry = registry;
    this.sessions = sessions;
    this.defaultAgent = this.#launchables.includes(defaultAgent) ? defaultAgent : null;
    this.motionWindowMs = motionWindowMs;
    this.operatorHome = operatorHome;
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
   * Continue is a RESUMPTION, never a shrug (founder ruling 2026-08-30): activate the living
   * app; else spawn the agent at the task's home in a terminal; else open the desktop app;
   * else the clipboard is the act. The package decides — the glass executes.
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
        command: `oathe ${agent} ${shellQuote(`continue ${base.task_id}`)}`,
        cwd: base.home_path,
        terminal_bundle: ref?.bundle ?? TERMINAL_FALLBACK,
        word,
      };
    }
    if (ref?.bundle) return { kind: 'open-app', bundle: ref.bundle, word };
    return { kind: 'copy-only', word };
  }

  glassRow(r, sess) {
    const row = (r.trace_session_id && sess[r.trace_session_id]) || null;
    const heard = this.#heard.get(r.task_id);
    // The durable registry row outranks the wire's ephemeral word; either way the ref
    // carries surface + the focusable app, so a HOMELESS task heard from a living app
    // (ChatGPT's embedded codex — no hooks, no registry row) still resolves to a switch.
    const ref = row !== null ? {
      surface: surfaceForSession({ ancestry: row.ancestry, app: row.app, transcriptPath: row.transcript_path }),
      app_pid: row.app?.pid ?? null,
      bundle: row.app?.bundle ?? null,
      alive: pidAlive(row.pid),
    } : (heard?.app ? {
      surface: heard.via ?? null,
      app_pid: heard.app.pid ?? null,
      bundle: heard.app.bundle ?? null,
      alive: heard.app.pid !== null && heard.app.pid !== undefined && pidAlive(heard.app.pid),
    } : null);
    const base = {
      task_id: r.task_id, objective: r.objective, holder: r.principal_id, state: r.state,
      last_word_at: r.last_word_at, last_progress: r.last_progress,
      children_line: r.children?.line ?? null,
      home_path: this.registry.rootOf(r.home) ?? r.home ?? 'homeless',
      // The surface speaking on the claim: the wire's live word wins; the durable fallback
      // is the latest trace-link statement's transcript, mapped by its owning store.
      surface: heard?.via ?? (r.trace_path ? ownerOfTracePath(r.trace_path) : null),
    };
    return { ...base, session: ref, resume: this.resumeFor(base, ref) };
  }

  /**
   * A breach row carries the ONE act that can change its truth (ruling 2026-08-31): never-
   * judged and engine-failed → dispatch the judgment, DETACHED (closing the window can't
   * orphan it) — for a sibling group, on its oldest child of the leading kind (children ride
   * in breach order); judged-rejected and gone-quiet → CONTINUE into the work, at the parent
   * for a group (the reclaim bundle carries the verdict — re-judging a judged assertion is
   * the one act that can never help). The act's WORD is the kinds table's; the act's KIND is
   * decided here, from the environment. Home is the ONE resolver's answer; a homeless
   * judgment runs from the operator's home.
   */
  glassBreach(b) {
    const home = typeof b.home === 'string' && b.home.startsWith('/') ? b.home : null;
    const word = KINDS[b.kind].act;
    if (judges(b.kind)) {
      const target = b.group ? b.group.children[0] : b.task_id;
      return { ...b, act: { kind: 'spawn-terminal', command: `oathe verify --detach ${shellQuote(target)}`, cwd: home ?? this.operatorHome, terminal_bundle: TERMINAL_FALLBACK, word } };
    }
    if (home !== null && this.defaultAgent) {
      return { ...b, act: { kind: 'spawn-terminal', command: `oathe ${this.defaultAgent} ${shellQuote(`continue ${b.task_id}`)}`, cwd: home, terminal_bundle: TERMINAL_FALLBACK, word } };
    }
    return { ...b, act: { kind: 'copy-only', word } };
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
    return {
      breaches: digest.rows.map((b) => this.glassBreach(b)),
      more: digest.more,
      motion: [...sections.mine, ...sections.held].filter((r) => this.moving(r)).map(row),
      idle: sections.mine.filter((r) => !this.moving(r)).map(row),
      sections,
      default_agent: this.defaultAgent,
    };
  }
}
