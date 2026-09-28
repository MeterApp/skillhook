# Skillhook Cloud

Skillhook Cloud is the hosted control plane for machines running skillhook: every webhook and job of every machine in one place, health of the CLIs and their MCP servers, replay, stats, a playground for skills, remote configuration from a browser or from an MCP client, alerts, and hosted webhook URLs that keep deliveries while a machine is asleep. It is a separate service (`MeterApp/skillhook-cloud`); this document is about the machine side.

**Status.** This version ships the settings (`cloud.*` below) and the wire protocol ([cloud-protocol.md](cloud-protocol.md), also exported as `@meterapp/skillhook/protocol`) so the service can be built against them. The link itself (`skillhook cloud connect`, the sync loop) is not in this version: nothing leaves the machine, whatever `cloud.enabled` says, until a version that carries the link.

## Principles

- **Opt-in, outbound only.** A machine talks to the cloud only after `skillhook cloud connect` pairs it (a code from the dashboard) and only by opening HTTPS requests to `cloud.url`; the cloud never connects to the machine and never holds the admin token. It works behind NAT without Tailscale.
- **Observe by default.** A freshly paired machine is in `mode: observe`: the cloud can read, not act. `--control` at pairing (what the dashboard's pairing page prints) or `cloud.mode: control` later lets it run skills, answer jobs, change the configuration and restart the server. `cloud.allow_commands` / `cloud.deny_commands` refine either mode per command type; the cloud cannot raise a machine's exposure, only the machine's own config can.
- **Payloads are data, secrets stay home.** Headers are redacted on the machine before anything is uploaded; every uploaded string is scrubbed against every value in `.env`; webhook bodies travel only when both `cloud.upload_payloads` and the organisation's policy allow, and never beyond 256 KiB. `SKILLHOOK_CLOUD_*` variables never reach a run, even when a skill lists them in `env:`. A secret the cloud asks skillhook to generate is sealed to the requester's key; the cloud never stores it in the clear.
- **Kill switches.** `cloud.enabled: false`, `SKILLHOOK_NO_CLOUD=1` in the server's environment, or `skillhook cloud disconnect` stop all traffic; the link never starts from `init`, from a job, or on its own.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `cloud.enabled` | `false` | Whether the server keeps a link open. Written by `skillhook cloud connect` / `disconnect`. |
| `cloud.url` | `https://cloud.skillhook.dev` (placeholder) | The service. `SKILLHOOK_CLOUD_URL` overrides it; plain `http` is accepted only for loopback addresses or with `SKILLHOOK_CLOUD_ALLOW_INSECURE=1`. |
| `cloud.machine_id` | unset | Assigned at pairing. |
| `cloud.mode` | `observe` | `observe` or `control`. |
| `cloud.allow_commands`, `cloud.deny_commands` | `[]` | Command types (`skill.run`, patterns like `job.*`, `*`) allowed regardless of mode, or refused regardless of anything. `secret.set` is never allowed without an explicit allow entry. |
| `cloud.upload_payloads` | `true` | Upload webhook payloads with deliveries (redacted headers; bodies at most 256 KiB). |
| `cloud.upload_artifacts` | `true` | Let the cloud fetch job artifacts and live output. |
| `cloud.ingress` | `true` | Accept hosted-ingress deliveries (webhooks the cloud received for this machine). |
| `cloud.snapshot_interval_seconds` | `60` | How often the full snapshot (skills, schedules, config, health summary) is sent. |
| `cloud.health_interval_seconds` | `600` | How often a deep health report is sent. |
| `cloud.outbox_max_events` | `5000` | Events kept on disk while the cloud is unreachable. |

The machine token lives in `.env` as `SKILLHOOK_CLOUD_TOKEN` (an optional X25519 private key as `SKILLHOOK_CLOUD_PRIVATE_KEY`); both are written once by `skillhook cloud connect` and never printed again.

## What leaves the machine (once the link exists)

Events as they happen: deliveries (record, redacted headers, body when allowed), jobs (records, outcomes, results up to 8 KiB inline, progress, questions and answers), schedules, skill changes, config changes (values, never `.env`), health reports, runner readiness; on request, job artifacts and live output. The snapshot every minute: skill summaries, schedules, projects, the effective configuration, health and readiness summaries, stats. Never: `.env`, the admin token, the SKILL.md bodies of skills unless `skill.get` is allowed, anything a command policy refuses.

## Commands the cloud may send

Read commands (both modes): `ping`, `health.get`, `snapshot.get`, `runners.get`, `skills.list`, `skill.get`, `delivery.list`, `delivery.get`, `job.list`, `job.get`, `job.artifact`, `job.watch`, `job.unwatch`, `job.progress.get`, `stats.get`, `config.get`, `secret.list` (names only), `service.status`, `logs.tail`, `schedules.list`, `update.check`, `expose.status`.

Control commands (`mode: control` or an allow entry): `skill.put`, `skill.delete`, `skill.run`, `skill.test`, `delivery.replay`, `job.cancel`, `job.replay`, `job.answer`, `config.patch` (never `host`, `port`, `trust_proxy`, `runners.*`, `env_passthrough`, `projects`, `cloud.*`), `secret.generate` (sealed), `service.restart`, `schedule.run`, `update.install`.

Allow-list only: `secret.set` (a value sealed to this machine's key).
