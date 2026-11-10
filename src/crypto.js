// AES-256-GCM with a random 96-bit nonce per value.
// The vault id and key name are bound in as additional data, so a ciphertext
// cannot be copied onto a different name or into a different vault.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SEALED_PREFIX } from './format.js';

const NONCE_LEN = 12;
const TAG_LEN = 16;

export function newMasterKey() {
  return randomBytes(32);
}

export function newVaultId() {
  return randomBytes(9).toString('base64url');
}

function aad(vaultId, name) {
  return Buffer.from(`blind-env:v1:${vaultId}:${name}`, 'utf8');
}

export function seal(masterKey, vaultId, name, plaintext) {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce);
  cipher.setAAD(aad(vaultId, name));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return SEALED_PREFIX + Buffer.concat([nonce, tag, ct]).toString('base64url');
}

export function open(masterKey, vaultId, name, sealed) {
  try {
    const raw = Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64url');
    if (raw.length < NONCE_LEN + TAG_LEN) throw new Error('too short');
    const nonce = raw.subarray(0, NONCE_LEN);
    const tag = raw.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
    const ct = raw.subarray(NONCE_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce);
    decipher.setAAD(aad(vaultId, name));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(
      `cannot decrypt ${name}: the vault file was changed by hand, or this is not the key it was encrypted with`
    );
  }
}
