# blind-env — a `.env` file for AI agents

> **Working name.** Alternatives: `ai-vault`, `sealed-env`, `.aienv`.

## The problem

AI coding agents (Claude Code, Copilot, Cursor, etc.) read your project files.
If your `.env` holds passwords, API keys or tokens, the AI can see them in
plain text. That means secrets can end up:

- in the model's context / chat transcript,
- in logs, screenshots, or shared sessions,
- accidentally pasted into code, commits, or messages.

Today the only options are "let the AI see everything" or "hide the file and
the AI can't help with anything that needs a secret".

## The idea

A `.env`-style file made **for AI**: the AI can **use** a secret by name, but
can **never read its value**.

- The AI sees: `DB_PASSWORD` exists, what it's for, what kind of value it is.
- The AI writes code like `process.env.DB_PASSWORD` or runs
  `blind-env run -- npm start`.
- The real value is only injected at **runtime**, into the process that
  needs it — never into the AI's view.

Think of it like a waiter carrying a sealed envelope: they deliver it to the
right table, but they can't open it.

## How it could work

### 1. Two files

| File | Who can read it | Contents |
|------|-----------------|----------|
| `.aienv` (public manifest) | AI + humans, can be committed | Secret **names**, descriptions, types — no values |
| `.aienv.sealed` (vault) | Only the `blind-env` tool | Encrypted values |

Example `.aienv`:

```ini
# name          type      description
DB_PASSWORD     password  Postgres password for local dev
STRIPE_KEY      api-key   Stripe test-mode secret key
SMTP_USER       string    Mail account username
```

### 2. Encryption

- Values in `.aienv.sealed` are encrypted (e.g. AES-256-GCM / age).
- The decryption key lives **outside the project**: OS keychain
  (Windows Credential Manager / macOS Keychain / libsecret), or a
  password the human types once per session.
- The AI agent never gets the key, so even if it opens the sealed file it
  only sees ciphertext.

### 3. Runtime injection

```bash
blind-env run -- python app.py
```

1. `blind-env` unlocks the vault (using the keychain).
2. Starts `python app.py` with the secrets as environment variables.
3. The AI only launched the command — the values went straight from the
   vault into the child process.

Libraries could also offer a direct call:

```python
from blind_env import secret
conn = connect(password=secret("DB_PASSWORD"))
```

### 4. Output redaction

A program might print a secret by accident (`print(os.environ)`).
`blind-env run` watches stdout/stderr and replaces any known secret value
with `***DB_PASSWORD***` before the AI (or terminal) sees it.

### 5. Adding secrets (human only)

```bash
blind-env set DB_PASSWORD        # prompts with hidden input
blind-env list                   # names only, never values
blind-env rm DB_PASSWORD
```

The AI can **ask** the human to add a secret ("please run
`blind-env set STRIPE_KEY`"), but can't type the value itself.

## Rules / guarantees to aim for

1. No command ever prints a decrypted value (no `get --show`, or only behind
   an explicit human confirmation outside the AI's terminal).
2. The manifest is safe to commit; the sealed file is safe-ish to commit
   (encrypted), the key never is.
3. Redaction is on by default.
4. Works with any language — it's just environment variables at the end.

## Honest limitations

- Code the AI writes *could* still try to exfiltrate a secret at runtime
  (e.g. send it to a URL). Redaction + reviewing AI code reduces this but
  can't fully prevent it. Possible later features: allow-list of hosts per
  secret, "secret only usable by this command".
- Redaction can miss transformed values (base64, split strings).
- It protects against **seeing**, not against a fully malicious program.

## Similar tools to look at

- `1Password CLI` (`op run`), Doppler, Infisical — runtime injection
- `sops`, `age`, `dotenvx` — encrypted env files
- `git-crypt` — encrypted files in repos

What's new here: designed around the AI agent as a **semi-trusted user** —
a manifest written for the AI to understand, plus redaction of anything it
would see.

## MVP plan (for later)

- [ ] Pick language (Node or Python CLI)
- [ ] `init` — create manifest + sealed file, store key in OS keychain
- [ ] `set` / `list` / `rm`
- [ ] `run -- <cmd>` with env injection
- [ ] stdout/stderr redaction
- [ ] Instructions snippet for `CLAUDE.md` / AI rules files:
      "secrets are in `.aienv`; use `blind-env run`; never ask for values"
- [ ] Optional: MCP server so agents can call `run_with_secrets` as a tool
