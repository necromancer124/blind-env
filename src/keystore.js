// Where the master key lives: in the user's home folder, never in the project.
//
//   ~/.facedown/keys/<vault id>.key
//
// On Windows the key is wrapped with DPAPI (tied to the Windows user account),
// so a copy of the file is useless on another machine or account.
// Elsewhere it is a file readable only by the owner (mode 0600).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function homeDir() {
  return process.env.FACEDOWN_HOME || path.join(os.homedir(), '.facedown');
}

function keyPath(vaultId) {
  return path.join(homeDir(), 'keys', `${vaultId}.key`);
}

function useDpapi() {
  return process.platform === 'win32' && process.env.FACEDOWN_NO_DPAPI !== '1';
}

function dpapi(mode, base64In) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$out = [System.Security.Cryptography.ProtectedData]::${mode}($in, $null, $scope)
[Console]::Out.Write([Convert]::ToBase64String($out))
`;
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input: base64In, encoding: 'utf8', windowsHide: true }
  );
  if (res.error || res.status !== 0 || !res.stdout) {
    throw new Error(`Windows key protection (DPAPI ${mode}) failed`);
  }
  return res.stdout.trim();
}

export function saveKey(vaultId, key) {
  const file = keyPath(vaultId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const b64 = key.toString('base64');
  const body = useDpapi() ? `dpapi:${dpapi('Protect', b64)}` : `raw:${b64}`;
  fs.writeFileSync(file, body + '\n', { mode: 0o600 });
}

/** Where keys were kept before the project was renamed from blind-env. */
function legacyKeyPath(vaultId) {
  return path.join(os.homedir(), '.blind-env', 'keys', `${vaultId}.key`);
}

export function loadKey(vaultId) {
  const file = keyPath(vaultId);
  let body;
  try {
    body = fs.readFileSync(file, 'utf8').trim();
  } catch {
    // A vault made by blind-env: its key is still in ~/.blind-env. Copy it to
    // the new place (the file is already protected, so a plain copy is fine).
    if (!process.env.FACEDOWN_HOME) {
      try {
        body = fs.readFileSync(legacyKeyPath(vaultId), 'utf8').trim();
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, body + '\n', { mode: 0o600 });
      } catch {
        body = undefined;
      }
    }
  }
  if (body === undefined) {
    throw new Error(
      `no key for this vault on this computer (looked in ${file}). ` +
        'The vault was created somewhere else: add the secrets again here with "facedown set NAME".'
    );
  }
  const sep = body.indexOf(':');
  const kind = body.slice(0, sep);
  const data = body.slice(sep + 1);
  let b64;
  if (kind === 'dpapi') b64 = dpapi('Unprotect', data);
  else if (kind === 'raw') b64 = data;
  else throw new Error(`unrecognized key file: ${file}`);
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error(`damaged key file: ${file}`);
  return key;
}
