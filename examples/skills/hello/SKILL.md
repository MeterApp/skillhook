---
name: hello
description: Smoke-test skill. Acknowledges whatever webhook payload it receives and writes a short note into the job directory. Use it to verify a new skillhook install end to end.
skillhook:
  # runner: claude          # claude | codex | shell — omit to use the server default
  # model: haiku            # cheap and fast is plenty for a smoke test
  timeout_seconds: 300
  auth:
    type: bearer            # Authorization: Bearer $SKILLHOOK_SECRET_HELLO
---

# hello

You received a webhook. Prove the pipeline works:

1. Summarize the payload in one or two sentences (what system sent it, what happened).
2. Write that summary to `{{job_dir}}/hello.md` (the job directory already exists).
3. Reply with the same summary as your final message.

Do not call any external services. If the payload is empty, say so.

Payload:

```json
{{payload}}
```
