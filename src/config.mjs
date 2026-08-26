// oathe — the ONE place every tunable is named (founder ruling: never hardcode). Layered:
// DEFAULTS → global file (<OATHE_HOME>/config.json) → workspace file (<workspace-root>/.oathe.json)
// → environment. Unknown keys and invalid values refuse loudly at LOAD, not at first use —
// a config file nobody validates is a config file that silently defers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class ConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.details = details;
  }
}

const ENGINES = ['claude', 'codex'];

/** Every key: default, env var, validator. Adding a tunable means adding a row HERE. */
const KEYS = Object.freeze({
  org: { default: 'oathe', env: 'OATHE_ORG', check: nonEmptyString },
  principal: { default: null, env: 'OATHE_PRINCIPAL', check: nullOrString },
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
  verifier: { default: 'claude', env: 'OATHE_VERIFIER', check: oneOf(ENGINES) },
  verifierPrincipal: { default: 'oathe-verifier', env: 'OATHE_VERIFIER_PRINCIPAL', check: nonEmptyString },
  verifierEvidenceBudget: { default: 24000, env: 'OATHE_VERIFIER_EVIDENCE_BUDGET', check: positiveInt },
  runtimeProvider: { default: 'auto', env: 'OATHE_RUNTIME_PROVIDER', check: oneOf(['auto', 'oathe', 'standalone']) },
  starUrl: {
    default: 'https://github.com/oathe-ai/oathe', env: 'OATHE_STAR_URL', check: httpsUrl,
  },
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
function oneOf(allowed) {
  const check = (v) => allowed.includes(v);
  check.expected = allowed.join('|');
  return check;
}
function httpsUrl(v) {
  return typeof v === 'string' && v.startsWith('https://');
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
export const VERIFIER_ENGINES = Object.freeze([...ENGINES]);

export class OatheConfig {
  /** @param {{env?: NodeJS.ProcessEnv, cwd?: string}} o */
  constructor({ env = process.env, cwd = process.cwd() } = {}) {
    this.env = env;
    this.globalPath = path.join(env.OATHE_HOME || path.join(env.HOME || os.homedir(), '.oathe'), 'config.json');
    this.workspacePath = path.join(workspaceRoot(cwd), '.oathe.json');
    this.values = { ...Object.fromEntries(Object.entries(KEYS).map(([k, spec]) => [k, spec.default])) };
    this.sources = Object.fromEntries(Object.keys(KEYS).map((k) => [k, 'default']));
    for (const [file, layer] of [[this.globalPath, 'global'], [this.workspacePath, 'workspace']]) {
      const loaded = this.#loadFile(file);
      Object.assign(this.values, loaded);
      for (const key of Object.keys(loaded)) this.sources[key] = layer;
    }
    for (const [key, spec] of Object.entries(KEYS)) {
      if (spec.env && env[spec.env] !== undefined) {
        const raw = env[spec.env];
        const value = typeof spec.default === 'number' ? Number(raw) : raw;
        this.#checkValue(key, value, `env ${spec.env}`);
        this.values[key] = value;
        this.sources[key] = 'env';
      }
    }
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
    const doc = this.#loadFile(file);
    doc[key] = value;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    this.values[key] = value;
    this.sources[key] = scope;
    return { file, key, value };
  }
}
