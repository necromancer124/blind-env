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

You need [Node.js](https://nodejs.org) 20 or newer.

**For Claude Code** (MCP server plus the `/addKey` and `/keys` commands, in
every project). Type this in Claude Code:

```
/plugin install blind-env --marketplace necromancer124/blind-env
```

On Claude Code older than 2.1.275, use two steps instead:

```
/plugin marketplace add necromancer124/blind-env
/plugin install blind-env@blind-env
```

**For the command line:**

```bash
npm install -g blind-env
```

Or run it without installing: `npx blind-env help`.

**From source:**

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
GITHUB_TOKEN  ok      length 40  fingerprint 7c2e91d4
```

The fingerprint stays the same until the value changes, so you can tell
"still the old token" from "the new one" at a glance. It is made with the
vault key, so it cannot be used to guess the value.

The `.aienv` file also starts with a short note for AI agents: use keys by
name, never print or decode a value.

### Allowed sites

A key can only be sent (with `http_request`) to the sites on its list. A new
key has an empty list.

```bash
blind-env allow GITHUB_TOKEN api.github.com
```

- `allow` sets the whole list, so name every site you want.
- `*.github.com` covers every subdomain (not `github.com` itself).
- `blind-env allow NAME --clear` removes all sites.
- **Adding a site to a saved secret always asks you first**, in a confirmation
  window on Windows (or a y/N question in a terminal elsewhere), even when an
  AI runs the command. Enter means Cancel; approving takes a click on Allow.
  Removing sites needs no confirmation.
- `set NAME --allow site` sets the sites together with a **new** value, so no
  window asks about them: a value already stored is never sent anywhere new
  this way. When you type the new value in the password window, new sites are
  marked `NEW` there.
- The list is protected by the encryption: if someone adds a site by editing
  `.aienv` by hand, that key stops working instead of being sent there.

Delete a secret with `blind-env rm NAME`. That also asks you first, because it
cannot be undone. Help: `blind-env help`.

## Use it from an AI agent (MCP server)

`blind-env mcp` is an MCP server. Any agent that speaks MCP can connect to it.
For Claude Code, in your project folder:

```bash
claude mcp add blind-env -- blind-env mcp
```

The agent gets six tools:

| Tool | What it does |
|------|--------------|
| `list_keys` | Which vault file is in use, plus names, descriptions, allowed hosts. Never values. |
| `add_key` | Opens a private window where **you** type the value. |
| `run_with_secrets` | Runs a command with the chosen keys as environment variables (in `cmd.exe` on Windows, so `%NAME%`). Output is cleaned. The command also gets the AI app's own environment variables, which blind-env does not hide. |
| `http_request` | Sends a web request with `{{KEY_NAME}}` filled in. Only to allowed hosts, HTTPS only, redirects not followed, response cleaned. |
| `allow_hosts` | Adds or removes allowed sites for a key. Adding opens a confirmation window; nothing changes unless **you** click Allow. |
| `remove_key` | Deletes a secret. Opens a confirmation window; nothing is deleted unless **you** click Delete. |

This repo is also laid out as a Claude Code plugin (`.claude-plugin/`), which
adds the `/addKey`, `/keys`, `/removeKey`, `/allowSite KEY host` and
`/removeSite KEY host` commands. If you open this
repo itself in Claude Code, `.mcp.json` and `.claude/commands/` give you the
server and the commands
without installing anything. Start the session in the repo folder itself: a
session that starts elsewhere does not load them until it moves into the repo.

## What it protects, and what it does not

**It does protect against:**

- secret values ending up in the chat, the AI's memory, transcripts or logs;
- the AI reading secrets from a file in your project;
- a program printing a secret by accident;
- a web page tricking the AI into sending a key to the wrong site through
  `http_request`.

An allowed site is trusted with the key. If you allow `api.github.com`, the AI
could still send the token there in a way that stores it, for example inside a
new gist. Allow only the API a key is for, and keep `run_with_secrets` and
`http_request` approvals in Claude Code switched on for anything sensitive.

**It does not protect against an AI that has a shell and is trying to steal a
secret.** An agent that can run any command as you can write a program that
scrambles the secret before printing it (so the cleaner misses it), sends it to
a server, unlocks the key file the same way blind-env does, or even "click" the
confirmation window with simulated key presses. Nothing running
under your own account can fully stop that.

So think of blind-env as a seat belt, not a vault door: it stops the common,
accidental ways secrets leak to an AI. The strongest setup is an agent that has
**only** the `http_request` tool and no shell. Then the allowed-hosts list is a
real barrier.

Other limits:

- Values must be at least 8 characters. Hiding a short value gives it away
  (`test` masked inside `testing` shows what it is), so shorter ones are
  refused unless `--allow-short` is given. Only use that for things that
  really are short, like a PIN: a short value is easy to spot in output, and
  values under 4 characters are not hidden at all.
  Key names are never masked, even when a value appears inside one.
- The vault only opens on the computer and account that created it. On a new
  machine, add the secrets again.
- The password window exists on Windows only. On macOS and Linux use
  `blind-env set NAME` in a terminal. Those platforms are untested.
- Logging in to websites through a browser (a `login` tool) is not built yet.

## License

MIT, see [LICENSE](LICENSE).

## Tests

The full manual test, written as a prompt for an AI session, is in
[docs/TEST-PROMPT.md](docs/TEST-PROMPT.md). Automatic tests:

```bash
npm test
```

## Roadmap

- `login` tool: fill a username and password into a browser form
- macOS Keychain and Linux secret-service for the key, plus password windows there
- Move a vault to another computer
- "This key may only be used by this command" rules for `run_with_secrets`
