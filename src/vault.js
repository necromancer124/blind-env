import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isLegacy, newMasterKey, newVaultId, open, seal } from './crypto.js';
import {
  FILE_NAME,
  LEGACY_FILE_NAME,
  NAME_RE,
  cleanDescription,
  normalizeHosts,
  parseVault,
  serializeVault,
} from './format.js';
import { loadKey, saveKey } from './keystore.js';

/**
 * Shorter values are refused unless the user allows it. Hiding a short value
 * in output gives it away: "test" masked inside "testing" shows what it is.
 */
export const MIN_VALUE_LENGTH = 8;

export class Vault {
  constructor(file, data) {
    this.file = file;
    this.id = data.id;
    this.entries = data.entries;
    this._key = null;
  }

  /**
   * Look for a .env.facedown file in startDir, then in each parent folder.
   * A vault from before the rename (.aienv) is found too.
   */
  static find(startDir = process.cwd()) {
    if (process.env.FACEDOWN_FILE) {
      return fs.existsSync(process.env.FACEDOWN_FILE) ? process.env.FACEDOWN_FILE : null;
    }
    let dir = path.resolve(startDir);
    for (;;) {
      for (const name of [FILE_NAME, LEGACY_FILE_NAME]) {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  static load(file) {
    return new Vault(file, parseVault(fs.readFileSync(file, 'utf8')));
  }

  static open(startDir) {
    const file = Vault.find(startDir);
    if (!file) throw new Error(`no ${FILE_NAME} vault here. Create one with "facedown init".`);
    return Vault.load(file);
  }

  static init(dir = process.cwd()) {
    const file = process.env.FACEDOWN_FILE || path.join(path.resolve(dir), FILE_NAME);
    if (fs.existsSync(file)) throw new Error(`${file} already exists`);
    const vault = new Vault(file, { id: newVaultId(), entries: new Map() });
    vault._key = newMasterKey();
    saveKey(vault.id, vault._key);
    vault.save();
    return vault;
  }

  static openOrInit(startDir = process.cwd()) {
    const file = Vault.find(startDir);
    return file ? Vault.load(file) : Vault.init(startDir);
  }

  key() {
    if (!this._key) this._key = loadKey(this.id);
    return this._key;
  }

  save() {
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, serializeVault(this));
    fs.renameSync(tmp, this.file);
  }

  has(name) {
    return this.entries.has(name);
  }

  /** Names, descriptions and allowed hosts. Never values. */
  list() {
    return [...this.entries.values()].map(({ name, description }) => ({
      name,
      description,
      allow: this.trustedAllow(name),
    }));
  }

  /** Throws if the name or hosts are not valid. Saves nothing. */
  static check(name, allow) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error(`invalid key name "${name}" (use letters, digits and _, like GITHUB_TOKEN)`);
    }
    if (allow !== undefined) {
      if (!Array.isArray(allow)) throw new Error('allow must be a list of hosts');
      normalizeHosts(allow);
    }
  }

  set(name, value, { description, allow, allowShort = false } = {}) {
    Vault.check(name, allow);
    if (typeof value !== 'string' || value.length === 0) throw new Error('the value is empty');
    if (value.length < MIN_VALUE_LENGTH && !allowShort) {
      const err = new Error(
        `${name} is only ${value.length} characters. Values shorter than ${MIN_VALUE_LENGTH} cannot be hidden ` +
          'safely in output (the hiding itself gives them away). Use a longer value, or if it really is short ' +
          `(like a PIN), run "facedown set ${name} --allow-short" in a terminal.`
      );
      err.code = 'SHORT_VALUE';
      throw err;
    }
    const old = this.entries.get(name);
    // A legacy (v1) entry's hosts were never protected, so they are not carried over.
    const keptAllow = old && !isLegacy(old.sealed) ? old.allow : [];
    const finalAllow = allow !== undefined ? normalizeHosts(allow) : keptAllow;
    this.entries.set(name, {
      name,
      sealed: seal(this.key(), this.id, name, value, finalAllow),
      description: description !== undefined ? cleanDescription(description) : old?.description ?? '',
      allow: finalAllow,
    });
    this.save();
  }

  remove(name) {
    if (!this.entries.delete(name)) throw new Error(`no key named ${name}`);
    this.save();
  }

  /**
   * Replace a key's allowed hosts. The value is sealed again, because the
   * hosts are part of what the encryption protects.
   * Callers must get the user's confirmation before ADDING a host.
   */
  setAllow(name, hosts) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`no key named ${name}`);
    const value = this.reveal([name])[name];
    entry.allow = normalizeHosts(hosts);
    entry.sealed = seal(this.key(), this.id, name, value, entry.allow);
    this.save();
  }

  /**
   * The hosts a key may really be sent to. Legacy (v1) entries count as none:
   * their host list was not protected and could have been edited by hand.
   * (For v2 entries a hand-edited list makes decryption fail instead.)
   */
  trustedAllow(name) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`no key named ${name}`);
    return isLegacy(entry.sealed) ? [] : [...entry.allow];
  }

  /** Hosts in `hosts` that this key is not yet allowed to be sent to. */
  newHosts(name, hosts) {
    const current = new Set(this.trustedAllow(name));
    return normalizeHosts(hosts).filter((h) => !current.has(h));
  }

  /**
   * Facts about a value that are safe to show: its length and a fingerprint.
   * The fingerprint is keyed with the vault key, so it cannot be used to guess
   * the value. It includes the key name, so it only tells "same value as
   * before" for one key: a test key holding a guess can never match another
   * key's fingerprint (that would let a program guess values offline).
   */
  inspect(name) {
    const value = this.reveal([name])[name];
    const mac = createHmac('sha256', this.key())
      .update(`blind-env:fingerprint:v2:${name}:`)
      .update(value)
      .digest('hex');
    return { length: value.length, fingerprint: mac.slice(0, 8) };
  }

  /**
   * Decrypt values. Internal use only: the result must go to a child process
   * or an outgoing request, never to anything the AI can read.
   */
  reveal(names = [...this.entries.keys()]) {
    const out = {};
    for (const name of names) {
      const entry = this.entries.get(name);
      if (!entry) throw new Error(`no key named ${name}`);
      out[name] = open(this.key(), this.id, name, entry.sealed, entry.allow);
    }
    return out;
  }
}

/** Is this key allowed to be sent to this host? An empty list allows nothing. */
export function hostAllowed(allow, hostname) {
  const host = hostname.toLowerCase();
  return allow.some((rule) =>
    rule.startsWith('*.') ? host.endsWith(rule.slice(1)) && host.length > rule.length - 1 : host === rule
  );
}
