---
description: Stop a facedown key from being sent to a website
argument-hint: KEY_NAME host [host...]
---

The user wants a facedown key to stop being sent to some websites: $ARGUMENTS

The first word is the key name. The other words are hosts. If the user gave full
URLs, use only the host part and tell them you did.

Call the facedown `allow_hosts` tool with `name` and `remove`. Removing sites
needs no confirmation.

Then tell the user in one line which sites the key may still be sent to.
