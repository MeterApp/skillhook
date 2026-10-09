# Changelog

All notable changes to skillhook, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org). Describe changes under **Unreleased** as they land; `npm run release -- <patch|minor|major>` moves them under a new version, and the Release and Publish workflows tag it, publish it to npm and turn the section into the GitHub release notes.

## Unreleased

- `skillhook cloud login` signs in with the browser: it shows a code, opens the cloud's sign-in page, and the person
  approves it there (choosing the organisation, where they are an admin or owner, and the access: read, run or
  admin); the cloud makes a new organisation API key for this computer,
  named `skillhook CLI on <hostname>` under Settings → API keys, and hands it to the waiting CLI once. Nobody copies a
  key out of the dashboard and into a terminal any more. `--no-browser` only prints the link; the link and the code go
  to stderr, so `--json` still answers on stdout. `--key shc_…`, `--key -` (stdin) and `--key` alone (asked for at a
  terminal) keep a key made on the dashboard, as before; in CI, where nobody can approve, login says to use them.
  Needs a Skillhook Cloud with browser sign-in (`/api/auth/device/*`); an older one says to use `--key`.
- `skillhook_cloud_setup` of `skillhook mcp --cloud` does the same for an agent: without a working key it opens the
  sign-in page in the person's browser and returns the link and the code to show them, keeps the key once they
  approved and loads the cloud's tools; `wait_seconds` waits for the approval. The key never passes through the
  conversation, and the sign-in goes only to the cloud the key would.
- The messages that sent people to Settings → API keys to make a key first (no key, a refused key, a missing scope)
  say to run `skillhook cloud login` instead.

## 0.9.1 (2026-10-07)

- `skillhook init` names pairing with Skillhook Cloud (https://skillhook.dev) among its next steps, and the `cloud link`
  hint of `skillhook doctor` and `skillhook --help` carry the URL. The README, `docs/`, `llms.txt` and the plugin skills
  point at Skillhook Cloud where it is the hosted alternative: hosted webhook URLs for a machine that sleeps or has no
  public URL, every machine's deliveries and jobs on record with replay, the inbox, alerts, teams, the hosted MCP server
  at https://skillhook.dev/api/mcp, and the plans.

## 0.9.0 (2026-10-07)

- skillhook updates itself. At most once an hour any command (from a person, a script, an agent or an MCP host) starts
  a detached `skillhook update --refresh` when the cached answer is stale; with the new `auto_update` setting (default
  `true`) it installs a newer version with the package manager that installed skillhook: npm into the same global
  prefix, through the npm beside the running Node, or pnpm, bun, yarn or Volta. One install runs at a time
  (`<home>/update.lock`), its output goes to `<home>/logs/update.log`, and a version that failed is tried again after a
  day. No command waits for it and nothing is printed for scripts or agents; at a terminal skillhook says once that it
  updated itself, and mentions a newer version only when it will not install it (`auto_update: false`, a source
  checkout, an npx cache, a project's dependency, a global directory the user cannot write, a failed install).
  Before, the check ran only after interactive commands and installed nothing, so a skillhook only agents used never
  moved.
- `skillhook serve` checks hourly (was daily), starts the background install, and restarts itself onto a newer
  installed version once no job is queued or running when launchd or systemd runs it, whoever installed it (the
  background update, `update --install`, the cloud's `update.install` or npm). `skillhook serve` run by hand only logs
  that a restart would pick it up.
- `skillhook update --install` also brings the skillhook plugin up to date wherever it is installed: `claude plugin
  marketplace update` and `claude plugin update` in Claude Code, `codex plugin marketplace upgrade` in Codex.
  `--no-plugins` skips that.
- An npm upgrade now targets the global prefix this copy runs from (`npm install -g --prefix …`), so a machine with
  several Nodes (nvm, Homebrew) upgrades the copy that runs; `doctor`'s version hint says when the background update
  will install it, or why it did not.

## 0.8.0 (2026-10-07)

- Reports people can act on: a job says what it is about, how far it got, what came of it in one line
  and where to look, and offers choices for a person to pick from. Skillhook Cloud's inbox shows all of
  it, Markdown included.
  - **A title** for the job: `job_progress {title}` / `skillhook job progress --title "…"` (it stays
    until a later report changes it), or `title` in `job_set_outcome` and `response.json`. It becomes
    `job.title`, is in the `?wait=` response and `GET /jobs/<id>/progress`, and a resume job inherits it.
  - **A headline**, the result in one line (at most 280 characters), next to the summary:
    `job_set_outcome {headline}`, `skillhook job outcome --headline`, `headline` in `response.json`.
    It is the last progress message once the outcome is reported.
  - **Typed links**: a link is a URL, as before, or `{url, title, kind}` with `kind` one of `source`
    (what started the run), `pull_request`, `commit`, `issue`, `message`, `document`, `deploy`, `test`
    (how to check the result), `log`, `result` or `other`. On the command line,
    `--link "pull_request:[PR #7](https://…)"` (the kind and the title are optional) and `--links JSON`.
    A misspelled kind is refused instead of ending up inside the URL.
  - **Choices**: questions take `recommended` (the option the agent suggests) and `multiple` (a person
    may pick several; the answer lists them one per line and `answer.options` says which they were, and
    `job_ask_human` / `skillhook job ask` return them as `options`). A `needs_human` outcome can offer
    `options` (with `recommended` and `multiple`) too: a person picks one and the session resumes with it.
    `skillhook jobs answer <id> --option A --option B` and the MCP `answer_job {options}` answer with
    several picks.
  - The guardrails ask every run for a title, a headline and its links, and tell it about choices; the
    default `response.schema` of `response.mode: structured` has the new fields (links as objects).
    `skillhook jobs list|show` print titles, headlines, links and choices.
  - The cloud protocol names the link kinds (`LINK_KINDS`) and the limits of a report (`REPORT_LIMITS`);
    records stay loose, so nothing else about the protocol changes.

## 0.7.1 (2026-10-06)

- Skillhook Cloud's production deployment is the default cloud: `cloud.url` (and so `skillhook cloud
  connect`, `cloud login`, the fleet commands and `skillhook mcp --cloud`) defaults to
  `https://skillhook.dev` instead of the placeholder `https://cloud.skillhook.dev`, where no cloud ever
  answered. A plain `skillhook cloud login` on a machine that names no other cloud logs in there instead
  of refusing without `--url`, and an API key without a cloud of its own (set in the environment alone,
  or kept by 0.6) goes there too. `--url`, `SKILLHOOK_CLOUD_URL` and `cloud.url` still name another
  deployment, and a paired machine keeps the `cloud.url` written at pairing. A key kept at login still
  goes only to the cloud it was checked against, whatever `cloud.url` says later, only over HTTPS, only
  when it looks like an organisation key (`shc_…`) and never under `SKILLHOOK_NO_CLOUD=1`. Since the
  default is now a cloud like any other, a login without `--url` asks which cloud the key is for when
  the one kept here differs from this machine's, Skillhook Cloud's own included.
- Without an API key, the fleet commands, the instructions of `skillhook mcp --cloud` and its
  `skillhook_cloud_setup` tool say where to create one and the command to run, `skillhook cloud login`
  (with `--url` only for a cloud other than Skillhook Cloud's own), instead of
  `--url https://<your cloud>`.

## 0.7.0 (2026-10-02)

- Everything Skillhook Cloud's dashboard shows and does, from the terminal and for an agent, with an
  organisation API key. The cloud publishes its tools (`GET /api/v1/tools`: each with its JSON Schema
  and the scope it needs) and skillhook builds its commands and MCP tools from that list when it runs,
  so a tool the cloud adds works without a new skillhook.
  - `skillhook cloud overview`: what needs a person across the organisation (agents waiting for an
    answer, open alerts, failing health checks, failed jobs and rejected webhooks of the last 24 hours,
    the day's numbers, the next steps).
  - `skillhook cloud tools [tool]` lists the tools the key has (and which a wider key would add) or
    describes one; `skillhook cloud <tool> [args] [--param value]…` runs any of them by name:
    `answer_job`, `replay_job`, `run_skill`, `test_skill`, `save_skill`, `get_job_artifact`,
    `get_stats`, `list_alerts`, `enable_hosted_url`, `send_command`, … The words after the tool's name
    are read with its schema (before it, only skillhook's own options): required parameters as arguments
    in order, typed flags (switches, checked numbers, JSON as a literal, `@file` or `-`,
    `--param-file PATH` for long text, `--input` for the whole input). skillhook's own options (`--json`, `--help`,
    `--version`, `--dir`) mean the same wherever they stand and are never a parameter's value
    (`--answer=--help` sends that text), so `--help` never runs a tool. The answer prints as indented
    text, or as it came with `--json`. Text from the cloud, machines and senders reaches the terminal
    without control characters or bidirectional overrides, error messages included; with `--json` (of
    any command) they are `\u` escapes, the same JSON. A catalogue entry this version cannot read (a
    malformed schema included) is skipped; a newer catalogue shape asks for an update.
  - `skillhook cloud secret <machine> <skill|NAME> [--force]`: the machine generates a skill's secret
    (only a skill's: never its admin token or a runner's key) sealed to a key pair made for this one
    request; only this terminal can open it, the cloud only forwards the sealed value.
  - `skillhook mcp --cloud`, registered by the plugin as the `skillhook-cloud` MCP server: the same
    tools for the agent, the cloud's instructions, and `generate_secret`. Without a key it offers only
    `skillhook_cloud_setup`, which says what is missing and loads the tools once the person logged in;
    the agent never handles the key.
  - `skillhook cloud login [--url URL]` checks the key against the cloud named (else the one logged in to
    before, else the machine's; when those two differ it asks which) and keeps it with that cloud (`SKILLHOOK_CLOUD_API_URL` next to
    `SKILLHOOK_CLOUD_API_KEY` in `.env`): the key goes there and nowhere else, whatever `cloud.url` says
    later, and login never touches the machine's link. The same key set in the environment goes there too.
    A key kept by 0.6 goes to the machine's cloud until the next login. At a terminal login asks for the key
    without echoing it. `cloud status` and the MCP tool `cloud_status` say whether a key is kept and for
    which cloud.
  - The local MCP server refuses `cloud.*` settings in `update_config` and `SKILLHOOK_CLOUD_*` names in
    `set_secret` and `generate_secret`, so its configuration and secret tools do not move the link or the
    API key. An agent that can run commands on the machine still acts with the person's rights.
  - A new plugin skill, `skillhook-cloud`, teaches the agent to triage the organisation (failure kinds,
    rejected deliveries, failing checks), act on it safely and set up machines, skills, secrets and hosted
    URLs.
- With `cloud.upload_payloads` false, or an organisation that keeps no bodies, the cloud's `job.artifact` and
  `job.get` no longer send a job's `payload`, `event` or `prompt` (which quotes the payload): webhook bodies stay
  on the machine, as the docs promised. An agent's own output (its transcript, its result) can still quote what it
  read; `cloud.upload_artifacts: false` keeps transcripts home.
- A skill's `secret_env` can no longer name one of skillhook's own credentials (`SKILLHOOK_ADMIN_TOKEN`,
  `SKILLHOOK_CLOUD_*`): generating or setting the skill's secret would have overwritten it (a cloud link's
  token, where the API key goes). Such a skill is reported invalid. The machine also refuses the cloud's
  `secret.generate` and `secret.set` for these variables by whatever name they come (a skill's or the
  variable's), so the cloud cannot rotate the admin token either.
- `--help` and `-h` never run a command. Most commands used to ignore them and do their work, so
  `skillhook jobs prune --help` pruned jobs and `skillhook service install --help` installed the service
  (0.6.0 fixed only `skillhook cloud`). Now `skillhook <command> [subcommand …] --help`, or
  `skillhook help <command>`, prints that command's usage and exits 0 without touching anything;
  `--json` prints `{ "ok": true, "command": …, "usage": … }`. The check sits in front of every command,
  so a new one cannot forget it. `serve`, `doctor`, `health`, `runners`, `mcp` and `url` gained a usage
  text, and `skillhook job <subcommand> --help` prints the agent's job API or, for the rest, `jobs`.

## 0.6.0 (2026-09-29)

- `skillhook cloud report "<title>"`: a person on a paired machine reports a problem to the Skillhook
  team without leaving the terminal (`--body TEXT`, `--body -` or `--body-file PATH`, `--kind`,
  `--severity`, `--job`, `--delivery`, `--skill`, `--email`). One request, `POST /api/agent/issues`
  with the machine token, carrying the person's text and, unless `--no-diagnostics`, what the machine
  already knows: skillhook, Node, OS and architecture, `cloud.mode`, the link's state, whether each
  runner is ready and the health summary with the failing and warning checks. Every `.env` value is
  scrubbed from all of it, and payloads, logs, prompts and job output never go; `--dry-run` prints the
  exact JSON instead of sending it. It answers `Reported as #N: <url>` and whether a confirmation email
  went out. Each report carries a `report_id` (a UUID) on every attempt: network errors, timeouts and
  5xx are retried (three attempts), a 429 only after a short `retry_after_ms`, another 4xx never, and
  the cloud files a retried report once. The MCP tool `cloud_report_issue` sends the same report for
  an agent the person asked (`dry_run: true` returns it without sending). Refused on a machine that is
  not paired and under `SKILLHOOK_NO_CLOUD=1`.
- The protocol gains the report, additively (`PROTOCOL_VERSION` stays 1): `IssueReportRequestSchema`
  (with `report_id`, a client-generated idempotency key), `IssueReportResponseSchema`,
  `IssueDiagnosticsSchema`, `ISSUE_KINDS`, `ISSUE_SEVERITIES` and `LIMITS.max_issue_report_bytes`
  (64 KiB), documented in [docs/cloud-protocol.md](docs/cloud-protocol.md#issue-reports).
- The organisation's fleet from the CLI with an organisation API key: `skillhook cloud login --key
  shc_…|-` checks the key (`GET /api/v1/me`) and keeps it in `.env` as `SKILLHOOK_CLOUD_API_KEY`
  without ever printing it (the environment variable works too, for CI), `cloud logout` forgets it,
  and `cloud machines`, `cloud jobs [--machine M] [--skill S] [--status ST] [--outcome O] [--waiting]
  [--limit N] [--before C]` and `cloud job <id>` print tables, or the API's JSON with `--json`. The
  machine token is never used for them, so a paired machine cannot read the rest of its organisation.
  A refused key says to log in again, a missing scope names it. A key only goes to a cloud URL someone
  set (pairing, `cloud.url` or `SKILLHOOK_CLOUD_URL`), never to the built-in placeholder, and only if
  it looks like one (`shc_…`, one line).
- The cloud HTTP client reads the public API's RFC 9457 problem answers (`code`, `detail`,
  `request_id`) as well as the agent API's `error` / `message`, refuses a token that is not one line
  of printable characters before it becomes a header, and never lets a token into an error message.
- `skillhook cloud <subcommand> --help` prints the usage instead of running the subcommand.

## 0.5.0 (2026-09-28)

- The cloud link checks the runners as soon as it connects, so the dashboard shows whether `claude` and
  `codex` are installed and signed in before the first job runs (previously only after one).
- MCP tools `cloud_status` and `cloud_disconnect`. There is deliberately no `cloud_connect`: pairing hands
  the machine to an account, so the person runs `skillhook cloud connect --code …` themselves. The setup
  skill gains a Skillhook Cloud step that says so.
- The Skillhook Cloud link, opt-in. `skillhook cloud connect --code XXXX-XXXX [--control]` pairs the
  machine (the token goes to `.env` as `SKILLHOOK_CLOUD_TOKEN`, `cloud.*` to skillhook.json; observe
  mode unless `--control`), `cloud status` and `cloud disconnect` (which revokes the token) complete
  it. The running server then keeps one outbound HTTPS connection to `cloud.url`: it uploads
  deliveries, jobs, progress, schedule, config and health changes (headers redacted, command lines
  dropped, every string scrubbed of every `.env` value; bodies only with `cloud.upload_payloads` and
  at most 256 KiB), snapshots and periodic health reports; runs read commands (health, jobs,
  deliveries, stats, logs, skills) and, in `cloud.mode: control` or when allow-listed, the ones that
  act on the machine (run, test, replay and cancel jobs, answer a job waiting for a person, patch the
  configuration except the bind address, runner commands and the link itself, fire a schedule,
  install an update, restart a service-run server once the cloud has the answer, write or remove
  skills, generate a secret returned only sealed to the requester's key, and, allow-listed only, set a
  secret sealed to the machine's own key); streams a watched job's output (`job.output`) and uploads
  large artifacts in chunks; and replays webhooks that arrived at the machine's hosted
  URLs to the local server, where the signature is checked with the local secret (`via: "ingress"`
  and `ingress_id` on the delivery record). Events wait in `jobs/.cloud/` while the cloud is
  unreachable. `GET /health` (admin) reports the link as `cloud`, and doctor/health gain a
  `cloud link` check. Kill switches: `cloud.enabled: false`, `SKILLHOOK_NO_CLOUD=1`,
  `cloud disconnect`. The settings and the wire protocol, exported as `@meterapp/skillhook/protocol`
  for the cloud to validate against, are documented in [docs/cloud.md](docs/cloud.md) and
  [docs/cloud-protocol.md](docs/cloud-protocol.md). `SKILLHOOK_CLOUD_*` variables never reach a run's
  environment, even when a skill lists them.

## 0.4.0 (2026-09-28)

- An event bus inside `skillhook serve` (`src/events.ts`): the queue publishes `job.queued`,
  `job.started`, `job.updated`, `job.cancelled` and `job.finished`, the scheduler
  `schedule.registered`, `schedule.fired` and `schedule.skipped`, the registry `skill.changed` (a
  `SKILL.md` or `skillhook.yaml` that appeared, changed or disappeared, noticed on the next lookup or
  listing) and the server `server.started` / `server.stopping`. Every event carries a `seq`, a
  timestamp and the full record.
- Two streaming admin routes (server-sent events): `GET /events` (the whole bus, `?types=` to filter)
  and `GET /jobs/<id>/events` (one job: `status` snapshots, `stdout`/`stderr` as they are written,
  `end`). `GET /jobs/<id>/artifacts/<name>` returns one artifact file as-is (`?tail=<bytes>`).
  `skillhook jobs logs <id> -f` follows a running job through the server when one is running.
- Many senders waiting with `?wait=` on the same server no longer trigger Node's
  `MaxListenersExceededWarning`.
- A delivery log. Every request to `/hooks/<skill>` is now recorded in `jobs/.delivery-log/` with its
  outcome (`accepted`, `duplicate`, `in_flight`, `skipped`, `rejected`, `challenge`, `error`), the HTTP
  status and error code the sender got, the reason (the failing `when` condition, the auth error), the
  redacted headers, the client IP and the job it created or was folded into. Refused deliveries keep
  their body (`deliveries.store_bodies`, `deliveries.body_max_bytes`, 64 KiB) so what arrived can be
  inspected and, later, replayed; the newest `deliveries.max` (2000) records are kept. New:
  `skillhook deliveries list|show`, `GET /deliveries` and `GET /deliveries/<id>?include=body`, the MCP
  tools `list_deliveries` and `get_delivery`, `recent_deliveries` in `skillhook_status`, `deliveries`
  in `GET /health` (admin) and the `delivery.received` event.
- `GET /jobs`, `skillhook jobs list` and the MCP tool `list_jobs` page with `after` (`next_after` in
  the response) and filter by `trigger` and `since`; the route caps `limit` at 500 and answers
  `400 bad_request` for an unknown `status` or `trigger`. A malformed skill name in a hook URL is
  `404 unknown_skill` instead of `500`.
- Task outcomes. Every finished job now carries `outcome` (`completed`, `partial`, `needs_human`,
  `nothing_to_do`, `failed`, `unknown`) next to `status`: the agent reports it by writing
  `response.json` (`{outcome, summary, links, data}`) in the job directory (`SKILLHOOK_RESPONSE_PATH`,
  `{{response_path}}`; the guardrails say so), and the report is kept as `job.response`. A new
  `response:` field in the `skillhook:` block chooses how firmly it is asked for: `mode: file` asks for
  the file, `mode: structured` makes the runner answer with JSON (`claude -p --json-schema`,
  `codex exec --output-schema <job dir>/response.schema.json`; the answer is stored as `response.json`
  too), optionally against your own `schema`. A shell command that exits 0 is `completed`; a run that
  reports nothing is `unknown`; every non-succeeded status is `failed`. Surfaces: the `?wait=`
  response (`outcome`, `response`), `GET /jobs?outcome=`, `?include=response`, the `response`
  artifact, `skillhook jobs list --outcome` (new column) and `jobs show --response`, the MCP
  `list_jobs` filter and `skillhook_status`.
- Replay. `skillhook deliveries replay <id>` (`POST /deliveries/<id>/replay`, MCP `replay_delivery`)
  runs a recorded delivery again through the skill as it is now, and `skillhook jobs replay <id>`
  (`POST /jobs/<id>/replay`, MCP `replay_job`) does the same for any earlier job: a new job with
  `trigger: replay`, `source.method: REPLAY` and `replay_of: {delivery, job}`, the original payload,
  redacted headers (plus `x-skillhook-replay-of`), query string and sender IP. The signature is not
  checked again (a delivery that was rejected needs `--force` / `force`), `when` filters apply unless
  `--skip-filters`, nothing is de-duplicated, and `runner`/`model`/`effort` can be overridden. Through
  the running server when there is one, in the CLI process otherwise. The guardrails tell the agent it
  is replaying. `src/manual.ts` (manual runs) and `src/replay.ts` (the planner) are new leaf modules,
  re-exported from `src/ops.ts`.
- A job API for the running agent, and a human in the loop. Every Claude and Codex run now gets a
  per-run MCP server (`skillhook mcp --job`, injected with `claude --mcp-config` /
  `codex -c mcp_servers.skillhook_job.*`, nothing to configure) with `job_progress`, `job_ask_human`,
  `job_set_outcome`, `job_note` and `job_context`; the same is available as
  `skillhook job progress|ask|outcome|note|context` (`$SKILLHOOK_BIN`) for shell skills and agents
  that prefer a CLI. The guardrails explain both. Everything is files in the job directory
  (`progress.jsonl`, `progress.json`, `question.json`, `answer.json`), which the queue watches: they
  become the `progress`, `question` and `answer` fields of the job, the events `job.progress`,
  `job.waiting_human` and `job.answered`, `GET /jobs/<id>/progress` and the timeline in
  `skillhook jobs show`. `job_ask_human` waits for a person (`human_wait_seconds`, default 300; the
  job's timeout clock is paused meanwhile). A person answers with `skillhook jobs answer <id> "…"`,
  `POST /jobs/<id>/answer` or the MCP tool `answer_job`: live when the agent is still waiting,
  otherwise as a new job with `trigger: resume` that continues the session
  (`claude -p --resume <session>`, `codex exec resume <thread>`) with the answer in a
  `<human_answer>` block; the two jobs are linked by `resume_of` / `resolved_by`, and a run without a
  session runs the skill afresh (`runner_reason`). `skillhook jobs list --waiting`,
  `GET /jobs?waiting=1` and `list_jobs {waiting: true}` show what waits for a person (an open
  question, or outcome `needs_human`); a run that ends with its question unanswered counts as
  `needs_human`. New block fields `agent_api` (`mcp` | `cli` | `none`) and `human_wait_seconds`; new
  job variables `SKILLHOOK_BIN`, `SKILLHOOK_HOME`, `SKILLHOOK_HUMAN_WAIT_SECONDS`.
- Live configuration and remote control. The running server now holds one live `skillhook.json`:
  `skillhook config set` / `unset` tell it to re-read the file (`skillhook config reload`,
  `POST /config/reload`, `PATCH /config {set, unset}`, MCP `update_config`; a hand edit is noticed
  within five seconds), every key but `host` and `port` applies at once, and those two are reported
  as `pending_restart` (`GET /config`, MCP `get_config`). An invalid change is refused and nothing is
  written. `POST /control/restart` (MCP `restart_server`) stops a service-run server gracefully and
  lets launchd / systemd start it again; `GET /service`, `GET /logs` and `POST /update` (MCP
  `check_update`) expose the service status, its log and the update check to the admin API. New event
  `config.changed`. Internally `ConfigRef` patches the live config in place, the logger and the job
  store take new settings, the rate limiter reads its limit at use, and the queue can `drain`.
- Stats. `skillhook stats [--since 24h|7d|ISO] [--until ISO] [--skill S]`, `GET /stats` and the MCP tool
  `get_stats` sum up the job directories and the delivery log: jobs by status, outcome, trigger, runner
  and failure kind, success and completion rates, duration and queue-wait percentiles, cost and
  tokens (Claude and Codex usage added up), deliveries by outcome and HTTP status, and the same per
  skill.
- Runner readiness, failure kinds and fallback. Before a job spawns, skillhook checks that its runner is
  installed and logged in (or has an API key), with the job environment, cached for
  `health.readiness_cache_seconds` (60): `skillhook runners`, `GET /runners`, MCP `get_runners`, event
  `runners.changed`. A runner that is not ready fails the job at once (`failure.kind: auth`, no
  process started) unless the skill's new `fallback: { runners: [codex] }` (or `defaults.fallback` in
  `skillhook.json`) names a ready runner, which then takes over (`runner_requested`, `runner_reason`).
  Every `failed` or `timed_out` job now carries `failure: {kind, code, retryable, message}` (`auth`,
  `usage_limit`, `rate_limit`, `budget`, `max_turns`, `not_found`, `timeout`, `crash`, `unknown`),
  classified from what the CLI printed; `jobs list --failure`, `GET /jobs?failure=` and `list_jobs`
  filter by it. `fallback.on` may add `auth`, `usage_limit`, `rate_limit`, `crash`, and the new
  `retry: { attempts, on, backoff_seconds }` repeats a run on the same runner; both act only on a run
  that failed before the agent produced anything, and record the earlier runs in `attempts`.
- Deep health. `skillhook health` (`GET /health/checks`, MCP `get_health`) is the doctor plus what the
  agents actually depend on, grouped (`system`, `skillhook`, `runners`, `tools`, `skills`, `exposure`):
  `claude` / `codex` versions and logins, one check per MCP server Claude Code and Codex know
  (connected, needs authentication, failed to connect, with the CLI's reason), Claude's MCP config
  diagnostics and installed plugins, `codex doctor`, free disk space, and per skill the last run and
  any `env:` name that is not set. The probes run with the same environment as a job, so
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or an API key in `.env` apply to the diagnosis. The server keeps
  one report per flavour for `health.cache_seconds` (60; `health.probe_timeout_seconds`, 20, bounds
  `claude mcp list`), answers `GET /doctor` and `GET /health/checks` from it (`?refresh=1`,
  `?deep=0`, `?network=1`) and publishes `health.changed` when a check changes status. `doctor`
  gained `disk` and shows the CLI versions; every check now carries `group` and `data`.
- Ad-hoc runs. `skillhook run --file SKILL.md` (or `--stdin`), `POST /skills/test` and the MCP tool
  `test_skill` run a SKILL.md that is not installed: the document is validated, kept at
  `jobs/<id>/skill/<name>/SKILL.md` and run from there, as a job with `trigger: test`, `adhoc: true`,
  `skill_file` and `source.method: TEST`; nothing is added to `<home>/skills`. `--dry-run` works with
  `--file` too. Every job now records `skill_file` (the SKILL.md or skillhook.yaml it ran from), and
  `skillhook run --cwd` applies to real runs, not only to `--dry-run`.

## 0.3.0 (2026-09-23)

- Scheduled hooks. A `schedule:` key on any skill (`skillhook:` block) or hook (`skillhook.yaml`) runs it
  on a cron schedule from the running server, without a webhook: a five-field expression or an alias
  (`@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`), read in an IANA `timezone` (default UTC), with
  `catch_up` for slots missed while the server was stopped or the machine asleep (`latest` by default,
  `all` up to 24, or `none`), `overlap` for a slot that comes due while the previous run is still going
  (`skip` by default, or `queue`), and a static `payload`. `webhook: false` makes a scheduled hook
  schedule-only: `POST /hooks/<name>` answers `404 schedule_only` and no secret is required. A slot is
  identified by its wall-clock minute in the hook's zone and recorded in the delivery index, so a
  restart, a second tick or the repeated hour of a fall-back night never runs it twice; a minute that
  does not exist on a spring-forward night is skipped. A new schedule waits for its next slot.
- Scheduled jobs carry `trigger: schedule`, `source.method: SCHEDULE`, `delivery_id: schedule:<slot>`
  and the payload `{scheduled_for, schedule: {cron, timezone, slot, fired_at, caught_up, manual}, …}`;
  the guardrails say the run was started by a schedule and has no external sender. State lives in
  `jobs/.schedules.json`; the server logs `schedule registered`, `schedule fired` and
  `schedule slots skipped`.
- `skillhook schedules list | next <name> [--count N] | run <name> [--wait S]`, the MCP tool
  `list_schedules`, `schedules` in `GET /health` (admin), `webhook` and `schedule` (with `next_run_at`)
  in `GET /skills`, `skills show` and the `skills list` URL column (`(schedule <cron>)` for
  schedule-only hooks). `doctor` gains a `schedules` check and, on macOS, a `sleep` check that warns
  when a machine with schedules is allowed to sleep; `doctor` and `skills validate` no longer ask
  schedule-only hooks for a secret.
- `skillhook.yaml` and `SKILL.md` files that use `schedule` or `webhook` are rejected by older
  servers (unknown keys have always been errors), so upgrade every linked machine before merging one.
  Reference: `docs/schedules.md`.

## 0.2.0 (2026-09-17)

- Version-controlled hooks: a repository can declare its webhooks in a `skillhook.yaml` at its root.
  Each hook maps a webhook name to what runs: `run:` (a shell command, executed in the repository
  with the payload on stdin), `skill:` (a `SKILL.md` directory in the repository, served under the
  hook's name) or `prompt:` (inline instructions for the agent), plus any field of the `skillhook:`
  block (`auth`, `when`, `model`, `cwd`, `env`, …). Secrets are named, never stored, in the file.
- `skillhook link [dir]` registers a repository (the new `projects` key in `skillhook.json`),
  `skillhook unlink <dir>` removes it, `skillhook projects` lists linked repositories with their
  hooks and URLs, and `skillhook projects init [dir]` writes a starter file (a `git pull --ff-only`
  hook for merged GitHub pull requests) and links it. The server re-reads `projects`, every
  `skillhook.yaml` and every referenced `SKILL.md` on change, so `link` and `git pull` need no
  restart. Names in `~/.skillhook/skills` win over repositories; a name defined twice is reported by
  `skills list`, `skills validate`, `doctor` and the server log instead of being served.
- `skills list` gained a `source` column, `skills show` a `source:` line, `GET /skills` and the MCP
  skill tools a `source` field (`{type: "home"}` or `{type: "project", dir, file, kind}`), and
  `doctor` a `project <dir>` check per linked repository. New MCP tools: `list_projects`,
  `link_project` (with `init`), `unlink_project`.
- `schema/skillhook.yaml.schema.json` (generated by `npm run schema`) gives editors validation and
  completion for `skillhook.yaml`; the starter file references it on its first line.
- This repository now carries its own `skillhook.yaml`: linking a checkout serves a
  `pull-after-merge` hook that fast-forwards it when a pull request merges.

## 0.1.1 (2026-09-16)

- The npm package is now `@meterapp/skillhook`; the command is still `skillhook`. Install with
  `npm install -g @meterapp/skillhook`. Coming from the unscoped `skillhook` 0.1.0 package, run
  `npm uninstall -g skillhook` first (npm refuses a second package that installs a `skillhook`
  command), then `skillhook service install` again if the service ran from that install. The old
  package's update check does not see the new name.
- The plugin's MCP server starts with `npx -y @meterapp/skillhook mcp`, and
  `skillhook mcp --print-config` prints the same `npx` fallback when skillhook is not installed.
- Releases: the Publish workflow takes the package name from `package.json`, and its verification
  waits until the new tarball downloads (then retries the install) instead of failing while the
  registry catches up. CI installs the tarball `npm pack` reports.

## 0.1.0 (2026-09-16)

Initial release.

- Webhook server (`/hooks/<skill>`) with per-skill auth: bearer, basic, HMAC, GitHub,
  Sentry, Linear, Standard Webhooks (Granola, Svix), Stripe, Slack; filters, de-duplication,
  rate limits, synchronous `?wait=` responses and an admin API.
- In-flight de-duplication: a delivery whose payload and query string match a job of the same
  skill that is still queued or running is answered with that job (`duplicate: true, in_flight: true`)
  instead of starting a second run. On by default (`jobs.dedupe_in_flight`); a skill opts out with
  `dedupe.in_flight: false`.
- Runners: Claude Code (`claude -p`, stream-json), Codex (`codex exec --json`), shell.
  Per-skill runner, model, effort, cwd, timeout and env allow-list.
- Agent Skills format (`SKILL.md` + `skillhook:` block) with a live-reloading registry.
- Jobs on disk with prompt, logs, result and a resume command for the agent session.
- CLI: init, doctor, serve, service (launchd/systemd), expose (Tailscale Funnel/Serve),
  skills, secret, run, send, jobs, config, url, mcp, update.
- Update notifications: `skillhook update [--install]`, a daily background check (cached in
  `update-check.json`) that mentions a newer version after commands, in `doctor` and in the
  server log. Opt out with `SKILLHOOK_NO_UPDATE_CHECK=1`, `CI`, or `"update_check": false`.
- MCP server exposing the whole workflow to Claude Code, Codex, Cursor and others.
- Bundled examples: hello, granola-meeting-actions, sentry-triage, github-issue-triage,
  remote-prompt.
- Release tooling: `npm run release`, a CI job that installs the packed tarball, and
  workflows that tag merged version bumps, publish to npm with provenance and verify the
  published package.
- Hardening from CodeQL: `Authorization` headers and `.env` lines are parsed without
  backtracking regexes, job-id characters come from `crypto.randomInt` instead of a biased
  modulo, and `config set` rejects `__proto__` / `constructor` / `prototype` keys.
