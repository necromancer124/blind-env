// End-to-end tests: the real command-line tool and the real MCP server.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const SECRET = 'sk-test-9f8e7d6c5b4a';
const OTHER = 'second-secret-value';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'facedown-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'facedown-proj-'));
// No windows during tests: anything that needs the user's OK is refused.
const env = { ...process.env, FACEDOWN_HOME: home, FACEDOWN_NO_WINDOW: '1' };
delete env.FACEDOWN_FILE;
delete env.FACEDOWN_DIR;
delete env.CLAUDE_PROJECT_DIR;

function cli(args, input) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: project, env, input, encoding: 'utf8' });
}

let server;
let baseUrl;
let lastRequest;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastRequest = { headers: req.headers, body };
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
        return res.end();
      }
      // Echo everything back, as a careless API might.
      res.setHeader('x-echo-auth', req.headers.authorization ?? '');
      res.end(JSON.stringify({ auth: req.headers.authorization, body }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  fs.writeFileSync(
    path.join(project, 'child.js'),
    `const v = process.env.API_KEY;
console.log('plain=' + v);
console.log('b64=' + Buffer.from(v).toString('base64'));
console.error('err=' + v);
console.log('other=' + (process.env.OTHER_KEY ?? 'unset'));
process.exit(7);
`
  );
});

after(() => server.close());

test('cli: set (stdin), list, and the vault file hides the value', () => {
  let r = cli(['set', 'API_KEY', '--desc', 'test api key', '--allow', '127.0.0.1', '--stdin'], SECRET + '\n');
  assert.equal(r.status, 0, r.stderr);
  r = cli(['set', 'OTHER_KEY', '--stdin'], OTHER);
  assert.equal(r.status, 0, r.stderr);

  const file = fs.readFileSync(path.join(project, '.env.facedown'), 'utf8');
  assert.ok(file.includes('API_KEY=enc:v2:'));
  assert.ok(!file.includes(SECRET));

  r = cli(['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /API_KEY\s+test api key\s+\[allowed: 127\.0\.0\.1\]/);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
});

test('a vault made before the rename (blind-env, .aienv, ~/.blind-env) still opens', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'facedown-legacyhome-'));
  const legacyProject = fs.mkdtempSync(path.join(os.tmpdir(), 'facedown-legacyproj-'));
  const legacyFile = path.join(legacyProject, '.aienv');

  // Make a vault whose key sits where blind-env kept it, then give the file
  // blind-env's header, as if blind-env had written it.
  const make = spawnSync(process.execPath, [CLI, 'set', 'OLD_KEY', '--stdin'], {
    cwd: legacyProject,
    env: { ...env, FACEDOWN_HOME: path.join(fakeHome, '.blind-env'), FACEDOWN_FILE: legacyFile },
    input: 'old-vault-value-12345',
    encoding: 'utf8',
  });
  assert.equal(make.status, 0, make.stderr);
  fs.writeFileSync(legacyFile, fs.readFileSync(legacyFile, 'utf8').replace('# facedown vault', '# blind-env vault'));

  // Now use it like a fresh facedown install would: default home, no file override.
  const plainEnv = { ...env, USERPROFILE: fakeHome, HOME: fakeHome };
  delete plainEnv.FACEDOWN_HOME;
  delete plainEnv.FACEDOWN_FILE;
  const r = spawnSync(process.execPath, [CLI, 'check'], { cwd: legacyProject, env: plainEnv, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OLD_KEY\s+ok\s+length 21/);
  // The key was copied to the new place.
  const vaultId = /id=([A-Za-z0-9_-]+)/.exec(fs.readFileSync(legacyFile, 'utf8'))[1];
  assert.ok(fs.existsSync(path.join(fakeHome, '.facedown', 'keys', `${vaultId}.key`)));
});

test('cli: a short value is refused unless --allow-short is given', () => {
  let r = cli(['set', 'SHORT_KEY', '--stdin'], 'abc12');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only 5 characters/);
  assert.ok(!r.stderr.includes('abc12'));
  r = cli(['set', 'SHORT_KEY', '--stdin', '--allow-short'], 'abc12');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Warning: SHORT_KEY is short/);
  assert.match(cli(['check', 'SHORT_KEY']).stdout, /length 5 .*\(short: cannot be hidden safely\)/);
  // Deleting needs the user's OK; with nobody to confirm, nothing is deleted.
  const rm = cli(['rm', 'SHORT_KEY']);
  assert.equal(rm.status, 1);
  assert.match(rm.stderr, /Cancelled/);
  assert.match(cli(['list']).stdout, /SHORT_KEY/);
});

test('cli: a value on the command line is refused', () => {
  const r = cli(['set', 'OOPS', 'my-value']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /do not put the value on the command line/);
  assert.ok(!cli(['list']).stdout.includes('OOPS'));
});

test('cli: run passes secrets to the program and hides them in its output', () => {
  const r = cli(['run', '--keys', 'API_KEY', '--', process.execPath, 'child.js']);
  assert.equal(r.status, 7, r.stderr);
  assert.match(r.stdout, /plain=\*\*\*API_KEY\*\*\*/);
  assert.match(r.stdout, /b64=\*\*\*API_KEY:base64\*\*\*/);
  assert.match(r.stderr, /err=\*\*\*API_KEY\*\*\*/);
  assert.match(r.stdout, /other=unset/); // only the keys asked for are passed
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
  // Printing is allowed: a short note, and the program's own exit code is kept.
  assert.match(r.stderr, /note: hid the value of API_KEY \(3x\)/);
});

test('cli: a secret printed in two parts with a pause is still hidden', () => {
  const code =
    'const v = process.env.API_KEY; process.stdout.write(v.slice(0, 11));' +
    ' setTimeout(() => console.log(v.slice(11)), 300);';
  const r = cli(['run', '--', process.execPath, '-e', code]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '***API_KEY***');
  assert.ok(!r.stdout.includes(SECRET.slice(0, 11)));
});

test('cli: --strict turns a printed secret into a failed run; clean programs are untouched', () => {
  fs.writeFileSync(path.join(project, 'leak.js'), "console.log('token is ' + process.env.API_KEY);\n");
  fs.writeFileSync(
    path.join(project, 'clean.js'),
    "console.log('key is set: ' + Boolean(process.env.API_KEY) + ', length ' + process.env.API_KEY.length);\n"
  );

  let r = cli(['run', '--strict', '--', process.execPath, 'leak.js']);
  assert.equal(r.status, 97, r.stderr);
  assert.match(r.stdout, /token is \*\*\*API_KEY\*\*\*/);
  assert.match(r.stderr, /ERROR: the command printed the value of API_KEY \(1x\)/);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));

  r = spawnSync(process.execPath, [CLI, 'run', '--', process.execPath, 'leak.js'], {
    cwd: project,
    env: { ...env, FACEDOWN_STRICT: '1' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 97, r.stderr);

  r = cli(['run', '--strict', '--', process.execPath, 'clean.js']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `key is set: true, length ${SECRET.length}`);
  assert.equal(r.stderr, '');
});

test('cli: --quiet drops the note; check shows length and fingerprint, never the value', () => {
  let r = cli(['run', '--quiet', '--', process.execPath, 'leak.js']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /token is \*\*\*API_KEY\*\*\*/);
  assert.equal(r.stderr, '');

  r = cli(['check']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.match(lines[0], new RegExp(`^API_KEY\\s+ok\\s+length ${SECRET.length}  fingerprint [0-9a-f]{8}$`));
  assert.match(lines[1], new RegExp(`^OTHER_KEY\\s+ok\\s+length ${OTHER.length}  fingerprint [0-9a-f]{8}$`));
  assert.notEqual(lines[0].slice(-8), lines[1].slice(-8));
  assert.equal(cli(['check', 'API_KEY']).stdout.trim().slice(-8), lines[0].slice(-8)); // stable
  assert.ok(!r.stdout.includes(SECRET));
  assert.equal(cli(['check', 'NOT_A_KEY']).status, 1);
});

test('cli: run with a key that does not exist fails before starting anything', () => {
  const r = cli(['run', '--keys', 'NOT_A_KEY', '--', process.execPath, 'clean.js']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no key named NOT_A_KEY/);
  assert.equal(r.stdout, '');
});

test('vault file: tells AI agents the rules, and a hand-edited value is rejected', () => {
  const file = path.join(project, '.env.facedown');
  const original = fs.readFileSync(file, 'utf8');
  assert.match(original, /AI agents: use these keys by NAME/);

  // Swap the two encrypted values: each one must refuse to open under the other name.
  const a = /^API_KEY=(.*)$/m.exec(original)[1];
  const b = /^OTHER_KEY=(.*)$/m.exec(original)[1];
  fs.writeFileSync(file, original.replace(a, 'TEMP').replace(b, a).replace('TEMP', b));
  const r = cli(['run', '--', process.execPath, 'clean.js']);
  fs.writeFileSync(file, original);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot decrypt/);
});

test('cli: allow needs confirmation to add a site, not to keep or remove one', () => {
  // Adding a site with nobody to confirm it: refused, nothing changes.
  let r = cli(['allow', 'OTHER_KEY', 'example.com']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Cancelled/);
  assert.ok(!/OTHER_KEY.*allowed/.test(cli(['list']).stdout));

  // Same list again: no new site, no confirmation needed.
  r = cli(['allow', 'API_KEY', '127.0.0.1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /API_KEY may be sent to: 127\.0\.0\.1/);

  r = cli(['allow', 'OTHER_KEY', '--clear']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(cli(['rm', 'NOPE']).status, 1);
});

test('vault file: adding a site by hand breaks that key instead of allowing it', () => {
  const file = path.join(project, '.env.facedown');
  const original = fs.readFileSync(file, 'utf8');
  assert.match(original, /^API_KEY=enc:v2:/m);
  fs.writeFileSync(file, original.replace('# @allow 127.0.0.1', '# @allow 127.0.0.1,evil.example'));
  const r = cli(['check', 'API_KEY']);
  const run = cli(['run', '--keys', 'API_KEY', '--', process.execPath, '-e', '1']);
  fs.writeFileSync(file, original);
  assert.match(r.stdout, /API_KEY\s+FAILED\s+cannot decrypt/);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /changed by hand/);
});

test('mcp (as plugin): never uses its own install folder, uses the project instead', () => {
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'facedown-plugin-'));
  const ask = (extraEnv) => {
    const input =
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_keys', arguments: {} } }) + '\n';
    const r = spawnSync(process.execPath, [CLI, 'mcp'], {
      cwd: pluginRoot,
      env: { ...env, FACEDOWN_SKIP_DIR: pluginRoot, ...extraEnv },
      input,
      encoding: 'utf8',
    });
    const reply = r.stdout.trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.id === 2);
    return reply.result.content[0].text;
  };
  assert.equal(ask({ CLAUDE_PROJECT_DIR: project }).split('\n')[0], `Vault: ${path.join(project, '.env.facedown')}`);
  assert.match(ask({}), /cannot tell which project folder to use/);
  assert.ok(!fs.existsSync(path.join(pluginRoot, '.env.facedown')));
});

test('mcp: bad messages get an error and never stop the server', () => {
  const lines = [
    'null',
    '5',
    '[]',
    'not json',
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'constructor' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: null }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_keys', arguments: 'oops' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }),
  ];
  const r = spawnSync(process.execPath, [CLI, 'mcp'], {
    cwd: project,
    env,
    input: lines.join('\n') + '\n',
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr);
  const replies = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(replies.filter((m) => m.id === null && m.error).length, 4);
  assert.ok(replies.find((m) => m.id === 1).error);
  assert.ok(replies.find((m) => m.id === 2).error);
  assert.match(replies.find((m) => m.id === 3).result.content[0].text, /^Vault: /);
  assert.deepEqual(replies.find((m) => m.id === 4).result, {});
});

test('mcp: handshake, tools, run_with_secrets, http_request', async () => {
  // CLAUDE_PROJECT_DIR points at a different, empty folder (like a session
  // that started somewhere else). The server must still use the project vault.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'facedown-elsewhere-'));
  const child = spawn(process.execPath, [CLI, 'mcp'], {
    cwd: project,
    env: { ...env, CLAUDE_PROJECT_DIR: elsewhere },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const waiting = new Map();
  let buffer = '';
  let everything = '';
  child.stdout.on('data', (chunk) => {
    everything += chunk;
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const call = async (name, args) => {
    const res = await request('tools/call', { name, arguments: args });
    return { text: res.result.content[0].text, isError: Boolean(res.result.isError) };
  };

  try {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'facedown');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const tools = await request('tools/list', {});
    assert.deepEqual(tools.result.tools.map((t) => t.name).sort(), ['add_key', 'allow_hosts', 'http_request', 'list_keys', 'remove_key', 'run_with_secrets']);
    const runTool = tools.result.tools.find((t) => t.name === 'run_with_secrets');
    assert.match(runTool.description, process.platform === 'win32' ? /cmd\.exe.*%NAME%/ : /\/bin\/sh/);

    const list = await call('list_keys', {});
    assert.equal(list.text.split('\n')[0], `Vault: ${path.join(project, '.env.facedown')}`);
    assert.match(list.text, /API_KEY\n {2}description: test api key\n {2}allowed hosts: 127\.0\.0\.1/);
    assert.ok(!fs.existsSync(path.join(elsewhere, '.env.facedown')));

    const run = await call('run_with_secrets', { command: `"${process.execPath}" child.js`, keys: ['API_KEY'] });
    assert.match(run.text, /^facedown: note: hid the value of API_KEY \(3x\).*\nexit code 7\n/);
    assert.match(run.text, /plain=\*\*\*API_KEY\*\*\*/);
    assert.match(run.text, /b64=\*\*\*API_KEY:base64\*\*\*/);
    assert.match(run.text, /err=\*\*\*API_KEY\*\*\*/);

    const missing = await call('run_with_secrets', { command: 'echo hi', keys: ['NOT_A_KEY'] });
    assert.equal(missing.isError, true);

    // The server really receives the secret; the AI only sees the mask.
    const ok = await call('http_request', {
      url: `${baseUrl}/echo`,
      method: 'POST',
      headers: { Authorization: 'Bearer {{API_KEY}}' },
      body: '{"token":"{{ API_KEY }}"}',
    });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(lastRequest.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(lastRequest.body, `{"token":"${SECRET}"}`);
    assert.match(ok.text, /^facedown: note: hid the value of API_KEY \(\d+x\).*\nHTTP 200/);
    assert.match(ok.text, /Bearer \*\*\*API_KEY\*\*\*/);
    assert.match(ok.text, /x-echo-auth: Bearer \*\*\*API_KEY\*\*\*/);

    // OTHER_KEY has no allowed hosts, so it may not be sent anywhere.
    lastRequest = null;
    const blocked = await call('http_request', { url: `${baseUrl}/echo`, headers: { 'X-Key': '{{OTHER_KEY}}' } });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /BLOCKED: OTHER_KEY may not be sent to 127\.0\.0\.1/);
    assert.equal(lastRequest, null);

    const inUrl = await call('http_request', { url: `${baseUrl}/echo?key={{API_KEY}}` });
    assert.match(inUrl.text, /not allowed in the URL/);

    const plainHttp = await call('http_request', { url: 'http://example.com/' });
    assert.match(plainHttp.text, /only https/);

    const redirect = await call('http_request', { url: `${baseUrl}/redirect`, headers: { Authorization: 'Bearer {{API_KEY}}' } });
    assert.match(redirect.text, /^HTTP 302/);
    assert.match(redirect.text, /Redirects are not followed/);

    const badName = await call('add_key', { name: 'bad name' });
    assert.equal(badName.isError, true);

    // allow_hosts: adding needs the user (refused here), removing does not.
    const addSite = await call('allow_hosts', { name: 'API_KEY', add: ['evil.example'] });
    assert.match(addSite.text, /^Not changed/);
    const blockedEvil = await call('http_request', { url: 'https://evil.example/', headers: { A: '{{API_KEY}}' } });
    assert.match(blockedEvil.text, /BLOCKED/);
    const removeSite = await call('allow_hosts', { name: 'API_KEY', remove: ['127.0.0.1'] });
    assert.match(removeSite.text, /may not be sent to any site now/);
    const afterRemove = await call('http_request', { url: `${baseUrl}/echo`, headers: { A: '{{API_KEY}}' } });
    assert.match(afterRemove.text, /BLOCKED/);

    const del = await call('remove_key', { name: 'OTHER_KEY' });
    assert.match(del.text, /^Not deleted/);
    assert.match((await call('list_keys', {})).text, /OTHER_KEY/);
    assert.equal((await call('remove_key', { name: 'NOT_A_KEY' })).isError, true);

    const unknown = await request('tools/call', { name: 'get_secret', arguments: {} });
    assert.ok(unknown.error);

    assert.ok(!everything.includes(SECRET), 'the secret must never appear in anything sent to the AI');
    assert.ok(!everything.includes(Buffer.from(SECRET).toString('base64')));
  } finally {
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
  }
});
