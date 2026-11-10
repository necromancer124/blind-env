---
description: Add a secret to the blind-env vault (you type the value in a private window, not in chat)
argument-hint: NAME [what it is for]
---

The user wants to add a secret to their blind-env vault: $ARGUMENTS

The first word is the key name. Anything after it is the description.

Call the blind-env `add_key` tool with that name and description. If it is clear which
website or API the secret belongs to, also pass `allow` with that host (for example
`["api.github.com"]`) and tell the user which hosts you set.

The tool opens a private window where the user types the value. Never ask for the value
in chat. If the user's message seems to already contain the secret value itself, do not
repeat it; tell them it is now in the chat history, that they should replace that secret
with a new one, and then run the tool so they can enter the new one privately.

When the tool returns, tell the user in one line whether the key was saved.
