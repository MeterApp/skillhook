---
name: skillhook-setup
description: Install, configure and expose skillhook so a Mac or Linux machine becomes a permanent, secure webhook endpoint that runs Agent Skills with Claude Code or Codex on the user's existing login. Covers prerequisites, `skillhook init`, reading `skillhook doctor`, choosing runner and model, the login-time service, a public HTTPS URL through Tailscale Funnel (or tailnet-only Serve), proving it with a signed test webhook, handing the URL and secret to the sender, the equivalent MCP tools, and fixing 401, 503, Funnel-approval and login errors. Use for any install, first-run, exposure or "my webhook is rejected" task; do not use for writing or improving a webhook skill's SKILL.md (skillhook-authoring).
---

# Setting up skillhook

skillhook is a small server on the user's machine. `POST <public_url>/hooks/<skill>` verifies the sender, queues a job, and runs `~/.skillhook/skills/<skill>/SKILL.md` with `claude -p` or `codex exec`. Everything lives under `~/.skillhook` (override with `SKILLHOOK_HOME` or `--dir`):

| Path | What |
| --- | --- |
| `skillhook.json` | server config: port 8787, bound to 127.0.0.1, defaults for runner/model/timeout |
| `.env` | secrets, mode 600: `SKILLHOOK_ADMIN_TOKEN`, `SKILLHOOK_SECRET_<SKILL>`, provider secrets, API keys |
| `skills/<name>/SKILL.md` | one directory per skill |
| `jobs/<id>/` | `payload.json`, `event.json`, `prompt.md`, `stdout.log`, `result.md` for every run |
| `logs/service.log` | output of the background service |

Work through the steps in order; each has a check. Run the commands yourself where you can and show the user the output that matters.

## 1. Prerequisites

```bash
node --version            # 22 or newer
claude auth status        # Claude Code logged in (subscription), or …
codex login status        # … Codex logged in (ChatGPT)
tailscale status          # optional, but the easiest permanent HTTPS URL; install from tailscale.com/download
```

No Claude or Codex login? An API key works instead: after step 2, `skillhook secret set ANTHROPIC_API_KEY` or `skillhook secret set OPENAI_API_KEY`. `ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*` and `CODEX_*` variables in `.env` are passed to every run automatically.

## 2. Install and initialize

```bash
npm install -g @meterapp/skillhook   # install globally: the background service points at this install
skillhook init                       # add --runner codex, --model <name>, --port <n> as needed
```

`init` creates the directory, `skillhook.json`, `.env` with an admin token, and copies the bundled `hello` skill with a fresh bearer secret. Re-running it keeps existing files (`--force` rewrites the config). `npx -y @meterapp/skillhook <command>` works for one-off commands, but install globally before `service install`. The package is `@meterapp/skillhook`; the command it installs is `skillhook`. Later, `skillhook update --install` upgrades that global install and restarts the service when it is idle; skillhook mentions new versions after commands and in `doctor`, and `SKILLHOOK_NO_UPDATE_CHECK=1` silences that.

## 3. Read the doctor

```bash
skillhook doctor                  # add --json for the same report as data
```

One line per check — `✓` fine, `!` warning, `✗` must be fixed — each with a `→ hint` naming the command that fixes it. In order: `node`; `home` / `config`; `secrets` (file mode 600); `admin token`; `skills` (every SKILL.md parses); one `skill <name>` line per skill (secret present, `cwd` exists); `claude` / `codex` (installed and logged in, or API key set); `tailscale` (installed, running, port exposed); `server` (running, and where); `service` (installed and running). Fix every `✗` before exposing anything. The tailscale, server and service warnings disappear in steps 5 and 6.

## 4. Choose runner and model

The server default applies to every skill that does not set its own:

```bash
skillhook config set defaults.runner codex        # claude (default) | codex
skillhook config set defaults.model sonnet        # anything the runner accepts: opus, sonnet, haiku, gpt-5-codex, …
skillhook config set defaults.effort high         # low | medium | high | xhigh | max
skillhook config show
```

A skill overrides these in its `skillhook:` frontmatter (`runner`, `model`, `effort`). Runs are unattended: Claude runs with `--permission-mode bypassPermissions`, Codex with the `workspace-write` sandbox plus network access. Tighten one skill with `claude: { permission_mode: acceptEdits, allowed_tools: [...] }` or `codex: { sandbox: read-only }`, or all of them under `runners.claude` / `runners.codex` in `skillhook.json`. A fast model as the default and an `opus`-class model only for skills that edit code is the usual split.

## 5. Run the server

```bash
skillhook serve                   # foreground with readable logs — good for the first test, Ctrl-C to stop
skillhook service install         # launchd (macOS) / systemd --user (Linux): starts at login, restarts on crash
skillhook service status          # also: logs [--follow], restart, uninstall
```

The service runs the installed `dist/cli.js` with the current Node binary, so reinstall it after upgrading skillhook or Node. SKILL.md edits apply to the next webhook without a restart; config changes need `skillhook service restart`.

## 6. Get a permanent public URL

```bash
skillhook expose tailscale        # Tailscale Funnel: public HTTPS at https://<machine>.<tailnet>.ts.net
```

The first time, Tailscale answers with a `https://login.tailscale.com/f/funnel?…` approval link: the user opens it once, enables Funnel for the tailnet, and runs the command again. The URL is the node's name, so it survives reboots, IP changes and moving between networks; tailscaled keeps the configuration and skillhook stores it as `public_url`. The server itself stays bound to `127.0.0.1` — only Tailscale's TLS proxy reaches it.

- Senders that are on your tailnet only (SaaS webhooks are not): `skillhook expose tailscale --serve` — tailnet-only, no approval needed.
- No Tailscale: `skillhook expose cloudflare` or `skillhook expose ngrok` print the recipe; finish with `skillhook config set public_url https://…`.
- `skillhook expose status` shows what is exposed; `skillhook expose off` removes it and clears `public_url`.

## 7. Prove it end to end

```bash
skillhook send hello --wait 60            # signs like a real sender, POSTs to the local server, waits for the result
skillhook send hello --public --wait 60   # the same through the public URL — what the sender will experience
skillhook jobs list                       # every run; skillhook jobs show <id> --stdout prints the agent transcript
```

`200` with `"status": "succeeded"` and a `result` proves auth, queue, runner and login in one go. `202` means it was still running after the wait — fine; poll the `status_url` or `skillhook jobs show <id>`.

## 8. Hand the URL and secret to the sender

```bash
skillhook url <skill>                     # https://<node>.ts.net/hooks/<skill>
skillhook skills show <skill>             # prints the exact auth the sender must present
skillhook secret generate <skill>         # bearer/basic/hmac skills: skillhook invents the secret (shown once; --force rotates)
skillhook secret set GRANOLA_WEBHOOK_SECRET   # provider-signed skills (github, sentry, granola, stripe, slack, linear, svix): paste the provider's secret
```

Give the user the URL and the header to configure (bearer: `Authorization: Bearer <secret>`); never paste a secret into chat, a commit or a screenshot. Senders that want the answer in the HTTP response add `?wait=<seconds>` (up to `max_wait_seconds`, default 120). The bundled examples carry provider-specific setup steps in their SKILL.md: `skillhook skills examples`, then `skillhook skills add <example>`.

## The same through MCP

Install the plugin (`/plugin marketplace add MeterApp/skillhook`, then `/plugin install skillhook@meterapp-skillhook`) or add the server directly — `skillhook mcp --print-config` prints the command for Claude Code, Codex and mcp.json hosts. Tools map onto the CLI:

| Task | CLI | MCP tool |
| --- | --- | --- |
| Where am I | `skillhook doctor`, `skills list`, `jobs list` | `skillhook_status` (call it first), `doctor`, `list_skills` |
| Create a skill | `skillhook skills new`, `skills add`, `skills examples` | `create_skill`, `add_example`, `list_examples` |
| Secrets | `skillhook secret set / generate / list` | `set_secret`, `generate_secret`, `list_secrets` |
| Run and test | `skillhook run`, `skillhook send` | `run_skill`, `send_test_webhook` |
| Expose | `skillhook expose tailscale [--serve]`, `skillhook url` | `expose` (mode `funnel` / `serve` / `status` / `off`), `get_webhook_urls` |
| Service | `skillhook service …` | `service` (action `install` / `status` / `restart` / `logs` / `uninstall`) |
| Jobs | `skillhook jobs show / logs / cancel` | `get_job`, `list_jobs`, `cancel_job` |

`skillhook_status` reports the home directory, whether the server runs, the public URL and every skill with its auth type. The MCP server never returns secret values except right after `generate_secret`. `run_skill` uses the running server when there is one, otherwise runs in-process.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `503 skill_not_configured` | the skill's secret is not in `.env` | `skillhook secret generate <skill>` (bearer) or `skillhook secret set <ENV>` (provider); `skillhook doctor` names the variable |
| `401 missing_token` / `invalid_token` / `missing_signature` / `invalid_signature` | wrong secret, wrong header, or the sender signs differently than the skill's `auth.type` | compare `skillhook skills show <skill>` with the sender's settings; re-paste the secret; `skillhook send <skill>` proves the server side works |
| `401 stale_timestamp` | sender clock off, or a replayed delivery outside the 5-minute tolerance | check the machine clock; raise `tolerance_seconds` for that skill only |
| `429 too_many_failures` | 10+ failed auth attempts per minute from one IP | stop the sender, fix the secret, wait a minute |
| `404 unknown_skill` | wrong name in the URL, `enabled: false`, or SKILL.md fails to parse | `skillhook skills validate`, `skillhook url` |
| `200` with `"skipped": true` | the `when` filter rejected the event | expected for other event types (GitHub's `ping`); otherwise fix the filter |
| `200` with `"duplicate": true` | same delivery id or `dedupe` value within 24 hours | expected on retries; change the id to run again |
| `200` with `"duplicate": true, "in_flight": true` | the same payload is still queued or running for that skill | wait for the job named in the response (or `?wait=`); set `dedupe.in_flight: false` on the skill if every identical delivery must run |
| `Funnel not enabled` / an approval URL is printed | one-time tailnet approval pending | open the `login.tailscale.com` link, enable Funnel, rerun `skillhook expose tailscale` |
| doctor: `claude … not logged in` | headless runs use the same login as the terminal | `claude login` in a terminal, or `skillhook secret set ANTHROPIC_API_KEY` |
| doctor: `codex … not logged in`, or runs fail on a usage limit | ChatGPT login missing or exhausted | `codex login`; wait for the limit to reset, or `skillhook secret set OPENAI_API_KEY` |
| job `timed_out` | the agent exceeded `timeout_seconds` (default 900) | raise it in the skill or split the task; `skillhook jobs resume <id>` reopens the session |
| service installed but not running | Node path changed, or the port is taken | `skillhook service logs`, `skillhook service restart`; `lsof -i :8787` |
| works locally, sender gets connection errors | Funnel off, or the service not running | `skillhook expose status`, `skillhook service status`, `curl https://<node>.ts.net/health` |
| `skillhook send` says no server is running | nothing listens on the configured port | `skillhook serve` or `skillhook service install`; `--url http://127.0.0.1:8787` targets a specific server |
| `npm install -g @meterapp/skillhook` fails with `EEXIST` on `bin/skillhook` | the old unscoped `skillhook` 0.1.0 package owns the command | `npm uninstall -g skillhook`, install again, then `skillhook service install` if the service ran from the old install |
