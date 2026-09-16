# HTTP API

The server is plain `node:http`. Locally it listens on `http://127.0.0.1:8787` (`host` and `port` in `skillhook.json`); publicly it is whatever your tunnel maps to it ([exposure.md](exposure.md)). Every route is available on both.

Conventions:

- JSON responses are pretty-printed, `content-type: application/json; charset=utf-8`, with `cache-control: no-store` and `x-content-type-options: nosniff`. `GET /` and `GET /hooks/<skill>` return `text/plain`.
- Errors are `{"ok": false, "error": "<code>", "message": "<text>"}`; codes are listed at the end.
- Timeouts: keep-alive 65 s, headers 70 s, whole request `max(300 s, max_wait_seconds + 30 s)`.
- Every request counts against the per-IP limit `rate_limit.requests_per_minute` (120); beyond it the answer is `429 rate_limited`.

Related: [security.md](security.md) (authentication), [skills.md](skills.md) (filters, dedupe, placeholders), [operations.md](operations.md) (job files).

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | none | Banner: `skillhook <version>` plus a hint. |
| `GET` | `/health` | none; admin for details | Liveness. Public callers get `{ok, version}`; admin callers also get `uptime_seconds` and `queue`. |
| `GET`, `HEAD` | `/hooks/<skill>` | none | `200` text when the skill exists and is enabled, `404` otherwise. Lets providers "test" the URL. |
| `POST`, `PUT` | `/hooks/<skill>` | the skill's `auth` | Deliver a webhook. |
| `GET` | `/skills` | admin | Every skill with its effective settings. |
| `POST` | `/skills/<skill>/run` | admin | Run a skill with an arbitrary payload, bypassing webhook auth. |
| `GET` | `/jobs` | admin | Recent jobs. |
| `GET` | `/jobs/<id>` | admin | One job, optionally with artifacts. |
| `POST` | `/jobs/<id>/cancel` | admin | Cancel a queued or running job. |

Anything else is `404 not_found`; another method on `/hooks/<skill>` is `405 method_not_allowed`.

## Webhook delivery: `POST /hooks/<skill>`

Processing order:

1. Rate limit per client IP.
2. Skill lookup: unknown, disabled or malformed name -> `404 unknown_skill`; a `SKILL.md` that fails to parse -> `500 invalid_skill` (details in the server log).
3. Body read: a `Content-Length` or streamed size above `max_body_bytes` (1 MiB) -> `413 payload_too_large`.
4. Authentication per the skill's `auth`: `403 ip_not_allowed`, `401 <code>`, or `503 skill_not_configured` when the secret env var is missing. After `rate_limit.auth_failures_per_minute` (10) failures from one IP within a minute the answer becomes `429 too_many_failures`.
5. Body parsing by content type (JSON, form, text, binary; see [skills.md](skills.md#what-the-agent-receives)).
6. Slack skills only: `{"type":"url_verification","challenge":"…"}` -> `200 {"challenge":"…"}`, no job.
7. Delivery id (provider header, `dedupe.header`, `dedupe.path`); a repeat within `jobs.dedupe_window_seconds` -> `200` with `duplicate: true` and the original `job_id`.
8. `when` filters -> `200` with `skipped: true` when they do not match.
9. In-flight check (`dedupe.in_flight`, default `jobs.dedupe_in_flight` = `true`): a payload and query string identical to a job of this skill that is still queued or running -> `200` with `duplicate: true`, `in_flight: true` and that job's `job_id`; with `?wait=` the response waits for that job instead.
10. The job is written to disk and queued; the response is sent.

### Responses

Asynchronous (default): `202 Accepted`

```json
{
  "ok": true,
  "job_id": "20260916T025442Z-r1wn6g",
  "status": "queued",
  "skill": "hello",
  "status_url": "/jobs/20260916T025442Z-r1wn6g"
}
```

Synchronous: add `?wait=<seconds>` or send a `Prefer: wait=<seconds>` header (clamped to `max_wait_seconds`, default 120). When the job finishes in time the answer is `200`; `ok` reflects the job outcome:

```json
{
  "ok": true,
  "job_id": "20260916T025442Z-e634on",
  "status": "succeeded",
  "result": "Summarized the payload and wrote hello.md.",
  "error": null,
  "job": {
    "id": "20260916T025442Z-e634on",
    "skill": "hello",
    "status": "succeeded",
    "trigger": "webhook",
    "runner": "claude",
    "created_at": "2026-09-16T02:54:42.452Z",
    "started_at": "2026-09-16T02:54:42.497Z",
    "finished_at": "2026-09-16T02:54:42.547Z",
    "duration_ms": 50,
    "cwd": "/Users/me/.skillhook/skills/hello",
    "session_id": "6f1c…",
    "resume_command": "cd /Users/me/.skillhook/skills/hello && claude --resume 6f1c…",
    "exit_code": 0,
    "signal": null,
    "cost_usd": 0.0123,
    "usage": { "input_tokens": 10, "output_tokens": 5 },
    "num_turns": 1,
    "result": "Summarized the payload and wrote hello.md.",
    "source": { "ip": "203.0.113.7", "method": "POST", "path": "/hooks/hello", "content_type": "application/json", "user_agent": "curl/8.7.1" }
  }
}
```

A job that ended as `failed`, `timed_out` or `cancelled` is still `200`, with `"ok": false`, the status, and `error` set. When the wait elapses first the answer is `202`:

```json
{ "ok": true, "job_id": "20260916T025442Z-e634on", "status": "running", "status_url": "/jobs/20260916T025442Z-e634on", "note": "still running after 30s" }
```

Duplicate delivery: `200`

```json
{ "ok": true, "duplicate": true, "job_id": "20260916T025442Z-w0un7d", "status_url": "/jobs/20260916T025442Z-w0un7d" }
```

Identical delivery still in flight: `200`

```json
{ "ok": true, "duplicate": true, "in_flight": true, "job_id": "20260916T025442Z-w0un7d", "status": "running", "status_url": "/jobs/20260916T025442Z-w0un7d" }
```

Filtered out: `200`

```json
{ "ok": true, "skipped": true, "reason": "payload.action equals \"created\": expected \"created\"" }
```

Duplicates and skips are 2xx on purpose: providers treat them as delivered and stop retrying.

### Examples

Bearer (the default auth):

```bash
curl -sS -X POST "https://mac.tail1234.ts.net/hooks/hello?wait=60" \
  -H "Authorization: Bearer $SKILLHOOK_SECRET_HELLO" \
  -H "Content-Type: application/json" \
  -d '{"name":"world"}'
```

GitHub-style HMAC, signed by hand:

```bash
body='{"action":"opened","issue":{"number":1}}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$GH_WEBHOOK_SECRET" | sed 's/^.* //')
curl -sS -X POST https://mac.tail1234.ts.net/hooks/github-issue-triage \
  -H "X-Hub-Signature-256: sha256=$sig" \
  -H "X-GitHub-Delivery: $(uuidgen)" \
  -H "X-GitHub-Event: issues" \
  -H "Content-Type: application/json" \
  -d "$body"
```

For any scheme (Standard Webhooks, Stripe, Slack, …) `skillhook send <skill> --payload … [--public]` builds the right headers from the stored secret, and the MCP tool `send_test_webhook` does the same.

Poll an asynchronous job:

```bash
curl -sS -H "Authorization: Bearer $SKILLHOOK_ADMIN_TOKEN" https://mac.tail1234.ts.net/jobs/20260916T025442Z-r1wn6g?include=result
```

## Admin authentication

Admin routes accept `Authorization: Bearer <SKILLHOOK_ADMIN_TOKEN>`. Without a token they are allowed only for direct loopback connections that carry no proxy header (`X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Real-IP`, `CF-Connecting-IP`, `Forwarded`, `Via`, `Tailscale-User-Login`, `ngrok-trace-id`); that is how the CLI and the MCP server talk to the local server. Through a tunnel the token is mandatory. If no token is configured the response is `401 unauthorized` with the message `admin endpoints need SKILLHOOK_ADMIN_TOKEN (run: skillhook secret generate admin)`; with a token configured but absent or wrong it is `admin token required`.

## `GET /health`

Public: `{"ok": true, "version": "0.1.0"}`. Admin or direct local: adds `"uptime_seconds"` and `"queue": {"running": 0, "queued": 0, "running_ids": []}`. The CLI and MCP server use this route to detect a running server.

## `GET /skills`

```json
{
  "skills": [
    {
      "name": "hello",
      "description": "Smoke-test skill…",
      "enabled": true,
      "runner": "claude",
      "model": null,
      "effort": null,
      "cwd": "/Users/me/.skillhook/skills/hello",
      "timeout_seconds": 300,
      "path": "/hooks/hello",
      "auth": {
        "type": "bearer",
        "secret_env": "SKILLHOOK_SECRET_HELLO",
        "configured": true,
        "how": "Authorization: Bearer <$SKILLHOOK_SECRET_HELLO>"
      },
      "when": ["payload.action equals \"created\""],
      "dir": "/Users/me/.skillhook/skills/hello"
    }
  ],
  "errors": [
    { "dir": "/Users/me/.skillhook/skills/broken", "name": "broken", "error": "Invalid SKILL.md frontmatter: …" }
  ]
}
```

`runner`, `model`, `effort`, `cwd` and `timeout_seconds` are effective values after `defaults`. `auth.type` is the normalized type: `github`, `sentry` and `linear` appear as `hmac`, `granola` and `svix` as `standard-webhooks`; `auth.how` spells out the preset. `auth.configured` says whether the secret is present. This call rescans the skills directory, so new directories appear immediately.

## `POST /skills/<skill>/run`

Body: a JSON object (anything else is `400 bad_request`).

| Field | Type | Meaning |
|---|---|---|
| `payload` | any | What the skill receives (default `{}`). A string is delivered as a text body. |
| `headers` | object | Simulated request headers, for `when: header:` filters and `{{headers.*}}`. |
| `runner` | `claude` \| `codex` \| `shell` | Override for this run. |
| `model`, `effort` | string | Overrides for this run. |
| `wait` | number | Seconds to wait for the result (also accepted as `?wait=`); clamped to `max_wait_seconds`. |

The job is recorded with `trigger: "api"` and answered with the same shapes as a webhook. No webhook signature is checked and no `when` filter or dedupe applies. This is what `skillhook run` (via the MCP `run_skill` tool) uses when a server is running.

```bash
curl -sS -X POST http://127.0.0.1:8787/skills/hello/run \
  -H "Content-Type: application/json" \
  -d '{"payload":{"name":"Dee"},"wait":60,"model":"sonnet"}'
```

## `GET /jobs`

Query: `skill=<name>`, `status=<queued|running|succeeded|failed|timed_out|cancelled|interrupted>`, `limit=<n>` (default 50). Newest first.

```json
{
  "jobs": [ { "id": "20260916T025443Z-z1y3m4", "skill": "hello", "status": "succeeded", "…": "…" } ],
  "queue": { "running": 0, "queued": 0, "running_ids": [] }
}
```

## `GET /jobs/<id>`

`?include=result,stdout,stderr,prompt,payload,event` adds an `artifacts` object with file contents (each capped to its last 512 KiB and prefixed with `… [N bytes omitted]` when truncated; a missing file is `null`).

```bash
curl -sS "http://127.0.0.1:8787/jobs/20260916T025442Z-r1wn6g?include=result,prompt"
```

```json
{
  "job": { "id": "20260916T025442Z-r1wn6g", "skill": "hello", "status": "succeeded", "…": "…" },
  "artifacts": {
    "result": "Summarized the payload and wrote hello.md.\n",
    "prompt": "# Skill: hello\n\n# hello\n\nYou received a webhook…"
  }
}
```

Ids that do not exist (or do not look like `YYYYMMDDTHHMMSSZ-xxxxxx`) are `404 unknown_job`.

## `POST /jobs/<id>/cancel`

`200 {"ok": true, "job_id": "…", "status": "…"}` when the job was queued (it becomes `cancelled` at once) or running (SIGTERM now, SIGKILL after 10 s, then `cancelled`). `409 {"ok": false, "job_id": "…", "status": "succeeded"}` when it had already finished.

## Job record

| Field | Type | Notes |
|---|---|---|
| `id` | string | `YYYYMMDDTHHMMSSZ-<6 chars>`, UTC, sortable; also the directory name under `jobs/`. |
| `skill` | string | |
| `status` | string | `queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`, `interrupted`. |
| `trigger` | string | `webhook`, `api`, `cli`, `mcp`. |
| `runner` | string | `claude`, `codex`, `shell`. |
| `model`, `effort` | string, optional | Resolved values when set. |
| `created_at`, `started_at`, `finished_at` | ISO-8601 | |
| `duration_ms` | number, optional | Start (or creation) to finish. |
| `cwd` | string, optional | Working directory used. |
| `pid` | number, optional | Only while running. |
| `exit_code`, `signal` | number / string / null | Process exit. |
| `session_id`, `resume_command` | string, optional | Claude session or Codex thread, and the shell command that resumes it. |
| `cost_usd`, `usage`, `num_turns` | optional | As reported by the runner (Claude reports all three, Codex `usage` only). |
| `result` | string, optional | Final agent message, truncated to 20 000 characters here; complete in `result.md`. |
| `error` | string, optional | Failure reason. |
| `delivery_id` | string, optional | Provider delivery id when known. |
| `fingerprint` | string, optional | SHA-256 of the payload and query string of a webhook delivery; what the in-flight duplicate check compares. |
| `source` | object | `ip`, `method` (`POST`, `PUT`, or `LOCAL` for CLI/MCP runs), `path`, `content_type`, `user_agent`. |

`job.json` on disk also contains `command` (the exact argv); API responses omit it.

## Status and error codes

| HTTP | `error` | Meaning |
|---|---|---|
| 200 | — | Result available, duplicate, skipped, Slack challenge, admin reads, successful cancel. |
| 202 | — | Job queued (or still running after `wait`). |
| 400 | `bad_request` | `/skills/<skill>/run` body is not a JSON object. |
| 401 | `missing_token`, `invalid_token`, `missing_credentials`, `invalid_credentials`, `missing_signature`, `invalid_signature`, `missing_timestamp`, `invalid_timestamp`, `stale_timestamp` | Webhook authentication failed. |
| 401 | `unauthorized` | Admin route without a valid token. |
| 403 | `ip_not_allowed` | Client IP not in the skill's `allow_ips`. |
| 404 | `unknown_skill`, `unknown_job`, `not_found` | |
| 405 | `method_not_allowed` | |
| 409 | — (`ok: false`) | Cancel on a finished job. |
| 413 | `payload_too_large` | Body over `max_body_bytes`. |
| 429 | `rate_limited`, `too_many_failures` | Per-IP limits. |
| 500 | `invalid_skill`, `internal_error` | `SKILL.md` failed to parse; unexpected error (see the server log). |
| 503 | `skill_not_configured` | The skill's secret env var is not set. |
