# Operations

Running skillhook day to day: the home directory, the server and its background service, logs, jobs and retention, configuration, `doctor`, and troubleshooting.

Related: [exposure.md](exposure.md) (public URL), [security.md](security.md) (secrets and limits), [api.md](api.md) (job record fields).

## Home directory

`~/.skillhook` by default; `SKILLHOOK_HOME=<path>` or `--dir <path>` (accepted by every command) selects another one. `skillhook init` creates it.

```text
~/.skillhook/
├── skillhook.json          server configuration (JSON Schema: schema/skillhook.schema.json in the package)
├── .env                    secrets, mode 600: SKILLHOOK_ADMIN_TOKEN, SKILLHOOK_SECRET_<NAME>, provider secrets, API keys
├── server.json             present while a server runs: pid, host, port, started_at, version, public_url
├── update-check.json       what npm said at the last daily update check: checked_at, latest, current
├── skills/
│   └── <name>/SKILL.md     one directory per skill, plus any files the skill needs
├── jobs/
│   ├── .deliveries.json    delivery-id index for replay protection
│   └── <job id>/           one directory per job (see Jobs)
└── logs/
    └── service.log         server output when run by launchd / systemd
```

`init` flags: `--runner claude|codex` (default runner), `--model M` (default model), `--port N`, `--force` (rewrite `skillhook.json`). It generates `SKILLHOOK_ADMIN_TOKEN` and `SKILLHOOK_SECRET_HELLO` when missing and copies the `hello` example skill. Running it again is safe: existing files are kept unless `--force`.

## Running the server

```bash
skillhook serve [--port N] [--host H] [--pretty] [--log-level debug|info|warn|error]
```

On start the server logs invalid skills, warns about skills with `auth: none` or a missing secret (`deliveries will get 503`) and about a missing admin token, marks jobs left `running` by a previous process as `interrupted`, re-queues jobs that were still `queued`, listens, writes `server.json`, and logs `skillhook listening` plus one `webhook url` line per skill when `public_url` is set. Once a day it also logs `update available` when npm has a newer skillhook (see [Upgrading](#upgrading-and-removing)).

Logs go to stderr as one JSON object per line (`{"ts":…,"level":…,"msg":…}`) unless stdin is a TTY or `--pretty` is given. `SIGINT`/`SIGTERM` stop accepting requests, SIGTERM running jobs (they end as `interrupted`; SIGKILL follows after 10 s) and remove `server.json`.

Other commands find the running server through `server.json` and `GET /health`. `skillhook send`, `skillhook jobs cancel` and the MCP tools `run_skill` (server mode) and `cancel_job` need it; `skillhook run` does not.

### As a background service

```bash
skillhook service install
```

macOS, a launchd LaunchAgent:

- File: `~/Library/LaunchAgents/co.meterapp.skillhook.plist`.
- `ProgramArguments`: `<node> <install>/dist/cli.js serve --dir <home>`. `<node>` is the Node binary that ran the install; a Homebrew `Cellar/node/<version>/bin/node` path is replaced by the stable `/opt/homebrew/bin/node` (or `/usr/local/bin/node`) symlink when it resolves to the same binary, so `brew upgrade node` does not strand the service.
- `EnvironmentVariables`: `PATH` (the installing shell's `PATH` plus the standard tool directories), `HOME`, `SKILLHOOK_HOME`, `LANG=en_US.UTF-8`.
- `RunAtLoad` and `KeepAlive` (restart on exit), `ThrottleInterval` 5 s, `WorkingDirectory` `<home>`, stdout and stderr appended to `<home>/logs/service.log`.
- Install runs `launchctl bootout gui/<uid>/co.meterapp.skillhook` (failure ignored), waits for the old instance to disappear, `launchctl bootstrap gui/<uid> <plist>` (retried up to five times), then `launchctl kickstart -k`.

Linux, a systemd user unit:

- File: `~/.config/systemd/user/co.meterapp.skillhook.service` (`$XDG_CONFIG_HOME` respected).
- `ExecStart=<node> <install>/dist/cli.js serve --dir <home>`, `Restart=always`, `RestartSec=5`, the same environment, output appended to `service.log`.
- Install runs `systemctl --user daemon-reload` and `systemctl --user enable --now co.meterapp.skillhook`. Run `loginctl enable-linger $USER` once so the unit starts at boot without an interactive login.

Requirements and caveats:

- The service points at the compiled `dist/cli.js` of the installation that ran `service install`. An npm install ships it; a git checkout needs `npm run build` first, otherwise install fails with `Compiled CLI not found`.
- Re-run `skillhook service install` after moving or reinstalling skillhook, switching Node installations, or changing `SKILLHOOK_HOME`. Run `skillhook service restart` after editing `skillhook.json`; skills and secrets reload without a restart.
- The service runs as your user, with your Claude and Codex logins. `claude login` / `codex login` must have been done by that same user.

```bash
skillhook service status       # platform, installed, running (pid), plist/unit path, log path; exit 1 when not installed
```

```bash
skillhook service restart
```

```bash
skillhook service logs --lines 200 --follow
```

```bash
skillhook service uninstall
```

## Logs

| What | Where |
|---|---|
| Server log, service | `<home>/logs/service.log`; `skillhook service logs [--lines N] [-f]` |
| Server log, foreground | stderr |
| Agent output per job | `<home>/jobs/<id>/stdout.log` and `stderr.log`; `skillhook jobs logs <id> [--stderr] [-f]` |
| Unexpected CLI errors with stack traces | run with `SKILLHOOK_DEBUG=1` |

Log lines carry skill names, job ids, client IPs, delivery ids, statuses, durations, cost and error messages; never secret values or payload bodies. `log_level` in `skillhook.json` (or `serve --log-level`) controls verbosity. skillhook does not rotate `service.log`; use `newsyslog`, `logrotate`, or truncate it.

## Jobs

Lifecycle: `queued` → `running` → one of `succeeded`, `failed`, `timed_out`, `cancelled`, `interrupted`. A job is written to disk before it is queued, so a crash loses at most the processes that were running; those become `interrupted` at the next start and queued ones run.

| File in `jobs/<id>/` | Content |
|---|---|
| `job.json` | The job record ([fields](api.md#job-record)) including the exact `command` argv. Rewritten atomically at every state change. |
| `payload.json` | The parsed payload, pretty-printed (the raw text for non-JSON bodies). |
| `event.json` | Everything known about the delivery: method, path, query, redacted headers, source IP, content type and length, body kind, delivery id, payload. |
| `prompt.md` | The exact prompt sent to the runner (not written by `--dry-run`). |
| `stdout.log`, `stderr.log` | Raw runner output (`stream-json` / JSONL for the agent runners). |
| `result.md` | The final agent message, complete. |
| `last-message.md` | Codex only, written by `codex exec -o`. |
| `body.bin` | The raw request body when it was binary. |

All files are mode 600. Job ids are `YYYYMMDDTHHMMSSZ-<6 random chars>` (UTC), so `ls jobs/` sorts chronologically.

Retention: after each new job the store deletes the oldest finished jobs beyond `jobs.max_jobs` (1000); `skillhook jobs prune [--keep N]` does the same on demand. Running and queued jobs are never pruned. Delivery ids expire after `jobs.dedupe_window_seconds` (86400).

```bash
skillhook jobs list [--skill NAME] [--status queued|running|succeeded|failed|timed_out|cancelled|interrupted] [--limit N]
```

```bash
skillhook jobs show <id> [--result] [--prompt] [--stdout] [--stderr]
```

```bash
skillhook jobs logs <id> [--follow] [--stderr]
```

```bash
skillhook jobs cancel <id>           # via the running server's admin API
```

```bash
skillhook jobs resume <id> [--exec]  # prints (or runs) `cd <cwd> && claude --resume <session>` / `codex resume <thread>`
```

```bash
skillhook jobs path <id>
```

```bash
skillhook jobs prune [--keep N]
```

`jobs cancel` needs the server that owns the job; a job started by `skillhook run` belongs to that CLI process (stop it with Ctrl-C).

## Configuration

`skillhook.json` is validated strictly: unknown keys and wrong types are errors, and `config set` refuses to write an invalid file. `skillhook config show` prints the effective configuration with defaults applied; `config get <dotted.key>`; `config set <dotted.key> <value>` (values that look like JSON, such as `4`, `true`, `["a","b"]`, `{"k":1}`, are parsed, everything else is a string); `config unset <dotted.key>`; `config path`. Restart the server after changing it, except for `projects`, which the server re-reads on its own.

| Key | Default | Meaning |
|---|---|---|
| `$schema` | set by `init` | JSON Schema URL for editor validation. |
| `port` | `8787` | Listen port. |
| `host` | `"127.0.0.1"` | Bind address. Keep it on loopback and let a tunnel expose it. |
| `public_url` | unset | Public base URL, set by `expose`; informational. |
| `trust_proxy` | `true` | Use forwarded client addresses from loopback proxies. |
| `defaults.runner` | `"claude"` | Runner for skills that do not set one (`claude`, `codex`, `shell`). |
| `defaults.model` | unset | Model for skills that do not set one. |
| `defaults.effort` | unset | Effort for skills that do not set one. |
| `defaults.timeout_seconds` | `900` | Timeout for skills that do not set one. |
| `defaults.cwd` | unset | Working directory for skills that do not set one (else the skill directory). |
| `concurrency` | `2` | Jobs running at once across all skills. |
| `max_body_bytes` | `1048576` | Request body limit. |
| `max_wait_seconds` | `120` | Upper bound for `?wait=`. |
| `rate_limit.requests_per_minute` | `120` | Per client IP. |
| `rate_limit.auth_failures_per_minute` | `10` | Per client IP. |
| `runners.claude.command` | `"claude"` | Executable, or an array whose head is the executable (`["node", "/path/cli.js"]`). Use an absolute path for services. |
| `runners.claude.permission_mode` | `"bypassPermissions"` | Default `--permission-mode`. |
| `runners.claude.args` | `[]` | Extra argv for every Claude run. |
| `runners.codex.command` | `"codex"` | Executable or array. |
| `runners.codex.sandbox` | `"workspace-write"` | Default `-s`. |
| `runners.codex.network_access` | `true` | Allow network in the `workspace-write` sandbox. |
| `runners.codex.approval_policy` | `"never"` | `-c approval_policy=…`. |
| `runners.codex.args` | `[]` | Extra argv for every Codex run. |
| `jobs.max_jobs` | `1000` | Retention. |
| `jobs.dedupe_window_seconds` | `86400` | Replay window. |
| `jobs.dedupe_in_flight` | `true` | Fold a delivery identical to a queued or running job of the same skill into that job; skills override with `dedupe.in_flight`. |
| `jobs.inline_payload_max_bytes` | `200000` | Payload size inlined in prompts. |
| `env_passthrough` | `[]` | Extra env var names copied into every run. |
| `projects` | `[]` | Linked repositories (absolute paths, `~` allowed; a directory holding `skillhook.yaml`, or the file itself). Written by `skillhook link` / `unlink`; re-read without a restart. See [projects.md](projects.md). |
| `log_level` | `"info"` | `debug`, `info`, `warn`, `error`. |
| `update_check` | `true` | Daily check of the npm registry for a newer skillhook (`SKILLHOOK_NO_UPDATE_CHECK=1` and `CI` disable it as well). |

Examples:

```bash
skillhook config set runners.claude.command '["/Users/me/.local/bin/claude"]'
```

```bash
skillhook config set concurrency 4
```

```bash
skillhook config set defaults.model sonnet
```

## Doctor

`skillhook doctor` prints one line per check with a hint for anything that is not ok, and exits 1 when a check fails. `--json` returns `{checks, ok, summary, public_url, server}`.

| Check | ok | warn | fail |
|---|---|---|---|
| `node` | Node >= 22 | | older Node |
| `version` | this is the latest skillhook | a newer version is on npm (hint: `skillhook update --install`) | (`skip` when the check is disabled or the registry does not answer) |
| `home` / `config` | home exists and `skillhook.json` parses (or defaults apply) | | home missing; invalid config |
| `secrets` | `.env` has mode 600 | `.env` missing or another mode | |
| `admin token` | `SKILLHOOK_ADMIN_TOKEN` set | unset (admin API localhost-only) | |
| `skills` | all `SKILL.md` files parse | no skills yet | one or more invalid |
| `skill <name>` | runner, model, auth type and cwd (and the `skillhook.yaml` it comes from) | `auth: none` | secret missing (`webhooks will get 503`); cwd does not exist |
| `project <dir>` | the linked repository's `skillhook.yaml` parses; hooks listed | | file missing or invalid; a hook that does not compile (`skip` when nothing is linked) |
| `claude` / `codex` | CLI found and logged in, or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` present | | not on PATH; not logged in (checked only for runners a skill or the default uses) |
| `tailscale` | the configured port is exposed via Funnel or Serve (URL shown) | CLI missing; not running; port not exposed | |
| `public url` | `<public_url>/health` answers | did not answer (certificate still provisioning, or the server is down) | |
| `server` | running (version, queue) | not running | |
| `service` | running (pid) | installed but not running | (`skip` when not installed or unsupported platform) |

## Keeping a Mac awake

Jobs run only while the machine is awake. On a desktop Mac disable sleep (`sudo pmset -a sleep 0`, or System Settings → Energy → Prevent automatic sleeping when the display is off). A laptop that stays on power can run `caffeinate -s` in a terminal, or use the same `pmset` setting. Tailscale reconnects after wake and providers such as Granola retry failed deliveries for days, so a short sleep loses nothing, but a long one delays every job until wake.

## Upgrading and removing

skillhook asks the npm registry once a day whether a newer version exists (in a detached background process after an interactive command, every 24 hours inside `skillhook serve`, and on demand in `skillhook doctor`) and caches the answer in `<home>/update-check.json`. A newer version is mentioned on stderr after the next interactive command (never with `--json`, never in CI), as a `version` warning in `doctor`, as an `update available` line in the server log, and in the MCP `skillhook_status` tool.

```bash
skillhook update             # ask the registry now and print the upgrade command
```

```bash
skillhook update --install   # upgrade with npm, pnpm, bun or yarn (whichever installed skillhook), then restart the service when it is idle
```

`--install` refuses to touch a source checkout (`git pull && npm ci && npm run build` there) or an `npx` cache (`npx @meterapp/skillhook@latest`). The background service keeps running the old version until it restarts; `update --install` restarts it unless a job is queued or running, and says so either way (`skillhook service restart` later). A global install that moved to another Node (`nvm`, Homebrew major upgrade) needs `skillhook service install` again so launchd/systemd point at the new `dist/cli.js`. Configuration, skills, secrets and jobs in `~/.skillhook` are untouched by upgrades.

skillhook 0.1.0 was published as the unscoped `skillhook` package; 0.1.1 and later are `@meterapp/skillhook`, which the old package's update check never sees. Move with `npm uninstall -g skillhook && npm install -g @meterapp/skillhook` (npm refuses the new package while the old one owns the `skillhook` command), then run `skillhook service install` again if the service ran from the old global install. `~/.skillhook` stays as it is.

Opt out of the check with `SKILLHOOK_NO_UPDATE_CHECK=1` (the conventional `NO_UPDATE_NOTIFIER=1` works too), `CI=1`, or `"update_check": false` in `skillhook.json`; `SKILLHOOK_NPM_REGISTRY=https://…` points it at a mirror. Release notes: https://github.com/MeterApp/skillhook/releases.

To stop everything:

```bash
skillhook service uninstall
```

```bash
skillhook expose off
```

Then delete `~/.skillhook` if you no longer want the configuration, secrets and job history.

## Troubleshooting

### `Funnel needs a one-time approval in the Tailscale admin console`

Funnel (and HTTPS certificates) must be enabled for the node once. Open the printed `https://login.tailscale.com/…` link, approve, and run `skillhook expose tailscale` again. See [exposure.md](exposure.md#troubleshooting).

### Webhook answers `503 skill_not_configured`

The env var named by the skill's `secret_env` (default `SKILLHOOK_SECRET_<NAME>`) is not in `.env` or the server environment; the server log says `skill secret missing`. `skillhook doctor` names the variable. Fix with `skillhook secret generate <skill>` (bearer, basic, generic hmac) or `skillhook secret set <ENV_NAME>` (provider secret). No restart is needed.

### Provider deliveries answer `401`

`invalid_signature` / `invalid_token`: the secret in `.env` differs from the one configured at the sender, or the sender is configured for a different scheme than `auth.type`. Compare with `skillhook skills show <name>` (it prints what the sender must send) and re-paste the secret. `stale_timestamp`: the machine's clock is off by more than `tolerance_seconds` (300); fix the clock. `missing_signature`: a proxy or test client is stripping headers.

### `404 unknown_skill`

The directory name and `name:` differ, the name has uppercase letters or underscores, the directory starts with `.` or `_`, the skill has `enabled: false`, or `SKILL.md` is invalid (then the server also logs `skill failed to load` and answers `500 invalid_skill`). For a repository hook: the repository is not linked on this machine, the hook was removed from `skillhook.yaml`, or its name is shadowed by an earlier definition. `skillhook skills validate` and `skillhook projects` show the reason.

### Job ends as `interrupted` after a restart

The server (or the machine) stopped while the agent was running; the process was terminated and the job marked `interrupted` with `server restarted while the job was running` or `server shut down while the job was running`. If a session id was captured, `skillhook jobs resume <id>` reopens the agent session; otherwise re-send the delivery (`skillhook send <skill> --payload @<home>/jobs/<id>/payload.json`).

### Job fails at once with `Working directory does not exist`

The skill's `cwd` (or `defaults.cwd`) points at a missing directory on this machine. `skillhook doctor` flags it per skill.

### `failed to start claude: spawn claude ENOENT` (or `codex`) under the service

The service `PATH` is fixed at install time; the runner binary is not in it. Set an absolute path (`skillhook config set runners.claude.command /Users/me/.local/bin/claude`) or re-run `skillhook service install` from a shell whose `PATH` contains the binary, then `skillhook service restart`.

### `claude` or `codex` is `not logged in` under the service but works in a terminal

Log in as the same user that runs the service (`claude login`, `codex login`), then check with `skillhook doctor`. As an alternative, put `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in `~/.skillhook/.env`; they pass through to the runner automatically.

### Service installed but not running

`skillhook service logs`. Typical causes: `Compiled CLI not found` (build or reinstall, then `service install` again); the Node binary moved (re-run `service install`); `EADDRINUSE` because a foreground `skillhook serve` or an old process holds the port (`lsof -i :8787`); an invalid `skillhook.json` (run `skillhook config show`).

### `429`

`rate_limited`: more than `rate_limit.requests_per_minute` requests from one IP in a minute. `too_many_failures`: more than `rate_limit.auth_failures_per_minute` failed authentications from one IP; usually a misconfigured secret at a retrying sender. Both reset after a minute.

### `413 payload_too_large`

Raise `max_body_bytes` (default 1 MiB) or have the sender post a reference instead of the full document.

### Delivery answered `duplicate: true` or `skipped: true`

`duplicate`: the same provider delivery id (or `dedupe` value) was seen within the last `jobs.dedupe_window_seconds`; the original `job_id` is in the response. `duplicate` with `in_flight: true`: a job of the same skill with the same payload and query string was still queued or running; the response names it, and the payload runs again once that job has finished (set `dedupe.in_flight: false` on the skill if every identical delivery must run). `skipped`: a `when` condition did not match; the `reason` names it. All three are logged at `info`.

### Jobs end as `timed_out`

The agent exceeded `timeout_seconds` (skill, else `defaults.timeout_seconds`, default 900). Raise it for long tasks, tighten the instructions, or pick a faster model. The captured session can be resumed with `skillhook jobs resume <id>`.

### Public URL does not answer

Right after `expose`, Tailscale may still be issuing the certificate: wait a minute and run `skillhook expose status` or `skillhook doctor` (the `public url` check). Otherwise confirm the server is running and the mapping targets the right port.

### The MCP server sees a different home than the CLI

The MCP process reads `SKILLHOOK_HOME` or `--dir` from its own configuration. `skillhook mcp --print-config` adds `--dir` when either is set; make the MCP client and your shell agree.
