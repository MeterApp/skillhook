# Accounts

One machine can hold several Claude Code and Codex logins: a work Claude Max and a personal one, a ChatGPT Pro and a
team plan, a long-lived token for CI, an API key that pays per use. skillhook names each one an **account**. A skill
runs as an account, or as a **pool** of accounts that skillhook picks from. skillhook keeps a record of what each
account is doing and says which ones need a person.

```bash
skillhook accounts add work --runner claude --login         # its own directory; logs in with claude auth login
skillhook accounts add personal --runner claude --login
skillhook accounts add pro --runner codex --login --device-auth
skillhook accounts default work personal                    # claude runs use this pool unless a skill names one
skillhook accounts                                          # state, who, plan, usage left, last use, jobs, what needs attention
```

```text
account     runner  state              who           plan  usage                 next reset    last used  jobs 24h           skills
----------  ------  -----------------  ------------  ----  --------------------  ------------  ---------  -----------------  ------
work *      claude  ready              me@acme.com   max   5h 42% · weekly 17%   5h in 2h 5m   3m ago     14/15 ok           4
personal *  claude  limited in 1h 50m  me@gmail.com  pro   5h 100% · weekly 61%  5h in 1h 50m  1h ago     2/3 ok, 1 limited  2
pro         codex   ready              me@acme.com   pro   weekly 48%            weekly in 3d  2h ago     1/1 ok             1
(* a runner's default: defaults.accounts)

Needs attention:
  ! personal: You've hit your session limit · resets 6pm (Europe/Paris); skipped until 2026-10-23T16:00:00.000Z
      → wait, or skillhook accounts reset personal once the plan allows runs again
```

## What an account is

| Kind | What it holds | How it logs in | Run gets |
| --- | --- | --- | --- |
| `login` (default) | a configuration directory of its own: `~/.skillhook/accounts/<name>`, or `--config-dir` | `skillhook accounts login <name>` runs `claude auth login` / `codex login` with that directory | `CLAUDE_CONFIG_DIR=<dir>` / `CODEX_HOME=<dir>` |
| `token` (Claude Code) | a `claude setup-token` token (about a year, uses the subscription, needs no browser on the machine) | `skillhook accounts login <name> --token` runs `claude setup-token` and keeps the token in `.env` | `CLAUDE_CODE_OAUTH_TOKEN` |
| `api_key` | an Anthropic or OpenAI API key (pay per use) | `skillhook secret set SKILLHOOK_ACCOUNT_<NAME>_API_KEY` | `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` and `CODEX_API_KEY` |

The machine's own login is an account like any other: `skillhook accounts add own --runner claude --config-dir ~/.claude`
(or `skillhook accounts discover --add`). For that directory no variable is set, because on macOS Claude Code names its
keychain entry after a `CLAUDE_CONFIG_DIR` other than `~/.claude`.

A run that uses an account gets **only that account's credentials**. skillhook removes `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` (Claude Code), or `OPENAI_API_KEY` and `CODEX_API_KEY` (Codex),
from the run's environment, wherever they came from, so the run is billed to that account. Even when a skill's `env:`
lists them, they are removed. Tokens and keys kept as `SKILLHOOK_ACCOUNT_*` in `.env` never reach a run directly; a run
gets them only as the CLI's own variable, and only for its own account.

### Settings shared with the machine's own login

A fresh configuration directory has none of the machine's settings: no MCP servers, plugins, skills or `config.toml`.
With `share_from`, skillhook links them in and leaves the login private:

- **Codex** (the default for `accounts add --runner codex`, as t3code does): every top-level entry of `~/.codex` is
  linked into the account's `CODEX_HOME`, so config, MCP servers, skills, plugins and sessions are shared. These stay
  the account's own: `auth.json`, `models_cache.json`, logs, memories, `tmp`. Because sessions are shared, a session
  one account started can be resumed by another. `--no-share` gives an isolated home. Codex must keep its login in
  `auth.json` (`cli_auth_credentials_store = "file"`, the default) for two homes to hold two logins.
- **Claude Code** (opt-in, `--share` or `--share ~/.claude`): `settings.json`, `CLAUDE.md`, `agents`, `commands`,
  `skills` and `output-styles` are linked. These stay the account's own: `.credentials.json` and the keychain entry,
  `.claude.json` (which also holds user-scoped MCP servers) and sessions.

An entry the account already has as its own file is kept, never replaced. `skillhook accounts sync` links whatever the
shared directory gained since.

## Using accounts in skills

```yaml
skillhook:
  account: work                  # one account
  # account: [work, personal]    # a pool: the first usable one runs (account_policy.strategy)
```

- `account:` sets the runner when the skill does not set `runner:` (all accounts of a pool share one runner).
- A skill without `account:` uses `defaults.accounts.<runner>` (`skillhook accounts default …`). With no default either,
  it uses the machine's own login, the same as before accounts existed. `claude.config_dir` still works; `account:` wins.
- In `skillhook.yaml`, `account:` works per hook like any other block key.
- `skillhook run <skill> --account NAME` (and `POST /skills/<name>/run` with `"account"`) runs as one account, whatever
  the skill says. `--dry-run` shows the account and its environment.
- A `fallback:` runner uses its target's `account:` (`{runner: codex, account: pro}`), else that runner's default.

### How a pool picks

Before a job runs, the queue goes through the pool:

1. **Order.** With `account_policy.strategy: ordered` (the default), accounts are tried in the order listed. With
   `balanced`, the account with the most usage left goes first, then the one used least recently. Either way, a limited
   account goes last.
2. **Skip** accounts that are disabled, limited until a reset that has not come yet, not defined, or that fail the
   readiness check: not logged in, login expired, token missing, CLI not installed. The check is cached for
   `health.readiness_cache_seconds`.
3. **Run** as the first account left. The job records `account`, and `runner_reason` lists the skipped accounts.
4. **Fail over.** When the run fails for an account reason (`auth`, `usage_limit`) before the agent produced anything,
   the pool's next usable account runs the same job. The failed run stays in `attempts` with its account. Turn this
   off with `account_policy.failover: false`. Only after that does `retry:` (same account) or `fallback:` (another
   runner) apply.
5. **No account left?** The job fails at once and its error gives every account's reason. Its `failure.kind` is
   `usage_limit` when they are all limited, otherwise `auth`. A `fallback:` with `on: [not_ready]` still takes over.

### What a run teaches about its account

The queue writes it to `jobs/.accounts.json` (`accounts reset <name>` forgets it):

- **When it was last used, and when it last succeeded.**
- **A usage limit.** The account is skipped until the limit resets. The reset time is taken from the first of these
  that gives one:
  1. Claude Code's own `rate_limit_event` with a rejected window.
  2. The CLI's message: Claude Code's `resets 6pm (America/New_York)` or `limit reached|<epoch>`, Codex's
     `try again in 2 days 3 hours`.
  3. Otherwise `account_policy.limited_cooldown_minutes` after the failure.
- **A failed login**, until the account's next success.
- **Usage windows.** Every Claude Code run reports how much of its 5-hour and weekly windows is used.

## Usage and plan

`skillhook accounts usage` (or `accounts --usage`, `accounts show <name> --usage`, MCP `list_accounts {usage: true}`,
`GET /accounts?usage=1`) asks each account's own CLI who is logged in and how much of its plan is used. No prompt is
sent and skillhook never handles a token: the CLI asks its provider with the account's own login, exactly as it does
before a run.

- **Claude Code** answers through its control protocol, the same one the Claude Agent SDK and t3code use. skillhook runs
  `claude -p --input-format stream-json` with no hooks, no MCP servers and no saved session, and sends three requests:
  - `initialize` returns the email, `subscriptionType` and token source;
  - `get_usage` returns the windows: `five_hour`, `seven_day`, one per model (for example "weekly (Opus)"), and extra
    usage or spend;
  - `get_status` says whether the login expired.
- **Codex** answers through `codex app-server`: `account/read` returns the email and plan; `account/rateLimits/read`
  returns the primary and secondary windows (5h / weekly), credits and whether a limit was reached.
- An `api_key` account has no windows (it pays per use).

A window at 100% marks the account as limited until that window resets. A window at or above
`account_policy.usage_warn_percent` (85 by default) makes the account need attention. While `serve` runs,
`account_policy.usage_poll_minutes` reads every account's usage that often (off by default, as t3code polls every 5
minutes); `skillhook accounts` shows the last reading and when it was taken.

## MCP servers, connectors and plugins

Every account has its own configuration directory, so its runs can get different MCP servers, claude.ai or ChatGPT
connectors and plugins than the machine's own login, and each one that uses OAuth needs logging in as that account.
`skillhook accounts show <name> --mcp` (or `accounts --mcp`, `accounts check --mcp`, MCP `list_accounts {mcp: true}`,
`GET /accounts?mcp=1`) asks each account's own CLI, with the account's environment, which servers its runs get and
whether each one connects:

```text
$ skillhook accounts show work --mcp
…
MCP servers: 3/5 connected
  server                    state       from       tools  target / problem
  ------------------------  ----------  ---------  -----  ---------------------------------
  sentry                    needs auth  user              needs authentication
  slack                     failed      user              Connection closed
  claude.ai Gmail           connected   connector  5      https://mcp-proxy.example/gmail (claudeai-proxy)
  plugin:supabase:supabase  connected   plugin     2      https://mcp.supabase.example/mcp (http)
  stitch                    connected   user       3      https://stitch.example/mcp (http)
  plugins    supabase@claude-plugins-official@0.1.15 (+1 disabled)

  ! MCP server needs authentication: sentry; its tools are missing from this account's runs
      → skillhook accounts exec work -- claude   then /mcp and authenticate sentry
```

It is slow, so only on request: every server connects, one process per account (in parallel), each bounded by
`health.probe_timeout_seconds`. No prompt is sent.

- **Claude Code** answers the control protocol's `mcp_status` request (`claude -p --input-format stream-json`, as for
  usage, but with the account's MCP configuration and claude.ai connectors left on and hooks off). It lists the
  user-, local- and managed-scope servers, plugins' servers (`plugin:<plugin>:<server>`) and the claude.ai connectors
  (`from: connector`) with their state (`connected`, `needs-auth`, `failed` with the CLI's reason, `disabled`), and
  skillhook asks again until none is still `pending`. The run starts in a temporary directory, so a repository's own
  `.mcp.json` is not part of it. `claude plugin list --json` lists the plugins. A Claude Code without `mcp_status`
  falls back to `claude mcp list` (no connectors).
- **Codex**: `codex mcp list --json` says what is configured and enabled, and `codex app-server`'s
  `mcpServerStatus/list` what connected, with how many tools, or why not (an OAuth server that needs logging in is
  `needs_auth`). Servers the configuration does not list come from plugins or are the ChatGPT apps (`codex_apps`,
  `from: connector`). `codex plugin list` lists the installed plugins.
- The probe runs with a job's environment (the allow-list, without any skill's `env:`), so a server whose command or
  headers need a variable from `.env` fails here with "Environment variable … is not set" as it would in a run of a
  skill that does not list it.
- The CLIs' answers include each server's headers and environment, tokens among them. skillhook keeps only the URL or
  the command line, as `claude mcp list` prints it.

Each server is `{name, target, transport?, state: connected|needs_auth|failed|disabled|unknown, detail?, source?,
plugin?, tools?}`; `unknown` is a server still connecting when the time ran out, or one Codex did not start. The
summary in `skillhook accounts --mcp` is `connected/not disabled` (for example `7/9 (1 need auth, 1 failed)`).
`skillhook health` (deep, the default) has an `account <name> mcp <server>` row per server of each account in the
"tools" group (an account with the machine's own directory is already covered by the `claude mcp` / `codex mcp` rows).

## What needs attention

Each account lists its problems in `attention`, each with a level and the command that fixes it:

| code | level | means | fix |
| --- | --- | --- | --- |
| `not_logged_in`, `dir_missing` | fail | the directory has no login | `skillhook accounts login <name>` |
| `login_expired` | fail | Claude Code says `Login: Expired` | `skillhook accounts login <name>` |
| `missing_secret` | fail | the token or key is not in `.env` | `accounts login <name> --token` / `secret set …` |
| `not_installed` | fail | `claude` / `codex` not found | install it, or `runners.<runner>.command` |
| `auth_failed` | fail | a run failed to authenticate in the last 24 h and none succeeded since | `skillhook accounts login <name>` |
| `limited` | warn | a usage limit; skipped until it resets | wait, or `accounts reset <name>` |
| `usage_high` | warn | a window at or above `usage_warn_percent` | — |
| `duplicate_login` | warn | logged in as the same person as another account: a pool of both adds no capacity | log one in as someone else |
| `unused` | info | no skill uses it and it is no runner's default | `account: <name>` in a skill |
| `mcp_needs_auth` | warn | (`--mcp`) MCP servers that need logging in as this account; their tools are missing from its runs | `skillhook accounts exec <name> -- claude`, then `/mcp`; `skillhook accounts exec <name> -- codex mcp login <server>` |
| `mcp_failed` | warn | (`--mcp`) MCP servers that fail to connect, with the reason | `skillhook accounts exec <name> -- claude mcp get <server>` (or `codex mcp get`); for a missing environment variable, `skillhook secret set <VAR>` and `env:` in the skills that need it |
| `mcp_missing` | info | (`--mcp`) servers the machine's own login has and this account lacks (connectors are not compared) | add them as the account (`accounts exec <name> -- claude mcp add --scope user …`), or for Codex share `~/.codex` |

Skills that name an account that does not exist, or one of another runner, are in `problems`.

These problems show up in several places:

- **`skillhook accounts`** lists them under "Needs attention".
- **`skillhook accounts check`** exits 1 when any account has a `fail` or `warn` problem, or a skill has a problem. Run
  it from cron, CI or a scheduled shell hook. `--notify` also shows a desktop notification (macOS `osascript`, Linux
  `notify-send`).
- **`skillhook health`** has an `account <name>` row per account in the "runners" group, and a failing
  `skill <name> account` row for a skill that names a wrong account.
- **The event bus** (`GET /events`) carries two account events:
  - `account.changed`: an account became usable or stopped being usable;
  - `account.updated`: it was `limited`, it `recovered`, it had `auth_failed`, or its `usage` was read.

  `serve` checks every account once when it starts, so a logged-out account is reported before a job trips over it.
  It also logs `account needs attention` with the fix.
- **`account_policy.notify: desktop`** makes `serve` show a desktop notification when an account stops working, hits a
  limit or recovers.

## Commands

| Command | What it does |
| --- | --- |
| `skillhook accounts [list] [--usage] [--mcp] [--refresh] [--local]` | Every account in one table, then what needs attention. Uses the running server when there is one, sharing the readiness cache that jobs use. `--mcp` adds how many of each account's MCP servers connect. |
| `accounts show <name> [--usage] [--mcp]` | One account in full: directory or secret, who, plan, each window with its reset, credits, last use, jobs and cost of the last 24 h, skills, with `--mcp` its MCP servers, connectors and plugins, and every problem with its fix. |
| `accounts usage [name]` | Reads the usage windows now and keeps them. |
| `accounts check [--usage] [--mcp] [--notify]` | Exit 1 when something needs a person (with `--mcp`, also an MCP server that needs authentication or fails). |
| `accounts add <name> --runner claude\|codex [--config-dir D] [--share [DIR]\|--no-share] [--token\|--api-key] [--secret-env NAME] [--label L] [--default] [--login]` | Registers an account and makes its directory (mode 700). |
| `accounts login <name> [--device-auth] [--console] [--sso] [--email E] [--token]` | Logs in in this terminal, then says who it is and warns about a duplicate. Over SSH, use `--device-auth` (Codex) or `--token` (Claude Code). |
| `accounts logout <name>` | `claude auth logout` / `codex logout` for that directory. |
| `accounts default <name>… [--runner R]` · `accounts default --clear --runner R` | The account or pool a runner uses when a skill names none. |
| `accounts enable\|disable <name>` | Takes an account out of every pool for a while. |
| `accounts reset <name>` | Forgets a remembered limit or failed login. |
| `accounts discover [--add]` | Finds logins already on the machine (`~/.claude`, `~/.codex`, `~/.claude-*`, `~/.codex-*`, each skill's `claude.config_dir`, `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in `.env`), shows who each one is, and registers the new ones. |
| `accounts sync [name]` | Links what the shared directory gained since (`share_from`). |
| `accounts exec <name> -- <command…>` | Runs any command as the account. A job's `resume_command` uses it: `skillhook accounts exec work -- claude --resume <id>`. |
| `accounts remove <name> [--purge]` | Forgets the account and takes it out of the defaults. `--purge` also deletes its directory under `~/.skillhook/accounts` and its `.env` entry. |

`skillhook jobs list --account NAME` (`GET /jobs?account=`) lists the jobs that ran as an account; `jobs show` shows the
account of each attempt.

## Configuration

```json
{
  "accounts": {
    "work": { "runner": "claude", "label": "Acme Max" },
    "personal": { "runner": "claude", "dir": "~/.claude" },
    "ci": { "runner": "claude", "kind": "token" },
    "pro": { "runner": "codex", "share_from": "~/.codex" }
  },
  "defaults": { "accounts": { "claude": ["work", "personal"], "codex": "pro" } },
  "account_policy": { "strategy": "ordered", "failover": true, "limited_cooldown_minutes": 60, "usage_poll_minutes": 0, "usage_warn_percent": 85, "notify": "none" }
}
```

Every key applies live (`skillhook config set`, or an edit to the file). The full list is in
[operations.md](operations.md#configuration).

## Compared with t3code

[t3code](https://github.com/pingdotgg/t3code) gives each account a "provider instance" of its own:

- a `CLAUDE_CONFIG_DIR` per Claude Code account;
- a "shadow" `CODEX_HOME` per Codex account, linking everything but `auth.json`.

It reads login and usage the same way described above: the Agent SDK's `initialize` and `get_usage`, and
`codex app-server`. skillhook does the same and adds what an unattended machine needs:

- pools that pick an account per job and fail over on a usage limit or a failed login, with reset times taken from the
  CLI's own notices;
- `token` and `api_key` accounts for machines without a browser;
- expired-login detection;
- per-account job history and cost;
- duplicate-login warnings;
- `accounts check` for monitoring;
- events, health rows and desktop notifications;
- `accounts exec` to resume a job's session as its account.
