# facedown — the concept

How to use the tool is in [README.md](README.md). This file is the idea behind
it and the choices made so far.

## The problem

AI coding agents read your project files. If `.env` holds passwords and API
keys, the AI sees them in plain text, and they can end up in its context, in
chat transcripts, in logs, or pasted into code and commits.

Today the choice is "let the AI see everything" or "hide the file, and the AI
cannot help with anything that needs a secret".

## The idea

Treat the AI as a **semi-trusted user**: it may know that `DB_PASSWORD` exists
and what it is for, and it may use it, but it never holds the value.

Like a waiter carrying a sealed envelope: they bring it to the right table,
but they cannot open it.

## Choices made

**One file, not two.** The first sketch had a readable manifest plus a separate
encrypted file. They could drift apart. Now there is one `.env.facedown` file where
names and notes are readable and each value is encrypted.

**A new file name, not a new format.** `.env.facedown` is `.env` syntax with
`# @desc` and `# @allow` comment lines. Editors already understand it.

**Standard encryption.** AES-256-GCM from Node's built-in crypto. Each value is
tied to its name and its vault, so an encrypted value cannot be copied onto
another key.

**The key stays out of the project.** It is in the home folder, wrapped by the
operating system's account protection where possible.

**Values enter through a private window, never the chat.** Anything typed into
a chat goes to the model. So `/addKey NAME` carries no value: the tool opens a
password window on the user's screen.

**The AI gets actions, not values.** `run_with_secrets` and `http_request` take
key names. There is no "get" action.

**Allowed hosts, off by default.** A key can only be sent to hosts on its list,
and a new key has an empty list. The user sees the list in the password window
when the key is added.

**No dependencies.** A security tool should be small enough to read in one
sitting. The MCP server speaks the protocol directly.

**Honest about the limit.** An agent with a full shell under your account can
get around any of this if it tries. The tool is built to stop accidents and
leaks into transcripts, and says so. See "What it protects" in the README.

## The name

The project started as **blind-env**, with the file `.aienv`. It was renamed
to **facedown** with the file `.env.facedown`: like a card played face down, it
counts in the game but nobody sees it, and keeping `.env` at the front makes
the file easy to recognise and lets editors highlight it. The runner-up was
`.env.broker` ("the better env"), which was a bit too cheesy.

## Open questions

- A tool, a skill, or both? Right now: a tool (CLI + MCP server) with two slash
  commands. A skill could be added to teach agents good habits.
- How should a team share a vault? (Each person has a different key today.)
- Can `run_with_secrets` be limited so a key only works with approved commands?
- How to do browser logins without the page content leaking the password back?
