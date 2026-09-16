# MCP server

`skillhook mcp` runs a Model Context Protocol server over stdio that exposes the whole skillhook workflow as tools: inspect the install, create and validate skills, manage secrets, run and test skills, read jobs, expose the server, install the service, run the doctor. Any MCP client works; Claude Code, Codex and Cursor are the usual ones. Tools call the same `ops` layer as the CLI, so everything they do is also visible to the CLI and vice versa.

Related: [skills.md](skills.md) (what `create_skill` writes), [api.md](api.md) (what `run_skill` calls on a running server), [operations.md](operations.md) (home directory, service).

## Setup

Print the configuration lines for your install (it uses `skillhook` when it is on `PATH`, otherwise the absolute Node binary and `dist/cli.js`, otherwise `npx -y skillhook`; it appends `--dir <home>` when `SKILLHOOK_HOME` or `--dir` is set):

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

The repository is also a plugin (skills plus this MCP server):

```text
/plugin marketplace add MeterApp/skillhook
```

Global options apply to the `mcp` command like any other (`--dir`); the server writes only to the home directory and never to the repository it is started from. If the home does not exist yet it prints a warning and creates what it needs on first use (or run `skillhook init`).

## What the server tells the client

The server announces itself as `skillhook` with these instructions:

> skillhook turns this machine into a webhook endpoint that runs Agent Skills (SKILL.md files) with Claude Code or Codex. Typical flow: skillhook_status → create_skill (or add_example) → set_secret/generate_secret → run_skill to test locally → get_webhook_urls to hand the URL to the sender (Granola, Sentry, GitHub, Zapier…). Skills live in `<home>/skills/<name>/SKILL.md`; the `skillhook:` frontmatter block sets runner, model, auth and filters. Secrets live in `<home>/.env` and are never returned by tools except right after generation. Jobs are directories under `<home>/jobs/<id>` with payload.json, prompt.md, stdout.log and result.md.

Every tool returns a text block (a one-line summary followed by JSON) and the same JSON as `structuredContent`. Failures come back as `isError: true` with `Error: <message>`; nothing throws.

## Tools

### Overview and skills

| Tool | Input | Use it to |
|---|---|---|
| `skillhook_status` | none | Get the lay of the land first: version and whether a newer one is on npm (`update`, from the daily check's cache), home, config file, whether a server is running (base URL, queue), public base URL and its source, every skill (runner, model, auth, URL), skill load errors, the 10 most recent jobs, and `defaults`. |
| `list_skills` | none | List every skill with effective runner/model/effort/cwd/timeout, auth type, whether its secret is configured, `when` conditions and webhook URL. |
| `get_skill` | `name` | Read one skill: the same summary plus the full `SKILL.md` text. |
| `create_skill` | `name`, `description`, `instructions`; optional `runner`, `model`, `effort`, `auth_type`, `secret_env`, `cwd`, `timeout_seconds`, `when`, `env`, `overwrite` | Write `<home>/skills/<name>/SKILL.md` from structured input. `instructions` is the Markdown body (use `{{payload}}`, `{{payload.some.path}}` or let skillhook append the event block). For `bearer`, `basic` and `hmac` a secret is generated and returned once in `secret`; for provider-signed types the response's `auth_note` says to call `set_secret` with the provider's secret. Returns the webhook URL and whether it is public. |
| `update_skill_file` | `name`, `content` | Replace a skill's `SKILL.md` after validating the frontmatter (invalid content is rejected and nothing is written). |
| `validate_skills` | optional `name` | Parse every skill (or one) and report errors plus warnings for `auth: none` and missing secrets. |
| `list_examples` | none | List the bundled example skills with description, runner and auth type. |
| `add_example` | `name`, optional `as` | Copy a bundled example into the home (optionally under another name); generates its secret when skillhook manages it. |

### Running and testing

| Tool | Input | Use it to |
|---|---|---|
| `run_skill` | `name`; optional `payload`, `headers`, `runner`, `model`, `effort`, `wait_seconds` (default 120, max 1800) | Run a skill exactly as a webhook would, without HTTP auth. When a server is running the job goes through its admin API (`via: "server"`, trigger `api`, visible in its queue); otherwise it runs in-process (`via: "local"`, trigger `mcp`). Returns the job record; when the wait elapses first, poll `get_job`. |
| `send_test_webhook` | `name`; optional `payload`, `public`, `base_url`, `wait_seconds` (max 600) | Prove the HTTP path: signs the payload the way the skill's `auth` expects (bearer, HMAC, Standard Webhooks, Stripe, Slack, …) and POSTs it to `/hooks/<name>` on the local server by default, the public URL with `public: true`, or any `base_url`. Returns the HTTP status, the names of the signed headers and the response body. |
| `list_jobs` | optional `skill`, `status`, `limit` (default 20, max 200) | Recent jobs, newest first. |
| `get_job` | `id`; optional `include` (any of `result`, `prompt`, `stdout`, `stderr`, `payload`, `event`; default `["result"]`) | One job with its directory path and the requested artifacts (each capped at the last 64 KiB). |
| `cancel_job` | `id` | Cancel a queued or running job through the running server's admin API. Fails when no server is running (jobs started by `skillhook run` must be stopped by killing that process). |

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
| `doctor` | none | The same checks as `skillhook doctor` (Node, config, secrets, skills, Claude/Codex login, Tailscale, public URL, server, service), as structured checks plus the formatted report. |

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
- All paths in results are absolute paths on the machine running the MCP server.
