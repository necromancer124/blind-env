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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-env-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-env-proj-'));
const env = { ...process.env, BLIND_ENV_HOME: home };
delete env.BLIND_ENV_FILE;
delete env.BLIND_ENV_DIR;
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

  const file = fs.readFileSync(path.join(project, '.aienv'), 'utf8');
  assert.ok(file.includes('API_KEY=enc:v1:'));
  assert.ok(!file.includes(SECRET));

  r = cli(['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /API_KEY\s+test api key\s+\[allowed: 127\.0\.0\.1\]/);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
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
  assert.match(r.stdout, /b64=\*\*\*API_KEY\*\*\*/);
  assert.match(r.stderr, /err=\*\*\*API_KEY\*\*\*/);
  assert.match(r.stdout, /other=unset/); // only the keys asked for are passed
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
});

test('cli: allow and rm', () => {
  let r = cli(['allow', 'OTHER_KEY', 'example.com', '*.example.org']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(cli(['list']).stdout, /OTHER_KEY.*\[allowed: example\.com, \*\.example\.org\]/);
  r = cli(['allow', 'OTHER_KEY', '--clear']);
  assert.equal(r.status, 0, r.stderr);
  r = cli(['rm', 'NOPE']);
  assert.equal(r.status, 1);
});

test('mcp: handshake, tools, run_with_secrets, http_request', async () => {
  const child = spawn(process.execPath, [CLI, 'mcp'], { cwd: project, env, stdio: ['pipe', 'pipe', 'inherit'] });
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
    assert.equal(init.result.serverInfo.name, 'blind-env');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const tools = await request('tools/list', {});
    assert.deepEqual(tools.result.tools.map((t) => t.name).sort(), ['add_key', 'http_request', 'list_keys', 'run_with_secrets']);

    const list = await call('list_keys', {});
    assert.match(list.text, /API_KEY\n {2}description: test api key\n {2}allowed hosts: 127\.0\.0\.1/);

    const run = await call('run_with_secrets', { command: `"${process.execPath}" child.js`, keys: ['API_KEY'] });
    assert.match(run.text, /^exit code 7/);
    assert.match(run.text, /plain=\*\*\*API_KEY\*\*\*/);
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
    assert.match(ok.text, /^HTTP 200/);
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

    const unknown = await request('tools/call', { name: 'get_secret', arguments: {} });
    assert.ok(unknown.error);

    assert.ok(!everything.includes(SECRET), 'the secret must never appear in anything sent to the AI');
    assert.ok(!everything.includes(Buffer.from(SECRET).toString('base64')));
  } finally {
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
  }
});
