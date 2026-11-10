---
description: Delete a secret from the facedown vault (you confirm in a window)
argument-hint: KEY_NAME
---

The user wants to delete a secret from their facedown vault: $ARGUMENTS

Call the facedown `remove_key` tool with that key name. A confirmation window
opens on the user's screen and nothing is deleted unless they click Delete.

If the name does not exist, call `list_keys` and show the user the names that do.

Then tell the user in one line whether the key was deleted.
