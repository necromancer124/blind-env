#!/usr/bin/env node
import { FILE_NAME } from './format.js';
import { serveMcp } from './mcp.js';
import {
  PromptCancelled,
  canPromptInTerminal,
  canPromptInWindow,
  describeKeyForPrompt,
  promptTerminal,
  promptWindow,
} from './prompt.js';
import { MIN_REDACT_LENGTH } from './redact.js';
import { runStreaming } from './run.js';
import { Vault } from './vault.js';

const VERSION = '0.1.0';

const HELP = `blind-env ${VERSION} - a .env file for AI agents

The AI can see the NAMES of your secrets and use them, but never the values.

Usage:
  blind-env init                         create a ${FILE_NAME} vault in this folder
  blind-env set NAME [options]           add or replace a secret (hidden input)
      --desc "text"                      what the secret is for (the AI can read this)
      --allow host1,host2                hosts it may be sent to in web requests
      --stdin                            read the value from stdin instead of asking
  blind-env list [--json]                show names, notes and allowed hosts
  blind-env rm NAME                      delete a secret
  blind-env allow NAME host [host...]    set the hosts a secret may be sent to
  blind-env allow NAME --clear           allow no hosts
  blind-env run [--keys A,B] -- command  run a command with secrets as env vars;
                                         secret values in its output are hidden
  blind-env mcp                          start the MCP server (for AI agents)

There is no command that prints a secret value, on purpose.
`;

function takeOption(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  if (i + 1 >= args.length) throw new Error(`${flag} needs a value`);
  return args.splice(i, 2)[1];
}

function takeFlag(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

async function cmdSet(args) {
  const description = takeOption(args, '--desc');
  const allowText = takeOption(args, '--allow');
  const fromStdin = takeFlag(args, '--stdin');
  const [name, extra] = args;
  if (!name) throw new Error('usage: blind-env set NAME [--desc "text"] [--allow host,host]');
  if (extra !== undefined) {
    throw new Error(
      'do not put the value on the command line (it would be saved in your shell history). ' +
        `Run "blind-env set ${name}" and type it when asked.`
    );
  }
  const allow = allowText === undefined ? undefined : allowText.split(',');

  const existed = Boolean(Vault.find());
  const vault = Vault.openOrInit();
  if (!existed) console.error(`Created ${vault.file}`);

  let value;
  if (fromStdin) {
    value = await readStdin();
  } else if (canPromptInTerminal()) {
    value = await promptTerminal(`Value for ${name} (hidden): `);
  } else if (canPromptInWindow()) {
    console.error(`A password window opened on your screen for ${name}.`);
    const old = vault.entries.get(name);
    value = await promptWindow(
      name,
      describeKeyForPrompt({
        description: description ?? old?.description,
        allow: allow ?? old?.allow,
        replacing: Boolean(old),
      })
    );
  } else {
    throw new Error(`no terminal to ask in. Run "blind-env set ${name}" yourself in a terminal.`);
  }

  vault.set(name, value, { description, allow });
  console.log(`Saved ${name}.`);
  if (value.length < MIN_REDACT_LENGTH) {
    console.error(`Warning: ${name} is shorter than ${MIN_REDACT_LENGTH} characters, so it cannot be hidden in program output.`);
  }
}

function cmdList(args) {
  const keys = Vault.open().list();
  if (takeFlag(args, '--json')) {
    console.log(JSON.stringify(keys, null, 2));
    return;
  }
  if (!keys.length) {
    console.log('The vault is empty. Add a secret with "blind-env set NAME".');
    return;
  }
  const width = Math.max(...keys.map((k) => k.name.length));
  for (const k of keys) {
    const allow = k.allow.length ? `  [allowed: ${k.allow.join(', ')}]` : '';
    console.log(`${k.name.padEnd(width)}  ${k.description || '-'}${allow}`);
  }
}

async function cmdRun(args) {
  const split = args.indexOf('--');
  if (split === -1 || split === args.length - 1) {
    throw new Error('usage: blind-env run [--keys A,B] -- command [args...]');
  }
  const options = args.slice(0, split);
  const argv = args.slice(split + 1);
  const keysText = takeOption(options, '--keys');
  if (options.length) throw new Error(`unknown option ${options[0]}`);

  const vault = Vault.open();
  const secrets = vault.reveal(keysText ? keysText.split(',').filter(Boolean) : undefined);
  process.exitCode = await runStreaming(argv, secrets);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'init': {
      const vault = Vault.init();
      console.log(`Created ${vault.file}`);
      console.log('Add a secret with: blind-env set NAME');
      break;
    }
    case 'set':
      await cmdSet(args);
      break;
    case 'list':
    case 'ls':
      cmdList(args);
      break;
    case 'rm':
    case 'remove': {
      if (!args[0]) throw new Error('usage: blind-env rm NAME');
      Vault.open().remove(args[0]);
      console.log(`Removed ${args[0]}.`);
      break;
    }
    case 'allow': {
      const clear = takeFlag(args, '--clear');
      const [name, ...hosts] = args;
      if (!name || (!clear && !hosts.length)) throw new Error('usage: blind-env allow NAME host [host...]');
      const vault = Vault.open();
      vault.setAllow(name, clear ? [] : hosts.flatMap((h) => h.split(',')));
      const now = vault.entries.get(name).allow;
      console.log(now.length ? `${name} may be sent to: ${now.join(', ')}` : `${name} may not be sent to any host.`);
      break;
    }
    case 'run':
      await cmdRun(args);
      break;
    case 'mcp':
      await serveMcp();
      break;
    case '--version':
    case '-v':
      console.log(VERSION);
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      throw new Error(`unknown command "${command}". Try "blind-env help".`);
  }
}

main().catch((err) => {
  if (err instanceof PromptCancelled) console.error(`Cancelled: ${err.message}.`);
  else console.error(`blind-env: ${err.message}`);
  process.exitCode = 1;
});
