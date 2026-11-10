#!/usr/bin/env node
import { FILE_NAME } from './format.js';
import { serveMcp } from './mcp.js';
import {
  PromptCancelled,
  canPromptInTerminal,
  canPromptInWindow,
  confirmDelete,
  confirmNewHosts,
  describeKeyForPrompt,
  promptTerminal,
  promptWindow,
} from './prompt.js';
import { MIN_REDACT_LENGTH, describeHits, leakMessage } from './redact.js';
import { runStreaming } from './run.js';
import { MIN_VALUE_LENGTH, Vault } from './vault.js';

const VERSION = '0.1.0';
const LEAK_EXIT_CODE = 97;

const HELP = `blind-env ${VERSION} - a .env file for AI agents

The AI can see the NAMES of your secrets and use them, but never the values.

Usage:
  blind-env init                         create a ${FILE_NAME} vault in this folder
  blind-env set NAME [options]           add or replace a secret (hidden input)
      --desc "text"                      what the secret is for (the AI can read this)
      --allow host1,host2                hosts it may be sent to in web requests
      --stdin                            read the value from stdin instead of asking
      --allow-short                      accept a value shorter than 8 characters
  blind-env list [--json]                show names, notes and allowed hosts
  blind-env rm NAME                      delete a secret (asks you to confirm)
  blind-env allow NAME host [host...]    set the hosts a secret may be sent to
                                         (adding a host asks you to confirm)
  blind-env allow NAME --clear           allow no hosts
  blind-env check [NAME...]              test that secrets decrypt; shows length
                                         and a fingerprint, never the value
  blind-env run [--keys A,B] [--strict] [--quiet] -- command
                                         run a command with secrets as env vars.
                                         Printing a secret is fine for logs: the
                                         output shows ***NAME*** instead of the
                                         value, plus a one-line note (--quiet
                                         drops the note). With --strict (or
                                         BLIND_ENV_STRICT=1) printing a secret
                                         fails the run with exit code 97.
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
  const allowShort = takeFlag(args, '--allow-short');
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

  vault.set(name, value, { description, allow, allowShort });
  console.log(`Saved ${name}.`);
  if (value.length < MIN_REDACT_LENGTH) {
    console.error(`Warning: ${name} is shorter than ${MIN_REDACT_LENGTH} characters, so it is not hidden in program output at all.`);
  } else if (value.length < MIN_VALUE_LENGTH) {
    console.error(`Warning: ${name} is short, so where it is hidden in output, the hiding can give it away.`);
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
  const strict = takeFlag(options, '--strict') || process.env.BLIND_ENV_STRICT === '1';
  const quiet = takeFlag(options, '--quiet');
  if (options.length) throw new Error(`unknown option ${options[0]}`);

  const vault = Vault.open();
  const secrets = vault.reveal(keysText ? keysText.split(',').filter(Boolean) : undefined);
  const { code, leaks } = await runStreaming(argv, secrets);
  process.exitCode = code;
  const message = leakMessage(leaks);
  if (message && strict) {
    console.error(
      `blind-env: ERROR: the command printed the value of ${describeHits(leaks)}. ` +
        `It was hidden, but --strict fails the run (exit code ${LEAK_EXIT_CODE}).`
    );
    process.exitCode = LEAK_EXIT_CODE;
  } else if (message && !quiet) {
    console.error(message);
  }
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
      const name = args[0];
      if (!name) throw new Error('usage: blind-env rm NAME');
      const vault = Vault.open();
      if (!vault.has(name)) throw new Error(`no key named ${name}`);
      // Deleting cannot be undone, so it always needs the user's OK.
      if (canPromptInWindow()) console.error('A confirmation window opened on your screen.');
      const ok = await confirmDelete(name, { description: vault.entries.get(name).description });
      if (!ok) throw new PromptCancelled(`${name} was not deleted`);
      Vault.open().remove(name);
      console.log(`Removed ${name}.`);
      break;
    }
    case 'allow': {
      const clear = takeFlag(args, '--clear');
      const [name, ...hosts] = args;
      if (!name || (!clear && !hosts.length)) throw new Error('usage: blind-env allow NAME host [host...]');
      const vault = Vault.open();
      if (!vault.has(name)) throw new Error(`no key named ${name}`);
      const wanted = clear ? [] : hosts.flatMap((h) => h.split(','));
      const adding = vault.newHosts(name, wanted);
      if (adding.length) {
        // Adding a site always needs the user's OK, even when an AI runs this.
        if (canPromptInWindow()) console.error('A confirmation window opened on your screen.');
        const ok = await confirmNewHosts(name, adding, { description: vault.entries.get(name).description });
        if (!ok) throw new PromptCancelled(`${adding.join(', ')} not allowed, nothing changed`);
      }
      vault.setAllow(name, wanted);
      const now = vault.trustedAllow(name);
      console.log(now.length ? `${name} may be sent to: ${now.join(', ')}` : `${name} may not be sent to any host.`);
      break;
    }
    case 'check': {
      const vault = Vault.open();
      const names = args.length ? args : [...vault.entries.keys()];
      if (!names.length) console.log('The vault is empty.');
      const width = Math.max(0, ...names.map((n) => n.length));
      for (const name of names) {
        try {
          const info = vault.inspect(name);
          const short = info.length < MIN_VALUE_LENGTH ? '  (short: cannot be hidden safely)' : '';
          console.log(`${name.padEnd(width)}  ok      length ${info.length}  fingerprint ${info.fingerprint}${short}`);
        } catch (err) {
          console.log(`${name.padEnd(width)}  FAILED  ${err.message}`);
          process.exitCode = 1;
        }
      }
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
