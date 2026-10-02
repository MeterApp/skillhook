# Skillhook Cloud protocol

The messages between a machine and Skillhook Cloud, as zod schemas in `src/cloud/protocol.ts`, exported as `@meterapp/skillhook/protocol` (no Node built-ins, so the cloud can import it in any runtime). `PROTOCOL_VERSION` is 1; the cloud answers `426 upgrade_required` with `min_protocol_version` to a machine that is too old, and keeps accepting older versions within its supported range. The cloud's public API (`/api/v1`, organisation API keys), which `skillhook cloud login|overview|machines|jobs|job|tools|<tool>|secret` and `skillhook mcp --cloud` use, is the cloud's own and not part of this protocol; skillhook parses its answers loosely and takes its tools from the cloud's catalogue (`GET /api/v1/tools`) at run time ([cloud.md](cloud.md#the-whole-organisation-with-an-api-key)).

## Transport

Outbound HTTPS from the machine only:

| Request | Purpose |
|---|---|
| `POST /api/agent/pair` | `PairRequest` (a pairing code from the dashboard, or a token) → `PairResponse` (`machine_id`, `machine_token` shown once, `mode`, `dashboard_url`). |
| `POST /api/agent/sync` | `SyncRequest` → `SyncResponse` (or `SyncError`). The machine's heartbeat, event upload, command channel and hosted-ingress channel, all in one; `wait: true` lets the cloud hold the request up to `LIMITS.long_poll_seconds` (25) when it has nothing to say. `Authorization: Bearer <machine_token>`, `x-skillhook-protocol: 1`. |
| `PUT /api/agent/artifacts/<job>/<name>` | Chunked upload of a job artifact for `job.artifact`: `application/octet-stream` bodies of `LIMITS.artifact_chunk_bytes` (1 MiB), in order, each with `Content-Range: bytes <start>-<end>/<total>` and `x-skillhook-sha256` (hex SHA-256 of the whole, already scrubbed, file); at most `LIMITS.max_artifact_bytes` (32 MiB). |
| `POST /api/agent/disconnect` | Revoke the token (`skillhook cloud disconnect`). |
| `POST /api/agent/issues` | `IssueReportRequest` → `IssueReportResponse`: a problem report from a person on the machine (`skillhook cloud report`, MCP `cloud_report_issue`), never from the link. `Authorization: Bearer <machine_token>`, a JSON body of at most `LIMITS.max_issue_report_bytes` (64 KiB). See [Issue reports](#issue-reports). |

## `SyncRequest`

| Field | Content |
|---|---|
| `protocol_version` | `1` |
| `sent_at` | The machine clock (the cloud derives skew). |
| `wait` | Nothing is pending; the cloud may hold the request. |
| `machine` | `{id, hostname, os, arch, skillhook_version, node_version, started_at, public_url?}` |
| `status` | `{queue: {running, queued}, running_jobs, link: {state, reason?, mode, outbox_depth, dropped_total, watched_jobs}}` |
| `snapshot?` | On connect and every `cloud.snapshot_interval_seconds`: skills, skill errors, projects, schedules, effective config, health and readiness summaries, stats. |
| `events` | Up to 200 `EventEnvelope`s: `{id: "<machine_id>:<seq>", seq, ts, machine_id, type, data}`; `seq` increases by one per durable event, `null` for transient `job.output`. Types: the server's own `delivery.received`, `job.*`, `schedule.*`, `skill.changed`, `config.changed`, `health.changed`, `runners.changed`, plus `link.started`, `link.stopped`, `health.report`, `job.output`. |
| `command_results` | Up to 50 `{command_id, ok, result?, error?: {code, message, hint?}, sensitive?, sealed?, started_at, finished_at, duration_ms}`; re-sent until acknowledged. |
| `ingress_acks` | `{id, outcome, http_status, job_id?, code?, reason?}` for hosted-ingress deliveries processed since the last sync. |
| `ack.commands_received` | Command ids received (the cloud stops re-sending them). |

## `SyncResponse`

| Field | Content |
|---|---|
| `ack.events_through` | Every event with `seq` ≤ this is durable on the cloud; the machine drops it from its outbox. `ack.command_results` lists result ids stored. |
| `commands` | Up to 50 `{id, type, args?, issued_at, expires_at?, timeout_ms?, requested_by?}`. The machine validates `args` against `COMMAND_ARGS[type]`, checks the policy (`commandAllowed`), runs them one at a time, and answers with a `CommandResult` in a later sync. |
| `ingress` | Up to 20 hosted-ingress deliveries `{id, skill, received_at, method, path, query, headers (raw), body_base64 (≤ 1 MiB), content_type, source_ip}`, fed through the ordinary webhook pipeline (signature verified with the local secret, dedupe, `when` filters, queue) and acknowledged in the next sync. |
| `next_poll_ms` | When to sync again if nothing is pending. |
| `hints?` | Only ever reduce or inform: `snapshot_interval_s`, `health_interval_s`, `upload_payloads: false`, `upload_artifacts: false`, `max_event_bytes`, `max_batch_events`, `mode: interactive \| idle`, `ingress_urls` (per skill). |
| `rotate?` | `{token, old_valid_until}`: a new machine token to store; the old one keeps working until then. |
| `notice?` | A line for the server log. |

Errors are `SyncError` `{ok: false, error, message?, retry_after_ms?, min_protocol_version?}` with HTTP status: `401 invalid_token` and `403 machine_disabled` stop the link until the config or the token changes; `413 payload_too_large` halves the batch; `426 upgrade_required` retries in ten minutes; `429 rate_limited` honours `retry_after_ms`; `5xx` and network errors back off exponentially (1 s to 60 s with full jitter).

## Transient output

`job.watch` makes the machine send `job.output` events with `seq: null` and an id of the form `<machine_id>:out:<uuid>`: `{job_id, stream, offset, chunk, eof?, status?, expired?}`. They ride along with the next sync, are never spooled to disk and are not re-sent if that request fails.

## Command results worth knowing

- `skill.run`, `skill.test`, `delivery.replay`, `job.replay`, `schedule.run`: `{accepted: true, job_id, …}` (a replay whose filters do not match: `{accepted: false, skipped: true, reason}`); the job itself is followed through its events.
- `job.answer`: `{job_id, delivered: live|resumed|recorded, answer, resume_job_id}`.
- `config.patch`: `{applied, restart_required_keys, pending_restart}`.
- `secret.generate`: `{secret_env, existed, generated}` with the value in the result's `sealed` field only, `sensitive: true`. It and `secret.set` answer `denied_by_policy` for the machine's own credentials (`SKILLHOOK_CLOUD_*`, `SKILLHOOK_ADMIN_TOKEN`) by any name.
- `job.artifact`: `{job_id, name, bytes, text, truncated}` inline, or `{job_id, name, uploaded: true, bytes, sha256, chunks}`. While webhook bodies may not leave the machine (`cloud.upload_payloads: false`, or the hint `upload_payloads: false`), `payload`, `event` and `prompt` answer `denied_by_policy`, and `job.get` leaves them out of `artifacts` and names them in `artifacts_withheld`.
- `service.restart`: `{restarting: true, when, wait_seconds, running}`; the restart begins once a sync response acknowledges this result (or 15 seconds later).

## Ordering and idempotency

Events carry a per-machine `seq`; the cloud de-duplicates on `(machine_id, seq)`, the machine on command ids and ingress ids, and both sides re-send until acknowledged, so a lost response is never lost work.

## Command classes and policy

`COMMAND_CLASS` says what each command type needs: `read` (both modes), `control` (`cloud.mode: control` or an entry in `cloud.allow_commands`) or `allow_list` (`secret.set`: only with an explicit entry). `cloud.deny_commands` wins over everything; patterns are exact types, `prefix.*` or `*`. `commandAllowed(type, policy)` in `src/cloud/config.ts` is the single implementation.

## Issue reports

`POST {cloud.url}/api/agent/issues` with `Authorization: Bearer <machine_token>` and a JSON `IssueReportRequest` of at most `LIMITS.max_issue_report_bytes` (64 KiB), which the machine sends only when a person asks for it:

| Field | Content |
|---|---|
| `title` | 1 to 200 characters. |
| `body?` | At most 20,000 characters. |
| `kind?` | `ISSUE_KINDS`: `bug`, `question`, `feature`, `other`; the cloud defaults to `bug`. |
| `severity?` | `ISSUE_SEVERITIES`: `low`, `normal`, `high`, `urgent`; the cloud defaults to `normal`. |
| `contact_email?` | An email address, at most 320 characters. |
| `job_id?`, `delivery_id?`, `skill?` | What the report is about: the machine's own job id, a delivery id, a skill name. References only. |
| `report_id?` | A client-generated idempotency key, 8 to 100 of `A-Z a-z 0-9 _ -`: a retry with the same `report_id` returns the original report instead of filing a second one. |
| `diagnostics?` | `IssueDiagnostics`: `skillhook_version`, `node_version`, `os`, `arch`, `mode`, `link {state, reason?, last_error? (≤ 500)}`, `runners [{runner, ready}]` (≤ 3), `health {ok, summary {ok, warn, fail, skip}, failing? [{id (≤ 200), status, message? (≤ 500)}] (≤ 50)}`; every field optional, unknown fields kept (`.loose()`). |

The request is strict (unknown fields are refused). The machine scrubs every `.env` value from the title, the body and the diagnostics before sending, like everything the link uploads, and never attaches payloads, logs, prompts or job output. The answer is `IssueReportResponse` `{ok: true, issue_id, number, url, acknowledged}`: the issue's id, its number and URL on the dashboard, and whether a confirmation email went out; it is the same for a new report and for a retry of one. `skillhook cloud report` generates a `report_id` (a UUID) per report and sends it with every attempt: it retries network errors, timeouts and `5xx` (three attempts in all), a `429` only after the `retry_after_ms` it asked for (when that is at most 15 seconds), and never another `4xx`. Errors have the agent API's shape (`{ok: false, error, message, retry_after_ms?}`, as `SyncError`): `401 invalid_token`, `403 machine_disabled`, `400 invalid_request`, `413 payload_too_large`, `429 rate_limited` (with `retry_after_ms`), `500 server_error`. The endpoint and its schemas are additive, so `PROTOCOL_VERSION` stays 1; a cloud without the route answers `404`, which the CLI reports as such.

## Sealed values

A `secret.generate` result (and a `secret.set` argument) is sealed to a recipient's X25519 public key: an ephemeral X25519 key pair, HKDF-SHA256 over the shared secret, AES-256-GCM; `{recipient_key, ephemeral_public_key, nonce, ciphertext}` as base64url. The cloud stores a sealed result for at most two minutes and only the recipient can open it.
