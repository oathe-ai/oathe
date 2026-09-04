// oathe — the ONE place every tunable is named (founder ruling: never hardcode). Layered:
// DEFAULTS → global file (<OATHE_HOME>/config.json) → workspace file (<workspace-root>/.oathe.json)
// → environment. Unknown keys and invalid values refuse loudly at LOAD, not at first use —
// a config file nobody validates is a config file that silently defers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { launchable, verifierCapable } from './harnesses/catalog.mjs';

export class ConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.details = details;
  }
}

const ENGINES = verifierCapable();

/** The OS user — the principal's one default, named here and nowhere else (D0-PREVIEW:
 *  "principal from OATHE_PRINCIPAL or the OS user"). os.userInfo() refuses in a container
 *  whose uid has no passwd entry; USER is the next truth and 'operator' the last word — the
 *  fallback three consumers each hardcoded before 2026-09-03, now in this one place. */
function osUser() {
  try { return os.userInfo().username; } catch { return process.env.USER || 'operator'; }
}

/** Every key: default, env var, validator. Adding a tunable means adding a row HERE. */
const KEYS = Object.freeze({
  org: { default: 'oathe', env: 'OATHE_ORG', check: nonEmptyString },
  principal: { default: osUser(), env: 'OATHE_PRINCIPAL', check: nonEmptyString },
  department: { default: 'operator', env: 'OATHE_DEPARTMENT', check: nonEmptyString },
  db: { default: 'oathe_local', env: 'OATHE_DB', check: nonEmptyString },
  // Standard-first: honor libpq's PGHOST when set; otherwise the platform's conventional
  // socket directory (Homebrew macOS: /tmp; Debian/Ubuntu: /var/run/postgresql). A '/tmp'
  // default alone was a macOS assumption that broke every fresh Linux machine.
  pgHost: {
    default: process.env.PGHOST
      || (process.platform === 'darwin' ? '/tmp' : '/var/run/postgresql'),
    env: 'OATHE_PG_HOST', check: nonEmptyString,
  },
  pgPort: { default: 5432, env: 'OATHE_PG_PORT', check: positiveInt },
  leaseHours: { default: 4, env: 'OATHE_LEASE_HOURS', check: positiveInt },
  verifyByHours: { default: 24, env: 'OATHE_VERIFY_BY_HOURS', check: positiveInt },
  verifier: { default: ENGINES[0], env: 'OATHE_VERIFIER', check: oneOf(ENGINES) },
  // Who picks your work back up (the notch's continue, resumption spawning): chosen at
  // onboarding — the init question ABOVE the verifier question (founder ruling 2026-08-30).
  defaultAgent: { default: null, env: 'OATHE_DEFAULT_AGENT', check: nullOrOneOf(launchable()) },
  verifierPrincipal: { default: 'oathe-verifier', env: 'OATHE_VERIFIER_PRINCIPAL', check: nonEmptyString },
  verifierEvidenceBudget: { default: 24000, env: 'OATHE_VERIFIER_EVIDENCE_BUDGET', check: positiveInt },
  // The trace census sweep window (doctor and the trace-census lane share these): how many
  // days back and at most how many records per engine — the cost knobs for busy stores.
  traceCensusDays: { default: 3, env: 'OATHE_TRACE_CENSUS_DAYS', check: positiveInt },
  traceCensusMaxFiles: { default: 40, env: 'OATHE_TRACE_CENSUS_MAX_FILES', check: positiveInt },
  runtimeProvider: { default: 'auto', env: 'OATHE_RUNTIME_PROVIDER', check: oneOf(['auto', 'oathe', 'standalone']) },
  // Activation (registry row + context-file fences) on first use in a workspace: the off
  // switch for machines that want register-only sessions.
  autoActivate: { default: true, env: 'OATHE_AUTO_ACTIVATE', check: boolean },
  // How long the MCP server waits on a client's roots/list answer before falling down the
  // resolution ladder.
  rootsTimeoutMs: { default: 2000, env: 'OATHE_ROOTS_TIMEOUT_MS', check: positiveInt },
  // R-PAGER: an active claim with no non-trace progress statement inside this many hours is
  // a breached promise (paged at session start). Lifecycle facts like a lapsed lease are not.
  pagerQuietHours: { default: 24, env: 'OATHE_PAGER_QUIET_HOURS', check: positiveInt },
  // The notch app: null is the app the package carries (notch/Oathe Notch.app, built at
  // prepack); a path overrides it for development. init owns the LaunchAgent (src/notch.mjs).
  notchApp: { default: null, env: 'OATHE_NOTCH_APP', check: nullOrString },
  // What "in motion" means on the glass: a claim whose last word (statement, or the claim
  // itself) is younger than this earns a row; idle-held work stays in `oathe ls`.
  notchMotionMinutes: { default: 60, env: 'OATHE_NOTCH_MOTION_MINUTES', check: positiveInt },
  // The notch feed's drift guard: `oathe notch --serve` recomputes a frame this often even
  // when no wire event arrives (the push path is pg_notify; this is the belt to its braces).
  notchHeartbeatSeconds: { default: 300, env: 'OATHE_NOTCH_HEARTBEAT_SECONDS', check: positiveInt },
  // The notch restart budget: launchd's bootout returns before the old job is gone, and a
  // bootstrap in that window is refused ("5: Input/output error") — init re-tries inside
  // this budget, asking this often, and says NOT RUNNING past it (the 0.4.3 update left
  // every re-wired notch unloaded because the one attempt's refusal went unread).
  notchRestartSeconds: { default: 10, env: 'OATHE_NOTCH_RESTART_SECONDS', check: positiveInt },
  notchRestartPollMs: { default: 100, env: 'OATHE_NOTCH_RESTART_POLL_MS', check: positiveInt },
});

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}
function nullOrString(v) {
  return v === null || nonEmptyString(v);
}
function positiveInt(v) {
  return Number.isInteger(v) && v > 0;
}
function boolean(v) {
  return v === true || v === false;
}
boolean.expected = 'true|false';

/** Env strings for boolean keys: 'true'/'1' and 'false'/'0'; anything else stays a string and refuses. */
function coerceEnv(spec, raw) {
  if (typeof spec.default === 'number') return Number(raw);
  if (typeof spec.default === 'boolean') {
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return raw;
  }
  return raw;
}
function oneOf(allowed) {
  const check = (v) => allowed.includes(v);
  check.expected = allowed.join('|');
  return check;
}
function nullOrOneOf(allowed) {
  const check = (v) => v === null || allowed.includes(v);
  check.expected = `null|${allowed.join('|')}`;
  return check;
}
/** Walk up from `dir` to the workspace root (the dir holding .git), else `dir` itself. */
function workspaceRoot(dir) {
  let current = dir;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return dir;
    current = parent;
  }
}

export const CONFIG_KEYS = Object.freeze(Object.keys(KEYS));

export class OatheConfig {
  /** @param {{env?: NodeJS.ProcessEnv, cwd?: string|null}} o cwd:null = global-only (no workspace layer) */
  constructor({ env = process.env, cwd = process.cwd() } = {}) {
    // A cwd that does not exist would walk to / and pick a silently-wrong config root — the
    // exact shape of an unexpanded ${...} template reaching us. Refuse at construction.
    if (cwd !== null && !fs.existsSync(cwd)) {
      throw new ConfigError('OATHE_CONFIG_CWD_INVALID',
        `config cwd '${cwd}' is not an existing directory — refusing to guess a workspace root`, { cwd });
    }
    this.env = env;
    const files = OatheConfig.filesFor({ env, cwd });
    this.globalPath = files[0];
    this.workspacePath = files[1] ?? null;
    this.values = { ...Object.fromEntries(Object.entries(KEYS).map(([k, spec]) => [k, spec.default])) };
    this.sources = Object.fromEntries(Object.keys(KEYS).map((k) => [k, 'default']));
    const layers = [[this.globalPath, 'global']];
    if (this.workspacePath !== null) layers.push([this.workspacePath, 'workspace']);
    for (const [file, layer] of layers) {
      const loaded = this.#loadFile(file);
      Object.assign(this.values, loaded);
      for (const key of Object.keys(loaded)) this.sources[key] = layer;
    }
    for (const [key, spec] of Object.entries(KEYS)) {
      if (spec.env && env[spec.env] !== undefined) {
        const value = coerceEnv(spec, env[spec.env]);
        this.#checkValue(key, value, `env ${spec.env}`);
        this.values[key] = value;
        this.sources[key] = 'env';
      }
    }
  }

  /** Defaults → global file → env, with NO workspace layer — the pre-resolution bootstrap. */
  static global({ env = process.env } = {}) {
    return new OatheConfig({ env, cwd: null });
  }

  /**
   * Coerce a CLI word into `key`'s own value shape — booleans take true/false, numbers
   * take digits, nullable keys take the word null. The one coercion (shared with the env
   * layer's rules); set() still validates, so a wrong word stays a typed refusal. The
   * digits-only rule this replaces made the documented `oathe config autoActivate false`
   * refuse — a config surface that cannot speak its own keys' types.
   */
  static coerce(key, raw) {
    const spec = KEYS[key];
    if (!spec) {
      throw new ConfigError('OATHE_CONFIG_KEY_UNKNOWN',
        `unknown config key '${key}' — known keys: ${CONFIG_KEYS.join(', ')}`, { key });
    }
    if (raw === 'null' && spec.check(null)) return null;
    if (typeof spec.default === 'boolean' || spec.check === boolean) {
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
      return raw;
    }
    return /^\d+$/.test(raw) ? Number(raw) : raw;
  }

  /**
   * The config LAYER FILES for an (env, cwd) — the one path logic, shared by the
   * constructor and by staleness watchers (the MCP connection stamps these files' clocks
   * so a long-lived server follows `oathe config`, never its startup snapshot).
   * @returns {string[]} [globalPath] or [globalPath, workspacePath]
   */
  static filesFor({ env = process.env, cwd = null } = {}) {
    const globalPath = path.join(env.OATHE_HOME || path.join(env.HOME || os.homedir(), '.oathe'), 'config.json');
    return cwd === null ? [globalPath] : [globalPath, path.join(workspaceRoot(cwd), '.oathe.json')];
  }

  /** Where a key's value came from: 'default' | 'global' | 'workspace' | 'env'. */
  source(key) {
    if (!(key in KEYS)) {
      throw new ConfigError('OATHE_CONFIG_KEY_UNKNOWN',
        `unknown config key '${key}' — known keys: ${CONFIG_KEYS.join(', ')}`, { key });
    }
    return this.sources[key];
  }

  #loadFile(file) {
    if (!fs.existsSync(file)) return {};
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new ConfigError('OATHE_CONFIG_FILE_MALFORMED',
        `${file} is not valid JSON: ${e.message}`, { file });
    }
    for (const [key, value] of Object.entries(doc)) {
      if (!(key in KEYS)) {
        throw new ConfigError('OATHE_CONFIG_KEY_UNKNOWN',
          `${file} sets unknown key '${key}' — known keys: ${CONFIG_KEYS.join(', ')}`, { file, key });
      }
      this.#checkValue(key, value, file);
    }
    return doc;
  }

  #checkValue(key, value, source) {
    const spec = KEYS[key];
    if (!spec.check(value)) {
      throw new ConfigError('OATHE_CONFIG_VALUE_INVALID',
        `${source}: '${key}' = ${JSON.stringify(value)} is invalid`
        + `${spec.check.expected ? ` (expected ${spec.check.expected})` : ''}`, { key, value, source });
    }
  }

  get(key) {
    if (!(key in KEYS)) {
      throw new ConfigError('OATHE_CONFIG_KEY_UNKNOWN',
        `unknown config key '${key}' — known keys: ${CONFIG_KEYS.join(', ')}`, { key });
    }
    return this.values[key];
  }

  /** Write one key to the chosen scope file and apply it live. */
  set(key, value, { scope }) {
    if (!(key in KEYS)) {
      throw new ConfigError('OATHE_CONFIG_KEY_UNKNOWN',
        `unknown config key '${key}' — known keys: ${CONFIG_KEYS.join(', ')}`, { key });
    }
    this.#checkValue(key, value, `set(${scope})`);
    const file = scope === 'global' ? this.globalPath
      : scope === 'workspace' ? this.workspacePath
        : (() => {
          throw new ConfigError('OATHE_CONFIG_SCOPE_UNKNOWN',
            `unknown scope '${scope}' — use 'global' or 'workspace'`, { scope });
        })();
    if (file === null) {
      throw new ConfigError('OATHE_CONFIG_SCOPE_UNKNOWN',
        'this config was built global-only (no workspace) — workspace scope has no file here', { scope });
    }
    const doc = this.#loadFile(file);
    doc[key] = value;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    this.values[key] = value;
    this.sources[key] = scope;
    return { file, key, value };
  }
}
