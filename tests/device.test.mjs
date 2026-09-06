// oathe — the device identity (ruling 2026-09-04): person → device → session. The device is
// the trust unit anything outside this machine will sign against, so `oathe init` mints ONE
// id and one ed25519 key pair under the oathe home (0600), keeps them byte-for-byte on every
// re-init (re-minting would sever every prior act's device ref), records them as one manifest
// row the doctor verifies, and removes them on uninstall. No signer ships in this lane — the
// key is minted for enrollment and the copy says exactly that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { DEVICE_FORMAT, readDeviceId, writeDevice, unwireDevice } from '../src/device.mjs';
import { InstallManifest } from '../src/manifest.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'oathe-device-')); }
function manifestIn(home) {
  return new InstallManifest({
    manifestPath: path.join(home, '.oathe', 'install-manifest.json'),
    backupsDir: path.join(home, '.oathe', 'backups'),
  });
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('writeDevice mints a random device id and an ed25519 pair, mode 0600, and records ONE manifest row', () => {
  const home = tmp();
  try {
    const devicePath = path.join(home, '.oathe', 'device.json');
    const manifest = manifestIn(home);
    const actions = writeDevice({ devicePath, manifest, version: '9.9.9' });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, 'device-minted');
    assert.equal(actions[0].file, devicePath);
    assert.match(actions[0].device_id, UUID, 'a random v4 uuid — derived from no hardware');
    assert.equal(fs.statSync(devicePath).mode & 0o777, 0o600, 'this user\'s alone');
    const doc = JSON.parse(fs.readFileSync(devicePath, 'utf8'));
    assert.equal(doc.format, DEVICE_FORMAT);
    assert.equal(doc.device_id, actions[0].device_id);
    assert.equal(doc.key.alg, 'ed25519');
    const pub = crypto.createPublicKey(doc.key.public_pem);
    const priv = crypto.createPrivateKey(doc.key.private_pem);
    const sig = crypto.sign(null, Buffer.from('probe'), priv);
    assert.equal(crypto.verify(null, Buffer.from('probe'), pub, sig), true, 'a real pair — usable by the enrollment that comes later');
    const rows = manifest.rows.filter((r) => r.kind === 'device-id');
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].harness, rows[0].file, rows[0].detail], ['device', devicePath, { device_id: doc.device_id }]);
    assert.equal(readDeviceId({ devicePath }), doc.device_id);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a second writeDevice KEEPS the identity byte-for-byte and still records one row; a malformed file refuses typed and is never re-minted over', () => {
  const home = tmp();
  try {
    const devicePath = path.join(home, '.oathe', 'device.json');
    const manifest = manifestIn(home);
    const [first] = writeDevice({ devicePath, manifest, version: '9.9.9' });
    const bytes = fs.readFileSync(devicePath);
    const [second] = writeDevice({ devicePath, manifest, version: '9.9.10' });
    assert.equal(second.action, 'device-kept');
    assert.equal(second.device_id, first.device_id);
    assert.ok(bytes.equals(fs.readFileSync(devicePath)), 're-minting would sever every prior act\'s device ref');
    assert.equal(fs.statSync(devicePath).mode & 0o777, 0o600);
    assert.equal(manifest.rows.filter((r) => r.kind === 'device-id').length, 1, 'one device, ONE row — the shim\'s F1 lesson');
    fs.writeFileSync(devicePath, '{"format":1,"device_id":"not-a-uuid"}');
    assert.throws(() => writeDevice({ devicePath, manifest, version: '9.9.9' }), (e) => e.code === 'OATHE_DEVICE_MALFORMED');
    assert.equal(fs.readFileSync(devicePath, 'utf8'), '{"format":1,"device_id":"not-a-uuid"}', 'the broken file is reported, never silently replaced');
    assert.throws(() => readDeviceId({ devicePath }), (e) => e.code === 'OATHE_DEVICE_MALFORMED');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readDeviceId is null when no device was minted; unwireDevice removes exactly what was recorded, and absence is a stated action', () => {
  const home = tmp();
  try {
    const devicePath = path.join(home, '.oathe', 'device.json');
    assert.equal(readDeviceId({ devicePath }), null);
    const manifest = manifestIn(home);
    writeDevice({ devicePath, manifest, version: '9.9.9' });
    assert.deepEqual(unwireDevice({ manifest }), [{ action: 'device-removed', file: devicePath }]);
    assert.ok(!fs.existsSync(devicePath));
    assert.equal(manifest.rows.filter((r) => r.kind === 'device-id').length, 0);
    assert.deepEqual(unwireDevice({ manifest }), [{ action: 'device-absent' }]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
