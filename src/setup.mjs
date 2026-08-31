// oathe init as DATA. A SetupPlan is everything the machine owner is asked and everything init
// will do: one step per wiring adapter, each step's "what yes writes" taken from the adapter's
// own describe() (the same data its onboard() writes — the prompt cannot promise what the
// write does not do), the verifier candidates from the census (headless-capable AND the CLI is
// here), the detect-only surfaces as explanations. A SetupPrompter renders the plan on a TTY:
// one explained yes/no per installed harness, the verifier by NAME, Enter = default, an
// unrecognized answer refused and re-asked. --yes and no-TTY apply the plan's defaults to the
// SAME plan and announce them. Nothing in this file writes anything. The rules every line here
// follows are docs/UX.md; tests/setup.test.mjs holds them.

import { launchable, verifiers } from './harnesses/catalog.mjs';

export class OatheInitError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OatheInitError';
    this.code = code;
    this.details = details;
  }
}

/** `~` for the home prefix — every path a person reads in a prompt or a summary. */
export function tilde(text, home) {
  return home ? String(text).split(home).join('~') : String(text);
}

/** Why a step was skipped, as a sentence for people — never the token. */
const SKIP_REASONS = Object.freeze({
  'not-installed': 'not installed',
  'not-wired': 'not wired',
  'harness-filter': 'not named by --harness',
  answered: 'you said no',
});

export class SetupStep {
  constructor({ name, displayName, covers, wired = false, presence, installed, writes, configHome, cliBins }) {
    this.name = name;
    this.displayName = displayName;
    this.covers = covers;
    this.wired = wired;
    this.presence = presence;
    this.installed = installed;
    this.writes = writes;
    this.configHome = configHome;
    this.cliBins = cliBins;
    /** null = unanswered; a harness that is not here is never a question. */
    this.selected = installed ? null : false;
    this.reason = installed ? null : 'not-installed';
  }

  decide(selected, reason) {
    this.selected = selected;
    this.reason = reason;
  }

  /** Presence as facts: what was found — or, when nothing was, what was looked for. */
  presenceLine(home) {
    const found = [];
    if (this.presence.app === true) found.push('app installed');
    if (this.presence.cli) found.push('CLI on PATH');
    if (this.presence.configHome) found.push(`config at ${tilde(this.presence.configHome, home)}`);
    if (this.installed) {
      const noCli = !this.presence.cli && this.cliBins.length > 0 ? ` (no ${this.cliBins.join('/')} on PATH)` : '';
      return `found: ${found.join(', ')}${noCli}`;
    }
    const lookedFor = [];
    if (this.cliBins.length > 0) lookedFor.push(`no ${this.cliBins.join('/')} on PATH`);
    lookedFor.push(`no ${tilde(this.configHome, home)}`);
    return `not found (${lookedFor.join(', ')})`;
  }
}

export class SetupPlan {
  constructor({ home, fresh = true, configPath, manifestPath, steps, verifier, agent, surfaces }) {
    this.home = home;
    /** No wiring exists yet — the screen defaults everything detected ON; else it shows the state. */
    this.fresh = fresh;
    this.configPath = configPath;
    this.manifestPath = manifestPath;
    this.steps = steps;
    this.verifier = verifier;
    this.agent = agent;
    this.surfaces = surfaces;
    /** Set when defaults were applied instead of answers: 'assume-yes' | 'no-tty' | … */
    this.defaultsReason = null;
  }

  /**
   * @param {{adapters: object[], census: object[], surfaces: object[], machine: import('./config.mjs').OatheConfig,
   *          home: string, paths: {manifestPath: string}, fallbackVerifier: string}} o — `machine` is the GLOBAL config layer: the
   *   verifier is a machine-wide choice, and only that layer says whether it was made.
   */
  static from({ adapters, census, surfaces, machine, home, paths, fallbackVerifier, wiredNow = new Set() }) {
    const steps = adapters.map((adapter) => {
      const seen = census.find((c) => c.name === adapter.name);
      return new SetupStep({
        name: adapter.name,
        displayName: adapter.constructor.displayName,
        covers: adapter.constructor.covers,
        wired: wiredNow.has(adapter.name),
        presence: seen.presence,
        installed: seen.installed,
        writes: adapter.describe(),
        configHome: adapter.configHome,
        cliBins: adapter.constructor.cliBins,
      });
    });
    const candidates = verifiers(census);
    const alreadyChosen = machine.source('verifier') !== 'default'
      ? { value: machine.get('verifier'), file: machine.globalPath }
      : null;
    const fresh = wiredNow.size === 0;
    const verifier = {
      candidates,
      default: candidates[0] ?? fallbackVerifier,
      alreadyChosen,
      chosen: alreadyChosen?.value ?? null,
      asked: false,
    };
    // The default agent (who picks your work back up — the notch's continue): the same
    // question shape as the verifier, asked ABOVE it (founder ruling 2026-08-30).
    const agentCandidates = launchable().filter((n) => census.find((c) => c.name === n)?.installed);
    const agentChosen = machine.source('defaultAgent') !== 'default'
      ? { value: machine.get('defaultAgent'), file: machine.globalPath }
      : null;
    const agent = {
      candidates: agentCandidates,
      default: agentCandidates[0] ?? null,
      alreadyChosen: agentChosen,
      chosen: agentChosen?.value ?? null,
      asked: false,
    };
    return new SetupPlan({
      home,
      fresh,
      configPath: machine.globalPath,
      manifestPath: paths.manifestPath,
      steps,
      verifier,
      agent,
      surfaces: surfaces.filter((s) => s.detected)
        .map((s) => ({ name: s.name, displayName: s.displayName, detected: true, note: s.steps })),
    });
  }

  step(name) {
    return this.steps.find((s) => s.name === name);
  }

  /** --harness a,b: exactly the named — an unknown name or one not on this machine is a refusal. */
  narrow(names) {
    const wireable = this.steps.map((s) => s.name);
    const unknown = names.filter((n) => !wireable.includes(n));
    if (unknown.length > 0) {
      throw new OatheInitError('OATHE_INIT_HARNESS_UNKNOWN',
        `--harness names ${unknown.join(', ')} — init wires: ${wireable.join(', ')}`, { unknown });
    }
    const absent = names.filter((n) => !this.step(n).installed);
    if (absent.length > 0) {
      throw new OatheInitError('OATHE_INIT_HARNESS_ABSENT',
        `--harness names ${absent.map((n) => `${n}, which is ${this.step(n).presenceLine(this.home)}`).join('; ')}`
        + ' — nothing to wire; install it first or drop it from --harness', { absent });
    }
    for (const step of this.steps.filter((s) => s.installed)) step.decide(names.includes(step.name), 'harness-filter');
    return this;
  }

  /** Answer every open question with its default — the CURRENT state (a fresh machine: all on). Never unwires. */
  applyDefaults(reason) {
    for (const step of this.steps) {
      if (!step.installed || step.selected !== null) continue;
      if (this.fresh || step.wired) step.decide(true, reason);
      else step.decide(false, 'not-wired');
    }
    if (this.verifier.chosen === null) this.verifier.chosen = this.verifier.default;
    if (this.agent.chosen === null) this.agent.chosen = this.agent.default;
    this.defaultsReason = reason;
    return this;
  }

  get wired() {
    return this.steps.filter((s) => s.selected === true).map((s) => s.name);
  }

  /** The wired harnesses the SCREEN unchecked — the only path that unwires (--yes/--harness never do). */
  get toUnwire() {
    return this.steps.filter((s) => s.wired && s.selected === false && s.reason === 'answered').map((s) => s.name);
  }

  get answered() {
    return this.steps.every((s) => s.selected !== null) && this.verifier.chosen !== null
      && (this.agent.chosen !== null || this.agent.candidates.length === 0);
  }

  /** What was applied, one clause each — the line --yes and no-TTY print. */
  announceLines() {
    const lines = [];
    if (this.wired.length > 0) lines.push(`wire: ${this.wired.join(', ')}`);
    const skipped = new Map();
    for (const s of this.steps.filter((x) => x.selected === false)) {
      const why = SKIP_REASONS[s.reason] ?? s.reason;
      skipped.set(why, [...(skipped.get(why) ?? []), s.name]);
    }
    for (const [why, names] of skipped) lines.push(`skip: ${names.join(', ')} (${why})`);
    if (this.agent.chosen !== null) {
      lines.push(`default agent: ${this.agent.chosen}${this.agent.alreadyChosen ? ' (already chosen machine-wide)' : ''}`);
    }
    lines.push(`verifier: ${this.verifier.chosen}${this.verifier.alreadyChosen ? ' (already chosen machine-wide)' : ''}`);
    return lines;
  }

  /** The plan plus what landed: one row per step, files under ~, reasons as sentences. */
  outcomes(actions) {
    return this.steps.map((step) => {
      const mine = actions.filter((a) => a.harness === step.name && !/^skipped/.test(a.action));
      const files = [...new Set(mine.filter((a) => a.file).map((a) => tilde(a.file, this.home)))];
      const landed = files.length > 0 ? files : mine.map((a) => a.action);
      if (step.selected === true) return { name: step.name, displayName: step.displayName, outcome: 'wired', reason: null, landed };
      if (this.toUnwire.includes(step.name)) return { name: step.name, displayName: step.displayName, outcome: 'unwired', reason: null, landed };
      return { name: step.name, displayName: step.displayName, outcome: 'skipped', reason: SKIP_REASONS[step.reason] ?? step.reason, landed: [] };
    });
  }
}

// ------------------------------------------------------------------ the one-screen checklist
// Raw-mode keys, plain ANSI, no TUI dependency. Every detected harness is a pre-selected row;
// ↑↓ move, space toggles, the verifier is a radio row (← →), Enter installs the selection —
// one keypress for the common case (docs/UX.md rule 1). Nothing here writes anything.

const ANSI = Object.freeze({
  dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', hide: '\x1b[?25l', show: '\x1b[?25h',
  up: (n) => `\x1b[${n}A`, clear: '\x1b[J',
});
const LEGEND = '↑↓ move · space toggle · enter install';
const OPENING = 'oathe init — reversible (oathe uninstall)';

const KEY_NAMES = Object.freeze({
  '\x1b[A': 'up', '\x1bOA': 'up', k: 'up',
  '\x1b[B': 'down', '\x1bOB': 'down', j: 'down',
  '\x1b[C': 'right', '\x1bOC': 'right', l: 'right',
  '\x1b[D': 'left', '\x1bOD': 'left', h: 'left',
  ' ': 'toggle', '\r': 'enter', '\n': 'enter',
  '\x03': 'abort', q: 'abort', '\x1b': 'abort',
});

/** Raw bytes → key names; a chunk may carry several keys (a paste, a piped line); unknown bytes do nothing (rule 5). */
export function decodeKeys(chunk) {
  const text = String(chunk);
  const keys = [];
  for (let at = 0; at < text.length;) {
    if (text[at] === '\x1b' && (text[at + 1] === '[' || text[at + 1] === 'O') && at + 2 < text.length) {
      const name = KEY_NAMES[text.slice(at, at + 3)];
      if (name) keys.push(name);
      at += 3;
      continue;
    }
    const name = KEY_NAMES[text[at]];
    if (name) keys.push(name);
    at += 1;
  }
  return keys;
}

class SetupScreen {
  constructor(plan, { columns }) {
    this.plan = plan;
    this.columns = columns;
    this.t = (x) => tilde(x, plan.home);
    // The live picks: only steps the plan has not already decided (installed and unanswered).
    this.picks = new Map(plan.steps.filter((s) => s.installed && s.selected === null).map((s) => [s.name, plan.fresh || s.wired]));
    const v = plan.verifier;
    this.radio = v.candidates.length > 1; // a recorded choice PRESETS the radio — re-running init is how you change it
    this.verifierAt = Math.max(0, v.candidates.indexOf(
      v.alreadyChosen !== null && v.candidates.includes(v.alreadyChosen.value) ? v.alreadyChosen.value : v.default));
    const a = plan.agent;
    this.agentRadio = a.candidates.length > 1;
    this.agentAt = Math.max(0, a.candidates.indexOf(
      a.alreadyChosen !== null && a.candidates.includes(a.alreadyChosen.value) ? a.alreadyChosen.value : a.default));
    // The rows the cursor can reach: toggleable steps, then the agent, then the verifier
    // (the agent question sits ABOVE the verifier — founder ruling 2026-08-30).
    this.movable = [
      ...plan.steps.filter((s) => this.picks.has(s.name)).map((s) => ({ kind: 'step', step: s })),
      ...(this.agentRadio ? [{ kind: 'agent' }] : []),
      ...(this.radio ? [{ kind: 'verifier' }] : []),
    ];
    this.cursor = 0;
  }

  get current() {
    return this.movable[this.cursor] ?? null;
  }

  move(delta) {
    if (this.movable.length > 0) this.cursor = (this.cursor + delta + this.movable.length) % this.movable.length;
  }

  toggle() {
    const row = this.current;
    if (!row) return;
    if (row.kind === 'step') this.picks.set(row.step.name, !this.picks.get(row.step.name));
    else this.cycle(1);
  }

  cycle(delta) {
    if (this.current?.kind === 'agent') {
      const n = this.plan.agent.candidates.length;
      this.agentAt = (this.agentAt + delta + n) % n;
      return;
    }
    if (this.current?.kind !== 'verifier') return;
    const n = this.plan.verifier.candidates.length;
    this.verifierAt = (this.verifierAt + delta + n) % n;
  }

  #stepRow(step) {
    const label = step.displayName.padEnd(12);
    if (!step.installed) return { text: `    ${label} ${step.presenceLine(this.plan.home)}`, fixed: true, step };
    const covers = `(${step.covers})`;
    if (this.picks.has(step.name)) {
      return { text: `[${this.picks.get(step.name) ? 'x' : ' '}] ${label} ${covers}`, fixed: false, step };
    }
    const why = step.selected === true ? '(--harness)' : (SKIP_REASONS[step.reason] ?? step.reason);
    return { text: `[${step.selected === true ? 'x' : ' '}] ${label} ${covers}  ${why}`, fixed: true, step };
  }

  #agentRow() {
    const a = this.plan.agent;
    const label = 'default agent'.padEnd(12);
    if (a.candidates.length === 0) return null; // no launchable agent installed — not a question
    if (a.candidates.length === 1) {
      return { text: `    ${label} ${a.candidates[0]}`, fixed: true };
    }
    const radio = a.candidates.map((c, i) => `(${i === this.agentAt ? '•' : ' '}) ${c}`).join('  ');
    return {
      text: `    ${label} ${radio}`,
      fixed: false,
      kind: 'agent',
      hint: '← → choose · who picks your work back up (the notch\'s continue opens this agent)',
    };
  }

  #verifierRow() {
    const v = this.plan.verifier;
    const label = 'verifier'.padEnd(12);
    if (v.candidates.length <= 1) {
      return { text: `    ${label} ${v.candidates[0] ?? v.default}`, fixed: true };
    }
    const radio = v.candidates.map((c, i) => `(${i === this.verifierAt ? '•' : ' '}) ${c}`).join('  ');
    return {
      text: `    ${label} ${radio}`,
      fixed: false,
      kind: 'verifier',
      hint: '← → choose · judges finished work in a fresh headless run under a non-author seat; tip: the one you use less',
    };
  }

  rows() {
    return [
      ...this.plan.steps.map((s) => this.#stepRow(s)),
      ...this.plan.surfaces.map((s) => ({ text: `    ${s.displayName.padEnd(12)} detected — nothing to wire`, fixed: true })),
      ...(this.#agentRow() ? [this.#agentRow()] : []),
      this.#verifierRow(),
    ];
  }

  #fit(text) {
    return text.length >= this.columns ? `${text.slice(0, this.columns - 2)}…` : text;
  }

  /** The live screen: opening, legend, rows with the cursor, the highlighted row's full writes. */
  render() {
    const cur = this.current;
    const lines = [OPENING, `  ${ANSI.dim}${LEGEND}${ANSI.reset}`, ''];
    for (const row of this.rows()) {
      const here = cur !== null
        && ((cur.kind === 'step' && row.step === cur.step) || (row.kind !== undefined && row.kind === cur.kind));
      const body = this.#fit(row.text);
      lines.push(here ? `${ANSI.bold}› ${body}${ANSI.reset}` : row.fixed ? `${ANSI.dim}  ${body}${ANSI.reset}` : `  ${body}`);
    }
    lines.push('');
    if (cur?.kind === 'step') for (const w of cur.step.writes) lines.push(`  ${ANSI.dim}${this.#fit(this.t(w))}${ANSI.reset}`);
    if (cur?.kind === 'verifier') lines.push(`  ${ANSI.dim}${this.#fit(this.rows().at(-1).hint)}${ANSI.reset}`);
    return lines;
  }

  /** What stays in scrollback once the choice is made: the rows, plain, no legend. */
  final() {
    return [OPENING, '', ...this.rows().map((row) => (row.fixed
      ? `${ANSI.dim}  ${this.#fit(row.text)}${ANSI.reset}`
      : `  ${this.#fit(row.text)}`)), ''];
  }

  /** Apply the picks to the plan. */
  commit() {
    for (const [name, on] of this.picks) this.plan.step(name).decide(on, 'answered');
    const v = this.plan.verifier;
    if (this.radio) {
      v.chosen = v.candidates[this.verifierAt];
      v.asked = true;
    } else {
      v.chosen = v.alreadyChosen?.value ?? v.candidates[0] ?? v.default;
    }
    const a = this.plan.agent;
    if (this.agentRadio) {
      a.chosen = a.candidates[this.agentAt];
      a.asked = true;
    } else {
      a.chosen = a.alreadyChosen?.value ?? a.candidates[0] ?? a.default;
    }
    return this.plan;
  }
}

/** The one-screen setup over a SetupPlan on a TTY. */
export class SetupPrompter {
  constructor({ stdin, out }) {
    this.stdin = stdin;
    this.out = out;
  }

  static isInteractive({ stdin, out }) {
    return stdin?.isTTY === true && out?.isTTY === true;
  }

  /** Show the screen, take keys until Enter, return the answered plan; Esc/q/ctrl-c and EOF are typed refusals. */
  ask(plan) {
    const screen = new SetupScreen(plan, { columns: this.out.columns || 100 });
    let drawn = 0;
    const columns = this.out.columns || 100;
    const fit = (line) => {
      const plain = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      if (plain.length <= columns) return line;
      // Clamp by VISIBLE length: a wrapped line occupies two rows while the redraw counts one.
      let visible = 0;
      let out = '';
      for (let at = 0; at < line.length && visible < columns - 1;) {
        const esc = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(at));
        if (esc) { out += esc[0]; at += esc[0].length; continue; }
        out += line[at]; at += 1; visible += 1;
      }
      return `${out}…${line.includes(ANSI.reset) ? ANSI.reset : ''}`;
    };
    const draw = (lines) => {
      this.out.write(`${drawn > 0 ? ANSI.up(drawn) + ANSI.clear : ''}${lines.map(fit).join('\n')}\n`);
      drawn = lines.length;
    };
    return new Promise((resolve, reject) => {
      const stop = () => {
        this.stdin.removeListener('data', onData);
        this.stdin.removeListener('end', onEnd);
        this.stdin.removeListener('close', onEnd);
        this.stdin.setRawMode?.(false);
        this.stdin.pause?.();
        this.out.write(ANSI.show);
      };
      const finish = () => {
        draw(screen.final());
        stop();
        resolve(screen.commit());
      };
      const refuse = (code, message) => {
        draw(screen.final());
        stop();
        reject(new OatheInitError(code, message));
      };
      const onData = (chunk) => {
        for (const key of decodeKeys(chunk)) {
          if (key === 'enter') return finish();
          if (key === 'abort') {
            return refuse('OATHE_INIT_ABORTED',
              'setup aborted at the keyboard — nothing was written; run `oathe init` again, or `oathe init --yes` for the defaults');
          }
          if (key === 'up') screen.move(-1);
          else if (key === 'down') screen.move(1);
          else if (key === 'toggle') screen.toggle();
          else if (key === 'right') screen.cycle(1);
          else if (key === 'left') screen.cycle(-1);
        }
        draw(screen.render());
        return undefined;
      };
      const onEnd = () => refuse('OATHE_INIT_INPUT_CLOSED',
        'stdin closed before Enter — nothing was written; run `oathe init` on a terminal, or `oathe init --yes` for a '
        + 'non-interactive setup (it announces the defaults it applies)');
      this.stdin.setRawMode?.(true);
      this.stdin.on('data', onData);
      this.stdin.on('end', onEnd);
      this.stdin.on('close', onEnd);
      this.stdin.resume?.();
      this.out.write(ANSI.hide);
      draw(screen.render());
    });
  }
}
