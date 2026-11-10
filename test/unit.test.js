import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-env-home-'));
process.env.BLIND_ENV_HOME = home;
delete process.env.BLIND_ENV_FILE;

const { newMasterKey, open, seal } = await import('../src/crypto.js');
const { parseVault, serializeVault } = await import('../src/format.js');
const { loadKey, saveKey } = await import('../src/keystore.js');
const { createRedactor } = await import('../src/redact.js');
const { Vault, hostAllowed } = await import('../src/vault.js');

const tmpProject = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blind-env-proj-'));

test('crypto: round trip, and a new nonce every time', () => {
  const key = newMasterKey();
  const a = seal(key, 'v1', 'TOKEN', 'hunter2-ünï');
  const b = seal(key, 'v1', 'TOKEN', 'hunter2-ünï');
  assert.notEqual(a, b);
  assert.ok(!a.includes('hunter2'));
  assert.equal(open(key, 'v1', 'TOKEN', a), 'hunter2-ünï');
});

test('crypto: rejects tampering, the wrong key, and a value moved to another name', () => {
  const key = newMasterKey();
  const sealed = seal(key, 'v1', 'TOKEN', 'hunter2');
  const flipped = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1);
  assert.throws(() => open(key, 'v1', 'TOKEN', flipped), /cannot decrypt/);
  assert.throws(() => open(newMasterKey(), 'v1', 'TOKEN', sealed), /cannot decrypt/);
  assert.throws(() => open(key, 'v1', 'OTHER', sealed), /cannot decrypt/);
  assert.throws(() => open(key, 'v2', 'TOKEN', sealed), /cannot decrypt/);
});

test('format: round trip keeps names, notes and hosts', () => {
  const vault = {
    id: 'abc123',
    entries: new Map([
      ['A_KEY', { name: 'A_KEY', sealed: 'enc:v1:AAAA', description: 'first key', allow: ['a.com', '*.b.com'] }],
      ['B_KEY', { name: 'B_KEY', sealed: 'enc:v1:BBBB', description: '', allow: [] }],
    ]),
  };
  const again = parseVault(serializeVault(vault));
  assert.equal(again.id, 'abc123');
  assert.deepEqual([...again.entries.values()], [...vault.entries.values()]);
});

test('format: a plain-text value is refused and not echoed', () => {
  const text = '# blind-env vault v1 id=abc\nTOKEN=hunter2\n';
  assert.throws(
    () => parseVault(text),
    (err) => /not encrypted/.test(err.message) && !err.message.includes('hunter2')
  );
});

test('keystore: the key survives a save and load, and is not stored in the clear on Windows', () => {
  const key = newMasterKey();
  saveKey('unit-test-vault', key);
  assert.deepEqual(loadKey('unit-test-vault'), key);
  const onDisk = fs.readFileSync(path.join(home, 'keys', 'unit-test-vault.key'), 'utf8');
  if (process.platform === 'win32') {
    assert.ok(onDisk.startsWith('dpapi:'));
    assert.ok(!onDisk.includes(key.toString('base64')));
  }
  assert.throws(() => loadKey('never-created'), /no key for this vault/);
});

test('vault: set, list, reveal, remove; the file never contains the value', () => {
  const dir = tmpProject();
  const vault = Vault.init(dir);
  vault.set('DB_PASSWORD', 'correct horse battery', { description: 'local db', allow: ['localhost'] });
  vault.set('API_KEY', 'sk-live-12345');

  const text = fs.readFileSync(path.join(dir, '.aienv'), 'utf8');
  assert.ok(text.includes('DB_PASSWORD=enc:v1:'));
  assert.ok(text.includes('# @desc local db'));
  assert.ok(!text.includes('correct horse'));
  assert.ok(!text.includes('sk-live'));

  const reloaded = Vault.open(dir);
  assert.deepEqual(reloaded.list(), [
    { name: 'DB_PASSWORD', description: 'local db', allow: ['localhost'] },
    { name: 'API_KEY', description: '', allow: [] },
  ]);
  assert.deepEqual(reloaded.reveal(), { DB_PASSWORD: 'correct horse battery', API_KEY: 'sk-live-12345' });

  // Replacing a value keeps its note and hosts.
  reloaded.set('DB_PASSWORD', 'new-password');
  assert.equal(Vault.open(dir).list()[0].description, 'local db');

  reloaded.remove('API_KEY');
  assert.equal(Vault.open(dir).has('API_KEY'), false);
  assert.throws(() => reloaded.set('bad name', 'x'), /invalid key name/);
  assert.throws(() => reloaded.set('EMPTY', ''), /empty/);
});

test('vault: found from a sub-folder', () => {
  const dir = tmpProject();
  Vault.init(dir);
  const sub = path.join(dir, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(Vault.find(sub), path.join(dir, '.aienv'));
});

test('hostAllowed: exact, wildcard, and nothing by default', () => {
  assert.equal(hostAllowed([], 'github.com'), false);
  assert.equal(hostAllowed(['github.com'], 'github.com'), true);
  assert.equal(hostAllowed(['github.com'], 'GitHub.com'), true);
  assert.equal(hostAllowed(['github.com'], 'api.github.com'), false);
  assert.equal(hostAllowed(['github.com'], 'github.com.evil.site'), false);
  assert.equal(hostAllowed(['github.com'], 'evilgithub.com'), false);
  assert.equal(hostAllowed(['*.github.com'], 'api.github.com'), true);
  assert.equal(hostAllowed(['*.github.com'], 'github.com'), false);
  assert.equal(hostAllowed(['*.github.com'], 'evilgithub.com'), false);
});

test('redact: plain value and common encodings', () => {
  const secret = 'p@ss word/+1';
  const r = createRedactor({ PW: secret });
  const b64 = Buffer.from(secret).toString('base64');
  const hex = Buffer.from(secret).toString('hex');
  const out = r.all(`a ${secret} b ${b64} c ${hex} d ${encodeURIComponent(secret)} e`);
  assert.equal(out, 'a ***PW*** b ***PW*** c ***PW*** d ***PW*** e');
});

test('redact: a secret split across chunks, at every possible split point', () => {
  const secret = 'sk-live-ABCDEFGH';
  const text = `start ${secret} middle ${secret}${secret} end`;
  const want = 'start ***KEY*** middle ***KEY******KEY*** end';
  for (let cut = 1; cut < text.length; cut++) {
    const r = createRedactor({ KEY: secret });
    const got = r.push(text.slice(0, cut)) + r.push(text.slice(cut)) + r.flush();
    assert.equal(got, want, `split at ${cut}`);
  }
  const r = createRedactor({ KEY: secret });
  let got = '';
  for (const ch of text) got += r.push(ch);
  assert.equal(got + r.flush(), want);
});

test('redact: several secrets, and the mask is never redacted again', () => {
  const r = createRedactor({ TOKEN: 'TOKEN_VALUE_1', NAME: 'TOKEN' });
  assert.equal(r.all('x TOKEN_VALUE_1 y TOKEN z'), 'x ***TOKEN*** y ***NAME*** z');
});

test('redact: very short values are left alone', () => {
  assert.equal(createRedactor({ PIN: 'abc' }).all('abc abcabc'), 'abc abcabc');
});
