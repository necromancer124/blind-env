// MCP server (stdio). Gives an AI agent tools that take key NAMES and never
// return key values.

import path from 'node:path';
import readline from 'node:readline';
import { httpRequest } from './http.js';
import { PromptCancelled, canPromptInWindow, describeKeyForPrompt, promptWindow } from './prompt.js';
import { MIN_REDACT_LENGTH, leakMessage } from './redact.js';
import { runCaptured } from './run.js';
import { Vault } from './vault.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS =
  'blind-env keeps the user\'s secrets (passwords, tokens, API keys). You can see key NAMES and use them, ' +
  'but never the values. Use list_keys to see what exists. In code, read secrets from environment variables ' +
  'named after the key, and run that code with run_with_secrets. For web APIs use http_request with {{KEY_NAME}} ' +
  'placeholders. To add a secret, call add_key: the user types the value into a private window. ' +
  'Never ask the user to paste a secret into the chat, and never try to print, decode or read a secret value.';

const TOOLS = [
  {
    name: 'list_keys',
    description:
      'List the secrets in the blind-env vault: name, description and the hosts each one may be sent to. Values are never returned.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_key',
    description:
      'Add (or replace) a secret. Opens a private password window on the user\'s screen where THEY type the value; ' +
      'you never see it. Do not ask the user to type the value in chat. Waits until the user saves or cancels.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Key name, like GITHUB_TOKEN' },
        description: { type: 'string', description: 'What the secret is for' },
        allow: {
          type: 'array',
          items: { type: 'string' },
          description: 'Hosts this key may be sent to with http_request, like ["api.github.com"]. Shown to the user.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'run_with_secrets',
    description:
      'Run a shell command with the named secrets set as environment variables (same names as the keys). ' +
      'Returns the exit code and output; secret values in the output are replaced with ***NAME***.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Names of the keys the command needs' },
        cwd: { type: 'string', description: 'Folder to run in (default: the project folder)' },
        timeout_seconds: { type: 'number', description: 'Default 120' },
      },
      required: ['command', 'keys'],
    },
  },
  {
    name: 'http_request',
    description:
      'Make an HTTPS request with secrets filled in. Write {{KEY_NAME}} in a header value or in the body, for example ' +
      '{"Authorization": "Bearer {{GITHUB_TOKEN}}"}. A key is only sent to hosts on its allow list. ' +
      'Redirects are not followed. Secret values in the response are hidden.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string', description: 'Default GET' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string' },
      },
      required: ['url'],
    },
  },
];

export async function serveMcp() {
  const startDir = process.env.BLIND_ENV_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const keyCache = new Map(); // vault id -> master key, so we unlock once per session
  let promptQueue = Promise.resolve();

  function withKeyCache(vault) {
    if (keyCache.has(vault.id)) vault._key = keyCache.get(vault.id);
    return vault;
  }
  function remember(vault) {
    if (vault._key) keyCache.set(vault.id, vault._key);
  }

  const handlers = {
    async list_keys() {
      const file = Vault.find(startDir);
      if (!file) return 'There is no vault yet. Call add_key to create one and add the first secret.';
      const keys = Vault.load(file).list();
      if (!keys.length) return 'The vault is empty. Call add_key to add a secret.';
      return keys
        .map((k) => {
          const allow = k.allow.length ? k.allow.join(', ') : 'none (cannot be used with http_request)';
          return `${k.name}\n  description: ${k.description || '-'}\n  allowed hosts: ${allow}`;
        })
        .join('\n');
    },

    async add_key({ name, description, allow }) {
      // Check the name and hosts before bothering the user.
      Vault.check(name, allow);
      if (!canPromptInWindow()) {
        return `I cannot open a password window on this system. Ask the user to run this in their own terminal:\n  blind-env set ${name}`;
      }
      // One window at a time.
      const turn = promptQueue.then(async () => {
        const vault = withKeyCache(Vault.openOrInit(startDir));
        const old = vault.entries.get(name);
        const value = await promptWindow(
          name,
          describeKeyForPrompt({
            description: description ?? old?.description,
            allow: allow ?? old?.allow,
            replacing: Boolean(old),
          }),
          180
        );
        const fresh = withKeyCache(Vault.load(vault.file));
        fresh.set(name, value, { description, allow });
        remember(fresh);
        const warn =
          value.length < MIN_REDACT_LENGTH
            ? ` Warning: it is shorter than ${MIN_REDACT_LENGTH} characters, so it cannot be hidden in program output.`
            : '';
        return `Saved ${name}.${warn}`;
      });
      promptQueue = turn.catch(() => {});
      try {
        return await turn;
      } catch (err) {
        if (err instanceof PromptCancelled) return `Not saved: ${err.message}.`;
        throw err;
      }
    },

    async run_with_secrets({ command, keys, cwd, timeout_seconds }) {
      if (typeof command !== 'string' || !command.trim()) throw new Error('command is required');
      if (!Array.isArray(keys) || !keys.length) throw new Error('keys must list at least one key name');
      const vault = withKeyCache(Vault.open(startDir));
      const secrets = vault.reveal(keys);
      remember(vault);
      const result = await runCaptured(command, secrets, {
        cwd: cwd ? path.resolve(startDir, cwd) : startDir,
        timeoutMs: Math.min(Math.max(Number(timeout_seconds) || 120, 1), 3600) * 1000,
      });
      if (result.startError) throw new Error(`could not start the command: ${result.startError}`);
      const status = result.timedOut ? 'timed out (stopped)' : `exit code ${result.exitCode}`;
      const cut = result.truncated ? '\n[output cut: too long]' : '';
      const leak = leakMessage(result.leaks);
      return `${leak ? `${leak}\n` : ''}${status}\n--- output ---\n${result.output}${cut}`;
    },

    async http_request(args) {
      if (typeof args.url !== 'string') throw new Error('url is required');
      const vault = withKeyCache(Vault.open(startDir));
      const res = await httpRequest(vault, args);
      remember(vault);
      const headers = Object.entries(res.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
      const cut = res.truncated ? '\n[body cut: too long]' : '';
      const note = res.note ? `\n[${res.note}]` : '';
      return `HTTP ${res.status}${note}\n${headers}\n\n${res.body}${cut}`;
    },
  };

  const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

  async function handle(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    const reply = (result) => isRequest && send({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => isRequest && send({ jsonrpc: '2.0', id, error: { code, message } });

    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'blind-env', version: '0.1.0' },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const handler = handlers[params?.name];
        if (!handler) return fail(-32602, `unknown tool: ${params?.name}`);
        try {
          const text = await handler(params.arguments ?? {});
          return reply({ content: [{ type: 'text', text }] });
        } catch (err) {
          return reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
        }
      }
      default:
        if (isRequest) fail(-32601, `method not found: ${method}`);
    }
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    const p = handle(msg).finally(() => pending.delete(p));
    pending.add(p);
  });
  await new Promise((resolve) => rl.on('close', resolve));
  await Promise.all(pending);
}
