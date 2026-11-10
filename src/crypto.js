// AES-256-GCM with a random 96-bit nonce per value.
//
// The vault id, the key name and (since v2) the key's allowed hosts are bound
// in as additional data. So a ciphertext cannot be copied onto another name or
// into another vault, and editing the "# @allow" line by hand makes the value
// impossible to decrypt: only blind-env can change which sites a key may go to.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const SEALED_V1 = 'enc:v1:';
export const SEALED_V2 = 'enc:v2:';

const NONCE_LEN = 12;
const TAG_LEN = 16;

export function newMasterKey() {
  return randomBytes(32);
}

export function newVaultId() {
  return randomBytes(9).toString('base64url');
}

/** v1 values were sealed before allowed hosts were protected. */
export function isLegacy(sealed) {
  return sealed.startsWith(SEALED_V1);
}

function aad(sealedPrefix, vaultId, name, allow) {
  if (sealedPrefix === SEALED_V1) return Buffer.from(`blind-env:v1:${vaultId}:${name}`, 'utf8');
  const hosts = [...allow].sort().join(',');
  return Buffer.from(`blind-env:v2:${vaultId}:${name}:${hosts}`, 'utf8');
}

export function seal(masterKey, vaultId, name, plaintext, allow = []) {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce);
  cipher.setAAD(aad(SEALED_V2, vaultId, name, allow));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return SEALED_V2 + Buffer.concat([nonce, tag, ct]).toString('base64url');
}

export function open(masterKey, vaultId, name, sealed, allow = []) {
  try {
    const prefix = sealed.slice(0, SEALED_V2.length);
    if (prefix !== SEALED_V1 && prefix !== SEALED_V2) throw new Error('unknown format');
    const raw = Buffer.from(sealed.slice(prefix.length), 'base64url');
    if (raw.length < NONCE_LEN + TAG_LEN) throw new Error('too short');
    const nonce = raw.subarray(0, NONCE_LEN);
    const tag = raw.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
    const ct = raw.subarray(NONCE_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce);
    decipher.setAAD(aad(prefix, vaultId, name, allow));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(
      `cannot decrypt ${name}: the vault file was changed by hand (for example its allowed hosts), ` +
        'or this is not the key it was encrypted with'
    );
  }
}
