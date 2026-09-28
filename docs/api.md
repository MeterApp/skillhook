# HTTP API

The server is plain `node:http`. Locally it listens on `http://127.0.0.1:8787` (`host` and `port` in `skillhook.json`); publicly it is whatever your tunnel maps to it ([exposure.md](exposure.md)). Every route is available on both.

Conventions:

- JSON responses are pretty-printed, `content-type: application/json; charset=utf-8`, with `cache-control: no-store` and `x-content-type-options: nosniff`. `GET /` and `GET /hooks/<skill>` return `text/plain`.
- Errors are `{"ok": false, "error": "<code>", "message": "<text>"}`; codes are listed at the end.
- Timeouts: keep-alive 65 s, headers 70 s, whole request `max(300 s, max_wait_seconds + 30 s)`.
- Every request counts against the per-IP limit `rate_limit.requests_per_minute` (120); beyond it the answer is `429 rate_limited`.
- `GET /events` and `GET /jobs/<id>/events` answer `text/event-stream` and stay open; every other route is one JSON (or text) response.

Related: [security.md](security.md) (authentication), [skills.md](skills.md) (filters, dedupe, placeholders), [operations.md](operations.md) (job files).

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | none | Banner: `skillhook <version>` plus a hint. |
| `GET` | `/health` | none; admin for details | Liveness. Public callers get `{ok, version}`; admin callers also get `uptime_seconds`, `queue` and `schedules`. |
| `GET` | `/health/checks` | admin | The grouped health report (`skillhook health`), cached; `?deep=0`, `?network=1`, `?refresh=1`. |
| `GET` | `/doctor` | admin | The quick report (`skillhook doctor`), cached; `?network=0`, `?refresh=1`. |
| `GET` | `/runners` | admin | Is each runner installed and logged in (what a job checks before it starts); `?refresh=1`. |
| `GET`, `HEAD` | `/hooks/<skill>` | none | `200` text when the skill exists, is enabled and has a webhook, `404` otherwise (`schedule_only` for a `webhook: false` skill). Lets providers "test" the URL. |
| `POST`, `PUT` | `/hooks/<skill>` | the skill's `auth` | Deliver a webhook. `404 schedule_only` for a skill with `webhook: false`. |
| `GET` | `/skills` | admin | Every skill with its effective settings. |
| `POST` | `/skills/<skill>/run` | admin | Run a skill with an arbitrary payload, bypassing webhook auth. |
| `POST` | `/skills/test` | admin | Run a SKILL.md that is not installed (the document travels in the body). |
| `GET` | `/jobs` | admin | Recent jobs (`?waiting=1`: only those waiting for a person). |
| `GET` | `/jobs/<id>` | admin | One job, optionally with artifacts. |
| `POST` | `/jobs/<id>/cancel` | admin | Cancel a queued or running job. |
| `GET` | `/jobs/<id>/progress` | admin | What the agent reported: current state, pending question, answer, timeline. |
| `POST` | `/jobs/<id>/answer` | admin | A person's answer: delivered live to a waiting job, or a new job continues the session. |
| `GET` | `/jobs/<id>/artifacts/<name>` | admin | One artifact file as it is on disk (`?tail=<bytes>` for its end). |
| `GET` | `/jobs/<id>/events` | admin | Server-sent events for one job: `status` snapshots, `stdout`/`stderr` as they are written, `end`. |
| `GET` | `/events` | admin | Server-sent events for the whole server: `delivery.received`, `job.*`, `schedule.*`, `skill.changed`, `server.*` (`?types=` to filter). |
| `GET` | `/deliveries` | admin | Every webhook received, newest first, whatever became of it. |
| `GET` | `/deliveries/<id>` | admin | One delivery, optionally with its body. |
| `POST` | `/deliveries/<id>/replay` | admin | Run a recorded delivery again, as a new job. |
| `POST` | `/jobs/<id>/replay` | admin | Run the request an earlier job received again, as a new job. |

Anything else is `404 not_found`; another method on `/hooks/<skill>` is `405 method_not_allowed`.

## Webhook delivery: `POST /hooks/<skill>`

Processing order:

1. Rate limit per client IP.
2. Skill lookup: unknown, disabled or malformed name -> `404 unknown_skill`; a schedule-only skill (`webhook: false`) -> `404 schedule_only`; a `SKILL.md` that fails to parse -> `500 invalid_skill` (details in the server log).
3. Body read: a `Content-Length` or streamed size above `max_body_bytes` (1 MiB) -> `413 payload_too_large`.
4. Authentication per the skill's `auth`: `403 ip_not_allowed`, `401 <code>`, or `503 skill_not_configured` when the secret env var is missing. After `rate_limit.auth_failures_per_minute` (10) failures from one IP within a minute the answer becomes `429 too_many_failures`.
5. Body parsing by content type (JSON, form, text, binary; see [skills.md](skills.md#what-the-agent-receives)).
6. Slack skills only: `{"type":"url_verification","challenge":"…"}` -> `200 {"challenge":"…"}`, no job.
7. Delivery id (provider header, `dedupe.header`, `dedupe.path`); a repeat within `jobs.dedupe_window_seconds` -> `200` with `duplicate: true` and the original `job_id`.
8. `when` filters -> `200` with `skipped: true` when they do not match.
9. In-flight check (`dedupe.in_flight`, default `jobs.dedupe_in_flight` = `true`): a payload and query string identical to a job of this skill that is still queued or running -> `200` with `duplicate: true`, `in_flight: true` and that job's `job_id`; with `?wait=` the response waits for that job instead.
10. The job is written to disk and queued; the response is sent.

Whatever the step it stopped at, every request to `/hooks/<skill>` is recorded in the delivery log with its outcome, the status it was answered with and the reason ([`GET /deliveries`](#get-deliveries)); a refused delivery keeps its body so it can be inspected and replayed.

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

Synchronous: add `?wait=<seconds>` or send a `Prefer: wait=<seconds>` header (clamped to `max_wait_seconds`, default 120). When the job finishes in time the answer is `200`; `ok` reflects the job status, and the body also carries `outcome` and `response` (whether the task was done and what the agent reported, `null` when it reported nothing; see [skills.md](skills.md#reporting-the-outcome)):

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

Public: `{"ok": true, "version": "0.1.0"}`. Admin or direct local: adds `"uptime_seconds"`, `"queue": {"running": 0, "queued": 0, "running_ids": []}`, `"deliveries": {"total": 412, "last_received_at": "2026-09-28T10:00:02.000Z"}` (the delivery log) and `"schedules"`, one entry per skill or hook with a `schedule:`:

```json
{ "skill": "weekly-review", "cron": "0 16 * * 5", "timezone": "America/New_York", "catch_up": "latest", "overlap": "skip", "enabled": true, "webhook": false, "next_due": "2026-09-25T20:00:00.000Z", "last_slot": "2026-09-18T20:00:00.000Z", "last_fired_at": "2026-09-18T20:00:09.120Z", "last_job": "20260918T200009Z-k3x9q2", "last_status": "succeeded", "skipped": 0 }
```

The CLI and MCP server use this route to detect a running server, and `skillhook schedules list` prefers its live `schedules` over the state file.

## `GET /health/checks`

The report of [`skillhook health`](operations.md#health): `{checks, ok, summary, groups, generated_at, duration_ms, deep, network, cached, public_url?, server?}`. Each check is `{name, status: ok|warn|fail|skip, detail, hint?, group: system|skillhook|runners|tools|skills|exposure, data?}`. The server keeps one report per flavour for `health.cache_seconds` (60) and answers from it (`cached: true`); `?refresh=1` probes again, `?deep=0` leaves out the slow probes (MCP servers, plugins, `codex doctor`, last runs), and `?network=1` also asks the npm registry for a newer version and probes the public URL (off by default: the server makes no outbound request unless asked). The `server` check describes this very process (uptime, queue). Concurrent callers share one probe run.

## `GET /doctor`

The quick flavour, as `skillhook doctor` prints it: `GET /health/checks?deep=0` with `network` on by default (`?network=0` to turn it off).

## `GET /runners`

`{runners: [{runner, found, path?, version?, authenticated, method?, detail, hint?, ready, checked_at}], default_runner}` for `claude`, `codex` and `shell`: whether each is installed and logged in or given an API key, as the queue checks before every job ([runners.md](runners.md#readiness)). Answers are cached for `health.readiness_cache_seconds`; `?refresh=1` probes again.

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
      "webhook": true,
      "schedule": null,
      "dir": "/Users/me/.skillhook/skills/hello",
      "file": "/Users/me/.skillhook/skills/hello/SKILL.md",
      "source": { "type": "home" }
    },
    {
      "name": "pull-after-merge",
      "description": "Fast-forward this checkout when a pull request merges.",
      "enabled": true,
      "runner": "shell",
      "model": null,
      "effort": null,
      "cwd": "/Users/me/dev/api",
      "timeout_seconds": 900,
      "path": "/hooks/pull-after-merge",
      "auth": { "type": "hmac", "secret_env": "GITHUB_WEBHOOK_SECRET", "configured": true, "how": "github HMAC-SHA256 of the body in x-hub-signature-256 (prefix sha256=), secret $GITHUB_WEBHOOK_SECRET" },
      "when": ["header x-github-event equals \"pull_request\"", "payload.action equals \"closed\"", "payload.pull_request.merged equals true"],
      "webhook": true,
      "schedule": null,
      "dir": "/Users/me/dev/api",
      "file": "/Users/me/dev/api/skillhook.yaml",
      "source": { "type": "project", "dir": "/Users/me/dev/api", "file": "/Users/me/dev/api/skillhook.yaml", "kind": "run" }
    }
  ],
  "errors": [
    { "dir": "/Users/me/.skillhook/skills/broken", "name": "broken", "error": "Invalid SKILL.md frontmatter: …" }
  ]
}
```

`runner`, `model`, `effort`, `cwd` and `timeout_seconds` are effective values after `defaults`. `auth.type` is the normalized type: `github`, `sentry` and `linear` appear as `hmac`, `granola` and `svix` as `standard-webhooks`; `auth.how` spells out the preset. `auth.configured` says whether the secret is present. `webhook` is false for a schedule-only skill; `schedule` is `null` or `{"cron", "timezone", "catch_up", "overlap", "next_run_at"}` ([schedules.md](schedules.md)). `source` says where the skill is defined: `{"type": "home"}` for `<home>/skills/<name>`, or `{"type": "project", "dir", "file", "kind"}` for a hook of a linked repository's `skillhook.yaml` (`kind` is `run`, `skill` or `prompt`; see [projects.md](projects.md)). This call rescans the skills directory and every linked repository, so new directories and hooks appear immediately.

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

## `POST /skills/test`

Runs a SKILL.md that is not installed: the document is validated like any skill file, written to `jobs/<id>/skill/<name>/SKILL.md` (the server writes nothing outside the jobs directory) and run from there, with `trigger: "test"`, `adhoc: true`, `skill_file` pointing at that copy and `source.method: "TEST"`. Nothing is added to `<home>/skills`, and the job's default working directory is the copy's own directory unless the document or `cwd` says otherwise.

| Field | Type | Meaning |
|---|---|---|
| `skill_md` | string | The whole SKILL.md text, frontmatter included. Its `name` must be a valid skill name; the frontmatter and `skillhook:` block are validated as usual. |
| `payload`, `headers`, `runner`, `model`, `effort`, `wait` | | As in `POST /skills/<skill>/run`. |
| `cwd` | string | Working directory for the run. |

Responses are the webhook shapes plus `adhoc: true`. An invalid document is `400 invalid_skill_document` with the validation message; a missing `skill_md` is `400 bad_request`. This is what `skillhook run --file` / `--stdin` and the MCP `test_skill` tool use when a server is running.

```bash
curl -sS -X POST -H "Authorization: Bearer $SKILLHOOK_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "$(jq -n --rawfile md draft/SKILL.md '{skill_md: $md, payload: {name: "Dee"}, wait: 120}')" http://127.0.0.1:8787/skills/test
```

## `GET /jobs`

Query: `skill=<name>`, `status=<queued|running|succeeded|failed|timed_out|cancelled|interrupted>`, `outcome=<completed|partial|needs_human|nothing_to_do|failed|unknown>` (derived for jobs recorded before outcomes existed; queued and running jobs never match), `trigger=<webhook|api|cli|mcp|schedule|replay|test|resume>`, `failure=<auth|usage_limit|rate_limit|budget|max_turns|not_found|timeout|crash|unknown>` (jobs that failed that way, see [runners.md](runners.md#failure-kinds)), `waiting=1` (only jobs waiting for a person: an unanswered question, or a finished job with outcome `needs_human` that nobody answered or resumed yet), `since=<ISO-8601>` (created at or after; whole seconds), `after=<job id>` (only older jobs: the `next_after` of the previous page), `limit=<n>` (default 50, at most 500). Newest first. An unknown `status`, `outcome`, `trigger` or `since` value is `400 bad_request`.

```json
{
  "jobs": [ { "id": "20260916T025443Z-z1y3m4", "skill": "hello", "status": "succeeded", "…": "…" } ],
  "queue": { "running": 0, "queued": 0, "running_ids": [] },
  "next_after": "20260916T025443Z-z1y3m4"
}
```

`next_after` is the last id of a full page (pass it as `after` for the next one) and `null` when the page was not full.

## `GET /jobs/<id>`

`?include=result,stdout,stderr,prompt,payload,event,response` adds an `artifacts` object with file contents (each capped to its last 512 KiB and prefixed with `… [N bytes omitted]` when truncated; a file the job did not write is left out).

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

## `GET /jobs/<id>/progress`

What the running (or finished) agent reported through the job API ([skills.md](skills.md#reporting-progress-and-asking-a-person)): `{job_id, status, outcome, waiting, progress?, question?, answer?, timeline}`. `progress` is the current state (`{state: working|blocked|waiting_human|done, message, percent?, step?, updated_at}`), `question` the pending or last question (`{id, text, options?, context?, asked_at, wait_until?, answered_at?}`), `answer` the person's answer (`{question_id?, text, option?, by?, at}`) and `timeline` the entries of `progress.jsonl`, oldest first (`?limit=` keeps the last N, default 200). All of it is also on the job record.

## `POST /jobs/<id>/answer`

A person answers a job. Body:

| Field | Type | Meaning |
|---|---|---|
| `answer` | string | The answer (required). |
| `option` | string | One of the question's options, when it had any. |
| `by` | string | Who answered, for the record and the agent. |
| `resume` | `auto` \| `never` | For a job that already ended: `auto` (default) starts a new job that continues the session, `never` only records the answer. |
| `wait` | number | Seconds to wait for the resume job (also `?wait=`); clamped to `max_wait_seconds`. |

Response: `{ok, job_id, delivered, answer, resume_job_id, resume_job?, job}` with `delivered` one of `live` (the job is running and waiting; the agent's `ask` call returns the answer), `resumed` (`resume_job` is the new job with `trigger: "resume"` and `resume_of`; the original gets `resolved_by`) or `recorded`. `409 not_waiting` when the job is not waiting for a person (nothing asked, already answered, already resumed, still queued); `404 unknown_job`; `400 bad_request` without `answer` or with another `resume` value.

```bash
curl -sS -X POST -H "Authorization: Bearer $SKILLHOOK_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"answer":"Go with the smaller change","option":"A","by":"ada","wait":120}' \
  http://127.0.0.1:8787/jobs/20260916T025442Z-r1wn6g/answer
```

## `GET /jobs/<id>/artifacts/<name>`

`<name>` is one of `stdout`, `stderr`, `prompt`, `result`, `payload`, `event`, `response`. The body is the file as written, with no JSON envelope: `application/json` for `event` and for a `payload` that was parsed as JSON, `text/plain` otherwise. `x-artifact-bytes` carries the file's full size. `?tail=<bytes>` returns only the last `<bytes>` bytes and adds `x-artifact-truncated: true`. A name outside the list, or a file the job has not written yet, is `404 unknown_artifact`.

```bash
curl -sS -H "Authorization: Bearer $SKILLHOOK_ADMIN_TOKEN" "http://127.0.0.1:8787/jobs/20260916T025442Z-r1wn6g/artifacts/result"
```

## `GET /jobs/<id>/events`

A `text/event-stream` that follows one job. Messages, in order:

- `event: status`, `data:` the job record: once at connect, then after each change (`running`, `pid`/`session_id` captured, cancel requested);
- `event: stdout` / `event: stderr`, `data:` a JSON string with the new bytes, sent as the files grow (`?streams=stdout,stderr`; default `stdout`; a file already larger than 512 KiB starts at its tail);
- `event: end`, `data:` the final record, after which the server closes the stream.

A job that has already finished gets `status`, the whole output and `end` at once. A comment line (`: ping`) every 15 s keeps proxies from closing an idle stream. `skillhook jobs logs <id> -f` uses this route when a server is running, and reads the file otherwise.

## `GET /events`

A `text/event-stream` of the server's event bus. Each message carries `id` (the event's `seq`, increasing by one per event in this server process), `event` (the type) and `data` (the whole event, `{"seq", "type", "at", "data"}`). `?types=job.finished,schedule.fired` limits it to those types; an unknown type is `400 bad_request`. Events that happened before the connection, or while it was down, are not replayed: a consumer that reconnects should reconcile through `/jobs` and `/health`.

| Type | `data` |
|---|---|
| `server.started`, `server.stopping` | `{state}` (the `server.json` record) and `{reason, running}` |
| `job.queued`, `job.started`, `job.finished` | `{job}` |
| `job.updated` | `{job, fields}`: `pid`, `session_id`, `resume_command` captured while running; `runner`, `runner_requested`, `runner_reason` when a fallback runner takes over; `attempts` when a run is repeated |
| `job.cancelled` | `{job, state}` with `state` `queued` or `running`; `job.finished` follows |
| `job.progress` | `{job, entry}`: the agent reported progress, a note or its outcome (`entry` is the `progress.jsonl` line) |
| `job.waiting_human` | `{job, question}`: the agent asked a person and waits |
| `job.answered` | `{job, answer, delivered, resume_job_id?}` with `delivered` `live`, `resumed` or `recorded` |
| `schedule.registered` | `{skill, cron, timezone, next_due}` |
| `schedule.fired` | `{skill, slot, job, caught_up}` |
| `schedule.skipped` | `{skill, slot, reason}`: `in_flight`, `caught_up`, `too_old` or `duplicate` |
| `skill.changed` | `{name, action, source}` with `action` `added`, `changed` or `removed`, noticed when a lookup or listing reads the changed file |
| `health.changed` | `{report, changed}`: a fresh health report whose checks differ from the previous one of the same flavour (`changed` lists `{name, from, to}`; the first report of a flavour has `from: null`) |
| `runners.changed` | `{runner, readiness, previous?}`: a runner became usable or stopped being so (installed, logged in), as the readiness check sees it |

```bash
curl -sN -H "Authorization: Bearer $SKILLHOOK_ADMIN_TOKEN" "http://127.0.0.1:8787/events?types=job.finished,schedule.fired"
```

## `GET /deliveries`

The delivery log: one record per request to `/hooks/<skill>`, newest first, whatever became of it. Query: `skill=<name>`, `outcome=<accepted|duplicate|in_flight|skipped|rejected|challenge|error>`, `since=<ISO-8601>`, `after=<delivery id>` (the `next_after` of the previous page), `limit=<n>` (default 50, at most 500).

```json
{
  "deliveries": [
    { "id": "20260928T100002Z-q7m2ka", "skill": "gh", "received_at": "2026-09-28T10:00:02.418Z", "outcome": "rejected", "http_status": 401, "code": "invalid_signature", "reason": "signature mismatch", "ip": "140.82.115.6", "method": "POST", "path": "/hooks/gh", "query": {}, "headers": { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": "b3e4…" }, "user_agent": "GitHub-Hookshot/abc", "content_type": "application/json", "bytes": 9412, "body_stored": true, "duration_ms": 2 },
    { "id": "20260928T095910Z-x1p0ll", "skill": "hello", "received_at": "2026-09-28T09:59:10.101Z", "outcome": "accepted", "http_status": 202, "delivery_id": null, "job_id": "20260928T095910Z-k3x9q2", "ip": "127.0.0.1", "method": "POST", "path": "/hooks/hello", "query": {}, "headers": { "content-type": "application/json", "user-agent": "skillhook-send" }, "user_agent": "skillhook-send", "content_type": "application/json", "bytes": 15, "body_kind": "json", "body_stored": false, "duration_ms": 4 }
  ],
  "next_after": null
}
```

The log lives in `jobs/.delivery-log/` and keeps the newest `deliveries.max` (2000) records. It is the answer to "why did that webhook not run": a `rejected` record carries the error code and message the sender got, a `skipped` one the `when` condition that did not match, a `duplicate` or `in_flight` one the job it was folded into. Rate-limited requests to a hook are recorded too (`429 rate_limited`). CLI: `skillhook deliveries list|show`; MCP: `list_deliveries`, `get_delivery`.

## `GET /deliveries/<id>`

`{"delivery": {…}}`; `?include=body` adds `"body": {"encoding": "utf8" | "base64", "text": "…", "truncated": false, "source": "log" | "job"}`: the body the log kept for a refused delivery (`skipped`, `rejected`, `error`; at most `deliveries.body_max_bytes`, 64 KiB, and only while `deliveries.store_bodies` is on), or the payload of the job an accepted delivery created; `null` when neither exists. An unknown id is `404 unknown_delivery`.

## `POST /deliveries/<id>/replay`

Runs a recorded delivery again through the skill as it is now: the original payload, headers (redacted, plus `x-skillhook-replay-of: <delivery id>`), query string and sender IP, as a new job with `trigger: "replay"`, `source.method: "REPLAY"` and `replay_of: {"delivery": "<id>", "job": "<original job id>"}` (the job is present when the delivery had been accepted; its `event.json` and `body.bin` are then what is replayed). The signature is not checked again, `when` filters apply unless skipped, and nothing is de-duplicated: a replay never counts as a duplicate and is never folded into a job still in flight, and it carries no `delivery_id` itself.

Body: a JSON object, all fields optional.

| Field | Type | Meaning |
|---|---|---|
| `force` | boolean | Replay a delivery that was `rejected` or `error`, whose body was therefore never verified. Without it the answer is `409 replay_needs_force`. |
| `skip_filters` | boolean | Run even when the skill's `when` conditions do not match; otherwise a non-match answers `200 {"ok": true, "skipped": true, "reason", "replay_of"}`. |
| `runner`, `model`, `effort` | string | Overrides for this run, as in `POST /skills/<skill>/run`. |
| `wait` | number | Seconds to wait for the result (also `?wait=`); clamped to `max_wait_seconds`. |

Responses are the webhook shapes (`202` queued, `200` finished when waiting) plus `replay_of`. Errors: `404 unknown_delivery`, `404 unknown_skill` (the skill is gone or disabled), `409 replay_needs_force`, `409 no_body` (the body was not kept: `deliveries.store_bodies` was off, it was cut at `deliveries.body_max_bytes`, or the record was compacted away), `400 bad_request` (not a JSON object, or an unknown `runner`).

```bash
curl -sS -X POST -H "Authorization: Bearer $SKILLHOOK_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"skip_filters": true, "wait": 60}' "http://127.0.0.1:8787/deliveries/20260928T100002Z-q7m2ka/replay"
```

## `POST /jobs/<id>/replay`

The same for an earlier job, whatever its trigger: its `event.json` (payload, redacted headers, query) is run again as a new job with `trigger: "replay"` and `replay_of: {"job": "<id>"}`. The body takes `skip_filters`, `runner`, `model`, `effort` and `wait` as above (`force` is not needed: a job's request was accepted). `404 unknown_job` / `404 unknown_skill`.

## Delivery record

| Field | Type | Notes |
|---|---|---|
| `id` | string | Same format as job ids; the delivery log's own id, distinct from the provider's `delivery_id`. |
| `skill` | string | The name in the URL, as requested, also when no such skill exists. |
| `received_at` | ISO-8601 | |
| `outcome` | string | `accepted` (a job was created), `duplicate` (delivery id seen before), `in_flight` (folded into a queued or running job), `skipped` (a `when` filter), `rejected` (any error answer: 401, 403, 404, 413, 429, 500, 503), `challenge` (Slack URL verification), `error` (unexpected server error). |
| `http_status` | number | What the sender was answered at decision time; a `?wait=` request may have ended as `200` with the result instead of `202`. |
| `code`, `reason` | string, optional | The error code and message of a rejected delivery; `duplicate`, `in_flight`, `skipped` (with the condition as `reason`), `challenge` or `internal_error` otherwise. Absent when accepted. |
| `delivery_id` | string, optional | Provider delivery id or `dedupe` value, when one was found. |
| `job_id` | string, optional | The job created, or the one the delivery was folded into. |
| `ip`, `method`, `path`, `query` | | The request (`token` and `wait` removed from `query`). |
| `headers` | object | Redacted like `event.json` (no authorization, signature, token or cookie headers); values over 512 characters are shortened. |
| `user_agent`, `content_type`, `bytes`, `body_kind` | | The body as received (`body_kind` is only known once the body was parsed). |
| `body_stored`, `body_truncated` | boolean | Whether the log kept the body, and whether it was cut at `deliveries.body_max_bytes`. |
| `duration_ms` | number | From arrival to the decision (a `?wait=` is not counted). |

## Job record

| Field | Type | Notes |
|---|---|---|
| `id` | string | `YYYYMMDDTHHMMSSZ-<6 chars>`, UTC, sortable; also the directory name under `jobs/`. |
| `skill` | string | |
| `status` | string | `queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`, `interrupted`. |
| `trigger` | string | `webhook`, `api`, `cli`, `mcp`, `schedule` (fired by a `schedule:`), `replay` (an operator replayed a delivery or job), `test` (a SKILL.md supplied with the request), `resume` (a person answered an earlier job; this run continues it). |
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
| `outcome` | string, optional | Whether the task was done, set when the job ends: `completed`, `partial`, `needs_human`, `nothing_to_do`, `failed` (also every status other than `succeeded`) or `unknown` (the agent reported nothing). See [skills.md](skills.md#reporting-the-outcome). |
| `response` | object, optional | What the agent reported: `{"outcome", "summary", "links"?, "data"?}` (`data` is capped at 64 KiB here; complete in `response.json`). |
| `replay_of` | object, optional | For `trigger: replay`: `{"delivery"?: "<delivery-log id>", "job"?: "<original job id>"}`. |
| `progress` | object, optional | What the agent last reported: `{"state": "working"\|"blocked"\|"waiting_human"\|"done", "message", "percent"?, "step"?, "updated_at"}`. |
| `question` | object, optional | The question the agent asked a person: `{"id", "text", "options"?, "context"?, "asked_at", "wait_until"?, "answered_at"?}`; pending until `answered_at` is set. |
| `answer` | object, optional | The person's answer: `{"question_id"?, "text", "option"?, "by"?, "at"}`. |
| `resume_of`, `resume` | optional | For `trigger: resume`: the job whose answer this run carries, and `{"session_id", "runner"}` when that job's session is continued (absent when the skill had to run afresh; `runner_reason` then says why). |
| `resolved_by` | string, optional | The resume job an answer to this job started. |
| `runner_reason` | string, optional | Why the run differs from what was asked: a resume without a session, or a fallback runner (`fallback: claude not logged in`, `fallback: claude failed (rate_limit)`). |
| `runner_requested` | string, optional | The runner the skill asked for, when `runner` is a fallback that took over. |
| `failure` | object, optional | For `failed` and `timed_out` jobs: `{"kind", "code"?, "retryable", "message"?}` with `kind` one of `auth`, `usage_limit`, `rate_limit`, `budget`, `max_turns`, `not_found`, `timeout`, `crash`, `unknown` ([runners.md](runners.md#failure-kinds)). |
| `attempts` | array, optional | Earlier runs of this job that a `retry:` or `fallback:` repeated: `[{runner, started_at, finished_at, status, error?, failure?}]`; the record itself is the last attempt. |
| `adhoc` | `true`, optional | The SKILL.md came with the request (`POST /skills/test`, `skillhook run --file`) and lives in `jobs/<id>/skill/<name>/`. |
| `skill_file` | string, optional | The `SKILL.md` (or `skillhook.yaml`) the job ran from. |
| `delivery_id` | string, optional | Provider delivery id when known; `schedule:<wall-clock slot>` for scheduled runs. |
| `fingerprint` | string, optional | SHA-256 of the payload and query string of a webhook delivery; what the in-flight duplicate check compares. |
| `source` | object | `ip`, `method` (`POST`, `PUT`, `LOCAL` for CLI/MCP runs, `SCHEDULE` for scheduled runs, `REPLAY` for replays, whose `ip` is the original sender's, `TEST` for ad-hoc runs, `RESUME` for resumed runs), `path`, `content_type`, `user_agent`. |

`job.json` on disk also contains `command` (the exact argv); API responses omit it.

## Status and error codes

| HTTP | `error` | Meaning |
|---|---|---|
| 200 | — | Result available, duplicate, skipped, Slack challenge, admin reads, successful cancel. |
| 202 | — | Job queued (or still running after `wait`). |
| 400 | `bad_request` | `/skills/<skill>/run` body is not a JSON object; unknown `?types=` (`/events`), `?streams=` (`/jobs/<id>/events`), `?status=`/`?trigger=` (`/jobs`), `?outcome=` (`/deliveries`) or malformed `?since=` value; `/skills/test` without `skill_md`; `/jobs/<id>/answer` without `answer` or with a `resume` other than `auto`/`never`; an unknown `?failure=` kind (`/jobs`). |
| 400 | `invalid_skill_document` | `/skills/test`: the SKILL.md does not validate (the message says why). |
| 401 | `missing_token`, `invalid_token`, `missing_credentials`, `invalid_credentials`, `missing_signature`, `invalid_signature`, `missing_timestamp`, `invalid_timestamp`, `stale_timestamp` | Webhook authentication failed. |
| 401 | `unauthorized` | Admin route without a valid token. |
| 403 | `ip_not_allowed` | Client IP not in the skill's `allow_ips`. |
| 404 | `unknown_skill`, `unknown_job`, `unknown_artifact`, `unknown_delivery`, `not_found` | |
| 404 | `schedule_only` | The skill has `webhook: false`; it runs only on its `schedule:`. |
| 405 | `method_not_allowed` | |
| 409 | — (`ok: false`) | Cancel on a finished job. |
| 409 | `replay_needs_force`, `no_body` | Replaying a rejected delivery without `force`; a delivery whose body was not kept. |
| 409 | `not_waiting`, `unknown_skill` | Answering a job that is not waiting for a person; the skill of the job to resume no longer exists. |
| 413 | `payload_too_large` | Body over `max_body_bytes`. |
| 429 | `rate_limited`, `too_many_failures` | Per-IP limits. |
| 500 | `invalid_skill`, `internal_error` | `SKILL.md` failed to parse; unexpected error (see the server log). |
| 503 | `skill_not_configured` | The skill's secret env var is not set. |
