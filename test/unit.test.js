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

test('crypto: allowed hosts are part of the seal; v1 values still open', async () => {
  const { createCipheriv, randomBytes } = await import('node:crypto');
  const key = newMasterKey();
  const sealed = seal(key, 'v1', 'TOKEN', 'hunter2-long', ['a.com', 'b.com']);
  assert.ok(sealed.startsWith('enc:v2:'));
  assert.equal(open(key, 'v1', 'TOKEN', sealed, ['b.com', 'a.com']), 'hunter2-long'); // order does not matter
  assert.throws(() => open(key, 'v1', 'TOKEN', sealed, ['a.com', 'b.com', 'evil.com']), /changed by hand/);
  assert.throws(() => open(key, 'v1', 'TOKEN', sealed, []), /changed by hand/);

  // A value written by the older v1 format (no hosts in the seal).
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from('blind-env:v1:v1:TOKEN'));
  const ct = Buffer.concat([c.update('old-value-123'), c.final()]);
  const legacy = 'enc:v1:' + Buffer.concat([nonce, c.getAuthTag(), ct]).toString('base64url');
  assert.equal(open(key, 'v1', 'TOKEN', legacy, ['anything.com']), 'old-value-123');
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
  assert.ok(text.includes('DB_PASSWORD=enc:v2:'));
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

test('vault: fingerprints are stable per key but differ between keys with the same value', () => {
  const vault = Vault.init(tmpProject());
  vault.set('A_KEY', 'same-value-123');
  vault.set('B_KEY', 'same-value-123');
  const a = vault.inspect('A_KEY').fingerprint;
  assert.notEqual(a, vault.inspect('B_KEY').fingerprint);
  assert.equal(Vault.open(path.dirname(vault.file)).inspect('A_KEY').fingerprint, a);
  vault.set('A_KEY', 'other-value-456');
  assert.notEqual(vault.inspect('A_KEY').fingerprint, a);
});

test('password window text points out newly added sites', async () => {
  const { describeKeyForPrompt } = await import('../src/prompt.js');
  const text = describeKeyForPrompt({ allow: ['a.com', 'evil.com'], previousAllow: ['a.com'], replacing: true });
  assert.match(text, /NEW: evil\.com/);
  assert.ok(!/NEW: a\.com/.test(text));
  assert.ok(!/NEW/.test(describeKeyForPrompt({ allow: ['a.com'], previousAllow: ['a.com'], replacing: true })));
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
  assert.equal(out, 'a ***PW*** b ***PW:base64*** c ***PW:hex*** d ***PW:url-encoded*** e');
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

test('redact: a value inside a key name is not masked there (that would give it away)', () => {
  const r = createRedactor({ testCloadSesh: 'test' });
  assert.equal(r.all('echo $testCloadSesh'), 'echo $testCloadSesh');
  assert.equal(r.all('testCloadSesh=test'), 'testCloadSesh=***testCloadSesh***');
  assert.deepEqual(r.hits(), {});
  // Same rule on a stream split inside the name.
  const s = createRedactor({ testCloadSesh: 'test' });
  assert.equal(s.push('$testClo') + s.push('adSesh test') + s.flush(), '$testCloadSesh ***testCloadSesh***');
});

test('vault: values shorter than 8 characters are refused unless allowed', () => {
  const vault = Vault.init(tmpProject());
  assert.throws(() => vault.set('PIN', '1234'), (e) => e.code === 'SHORT_VALUE' && !e.message.includes('1234'));
  assert.equal(vault.has('PIN'), false);
  vault.set('PIN', '1234', { allowShort: true });
  assert.equal(vault.reveal(['PIN']).PIN, '1234');
});

test('redact stream: a pause in the middle of a secret does not let the first part out', async () => {
  const { createStreamRedactor } = await import('../src/redact.js');
  const secret = 'sk-live-ABCDEFGH1234';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let out = '';
  const s = createStreamRedactor({ KEY: secret }, (t) => (out += t), 10);
  s.write(Buffer.from('token: ' + secret.slice(0, 9)));
  await wait(50); // longer than the idle time
  assert.equal(out, 'token: ', 'the start of the secret must still be held back');
  s.write(Buffer.from(secret.slice(9) + ' done\n'));
  s.end();
  assert.equal(out, 'token: ***KEY*** done\n');

  // A prompt that is not the start of a secret is shown while the program waits.
  let shown = '';
  const p = createStreamRedactor({ KEY: secret }, (t) => (shown += t), 10);
  p.write(Buffer.from('Password: '));
  await wait(50);
  assert.equal(shown, 'Password: ');
  p.end();
});

test('redact: very short values are left alone', () => {
  assert.equal(createRedactor({ PIN: 'abc' }).all('abc abcabc'), 'abc abcabc');
});
