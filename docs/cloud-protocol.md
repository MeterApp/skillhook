# Skillhook Cloud protocol

The messages between a machine and Skillhook Cloud, as zod schemas in `src/cloud/protocol.ts`, exported as `@meterapp/skillhook/protocol` (no Node built-ins, so the cloud can import it in any runtime). `PROTOCOL_VERSION` is 1; the cloud answers `426 upgrade_required` with `min_protocol_version` to a machine that is too old, and keeps accepting older versions within its supported range.

## Transport

Outbound HTTPS from the machine only:

| Request | Purpose |
|---|---|
| `POST /api/agent/pair` | `PairRequest` (a pairing code from the dashboard, or a token) → `PairResponse` (`machine_id`, `machine_token` shown once, `mode`, `dashboard_url`). |
| `POST /api/agent/sync` | `SyncRequest` → `SyncResponse` (or `SyncError`). The machine's heartbeat, event upload, command channel and hosted-ingress channel, all in one; `wait: true` lets the cloud hold the request up to `LIMITS.long_poll_seconds` (25) when it has nothing to say. `Authorization: Bearer <machine_token>`, `x-skillhook-protocol: 1`. |
| `PUT /api/agent/artifacts/<job>/<name>` | Chunked upload of a job artifact for `job.artifact`: `application/octet-stream` bodies of `LIMITS.artifact_chunk_bytes` (1 MiB), in order, each with `Content-Range: bytes <start>-<end>/<total>` and `x-skillhook-sha256` (hex SHA-256 of the whole, already scrubbed, file); at most `LIMITS.max_artifact_bytes` (32 MiB). |
| `POST /api/agent/disconnect` | Revoke the token (`skillhook cloud disconnect`). |

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
- `secret.generate`: `{secret_env, existed, generated}` with the value in the result's `sealed` field only, `sensitive: true`.
- `job.artifact`: `{job_id, name, bytes, text, truncated}` inline, or `{job_id, name, uploaded: true, bytes, sha256, chunks}`.
- `service.restart`: `{restarting: true, when, wait_seconds, running}`; the restart begins once a sync response acknowledges this result (or 15 seconds later).

## Ordering and idempotency

Events carry a per-machine `seq`; the cloud de-duplicates on `(machine_id, seq)`, the machine on command ids and ingress ids, and both sides re-send until acknowledged, so a lost response is never lost work.

## Command classes and policy

`COMMAND_CLASS` says what each command type needs: `read` (both modes), `control` (`cloud.mode: control` or an entry in `cloud.allow_commands`) or `allow_list` (`secret.set`: only with an explicit entry). `cloud.deny_commands` wins over everything; patterns are exact types, `prefix.*` or `*`. `commandAllowed(type, policy)` in `src/cloud/config.ts` is the single implementation.

## Sealed values

A `secret.generate` result (and a `secret.set` argument) is sealed to a recipient's X25519 public key: an ephemeral X25519 key pair, HKDF-SHA256 over the shared secret, AES-256-GCM; `{recipient_key, ephemeral_public_key, nonce, ciphertext}` as base64url. The cloud stores a sealed result for at most two minutes and only the recipient can open it.
