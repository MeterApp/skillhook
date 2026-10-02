# MCP server

`skillhook mcp` runs a Model Context Protocol server over stdio that exposes the whole skillhook workflow as tools: inspect the install, create and validate skills, manage secrets, run and test skills, read jobs, expose the server, install the service, run the doctor. Any MCP client works; Claude Code, Codex and Cursor are the usual ones. Tools call the same `ops` layer as the CLI, so everything they do is also visible to the CLI and vice versa.

Related: [skills.md](skills.md) (what `create_skill` writes), [api.md](api.md) (what `run_skill` calls on a running server), [operations.md](operations.md) (home directory, service).

## Setup

Print the configuration lines for your install (it uses `skillhook` when it is on `PATH`, otherwise the absolute Node binary and `dist/cli.js`, otherwise `npx -y @meterapp/skillhook`; it appends `--dir <home>` when `SKILLHOOK_HOME` or `--dir` is set):

```bash
skillhook mcp --print-config
```

Claude Code:

```bash
claude mcp add skillhook -- skillhook mcp
```

Codex:

```bash
codex mcp add skillhook -- skillhook mcp
```

Cursor, Windsurf and other `mcp.json` clients:

```json
{
  "mcpServers": {
    "skillhook": {
      "command": "skillhook",
      "args": ["mcp"]
    }
  }
}
```

Non-default home: add `"--dir", "/path/to/home"` to `args` (or set `SKILLHOOK_HOME` in the client's environment). The MCP process must see the same home as your shell.

The repository is also a plugin: its skills, this MCP server, and `skillhook-cloud`, the organisation's fleet through Skillhook Cloud (below):

```text
/plugin marketplace add MeterApp/skillhook
```

Global options apply to the `mcp` command like any other (`--dir`); the server writes only to the home directory and never to the repository it is started from. If the home does not exist yet it prints a warning and creates what it needs on first use (or run `skillhook init`).

## What the server tells the client

The server announces itself as `skillhook` with these instructions:

> skillhook turns this machine into a webhook endpoint that runs Agent Skills (SKILL.md files) with Claude Code or Codex. Typical flow: skillhook_status → create_skill (or add_example) → set_secret/generate_secret → run_skill to test locally → get_webhook_urls to hand the URL to the sender (Granola, Sentry, GitHub, Zapier…). Skills live in `<home>/skills/<name>/SKILL.md`; the `skillhook:` frontmatter block sets runner, model, auth and filters. Secrets live in `<home>/.env` and are never returned by tools except right after generation. A repository can declare its own hooks in a version-controlled skillhook.yaml (webhook name → run: shell command | skill: SKILL.md directory | prompt: inline instructions); link_project registers it so the hooks are served, list_projects shows what runs from which webhook. A `schedule:` key (cron expression, optional timezone/catch_up/overlap) on any skill or hook makes the running server fire it on time without a webhook; `webhook: false` makes it schedule-only. list_schedules shows the next and last runs. Jobs are directories under `<home>/jobs/<id>` with payload.json, prompt.md, stdout.log and result.md.

Every tool returns a text block (a one-line summary followed by JSON) and the same JSON as `structuredContent`. Failures come back as `isError: true` with `Error: <message>`; nothing throws.

## Tools

### Overview and skills

| Tool | Input | Use it to |
|---|---|---|
| `skillhook_status` | none | Get the lay of the land first: version and whether a newer one is on npm (`update`, from the daily check's cache), home, config file, whether a server is running (base URL, queue), public base URL and its source, every skill (runner, model, auth, source, URL), skill load errors, linked `projects`, the 10 most recent jobs, and `defaults`. |
| `list_skills` | none | List every skill and repository hook with effective runner/model/effort/cwd/timeout, auth type, whether its secret is configured, `when` conditions, `source` and webhook URL. |
| `get_skill` | `name` | Read one skill: the same summary plus the full `SKILL.md` text. |
| `create_skill` | `name`, `description`, `instructions`; optional `runner`, `model`, `effort`, `auth_type`, `secret_env`, `cwd`, `timeout_seconds`, `when`, `env`, `overwrite` | Write `<home>/skills/<name>/SKILL.md` from structured input. `instructions` is the Markdown body (use `{{payload}}`, `{{payload.some.path}}` or let skillhook append the event block). For `bearer`, `basic` and `hmac` a secret is generated and returned once in `secret`; for provider-signed types the response's `auth_note` says to call `set_secret` with the provider's secret. Returns the webhook URL and whether it is public. |
| `update_skill_file` | `name`, `content` | Replace a skill's `SKILL.md` after validating the frontmatter (invalid content is rejected and nothing is written). |
| `validate_skills` | optional `name` | Parse every skill (or one) and report errors plus warnings for `auth: none` and missing secrets. |
| `list_examples` | none | List the bundled example skills with description, runner and auth type. |
| `add_example` | `name`, optional `as` | Copy a bundled example into the home (optionally under another name); generates its secret when skillhook manages it. |

### Repositories with a `skillhook.yaml`

| Tool | Input | Use it to |
|---|---|---|
| `list_projects` | none | Every linked repository with its hooks (runner, `source.kind` of `run`/`skill`/`prompt`, auth, cwd, URL) and errors: the version-controlled answer to "which skill runs from which webhook". |
| `link_project` | `dir`; optional `init`, `no_secret` | Register a repository's `skillhook.yaml` (or the file's path) so its hooks are served; the running server needs no restart. `init: true` writes a starter file first when none exists. Returns the hooks with URLs, generated secrets (once) and any hook errors. |
| `unlink_project` | `dir` | Stop serving a repository's hooks (`404` at once); nothing in the repository is touched. |
| `list_schedules` | none | Every skill or hook with a `schedule:`: cron, time zone, `catch_up` and `overlap`, enabled and `webhook` flags, next due time, and the last slot, job and status. Live from the running server's `/health` when there is one, otherwise from the skills and `jobs/.schedules.json` (nothing fires without a server). See [schedules.md](schedules.md). |

`update_skill_file` works for `skill:` hooks (it edits the SKILL.md in the repository) and refuses `run:`/`prompt:` hooks, which live in `skillhook.yaml` itself. See [projects.md](projects.md).

### Running and testing

| Tool | Input | Use it to |
|---|---|---|
| `run_skill` | `name`; optional `payload`, `headers`, `runner`, `model`, `effort`, `wait_seconds` (default 120, max 1800) | Run a skill exactly as a webhook would, without HTTP auth. When a server is running the job goes through its admin API (`via: "server"`, trigger `api`, visible in its queue); otherwise it runs in-process (`via: "local"`, trigger `mcp`). Returns the job record; when the wait elapses first, poll `get_job`. |
| `test_skill` | `skill_md` (the whole SKILL.md text); optional `payload`, `headers`, `runner`, `model`, `effort`, `cwd`, `wait_seconds` (default 120) | Run a SKILL.md that is not installed, exactly like `run_skill`: the document is validated, kept in the job directory (`jobs/<id>/skill/<name>/SKILL.md`) and run from there with trigger `test`. Try a draft before `create_skill`, or a change before writing it. |
| `send_test_webhook` | `name`; optional `payload`, `public`, `base_url`, `wait_seconds` (max 600) | Prove the HTTP path: signs the payload the way the skill's `auth` expects (bearer, HMAC, Standard Webhooks, Stripe, Slack, …) and POSTs it to `/hooks/<name>` on the local server by default, the public URL with `public: true`, or any `base_url`. Returns the HTTP status, the names of the signed headers and the response body. |
| `list_jobs` | optional `skill`, `status`, `outcome` (`completed`, `partial`, `needs_human`, `nothing_to_do`, `failed`, `unknown`), `trigger`, `failure` (`auth`, `usage_limit`, `rate_limit`, `budget`, `max_turns`, `not_found`, `timeout`, `crash`, `unknown`), `waiting` (boolean), `since` (ISO-8601), `after` (the previous call's `next_after`), `limit` (default 20, max 200) | Recent jobs, newest first, with `next_after` for the next page. `status` is how the process ended, `outcome` whether the task was done; `waiting: true` lists only the jobs waiting for a person (an open question, or outcome `needs_human` nobody answered yet). |
| `get_job` | `id`; optional `include` (any of `result`, `response`, `prompt`, `stdout`, `stderr`, `payload`, `event`; default `["result"]`) | One job (with `outcome`, `response` and, when the agent reported any, `progress`: current state, pending question, answer, timeline) plus its directory path and the requested artifacts (each capped at the last 64 KiB). |
| `answer_job` | `id`, `answer`; optional `option`, `by`, `resume` (`auto` \| `never`), `wait_seconds` (default 120) | A person's answer to a waiting job. Delivered live when the job is still running and waiting (`delivered: live`); otherwise recorded and, unless `resume: never`, a new job with trigger `resume` continues the agent's session with it (`delivered: resumed`, `resume_job`). Through the running server when there is one, otherwise the resume job runs in-process. |
| `cancel_job` | `id` | Cancel a queued or running job through the running server's admin API. Fails when no server is running (jobs started by `skillhook run` must be stopped by killing that process). |
| `list_deliveries` | optional `skill`, `outcome` (`accepted`, `duplicate`, `in_flight`, `skipped`, `rejected`, `challenge`, `error`), `since`, `after`, `limit` (default 20, max 200) | Every webhook the server received, newest first, with what became of it: the answer to "why did that webhook not run". |
| `get_stats` | optional `since` (`24h`, `7d`, `2w` or ISO-8601), `until`, `skill` | Numbers over jobs and deliveries: by status, outcome, trigger, runner and failure kind; success and completion rates; duration and queue-wait percentiles; cost and tokens; deliveries by outcome and HTTP status; per skill. |
| `get_delivery` | `id`; optional `include_body` | One delivery record, plus the body the log kept for a refused delivery (or the payload of the job an accepted one created). |
| `replay_delivery` | `id`; optional `force` (a rejected delivery), `skip_filters`, `runner`, `model`, `effort`, `wait_seconds` (default 120) | Runs a recorded delivery again through the skill as it is now: a new job with trigger `replay`, no signature check, `when` filters unless skipped, never de-duplicated. Through the running server when there is one, otherwise in-process. |
| `replay_job` | `id`; optional `skip_filters`, `runner`, `model`, `effort`, `wait_seconds` | The same for an earlier job's request (`replay_of: {job}`). |

### Secrets

| Tool | Input | Use it to |
|---|---|---|
| `set_secret` | `name`, `value` | Store a value in `<home>/.env` (mode 600). `name` is an `ENV_VAR_NAME`, a skill name (its `secret_env`) or `admin`. Use it for provider signing secrets (Granola `whsec_…`, Sentry client secret, GitHub webhook secret) and for API keys a skill lists in `env:`. |
| `generate_secret` | `name`; optional `force` | Generate a random secret for a skill or `admin` and return it once. An existing value is kept unless `force: true`. |
| `list_secrets` | none | Names of the variables in `.env`; values are never returned. |

### URL, exposure, service, health

| Tool | Input | Use it to |
|---|---|---|
| `get_webhook_urls` | optional `skill` | Webhook URL per skill, using the public URL (config or an active Tailscale mapping) when one exists; `public: false` means only the local address is known. |
| `expose` | `mode`: `funnel`, `serve`, `off`, `status` | `funnel`: public HTTPS URL via Tailscale Funnel; `serve`: tailnet-only URL; `status`: Tailscale state and current mappings; `off`: disable Funnel and Serve on :443 and clear `public_url`. On success `public_url` is written and per-skill webhook URLs are returned; when Funnel needs its one-time approval the response carries `approval_url`. |
| `service` | `action`: `install`, `uninstall`, `status`, `restart`, `logs`; optional `lines` | Manage the launchd / systemd service that keeps the server running at login. |
| `doctor` | none | The same checks as `skillhook doctor` (Node, disk, config, secrets, skills, Claude/Codex login, Tailscale, public URL, server, service), as structured checks plus the formatted report. |
| `get_config` | none | The live `skillhook.json` with defaults applied, which keys the running server applies live and which wait for a restart, and what is pending one. |
| `update_config` | `set` (dotted keys to values) and/or `unset` (dotted keys) | Change `skillhook.json` in one validated write; the running server re-reads it at once and reports what applied live and what (host, port) needs `restart_server`. Never writes an invalid file. |
| `restart_server` | optional `force`, `wait_seconds` (default 30) | Ask the service-run server to stop (letting jobs finish) and let launchd / systemd start it again; `409` for a server run in a terminal. |
| `check_update` | optional `install` | Ask npm for a newer skillhook; `install: true` upgrades with the package manager that installed it and restarts an idle service. |
| `cloud_status` | none | Whether the machine is paired with Skillhook Cloud: URL, machine id, mode, whether the token is present (never the token), the running server's link state, and whether an organisation API key is kept here and for which cloud (`api_key`; [`skillhook mcp --cloud`](#skillhook-cloud-skillhook-mcp---cloud) uses it). `update_config` refuses `cloud.*` keys and `set_secret` / `generate_secret` refuse `SKILLHOOK_CLOUD_*` names: where the link and the API key go is the person's to set. |
| `cloud_disconnect` | optional `keep_token` | Stop the Skillhook Cloud link: `cloud.enabled: false`, token and machine key revoked and removed, spool deleted. There is no `cloud_connect` tool on purpose: pairing hands the machine to an account, so the person runs `skillhook cloud connect --code …` themselves ([cloud.md](cloud.md#connecting)). |
| `cloud_report_issue` | `title`; optional `body`, `kind` (bug, question, feature, other), `severity` (low, normal, high, urgent), `contact_email`, `job_id`, `delivery_id`, `skill`, `diagnostics` (default true), `dry_run` | Send a problem report to the Skillhook team from a paired machine, when the person asks for one (what `skillhook cloud report` does; `dry_run: true` returns the exact report without sending it). With diagnostics: versions, OS, cloud mode, the link's state, whether each runner is ready and the failing or warning checks, all scrubbed of every `.env` value; never payloads, logs, prompts or job output ([cloud.md](cloud.md#reporting-a-problem)). Returns the issue number and URL, whether a confirmation email went out, and the diagnostics that were sent. |
| `get_runners` | optional `refresh` | Is each runner (claude, codex, shell) installed and logged in or given an API key: what every job checks before it starts. Through the running server's cached answer when there is one. |
| `get_health` | optional `deep` (default true), `refresh`, `network` | The grouped health report of `skillhook health`: the doctor's checks plus every MCP server Claude Code and Codex know (connected, needs authentication, failed), installed plugins, `codex doctor`, disk and each skill's last run. Through the running server's cached report when there is one (`refresh: true` probes again), otherwise probed now. Use it to answer "why does the agent's MCP tool not work" before touching a skill. |

## Skillhook Cloud: `skillhook mcp --cloud`

A separate server for the whole organisation, as the Skillhook Cloud dashboard shows and runs it: every machine's jobs,
deliveries, alerts, health and stats, answering agents, replaying, running and testing skills, skills, secrets, hosted
URLs and machines. The skillhook plugin registers it as `skillhook-cloud`; elsewhere:

```bash
claude mcp add skillhook-cloud -- skillhook mcp --cloud
codex mcp add skillhook-cloud -- skillhook mcp --cloud
```

It needs an organisation API key, which the person keeps here once with `skillhook cloud login --url https://<cloud>`
([cloud.md](cloud.md#the-whole-organisation-with-an-api-key)). When it starts it reads the cloud's catalogue of tools
(`GET /api/v1/tools`, waiting at most 8 s) and offers each one the key's scope allows, with the cloud's own name,
description and input schema; a call goes to `POST /api/v1/tools/<name>` with the key (only to the cloud the key was
checked against at login), and the cloud validates, authorises and audits it. So the tools are the cloud's as of the
server's start (reconnect it to see tools the cloud added since): `describe_cloud` (start here: what needs a person now, with
`next_steps`), `get_stats`, `list_alerts`, `list_machines`, `get_machine`, `list_skills`, `get_skill`, `list_jobs`,
`get_job`, `get_job_artifact`, `answer_job`, `replay_job`, `run_skill`, `test_skill`, `save_skill`,
`list_deliveries`, `get_delivery`, `replay_delivery`, `list_hosted_urls`, `enable_hosted_url`, `send_command` and the
rest ([the cloud's list](https://github.com/MeterApp/skillhook-cloud/blob/main/docs/api.md#mcp)). The instructions it
announces are the cloud's, with the organisation and the key's scopes.

One tool is local: `generate_secret {machine, skill, force?}` (admin keys) has the machine generate a skill's secret
(only a skill's: never its admin token or a runner's key) sealed to a key pair made for that call, and returns the value
once; the cloud only forwards the sealed value. A catalogue tool of that name never replaces it.

Without a key (or while the cloud cannot be reached, or under `SKILLHOOK_NO_CLOUD=1`) the server offers only
`skillhook_cloud_setup`: it says what is missing, and once the person logged in a call loads the cloud's tools (a
`tools/list_changed` notification; reconnect the server if the client ignores it). Logging in stays with the person in
a terminal, so a key never passes through a conversation.

## The job API: `skillhook mcp --job`

A second, much smaller MCP server exists for the agent *inside* a run. The Claude and Codex runners start it for every job (`claude --mcp-config …`, `codex -c mcp_servers.skillhook_job.…`) with `SKILLHOOK_JOB_ID` and `SKILLHOOK_JOB_DIR` in its environment, so the agent sees these tools without any setup (`agent_api: none` in the skill turns it off; `agent_api: cli` keeps only `skillhook job …`):

| Tool | Input | Effect |
|---|---|---|
| `job_progress` | `message`; optional `state` (`working`, `blocked`), `percent`, `step` | Records what the agent is doing (`job.progress`, `skillhook jobs show`). |
| `job_ask_human` | `question`; optional `options`, `context`, `wait_seconds` | Asks a person and waits for the answer (`human_wait_seconds`); returns `{answered, answer, option, by}`. The job's timeout is paused meanwhile. |
| `job_set_outcome` | `outcome`, `summary`; optional `links`, `data` | Writes `response.json` (the task outcome). |
| `job_note` | `text` | A timeline entry. |
| `job_context` | — | The job, its files, what was reported so far, earlier questions and answers. |

Everything is files in the job directory ([skills.md](skills.md#reporting-progress-and-asking-a-person)); the operator-side `answer_job` (above), `skillhook jobs answer` and `POST /jobs/<id>/answer` are the other end.

## Typical session

1. `skillhook_status`: no server, no public URL, one skill (`hello`).
2. `create_skill` with `name: sentry-triage`, `auth_type: sentry`, `secret_env: SENTRY_CLIENT_SECRET`, `cwd: ~/dev/api`, `when: [{"header":"sentry-hook-resource","equals":"issue"},{"path":"action","equals":"created"}]`, `env: ["SENTRY_AUTH_TOKEN"]` and the instructions.
3. `set_secret` for `SENTRY_CLIENT_SECRET` and `SENTRY_AUTH_TOKEN` (values supplied by the human).
4. `run_skill` with a sample Sentry payload and `wait_seconds: 300`; read `result` and, if needed, `get_job` with `include: ["prompt","stderr"]`.
5. `service` `install`, then `expose` `funnel` (hand the `approval_url` to the human if it appears, then call again).
6. `send_test_webhook` with `public: true` to prove the signed path end to end.
7. `get_webhook_urls` and give the `sentry-triage` URL to whoever configures the Sentry integration.

## Notes for tool authors and agents

- Secrets appear in a tool result exactly once (`create_skill`, `add_example`, `generate_secret`); if a value is lost, rotate with `generate_secret` and `force: true` and update the sender.
- `run_skill` and `POST /skills/<name>/run` bypass webhook authentication, `when` filters and dedupe; use `send_test_webhook` to test those.
- `run_skill` waits at most `wait_seconds`; long agent runs should be polled with `get_job` rather than waited on.
- A job that `list_jobs {waiting: true}` shows needs a person: read its `question` (or `response.summary`), then `answer_job`; the agent continues in the same session.
- All paths in results are absolute paths on the machine running the MCP server.
