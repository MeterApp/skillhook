# Runners

A runner is the program skillhook starts for a job. Three exist: `claude` (Claude Code, `claude -p`), `codex` (OpenAI Codex CLI, `codex exec`) and `shell` (any command). The runner, model, effort and working directory are resolved per job:

1. explicit overrides (`skillhook run --runner/--model/--effort/--cwd`, the `POST /skills/<name>/run` body, the MCP `run_skill` tool), then
2. the skill's `skillhook:` block, then
3. `defaults` in `skillhook.json` (`runner: claude`, `timeout_seconds: 900`, optional `model`, `effort`, `cwd`), then
4. for `cwd` only, the skill directory.

`skillhook run <name> --dry-run` prints the resolved command line, environment variable names, guardrails and prompt for any skill without starting the agent.

Related: [skills.md](skills.md) (per-skill fields), [security.md](security.md) (what the agent may do), [operations.md](operations.md) (config keys).

## Subscription or API key

Both agent runners use whatever login the CLI already has on the machine:

| Runner | Subscription login | API key |
|---|---|---|
| `claude` | `claude login` (Claude Pro/Max OAuth). `doctor` runs `claude auth status`. | `ANTHROPIC_API_KEY` in `~/.skillhook/.env` or the server environment (passes through automatically). |
| `codex` | `codex login` (ChatGPT account). `doctor` runs `codex login status`. | `OPENAI_API_KEY` in `.env` or the environment. |

Log in as the same user that runs the server (the launchd LaunchAgent / systemd user unit runs as you). Any variable in `~/.skillhook/.env` starting with `ANTHROPIC_`, `CLAUDE_`, `OPENAI_` or `CODEX_` (for example `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `OPENAI_BASE_URL`) is forwarded, so gateway and enterprise setups work unchanged. From the server's own environment only `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and the proxy/CA variables are copied.

## Claude runner

Command built for every job (`runners.claude.command` defaults to `claude`; set an absolute path or `["node", "/path/to/cli.js"]` when needed):

```text
claude -p --output-format stream-json --verbose \
  --permission-mode <claude.permission_mode | runners.claude.permission_mode> \
  --permission-prompts none \
  [--model <model>] [--effort <effort>] \
  --add-dir <skill dir> --add-dir <job dir> [--add-dir <claude.add_dirs…>] \
  [--allowedTools <allowed-tools + claude.allowed_tools, comma-joined>] \
  [--disallowedTools <claude.disallowed_tools>] \
  [--max-budget-usd <claude.max_budget_usd>] \
  --append-system-prompt "<guardrails>\n\n<claude.append_system_prompt>" \
  <runners.claude.args…> <claude.args…>
```

- The prompt (`# Skill: <name>` + rendered body [+ event block]) is written to the process's stdin, so payload size is not limited by argv.
- `--add-dir` is skipped for a directory that is already the cwd.
- Default permission mode is `bypassPermissions` so unattended runs never stall. `--permission-prompts none` is always set; with `acceptEdits`, `dontAsk` or `plan` a tool that would have prompted is denied instead, which is how `allowed_tools` becomes an allow-list.
- Model: aliases (`opus`, `sonnet`, `haiku`) or full ids. Effort: passed verbatim to `--effort`.

Output handling: skillhook parses the `stream-json` lines as they arrive. The `session_id` is captured from the first event and stored on the job immediately (so a cancelled or timed-out run is still resumable); the last `assistant` text and the final `result` event provide `result`, `cost_usd`, `usage` and `num_turns`. A result event with `is_error: true` or a non-zero exit marks the job `failed` with the error text (or the last stderr lines). Raw output is kept in `stdout.log` / `stderr.log`.

Resume a session interactively:

```bash
skillhook jobs resume <job id>
```

prints `cd <cwd> && claude --resume <session_id>`; add `--exec` to run it.

Server-wide settings (`skillhook.json`):

```json
{
  "runners": {
    "claude": {
      "command": "claude",
      "permission_mode": "bypassPermissions",
      "args": []
    }
  }
}
```

## Codex runner

Command built for every job (`runners.codex.command` defaults to `codex`):

```text
codex exec --json --skip-git-repo-check \
  -C <cwd> \
  -s <codex.sandbox | runners.codex.sandbox> \
  -c approval_policy="<runners.codex.approval_policy>" \
  -o <job dir>/last-message.md \
  [-c sandbox_workspace_write.network_access=true]   # when sandbox is workspace-write and network_access is true
  [-m <model>] [-c model_reasoning_effort="<effort>"] \
  [-p <codex.profile>] \
  --add-dir <skill dir> --add-dir <job dir> [--add-dir <codex.add_dirs…>] \
  <runners.codex.args…> <codex.args…> -
```

- The trailing `-` makes Codex read the prompt from stdin. Codex has no system-prompt flag, so the guardrails are prepended to the prompt, separated by a blank line.
- Defaults: sandbox `workspace-write`, `network_access: true` (webhook automations usually need to call APIs; Codex's own default is no network in that sandbox), `approval_policy: never`.
- `-o <file>` makes Codex write its final message to `last-message.md`; skillhook reads it when the JSON stream did not contain an `agent_message`.

Output handling: `thread.started` provides the `thread_id` (stored as `session_id`), `item.completed` with `type: agent_message` provides the result, `turn.completed` provides `usage`, and `turn.failed` / `error` mark the job `failed`. Codex does not report cost, so `cost_usd` is absent for Codex jobs.

Resume: `skillhook jobs resume <id>` prints `cd <cwd> && codex resume <thread_id>`.

Server-wide settings:

```json
{
  "runners": {
    "codex": {
      "command": "codex",
      "sandbox": "workspace-write",
      "network_access": true,
      "approval_policy": "never",
      "args": []
    }
  }
}
```

## Shell runner

For scripts, other agents, or forwarding. The skill must set `skillhook.shell.command`:

```yaml
skillhook:
  runner: shell
  shell:
    command: "./handle.sh"            # string: run via /bin/sh -c
    # command: ["python3", "handle.py"]   # array: executed directly
```

- stdin: the payload as pretty-printed JSON (or the raw text body).
- Environment: the same as the agent runners (below), including `SKILLHOOK_PAYLOAD_PATH`, `SKILLHOOK_EVENT_PATH`, `SKILLHOOK_PROMPT_PATH`, `SKILLHOOK_JOB_DIR`.
- cwd: resolved like any other job (skill `cwd`, `defaults.cwd`, else the skill directory), so relative script paths resolve against the skill directory by default.
- Result: stdout becomes `result`; exit code 0 means `succeeded`, anything else `failed` with the last stderr lines as the error. `--model`/`--effort` are ignored; no session is recorded.

The rendered prompt is still written to `prompt.md`, so a shell command can hand it to another LLM tool.

In a repository's `skillhook.yaml` a shell hook is written as `run: <command>` (string or array) and runs in the repository by default; see [projects.md](projects.md#run-hooks).

## Environment

Every runner gets a freshly built environment:

| Group | Variables |
|---|---|
| Base | `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TERM`, `TZ`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `SSH_AUTH_SOCK`, `COLORTERM` (copied from the server process when set). |
| `PATH` | The server's `PATH` followed by `~/.local/bin`, `~/.npm-global/bin`, `~/.bun/bin`, `~/.cargo/bin`, `/opt/homebrew/bin`, `/opt/homebrew/sbin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, so launchd's minimal PATH still finds `claude`, `codex`, `gh`, `node`. |
| Runner credentials | Every variable whose name starts with `ANTHROPIC_`, `CLAUDE_`, `OPENAI_` or `CODEX_`, plus `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `https_proxy`, `http_proxy`, `no_proxy`. Values come from `.env` merged with the server environment. |
| Explicit | Names listed in `env_passthrough` (config) and the skill's `env:`. |
| Job | `SKILLHOOK_JOB_ID`, `SKILLHOOK_JOB_DIR`, `SKILLHOOK_SKILL`, `SKILLHOOK_SKILL_DIR`, `SKILLHOOK_PAYLOAD_PATH`, `SKILLHOOK_EVENT_PATH`, `SKILLHOOK_PROMPT_PATH`, `SKILLHOOK_TRIGGER` (`webhook`/`cli`/`mcp`/`api`), `SKILLHOOK_RUNNER`. |
| Never implicit | `SKILLHOOK_ADMIN_TOKEN`, `SKILLHOOK_SECRET_*` (only if a skill lists them in `env:`). |

A `skillhook serve` started from inside an interactive Claude Code session does not leak that session's `CLAUDE_CODE_*` variables to child runs: prefix passthrough applies to `.env` only, and only the credential names listed above are copied from the server's environment.

## Working directory and extra directories

- `cwd` must exist when the job starts, otherwise the job fails immediately with `Working directory does not exist: <path> (skill "<name>" cwd)`. `~` is expanded.
- The skill directory and the job directory are always reachable: they are passed as `--add-dir` to Claude and Codex (unless one is the cwd) and given as absolute paths in the guardrails, the event block, `{{skill_dir}}`/`{{job_dir}}` and `SKILLHOOK_SKILL_DIR`/`SKILLHOOK_JOB_DIR`.
- Add more with `claude.add_dirs` / `codex.add_dirs`.
- Job directories are the intended place for artifacts (`{{job_dir}}/report.md`); they are deleted only by retention pruning.

## Timeouts, cancellation, concurrency

- Processes are spawned detached in their own process group. On timeout (`timeout_seconds`), cancel (`POST /jobs/<id>/cancel`, `skillhook jobs cancel`, MCP `cancel_job`) or server shutdown, the whole group gets `SIGTERM`, then `SIGKILL` 10 seconds later.
- Resulting statuses: `timed_out` (error `timed out after Ns`), `cancelled`, `interrupted` (server shut down or restarted while running; a queued job survives a restart and is re-queued).
- The queue is FIFO with a global cap of `concurrency` (default 2) running jobs and one job per skill at a time unless the skill sets `concurrency`. A job whose skill is at its limit is skipped in favour of the next eligible job.
- The `session_id`/`resume_command` are stored as soon as they appear, so an interrupted Claude or Codex run can be picked up with `skillhook jobs resume <id>`.

## Cost and usage

`job.json` records `cost_usd`, `usage` and `num_turns` when the runner reports them (Claude does; Codex reports `usage` only). `skillhook jobs list` shows duration, `jobs show` shows cost, and the `?wait=` HTTP response and the MCP `get_job` tool include the full record.
