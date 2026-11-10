// Run a command with secrets in its environment, redacting its output.

import { spawn } from 'node:child_process';
import { createRedactor, createStreamRedactor } from './redact.js';

function quoteForCmd(arg) {
  if (arg !== '' && /^[A-Za-z0-9_\-./:=\\@+,]+$/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

function spawnArgv(argv, options) {
  if (process.platform === 'win32') {
    // Windows needs a shell to run .cmd/.bat launchers such as npm or npx.
    return spawn(argv.map(quoteForCmd).join(' '), { ...options, shell: true });
  }
  return spawn(argv[0], argv.slice(1), options);
}

/**
 * For the command line: output is streamed to the terminal as it arrives.
 * Resolves with the exit code.
 */
export function runStreaming(argv, secrets, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnArgv(argv, {
      cwd,
      env: { ...process.env, ...secrets },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const out = createStreamRedactor(secrets, (t) => process.stdout.write(t));
    const err = createStreamRedactor(secrets, (t) => process.stderr.write(t));
    child.stdout.on('data', (c) => out.write(c));
    child.stderr.on('data', (c) => err.write(c));
    child.on('error', (e) => reject(new Error(`cannot start "${argv[0]}": ${e.message}`)));
    child.on('close', (code, signal) => {
      out.end();
      err.end();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

/**
 * For the MCP server: runs a shell command and returns its (redacted) output
 * as one string, with a size cap and a timeout.
 */
export function runCaptured(command, secrets, { cwd, timeoutMs = 120_000, maxChars = 100_000 } = {}) {
  return new Promise((resolve) => {
    let raw = '';
    let truncated = false;
    let timedOut = false;

    const child = spawn(command, {
      cwd,
      env: { ...process.env, ...secrets },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const collect = (chunk) => {
      if (raw.length < maxChars * 4) raw += chunk.toString('utf8');
      else truncated = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const done = (exitCode, startError) => {
      clearTimeout(timer);
      // Redact first, cut second: cutting first could slice a secret in half
      // and let the remaining half through.
      let output = createRedactor(secrets).finish(raw);
      if (output.length > maxChars) {
        output = output.slice(0, maxChars);
        truncated = true;
      }
      resolve({ exitCode, output, truncated, timedOut, startError });
    };

    child.on('error', (e) => done(null, e.message));
    child.on('close', (code) => done(code));
  });
}
