// oathe — the device identity (founder ruling 2026-09-04): person → device → session. The
// person comes from auth at the cloud seam; the SESSION is attested on this machine by the
// daemon; the DEVICE is the trust unit anything outside this machine will sign against. So
// `oathe init` mints ONE identity under the oathe home — a random id and an ed25519 key pair,
// derived from no hardware, in a 0600 file — the way the shim is materialized (src/shim.mjs):
// an oathe-home-owned artifact with one manifest row the doctor verifies and uninstall removes.
// It is KEPT byte-for-byte on every re-init: re-minting would sever every prior act's device
// ref. A malformed file is a typed refusal, never silently replaced. No signer ships in this
// lane — the key is minted for enrollment, and the copy says exactly that.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { sha256Hex } from './manifest.mjs';

export const DEVICE_FORMAT = 1;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class OatheDeviceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OatheDeviceError';
    this.code = code;
    this.details = details;
  }
}

/** The identity on disk, whole — `null` when never minted; a broken file refuses typed. */
function readDevice(devicePath) {
  if (!fs.existsSync(devicePath)) return null;
  const raw = fs.readFileSync(devicePath, 'utf8');
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new OatheDeviceError('OATHE_DEVICE_MALFORMED',
      `${devicePath} is not JSON (${e.message}) — the device identity is never re-minted over a `
      + 'broken file; move it aside and run `oathe init`', { file: devicePath });
  }
  if (doc?.format !== DEVICE_FORMAT || typeof doc.device_id !== 'string' || !UUID_V4.test(doc.device_id)) {
    throw new OatheDeviceError('OATHE_DEVICE_MALFORMED',
      `${devicePath} carries no device_id in format ${DEVICE_FORMAT} — the device identity is never `
      + 're-minted over a broken file; move it aside and run `oathe init`', { file: devicePath });
  }
  return { doc, raw };
}

/** The device id — `null` when no identity was minted (never invented at read time). */
export function readDeviceId({ devicePath }) {
  return readDevice(devicePath)?.doc.device_id ?? null;
}

/**
 * Mint the identity once, keep it forever, record it as ONE manifest row.
 * @returns {[{action: 'device-minted'|'device-kept', file: string, device_id: string}]}
 */
export function writeDevice({ devicePath, manifest, version, clock = () => new Date() }) {
  const existing = readDevice(devicePath);
  let raw = existing?.raw;
  let deviceId = existing?.doc.device_id;
  if (!existing) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    deviceId = crypto.randomUUID();
    raw = `${JSON.stringify({
      format: DEVICE_FORMAT,
      device_id: deviceId,
      key: {
        alg: 'ed25519',
        public_pem: publicKey.export({ type: 'spki', format: 'pem' }),
        private_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      },
      minted_at: clock().toISOString(),
    }, null, 2)}\n`;
    // Temp-then-rename with the mode on the temp write, then chmod after the rename: rename
    // keeps a pre-existing file's mode (the shim's precedent, src/shim.mjs).
    fs.mkdirSync(path.dirname(devicePath), { recursive: true });
    const tmp = `${devicePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, raw, { mode: 0o600 });
    fs.renameSync(tmp, devicePath);
  }
  fs.chmodSync(devicePath, 0o600);
  // One device, ONE row (the shim's F1 lesson): a re-run replaces, never accumulates.
  manifest.removeWhere((r) => r.kind === 'device-id');
  manifest.upsert({
    harness: 'device',
    file: devicePath,
    kind: 'device-id',
    detail: { device_id: deviceId },
    blockVersion: version,
    sha256: sha256Hex(raw),
  });
  return [{ action: existing ? 'device-kept' : 'device-minted', file: devicePath, device_id: deviceId }];
}

/** Remove exactly what was recorded; absence is a stated action, never silence. */
export function unwireDevice({ manifest }) {
  const rows = manifest.removeWhere((r) => r.kind === 'device-id');
  if (rows.length === 0) return [{ action: 'device-absent' }];
  const actions = [];
  for (const row of rows) {
    fs.rmSync(row.file, { force: true });
    actions.push({ action: 'device-removed', file: row.file });
  }
  return actions;
}
