# Security

blind-env exists to keep secrets away from AI agents, so security reports are
very welcome.

## Reporting a problem

Please **do not open a public issue** for a security problem. Use GitHub's
private reporting instead:

1. Go to the [Security tab](https://github.com/necromancer124/blind-env/security)
   of this repository.
2. Click **Report a vulnerability**.

Include what you did, what you expected, and what happened. Use dummy values
in your report, never a real secret.

## What counts

Anything that lets a secret value reach the AI, the chat, or a site that is
not on the key's allowed list, through normal use of blind-env. For example:

- a way a value gets past the output cleaner (`***NAME***`);
- a way to add an allowed site or delete a key without the confirmation window;
- a way to make the MCP server crash or misbehave from a tool call.

## Known limits (not bugs)

The README section "What it protects, and what it does not" lists what
blind-env does not try to stop. Most importantly: an AI with a full shell that
is deliberately trying to steal a secret can get around it, because it runs as
you. Reports that show a cheap, practical improvement there are still welcome.

## Supported versions

Only the latest release gets fixes.
