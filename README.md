# blind-env

A `.env` file for AI agents. The AI can see the **names** of your secrets and
**use** them, but it never sees the **values**.

```
You:  /addKey GITHUB_TOKEN token for the GitHub API
      → a private window opens, you type the value there
AI:   ✓ Saved GITHUB_TOKEN.

You:  list my GitHub repos
AI:   ▶ http_request  Authorization: Bearer {{GITHUB_TOKEN}}
      → blind-env fills in the real token, sends the request,
        and hides the token in whatever comes back
```

**Status: v0.1 preview. Windows for now; macOS and Linux are planned.** It
needs Node 20 or newer and has no other dependencies. On macOS and Linux the
command line works but is untested, there is no password window yet (use
`blind-env set NAME` in a terminal), and the key file is protected only by file
permissions instead of the OS keychain.

## How it works

Secrets live in one file in your project, `.aienv`:

```ini
# blind-env vault v1 id=Qm9iX2lk

# @desc token for the GitHub API
# @allow api.github.com
GITHUB_TOKEN=enc:v1:8kZ0…

# @desc Postgres password (local)
DB_PASSWORD=enc:v1:Lw91…
```

- **Names, notes and allowed hosts are plain text.** The AI reads them to know
  what exists.
- **Values are encrypted** (AES-256-GCM). The key is *not* in the project. It
  is in your home folder (`~/.blind-env/keys/`), and on Windows it is locked to
  your Windows account with DPAPI.
- **There is no command that prints a value.** Secrets only ever go to two
  places: the environment of a program you run, or an outgoing web request.
- **Logs show the key name, not the value.** A program may print a secret
  (handy for debugging): it shows up as `***GITHUB_TOKEN***`. The base64, hex
  and URL-encoded forms are caught too and labelled, like
  `***GITHUB_TOKEN:base64***`.
- **Each key has a list of hosts** it may be sent to. A key with no hosts
  cannot be used in web requests at all.

## Install

```bash
git clone https://github.com/necromancer124/blind-env
```
```bash
cd blind-env
```
```bash
npm link
```

## Use it yourself (command line)

```bash
blind-env set GITHUB_TOKEN --desc "token for the GitHub API" --allow api.github.com
```
You are asked for the value with hidden typing. If there is no terminal to ask
in, a small password window opens instead (Windows).

```bash
blind-env list
```
```bash
blind-env run -- node app.js
```
`app.js` reads `process.env.GITHUB_TOKEN` as usual. Add `--keys A,B` to pass
only some keys.

### Debugging: printing a secret is allowed

Your code can log a secret like any other variable. The log shows which key
it was instead of the value, and how it was encoded:

```
[debug] connecting with token ***GITHUB_TOKEN*** | as base64: ***GITHUB_TOKEN:base64***
blind-env: note: hid the value of GITHUB_TOKEN (2x) in the output. Logs show the key name instead of the value.
```

- `--quiet` drops the note line.
- `--strict` treats a printed secret as an error and fails the run with exit
  code 97. Set `BLIND_ENV_STRICT=1` to make every run strict.

To check that a secret is stored and is the value you expect, without seeing
it:

```bash
blind-env check
```
```
GITHUB_TOKEN  ok      length 40  fingerprint 04abe0b8
```

The fingerprint stays the same until the value changes, so you can tell
"still the old token" from "the new one" at a glance. It is made with the
vault key, so it cannot be used to guess the value.

The `.aienv` file also starts with a short note for AI agents: use keys by
name, never print or decode a value.

Other commands: `blind-env rm NAME`, `blind-env allow NAME host…`,
`blind-env allow NAME --clear`, `blind-env help`.

## Use it from an AI agent (MCP server)

`blind-env mcp` is an MCP server. Any agent that speaks MCP can connect to it.
For Claude Code, in your project folder:

```bash
claude mcp add blind-env -- blind-env mcp
```

The agent gets four tools:

| Tool | What it does |
|------|--------------|
| `list_keys` | Which vault file is in use, plus names, descriptions, allowed hosts. Never values. |
| `add_key` | Opens a private window where **you** type the value. |
| `run_with_secrets` | Runs a command with the chosen keys as environment variables (in `cmd.exe` on Windows, so `%NAME%`). Output is cleaned. |
| `http_request` | Sends a web request with `{{KEY_NAME}}` filled in. Only to allowed hosts, HTTPS only, redirects not followed, response cleaned. |

This repo is also laid out as a Claude Code plugin (`.claude-plugin/`), which
adds the `/addKey` and `/keys` commands. If you open this repo itself in Claude
Code, `.mcp.json` and `.claude/commands/` give you the server and both commands
without installing anything.

## What it protects, and what it does not

**It does protect against:**

- secret values ending up in the chat, the AI's memory, transcripts or logs;
- the AI reading secrets from a file in your project;
- a program printing a secret by accident;
- a web page tricking the AI into sending a key to the wrong site through
  `http_request`.

**It does not protect against an AI that has a shell and is trying to steal a
secret.** An agent that can run any command as you can write a program that
scrambles the secret before printing it (so the cleaner misses it), sends it to
a server, or unlocks the key file the same way blind-env does. Nothing running
under your own account can fully stop that.

So think of blind-env as a seat belt, not a vault door: it stops the common,
accidental ways secrets leak to an AI. The strongest setup is an agent that has
**only** the `http_request` tool and no shell. Then the allowed-hosts list is a
real barrier.

Other limits:

- Values must be at least 8 characters. Hiding a short value gives it away
  (`test` masked inside `testing` shows what it is), so shorter ones are
  refused unless you run `blind-env set NAME --allow-short` yourself.
  Key names are never masked, even when a value appears inside one.
- The vault only opens on the computer and account that created it. On a new
  machine, add the secrets again.
- The password window exists on Windows only. On macOS and Linux use
  `blind-env set NAME` in a terminal. Those platforms are untested.
- Logging in to websites through a browser (a `login` tool) is not built yet.

## License

MIT, see [LICENSE](LICENSE).

## Tests

```bash
npm test
```

## Roadmap

- `login` tool: fill a username and password into a browser form
- macOS Keychain and Linux secret-service for the key, plus password windows there
- Move a vault to another computer
- "This key may only be used by this command" rules for `run_with_secrets`
