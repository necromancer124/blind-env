---
description: Let a facedown key be sent to a website (you confirm in a window)
argument-hint: KEY_NAME host [host...]
---

The user wants to allow a facedown key to be sent to more websites: $ARGUMENTS

The first word is the key name. The other words are hosts, like `api.github.com`
or `*.example.com`. If the user gave full URLs, use only the host part (no
`https://`, no path) and tell them you did.

Call the facedown `allow_hosts` tool with `name` and `add`. A confirmation window
opens on the user's screen and nothing changes unless they click Allow.

Then tell the user in one line which sites the key may now be sent to, or that
nothing changed.

To remove sites instead, the user can say so; then pass them in `remove`.
