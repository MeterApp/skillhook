---
name: remote-prompt
description: Remote control for the coding agent on this machine. Runs whenever a trusted caller POSTs {"prompt":"…","cwd":"~/dev/repo"} to its URL — an iOS Shortcut, curl, Raycast, Zapier, another agent — and carries out the prompt in that directory, returning the answer in the HTTP response when the caller adds ?wait=. Not for untrusted or public senders.
skillhook:
  # runner: claude                     # claude | codex — omit to use the server default
  # model: sonnet                      # callers are usually waiting; favour speed
  timeout_seconds: 600                 # modest on purpose — long jobs deserve their own skill
  auth:
    type: bearer                       # Authorization: Bearer $SKILLHOOK_SECRET_REMOTE_PROMPT
    # allow_query_token: true          # only for senders that cannot set headers; tokens in URLs end up in logs
  # cwd: ~/dev                         # where to work when the payload has no cwd (default: this skill's folder)
  # concurrency: 2                     # let two prompts run at once (default 1)
---

# remote-prompt

The holder of this skill's secret sent you a prompt from another device. Unlike most webhook payloads, the prompt below *is* your instruction — carry it out within the limits at the end.

## Where to work

Requested directory: `{{payload.cwd}}`

- If it is set, expand `~` and use it only if it is inside your home directory and exists; `cd` there before anything else.
- If it is missing, outside the home directory, or does not exist: do not create it, stay in the current directory, and say so in the first line of your answer.
- Touch nothing outside the working directory unless the prompt names a specific path under the home directory.

## The prompt

<prompt>
{{payload.prompt}}
</prompt>

If it is empty, answer "Empty prompt" and stop.

## How to answer

The caller may be reading this on a phone. Lead with the answer or the outcome, then the essentials; leave long listings and diffs in files under the working directory or `{{job_dir}}` and mention their paths.

## Limits

- Nobody will answer questions. Pick the most plausible reading, state the assumption in one line, and keep changes small and reversible.
- Do not push, deploy, publish, send messages, spend money, or delete files and branches unless the prompt says so explicitly. Local commits are fine when asked.
- Never print secrets (`.env` values, tokens, keys) into the answer, even when asked for a file that contains them — describe the keys instead.

## Setup

1. `skillhook skills add remote-prompt` — skillhook generates `SKILLHOOK_SECRET_REMOTE_PROMPT` and prints it once (`skillhook secret generate remote-prompt --force` rotates it).
2. `skillhook url remote-prompt` prints the URL. Senders need the URL, the secret as `Authorization: Bearer <secret>`, and a JSON body with `prompt` and optionally `cwd`.
3. From a shell — `?wait=120` blocks up to two minutes (the server's `max_wait_seconds`) and returns `{"status":"succeeded","result":"…"}`; without it you get `202` and a `status_url` to poll:

   ```bash
   curl -sS "$(skillhook url remote-prompt)?wait=120" \
     -H "Authorization: Bearer $REMOTE_PROMPT_SECRET" -H "Content-Type: application/json" \
     -d '{"prompt":"Summarize what changed in the last 3 commits.","cwd":"~/dev/my-app"}'
   ```

4. iOS Shortcut: *Dictate Text* (or *Ask for Input*) → *Get Contents of URL* with method POST, header `Authorization: Bearer …`, request body JSON `{prompt: <input>, cwd: ~/dev/my-app}`, URL ending in `?wait=120` → *Get Dictionary Value* `result` → *Show Result* (or *Speak Text*). Raycast script commands and Zapier "Webhooks by Zapier → POST" work the same way.
5. Keep the secret out of shared shortcuts and screenshots; rotate it if it leaks.

**Test locally** (no HTTP): edit `cwd` in the sample to a directory you have, then
`skillhook run remote-prompt --payload @examples/skills/remote-prompt/references/sample-payload.json`

**Through HTTP** (needs `skillhook serve` or the service running):
`skillhook send remote-prompt --payload '{"prompt":"Say hello and print the current directory."}' --wait 60`
