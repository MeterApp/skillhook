# Skillhook Cloud

Skillhook Cloud is the hosted control plane for machines running skillhook: every webhook and job of every machine in one place, health of the CLIs and their MCP servers, replay, stats, a playground for skills, remote configuration from a browser or from an MCP client, alerts, and hosted webhook URLs that keep deliveries while a machine is asleep. It is a separate service (`MeterApp/skillhook-cloud`); this document is about the machine side.

**Status.** The link is in this version: `skillhook cloud connect` pairs a machine, the running server keeps one outbound connection to the cloud, uploads what happens, runs the commands below as far as `cloud.mode` and the allow/deny lists permit, and delivers webhooks that arrived at the machine's hosted URLs.

## Principles

- **Opt-in, outbound only.** A machine talks to the cloud only after `skillhook cloud connect` pairs it (a code from the dashboard) and only by opening HTTPS requests to `cloud.url` (plain `http` only to a loopback address or with `SKILLHOOK_CLOUD_ALLOW_INSECURE=1`); the cloud never connects to the machine and never holds the admin token. It works behind NAT without Tailscale. Besides the link, [`cloud report`](#reporting-a-problem) and the [API-key commands](#reading-the-fleet-with-an-api-key) send one request each, to the same URL, only when a person runs them.
- **Observe by default.** A freshly paired machine is in `mode: observe`: the cloud can read, not act. `--control` at pairing (what the dashboard's pairing page prints) or `cloud.mode: control` later lets it run skills, answer jobs, change the configuration and restart the server. `cloud.allow_commands` / `cloud.deny_commands` refine either mode per command type; the cloud cannot raise a machine's exposure, only the machine's own config can.
- **Payloads are data, secrets stay home.** Headers are redacted on the machine before anything is uploaded; every uploaded string is scrubbed against every value in `.env`; webhook bodies travel only when both `cloud.upload_payloads` and the organisation's policy allow, and never beyond 256 KiB. `SKILLHOOK_CLOUD_*` variables never reach a run, even when a skill lists them in `env:`. A secret the cloud asks skillhook to generate is sealed to the requester's key; the cloud never stores it in the clear.
- **Kill switches.** `cloud.enabled: false`, `SKILLHOOK_NO_CLOUD=1` in the server's environment, or `skillhook cloud disconnect` stop all traffic; the link never starts from `init`, from a job, or on its own. With `SKILLHOOK_NO_CLOUD=1` in its environment, `cloud report` and the API-key commands refuse to send anything too.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `cloud.enabled` | `false` | Whether the running server keeps a link open. Written by `skillhook cloud connect` / `disconnect`; the server follows it within seconds, without a restart. |
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

The machine token lives in `.env` as `SKILLHOOK_CLOUD_TOKEN` (an optional X25519 private key as `SKILLHOOK_CLOUD_PRIVATE_KEY`); both are written once by `skillhook cloud connect` and never printed again. An organisation API key that a person keeps with `skillhook cloud login` lives there as `SKILLHOOK_CLOUD_API_KEY`; the link never uses it. Like every `SKILLHOOK_CLOUD_*` variable, none of them ever reaches a run.

## Connecting

On the dashboard's pairing page choose *Control* or *Observe* and copy the command it prints:

```bash
skillhook cloud connect --code ABCD-EFGH --control
```

`connect` sends the code with a description of the machine (hostname, OS, architecture, skillhook and Node versions, public URL), receives a machine id and a machine token, stores the token in `.env` as `SKILLHOOK_CLOUD_TOKEN` (mode 600, never printed), writes `cloud.url`, `cloud.machine_id`, `cloud.mode` and finally `cloud.enabled: true` to `skillhook.json`, and tells a running server to re-read its configuration; the link is up within seconds. Without `--control` the machine is paired in `observe` mode. `--url` (or `SKILLHOOK_CLOUD_URL`) points at another deployment; `--token` pairs with a machine token instead of a code; `--force` pairs a machine that is already connected again.

```bash
skillhook cloud status        # enabled, URL, machine id, mode, token present, and the running server's link state
```

```bash
skillhook cloud disconnect    # cloud.enabled: false, token removed from .env and revoked, local spool deleted
```

`disconnect --keep-token` leaves the token in `.env`. `skillhook doctor` and `skillhook health` report a `cloud link` check: skipped when not connected, failing when `cloud.enabled` has no token, an `http` URL, or a revoked token or disabled machine, warning when no server runs, the link is degraded or events were dropped.

## Reporting a problem

A person on a paired machine can tell the Skillhook team about a problem without leaving the terminal:

```bash
skillhook cloud report "GitHub deliveries fail since the update" --body-file notes.txt --job 20260929T101500Z-a1b2c3 --email ada@example.com
skillhook cloud report "Where do hosted URLs come from?" --kind question --no-diagnostics
skillhook cloud report "Replays hang" --body - --dry-run < notes.txt     # print exactly what would be sent, send nothing
```

It sends one request, `POST {cloud.url}/api/agent/issues` with the machine token ([cloud-protocol.md](cloud-protocol.md#issue-reports)), carrying exactly:

- `title`: the argument (or `--title`), at most 200 characters;
- `body`: `--body TEXT`, `--body -` (stdin) or `--body-file PATH`, at most 20,000 characters;
- `kind` (`--kind bug|question|feature|other`; the cloud files a report without one as `bug`), `severity` (`--severity low|normal|high|urgent`; `normal`) and `contact_email` (`--email`), when given;
- `job_id` (the machine's own job id), `delivery_id` and `skill` (`--job`, `--delivery`, `--skill`), when given: references only, the job or delivery itself stays on the machine;
- `report_id`: a UUID generated for this report, the same on every attempt, so the cloud files it once however often it is retried;
- unless `--no-diagnostics`, `diagnostics`: `skillhook_version`, `node_version`, `os`, `arch`, the machine's `cloud.mode`, the link's `state`, `reason` and `last_error` (from the running server), whether each runner is ready (`{runner, ready}` only), and the health summary (how many checks are ok, warn, fail, skip) with the checks that fail or warn (`id`: the check's name, `status`, `message`: its detail line; at most 50). With a running server these are its cached answers; without one, a quick local check (the doctor's checks, no network probes) and the runners' readiness.

Every value in `.env` is replaced with `[redacted]` in the title, the body, the references and the diagnostics before anything leaves, as for everything the link sends (a contact address that is itself a value from `.env` is refused). Nothing else goes: never payloads, logs, prompts, job output, command lines, environments or `.env` itself. `--dry-run` prints the JSON that would be sent. The answer is `Reported as #N: <url>` and whether a confirmation email went out; `--json` prints the cloud's answer (`{ok, issue_id, number, url, acknowledged}`). Network errors, timeouts and `5xx` answers are retried (three attempts), a `429` only when the cloud asks for a pause of at most 15 seconds, another `4xx` never.

It needs a paired machine (`cloud.enabled` and `SKILLHOOK_CLOUD_TOKEN`); on one that is not, pair it first or report the problem on the dashboard or through its hosted MCP server. It refuses under `SKILLHOOK_NO_CLOUD=1` and to a `cloud.url` that is not https. The MCP tool `cloud_report_issue` sends the same report for an agent the person asked to file one ([mcp.md](mcp.md)).

## Reading the fleet with an API key

The organisation's machines and jobs can be read from any terminal with an organisation API key (`shc_…`; an admin creates one on the dashboard under Settings → API keys, and `fleet:read` is enough):

```bash
pbpaste | skillhook cloud login --key -     # or --key shc_…; checked, then kept in .env, never printed
skillhook cloud machines
skillhook cloud jobs --waiting
skillhook cloud jobs --machine mac-mini --status failed --limit 50
skillhook cloud job 20260929T101500Z-a1b2c3
skillhook cloud logout                      # forget the key here; revoke it on the dashboard to end it
```

These use the cloud's public API with the person's key, never the machine token: a paired machine cannot read the rest of its organisation, only someone holding a key can. `login` checks the key with `GET /api/v1/me` and keeps it in `.env` as `SKILLHOOK_CLOUD_API_KEY` (mode 600); `SKILLHOOK_CLOUD_API_KEY` in the environment (CI) takes precedence; `logout` removes it from `.env`. What they read, each a `GET` with `Authorization: Bearer <key>`; nothing from the machine goes with it beyond the filters in the query:

| Command | Request |
|---|---|
| `cloud login` | `GET /api/v1/me` (the organisation, the key's name and scopes) |
| `cloud machines` | `GET /api/v1/machines`: name, status, mode, skillhook version, last seen |
| `cloud jobs [--machine M] [--skill S] [--status ST] [--outcome O] [--waiting] [--limit N] [--before CURSOR]` | `GET /api/v1/jobs` with those filters (newest first; `--before` pages), and for the table `GET /api/v1/machines` for the machines' names |
| `cloud job <id>` | `GET /api/v1/jobs/{id}` (the machine's job id or the cloud's): status, outcome, the question waiting for a person, the answer, the result excerpt; and for the text `GET /api/v1/machines` for the machine's name |

The requests go to the machine's cloud URL (`cloud.url`, or `SKILLHOOK_CLOUD_URL`), HTTPS only. Pairing sets it; until one is set (`skillhook config set cloud.url https://…`) the commands refuse, so a key never goes to the built-in placeholder URL. A key must look like one (`shc_` and then letters, digits, `-` and `_`), so a pasted second line or the machine token is refused before anything is sent. Tables by default; `--json` prints the API's answer as it came. A refused key (`401`) says to run `skillhook cloud login` again, a missing scope (`403`) names it. They refuse under `SKILLHOOK_NO_CLOUD=1`. Answering a job, replaying and running skills stay on the dashboard, its hosted MCP server and the machine's own `skillhook jobs answer`.

## What the link does

The running server opens HTTPS requests to `cloud.url` (`POST /api/agent/sync`); the cloud may hold a request up to 25 seconds when it has nothing to say, which makes the link both the heartbeat and the command channel ([cloud-protocol.md](cloud-protocol.md)). Each request carries:

- **Events**: every delivery (the delivery record with redacted headers, and the body when `cloud.upload_payloads` allows it and it is at most 256 KiB), every job change (the job record without its command line; the result up to 8 KiB), progress lines (at most one per job every five seconds, questions and answers always), schedule and skill changes, configuration changes, health changes and runner readiness (checked once when the link connects, then whenever a job checks it), plus `link.started` / `link.stopped`.
- **A snapshot** on connect and every `cloud.snapshot_interval_seconds`: skill summaries, projects, schedules, the effective configuration, the last health and readiness answers and a day of stats.
- **A deep health report** every `cloud.health_interval_seconds`.
- **Command results** and **hosted-ingress acknowledgements** (below).

Every string is scrubbed of every value in `.env` before it leaves, `authorization`, cookie, signature and token headers never leave, and command lines, environments and `.env` itself never do. Events wait in `jobs/.cloud/outbox.jsonl` while the cloud is unreachable (at most `cloud.outbox_max_events`, oldest dropped first and counted); a server restart loses nothing that was spooled. On errors the link backs off exponentially up to a minute, is reported `degraded` after three failures, stops on a revoked token (`401`) or a disabled machine (`403`) until the configuration or the token changes, halves its batches on `413`, honours `429`'s retry delay and waits ten minutes on `426` (update skillhook).

## Hosted URLs

A skill can have a hosted webhook URL on the cloud (the dashboard creates it) in addition to, or instead of, its Tailscale URL. The cloud accepts the request, keeps it sealed until this machine collects it, and hands it over in a sync response; the link replays it to the local server as the original request (method, headers, body, query string without `wait`, the sender's address as `X-Forwarded-For`), so the signature is verified here with the local secret and deduplication, `when` filters and queueing apply exactly as for a direct webhook. The delivery record says `via: "ingress"` with the cloud's `ingress_id`, and the outcome goes back to the cloud with the next sync. A delivery the cloud sends twice is acknowledged again from `jobs/.cloud/ingress.json` and never run twice. `cloud.ingress: false` declines them (`503 ingress_disabled`). `?wait=` does not apply to hosted deliveries: the cloud has already answered the sender.

## What never leaves the machine

`.env` and every value in it, the admin token, command lines and run environments, `authorization` / cookie / signature / token headers, job artifacts unless `cloud.upload_artifacts` allows them and a command asks, webhook bodies unless `cloud.upload_payloads` allows them, and anything a command policy refuses.

## Commands the cloud may send

Read commands (both modes): `ping`, `health.get`, `snapshot.get`, `runners.get`, `skills.list`, `skill.get`, `delivery.list`, `delivery.get`, `job.list`, `job.get`, `job.artifact`, `job.watch`, `job.unwatch`, `job.progress.get`, `stats.get`, `config.get`, `secret.list` (names only), `service.status`, `logs.tail`, `schedules.list`, `update.check`, `expose.status`.

Control commands (`mode: control` or an allow entry): `skill.put`, `skill.delete`, `skill.run`, `skill.test`, `delivery.replay`, `job.cancel`, `job.replay`, `job.answer`, `config.patch`, `secret.generate`, `service.restart`, `schedule.run`, `update.install`.

Results are scrubbed like events. Each command runs once: its id is remembered in `jobs/.cloud/commands.json`, and a command the cloud sends again is answered from the kept result.

## Control mode

**Control mode gives the cloud, and everyone with access to this machine on the dashboard, the power to run code on the machine as the user who runs skillhook:** `skill.test` runs any SKILL.md, including `runner: shell` commands and agents with `bypassPermissions`, and `skill.put` installs one. Turn it on only for machines you would give those people a shell on. `cloud.deny_commands` narrows it (for example `["skill.put", "skill.test", "update.install"]` keeps running and answering installed skills while refusing new code), and `cloud.allow_commands` lets an `observe` machine accept a few chosen ones (`["job.answer"]` to answer the agents' questions from a phone and nothing else).

What each control command does, and the rules it adds on top of the policy:

| Command | Effect |
|---|---|
| `skill.run` | Runs an installed skill with the given payload as a new job (`trigger: api`, `source.method: CLOUD`, header `x-skillhook-cloud-user` with the requester's name). Answers `{accepted, job_id}` at once; the job's progress arrives as events. |
| `skill.test` | Runs a SKILL.md that is not installed, like `skillhook run --file` (`trigger: test`). |
| `delivery.replay`, `job.replay` | Replays a recorded delivery or an earlier job, like `skillhook deliveries replay` / `jobs replay` (`force` for a rejected delivery, `skip_filters`). |
| `job.cancel` | Cancels a queued or running job. |
| `job.answer` | A person's answer to a job waiting for one: delivered live, or a new job resumes the agent's session ([skills.md](skills.md#reporting-progress-and-asking-a-person)); `by` defaults to the requester's name. |
| `config.patch` | Changes `skillhook.json` like `PATCH /config`, except for `host`, `port`, `trust_proxy`, `runners`, `env_passthrough`, `projects` and `cloud`, which the cloud may never change. |
| `service.restart` | Restarts a server run by launchd / systemd once the cloud has the answer (`when: idle` lets running jobs finish, up to `wait_seconds`; `now` does not wait). |
| `schedule.run` | Fires a scheduled skill now. |
| `update.install` | Installs a newer skillhook with the package manager that installed it; the server keeps running the old version until `service.restart`. |
| `secret.generate` | Generates a skill's secret (or any `ENV_NAME`) and returns it only sealed to the requester's key (`recipient_key`, required); the value never travels or rests in the clear. `SKILLHOOK_CLOUD_*` names are refused. |
| `skill.put` | Writes `skills/<name>/SKILL.md` after validating it. Never for a name that comes from a linked repository; `auth: none` needs `allow_unauthenticated`. No secret is created: `secret.generate` does that, sealed. |
| `skill.delete` | Removes a skill of `skills/` by moving its directory to `jobs/.removed-skills/<name>-<time>/`, where it can be restored. |

`secret.set` (a value sealed to this machine's key, created at pairing and kept in `.env` as `SKILLHOOK_CLOUD_PRIVATE_KEY`) is allowed only when listed in `cloud.allow_commands`, whatever the mode.

## Live output and artifacts

`job.watch` streams a job's `stdout` (or `stderr`) to the cloud as `job.output` events: complete lines, at most 64 KiB per job every two seconds, for at most five jobs at once, until the job ends (`eof: true` with its status) or `ttl_s` runs out (`expired: true`). `job.artifact` returns an artifact inline up to 256 KiB (`max_inline_bytes`) and uploads a larger one (up to 32 MiB) in 1 MiB chunks. Both are scrubbed of `.env` values and need `cloud.upload_artifacts`.

Allow-list only: `secret.set` (a value sealed to this machine's key).
