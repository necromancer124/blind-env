# Full manual test (prompt for an AI session)

How to use it: start a **new** Claude Code session in the facedown repo folder,
approve the **facedown** MCP server when asked, and paste everything in the box
below. Some steps need you to click in a window; the AI will tell you when.

```text
You are testing facedown, a ".env for AI agents", in this repo. Read README.md first.
Goal: check that every feature works AND that secret values never reach you.
Do not change any code, and do not commit or push. Only test and report.

RULES
- Never decrypt anything yourself: do not read ~/.facedown, do not import
  src/vault.js or src/crypto.js, do not write scripts that call reveal().
  Only use the facedown MCP tools and "node src/cli.js <command>".
- Never simulate key presses or clicks on facedown windows. Windows are for
  the user. When a step needs a window, tell the user exactly what to click.
- For keys YOU create with --stdin, use dummy values of 20+ characters
  (like dummy-alpha-1234567890) so you can search all output for them.
- Seeing a dummy value in plain text anywhere is a FAIL.
- In Git Bash, set MSYS_NO_PATHCONV=1 before commands that pass Windows paths
  or "cmd /c" arguments.

PART 1 - SETUP
1. list_keys: the first line must be
   "Vault: C:\Users\nirsh\OneDrive\Desktop\facedown\.env.facedown", not a temp folder.
2. Ask the user to type /keys and tell you what they see.
3. Check that these slash commands exist (ask the user to type / and look):
   /addKey /keys /removeKey /allowSite /removeSite

PART 2 - ADDING KEYS
4. Ask the user: "/addKey WINDOW_KEY test key from the window" and to type a
   dummy value of 10+ characters, then Save. Then run check WINDOW_KEY.
5. Ask the user: "/addKey SHORT_KEY short test" and to type "abc".
   Expected: "Not saved" (shorter than 8).
6. CLI with --stdin and dummy values:
   - TEST_TOKEN --allow 127.0.0.1
   - NO_HOSTS_KEY (no --allow)
   - BAD_KEY with the value on the command line -> refused
   - a 5-character value -> refused; with --allow-short -> saved with a warning
     (call it SHORT5_KEY)
7. check: every key "ok"; SHORT5_KEY marked short. Run check twice: same
   fingerprints. Save the SAME dummy value under two names: the fingerprints
   must differ.

PART 3 - ACCIDENTAL LEAKS (expect ***NAME***, never the value)
Use both "node src/cli.js run --keys TEST_TOKEN -- ..." and run_with_secrets:
8. print plainly; dump the whole environment; base64, hex, URL-encoded, JSON;
   stderr; cmd "echo %TEST_TOKEN%".
9. Print the key NAME as text ("echo $TEST_TOKEN and TEST_TOKEN"): the name stays
   readable and reveals nothing.
10. Print the value in two parts with a 300 ms pause in between (CLI run):
    node -e "const v=process.env.TEST_TOKEN;process.stdout.write(v.slice(0,11));setTimeout(()=>console.log(v.slice(11)),300)"
    Expected: only ***TEST_TOKEN***.
11. Note line "hid the value of ..." appears; --quiet removes it; --strict and
    FACEDOWN_STRICT=1 fail with exit code 97. Printing only the length: no note.

PART 4 - WEB REQUESTS
12. Start a local HTTP echo server on 127.0.0.1 (node, in the background) that
    echoes request headers and body. With http_request:
    - TEST_TOKEN in an Authorization header -> works; response shows
      ***TEST_TOKEN*** AND starts with a "hid the value of" note
    - NO_HOSTS_KEY -> BLOCKED
    - TEST_TOKEN to https://example.com -> BLOCKED
    - {{TEST_TOKEN}} in the URL -> refused
    - plain http:// to a non-localhost site -> refused
    - a 302 redirect -> not followed
    - MY_TEST_KEY (an older-format key) to 127.0.0.1 -> BLOCKED

PART 5 - ALLOWED SITES
13. Ask the user: "/allowSite NO_HOSTS_KEY 127.0.0.1", and to press CANCEL in the
    window. Expected: not changed; http_request with NO_HOSTS_KEY still BLOCKED.
14. Same again, and this time the user clicks ALLOW. Expected: allowed; the
    http_request now works.
15. Ask the user: "/removeSite NO_HOSTS_KEY 127.0.0.1". No window. BLOCKED again.
16. CLI "allow TEST_TOKEN 127.0.0.1 example.com": a window opens; ask the user
    to press Cancel. Expected: exit 1, nothing changed.
17. Hand-edit test: in .env.facedown, add ",evil.example" to TEST_TOKEN's "# @allow"
    line with a text edit. Expected: check says FAILED / cannot decrypt, and
    run and http_request with TEST_TOKEN fail. Put the line back exactly and
    confirm check is ok again.

PART 6 - DELETING
18. Ask the user: "/removeKey WINDOW_KEY" and to press CANCEL. Expected: still
    in list_keys.
19. Same again; the user clicks DELETE. Expected: gone.
20. CLI "rm SHORT5_KEY": a window opens; the user clicks Delete. Gone.
21. Commands that must not exist: get, show, print, reveal, export, cat, decrypt.

PART 7 - FINISH
22. Run npm test and report the result.
23. Remove every key you created (TEST_TOKEN, NO_HOSTS_KEY, and any others left;
    the user confirms each delete). Leave MY_TEST_KEY. Stop the echo server.
    "git status" must be clean.

REPORT
A table: # | test | expected | actual | PASS/FAIL. Then a numbered list of bugs
or confusing behaviour, each with exact commands to reproduce. Never include a
secret value in the report, not even a dummy one.
```
