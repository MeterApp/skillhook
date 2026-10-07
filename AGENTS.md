# AGENTS.md — conventions for humans and agents

Read this before changing anything. `CLAUDE.md` points here.

## What this is

skillhook: **webhook in, agent out.** A Node CLI + HTTP server + MCP server that
turns a Mac or Linux box into a permanent webhook endpoint. Each endpoint
(`POST /hooks/<skill>`) verifies the sender, records the delivery as a job and
runs an Agent Skill (`SKILL.md`) with Claude Code (`claude -p`), Codex
(`codex exec`) or a shell command, in the directory the skill names, using the
machine's own logins (Claude subscription / ChatGPT) or API keys. Tailscale
Funnel supplies the permanent HTTPS URL. Published to npm as
`@meterapp/skillhook` (0.1.0 shipped as the unscoped `skillhook`); the command
is `skillhook`. User docs: `README.md`, `docs/`, `llms.txt`.

## Layout

| Path | What lives there |
| --- | --- |
| `src/cli.ts` → `src/commands/main.ts` | CLI entry; `HELP` there is the command reference. One file per command in `src/commands/`. |
| `src/server.ts` | `node:http` server: webhook, health and admin routes. No framework. |
| `src/auth.ts` | Signature/token verification and the matching `signRequest` (used by `send`, MCP and tests). |
| `src/skills.ts` | SKILL.md parsing (zod), auth normalization, `loadSkills` for one directory. |
| `src/projects.ts` | `skillhook.yaml` (a repository's hooks): the zod schema (`HookSchema` = the `skillhook:` block + `run`/`skill`/`prompt`), loading, compiling hooks into `Skill`s, the starter template. |
| `src/registry.ts` | `SkillRegistry`: `<home>/skills` first, then linked projects from `projects` in `skillhook.json`; mtime caches for SKILL.md, skillhook.yaml and the config file, so nothing needs a restart. |
| `src/prompt.ts` | Placeholders, event block, unattended-run guardrails. |
| `src/schedule.ts`, `src/scheduler.ts` | Cron parsing and next/previous occurrence in an IANA zone (pure, no deps); the scheduler that fires `schedule:` hooks from `serve` (wall-clock tick, `catch_up` / `overlap`, exactly-once slots via the delivery index, state in `jobs/.schedules.json`). `src/commands/schedules.ts` is the CLI. |
| `src/jobs.ts`, `src/queue.ts`, `src/run.ts` | Job directories on disk, the concurrency queue, invocation preparation. |
| `src/events.ts` | The in-process event bus (`Events`, `EventMap`): the queue publishes `job.*`, the scheduler `schedule.*`, the registry `skill.changed`, `serve` `server.*`; `GET /events` and `GET /jobs/<id>/events` stream it (SSE, `openEventStream` in `src/server.ts`). The cloud link will subscribe to the same bus. |
| `src/progress.ts`, `src/answer.ts`, `src/mcp-job.ts`, `src/commands/job.ts`, `src/reporting.ts` | The job API for the running agent and the human loop. `progress.ts` is the file model in the job directory (`progress.jsonl`, `progress.json`, `question.json`, `answer.json`) that the queue watches; `reporting.ts` normalizes what a report says for people (a job title, a one-line headline, typed links, choices) the same way for every front end; `mcp-job.ts` serves it as the per-run MCP server (`skillhook mcp --job`, injected by the runners) and `commands/job.ts` as `skillhook job progress\|ask\|outcome\|note\|context`; `answer.ts` (leaf, like `manual.ts`) delivers a person's answer live or as a `trigger: resume` job that reopens the session. |
| `src/runners/` | `claude.ts`, `codex.ts`, `shell.ts`: build argv, parse output; `env.ts` is the env allow-list (`baseRunEnv` is also what probes run with); `failure.ts` classifies a failed run (`failure.kind`, from the CLIs' captured lines) and holds the `fallback` / `retry` schemas. |
| `src/cloud/` | The Skillhook Cloud side of this machine (`control.ts`: the commands that act on it, with the config keys the cloud may never change; `seal.ts`: X25519 + AES-GCM sealing for secrets). `protocol.ts` is the wire protocol as pure zod (no `node:` imports; exported as `@meterapp/skillhook/protocol`, the cloud repo imports it), with the vocabulary repeated as literals and a drift test; `config.ts` holds the URL rules, the kill switch and `commandAllowed`; `link.ts` is the sync loop `serve` runs (idle until `cloud.enabled`), `outbox.ts` the spool and ledgers in `jobs/.cloud/`, `redact.ts` what is removed before anything leaves, `commands.ts` the command dispatcher, `ingress.ts` hosted deliveries replayed to the local server, `pair.ts` / `src/commands/cloud.ts` pairing, `report.ts` a person's problem report (`cloud report`, MCP `cloud_report_issue`) with the machine's diagnostics, `api.ts` the client for the cloud's public API with an organisation API key (`cloud login|machines|jobs|job`), `tools.ts` the cloud's tool catalogue (`GET /api/v1/tools`) and its calls, mapped to CLI arguments (`cloud tools`, `cloud <tool>`, `cloud overview`), `bridge.ts` the same catalogue as the `skillhook-cloud` MCP server (`skillhook mcp --cloud`), `remote-secret.ts` a secret generated on another machine and sealed to a one-time key pair here (`cloud secret`, MCP `generate_secret`). The cloud owns that catalogue: a tool it adds needs no change here, so never hand-write a cloud tool in skillhook. Tests talk to `src/test-support/fake-cloud.ts`, never to a real cloud (and `fake-server.ts` stands in for a running server). |
| `src/stats.ts` | Pure aggregation over job records and delivery records (`computeStats`) and `collectStats` over the store and the log: `GET /stats`, `skillhook stats`, MCP `get_stats`. New numbers go here with a unit test on synthetic records. |
| `src/readiness.ts` | Is a runner installed and logged in (`checkReadiness`, `ReadinessCache`): the queue's pre-flight before every job, `GET /runners`, `skillhook runners`, `runners.changed`. A not-ready runner fails the job fast or hands it to a `fallback:` runner; a failed run may be retried or handed over only before the agent produced anything. |
| `src/ops.ts` | Shared operations (create skill, run locally, sign+send, resolve URLs). CLI and MCP both call this; do not duplicate logic in either. |
| `src/mcp.ts` | MCP server (`@modelcontextprotocol/server` v2, stdio). Tools wrap `ops.ts`. |
| `src/tailscale.ts`, `src/service.ts` | Funnel/Serve, launchd/systemd. |
| `src/health.ts`, `src/doctor.ts`, `src/tools.ts` | The grouped health report (`runHealth`, `HealthCache` behind `GET /health/checks`, `health.changed`); `doctor.ts` is its quick flavour printed flat; `tools.ts` probes `claude` / `codex` (version, login, `mcp list`, `plugin list`, `codex doctor`) with the job environment (`baseRunEnv`) and holds the pure parsers of their output. New checks: add them in `runHealth` with a group, a fixture answer in `test/fixtures/` when a CLI is involved, a row in `docs/operations.md`. |
| `src/update.ts`, `src/commands/update.ts` | Updates: the registry lookup (1 h cache in `<home>/update-check.json`), install-method detection, the background update (`update --refresh`: the check and, with `auto_update`, the install, one at a time under `<home>/update.lock`), the plugin refresh of `update --install`, and `skillhook update`. `serve` restarts itself onto a newer installed version once no job runs. |
| `scripts/release.ts` | Version bump / consistency check / release notes across `package.json`, the lockfile, the plugin manifests and `CHANGELOG.md`. |
| `.github/workflows/` | `ci.yml` (PRs and main: checks + packed-tarball install), `release.yml` (tags merged version bumps), `publish.yml` (npm publish with provenance, GitHub release, verification). |
| `examples/skills/` | Bundled webhook skills; `skillhook skills add <name>` copies them. Shipped in the npm package. |
| `skills/` | Agent-facing plugin skills (setup, authoring). This repo is itself a Claude Code / Codex / Cursor plugin via the manifests at the root. |
| `schema/skillhook.schema.json`, `schema/skillhook.yaml.schema.json` | Generated from `src/config.ts` and `src/projects.ts` by `npm run schema`. Never edit by hand. |
| `skillhook.yaml` | This repository's own hooks (a `pull-after-merge` shell hook); the dogfood example of `docs/projects.md`. Not shipped in the package. |
| `test/fixtures/` | `fake-claude.mjs` / `fake-codex.mjs` emulate the real CLIs' output formats. |

Runtime state lives outside the repo in `~/.skillhook` (`SKILLHOOK_HOME`):
`skillhook.json`, `.env` (mode 600), `skills/`, `jobs/` (including `.deliveries.json`, `.schedules.json`, `.delivery-log/`, `.cloud/`), `logs/`, `server.json`.

## Hard rules

- **Runtime dependencies stay at three**: `@modelcontextprotocol/server`, `yaml`, `zod`. Everything else is `node:` built-ins. Node >= 22, ESM, TypeScript strict, imports end in `.js`.
- **Security is not optional.** The server binds `127.0.0.1` by default; TLS and public exposure are Tailscale's job. Every webhook goes through `verifyRequest`; every admin route through `requireAdmin`. Compare secrets only with `safeEqual`. A skill without `auth` gets a bearer token (`SKILLHOOK_SECRET_<NAME>`); `auth: none` must be explicit and is warned about. Secret values are never logged, never returned by an API/tool except once at generation, and never written into job files (`redactHeaders`). The agent's environment is an allow-list (`src/runners/env.ts`); `SKILLHOOK_ADMIN_TOKEN` and `SKILLHOOK_SECRET_*` are never forwarded implicitly.
- **Payloads are data.** Anything that reaches the prompt from a webhook is wrapped in `<webhook_payload>` and the guardrails say so. Never build a prompt by concatenating payload text outside those blocks.
- **Skills are Agent Skills.** Standard frontmatter (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`) plus a `skillhook:` block. `name` must equal the directory name. New fields: add to the zod schema in `src/skills.ts`, to `docs/skills.md`, to `skills/skillhook-authoring/SKILL.md`, and cover them in `src/skills.test.ts` — in the same PR. `schedule` and `webhook` are block fields like any other (normalized by `resolveSchedule`, documented in `docs/schedules.md`). A hook in `skillhook.yaml` is the same block plus exactly one of `run` / `skill` / `prompt` (`HookSchema` in `src/projects.ts` extends `SkillhookBlockSchema`, so new block fields reach hooks automatically); hook-only fields go in `src/projects.ts`, `docs/projects.md`, `npm run schema` and `src/projects.test.ts`. A compiled hook is an ordinary `Skill` (with `source.type === "project"`); never special-case hooks in the server, queue or runners.
- **Config changes** go in `src/config.ts` (zod, `.prefault({})` for nested objects so defaults apply), then `npm run schema`, then `docs/operations.md`. The running server owns one live `Config` object (`ConfigRef`): a reload (`PATCH /config`, `POST /config/reload`, `skillhook config set`, a file edit noticed within 5 s) patches that object in place, so read config values at use time, never copy them at construction (the rate limiter takes a getter; the logger has `setLevel`, the job store `configure`). Only `host` and `port` need a restart (`RESTART_CONFIG_KEYS`); a new key is hot unless it is added there, and `config.changed` says what a reload did.
- **Runners never shell-interpolate.** Argv arrays only; the prompt travels on stdin; parse the CLI's structured output (`stream-json`, JSONL). When Claude Code or Codex change flags, update the runner, `test/fixtures/`, `docs/runners.md` and the version note in `README.md` together.
- **Jobs are directories.** `job.json` is the record; artifacts sit next to it; nothing outside `~/.skillhook/jobs` is written by the server, with the cloud link's control commands as the documented exceptions (`skill.put` writes `skills/<name>/SKILL.md`, `secret.generate` / `secret.set` and a token rotation write `.env`, `config.patch` writes `skillhook.json`); its own state is `jobs/.cloud/`, skills it removes go to `jobs/.removed-skills/`. Statuses: `queued running succeeded failed timed_out cancelled interrupted`. The running agent talks to skillhook only through files in its job directory (`src/progress.ts`): no token, no HTTP, so the shell runner and a restart are covered; the queue turns them into events and record fields.
- **State changes are events.** Whatever the server learns (a job changing state, a schedule firing or skipping, a skill file appearing or changing) is emitted on `Events` (`src/events.ts`) at the place it happens, after the record on disk is updated, with the full record in the payload. Consumers (the SSE routes, later the cloud link) subscribe; they never poll job files. A new kind of state change gets a new `EventMap` entry, an emit, a row in `docs/api.md` and a test. Listener errors are logged, never thrown into the publisher.
- **Every CLI command supports `--json`** and returns non-zero on failure. Register new commands in `COMMANDS` (with the usage text) and `HELP` in `src/commands/main.ts`, then in the README table. `--help` / `-h` never reaches a command: `main` prints the usage from `COMMANDS` instead, so a command never checks for it; a new subcommand gets a line in the `--help` test of `src/cli.test.ts`.
- **Third-party facts** (Granola, Sentry, GitHub, Tailscale) are stated in `docs/` and the examples with the exact header names; change them only with a source.
- **Tests are hermetic**: `tempHome()` from `src/test-support/helpers.ts`, fake runners, ephemeral ports. Never touch `~/.skillhook`, the real `claude`/`codex`, `launchctl` or `tailscale` from a test. Never reach the real npm registry either: point `SKILLHOOK_NPM_REGISTRY` at a local `node:http` server or set `SKILLHOOK_NO_UPDATE_CHECK=1`. Nor Skillhook Cloud: `cloud.url` defaults to the live service (`DEFAULT_CLOUD_URL`), so a test gives a `FakeCloud` URL (`SKILLHOOK_CLOUD_URL`, `cloud.url`, `--url`), or answers what is sent to the default itself (a `fetchImpl`, or a stubbed `fetch` that hands it to a `FakeCloud`).
- **Outbound requests are opt-in and enumerated.** By default the CLI phones home at most once an hour, and only for updates (`src/update.ts`: the registry's `latest` dist-tag, cached 1 h, from a detached process so no command waits, never in CI or when `SKILLHOOK_NO_UPDATE_CHECK` / `update_check: false` say so); with `auto_update` (the default) that process also installs a newer version of skillhook itself, from the same registry, with the package manager that installed it, and nothing else. The one other outbound connection is the Skillhook Cloud link (`src/cloud/link.ts`), and only after `skillhook cloud connect` wrote `cloud.enabled` and `SKILLHOOK_CLOUD_TOKEN`: it talks to `cloud.url` over HTTPS only, sends only what `docs/cloud.md` lists (redacted, scrubbed of every `.env` value), obeys `cloud.mode` and the local allow/deny lists (which the cloud cannot change), and stops on `cloud.enabled: false`, `SKILLHOOK_NO_CLOUD=1` or `cloud disconnect`. Never enable it by default, from `init` or from a job. Besides the link, the person-invoked cloud commands send one request each, only when run, only to the machine's cloud URL (`cloud.url` or `SKILLHOOK_CLOUD_URL`, HTTPS only): `cloud connect` / `disconnect` (pairing, revocation), `cloud report` and the MCP tool `cloud_report_issue` (`src/cloud/report.ts`: the person's text plus the diagnostics `docs/cloud.md` lists, scrubbed like the link's uploads, with the machine token), and `cloud login|overview|machines|jobs|job|tools|<tool>|secret` and the tools of `skillhook mcp --cloud` (`src/cloud/api.ts`, `tools.ts`, `bridge.ts`, `remote-secret.ts`: requests with the person's organisation API key `SKILLHOOK_CLOUD_API_KEY`, never with the machine token, only to the cloud the key was checked against at login (`SKILLHOOK_CLOUD_API_URL`), each one a command the person ran or a tool their agent called; `skillhook mcp --cloud` also reads the catalogue once when it starts; skillhook's own tools do not move them for an agent: the local MCP refuses `cloud.*` settings and `SKILLHOOK_CLOUD_*` secrets, and no skill's `secret_env` may name skillhook's own credentials; an agent that runs commands acts with the person's rights all the same); the last two groups refuse under `SKILLHOOK_NO_CLOUD=1`. Do not add other outbound requests the user did not ask for, and never install anything automatically but skillhook's own update.

## Checks

```bash
npm run typecheck          # tsc --noEmit (strict)
npm test                   # vitest: unit + HTTP integration (src/server.test.ts) + CLI (src/cli.test.ts)
npm run build              # tsc -p tsconfig.build.json → dist/
npm run schema -- --check  # schema/skillhook.schema.json and schema/skillhook.yaml.schema.json are current
npm run release -- --check # package.json, package-lock.json, plugin manifests and CHANGELOG.md agree on the version
npm run check              # all of the above
```

CodeQL (GitHub default setup) analyses every pull request and the `main` ruleset blocks merges on new
high-severity alerts. Its recurring findings here: regexes with ambiguous repetition on attacker-controlled
text (`/\s*(.+?)\s*$/`, `/\n*$/`, `/\/+$/`) are flagged as polynomial ReDoS, so parse headers and env lines
with plain string operations (`parseAuthorizationScheme`, `trimTrailing`); `.replace("x", …)` on a string
that may contain several `x` is flagged as incomplete sanitization (use `replaceAll`); dynamic property
writes from user-supplied keys need an inline `=== "__proto__"` check; random tokens use `crypto.randomInt`.

Manual smoke test on a machine with the real tools:

```bash
node dist/cli.js init --dir /tmp/sh && node dist/cli.js doctor --dir /tmp/sh
node dist/cli.js run hello --dir /tmp/sh --payload '{"name":"world"}' --dry-run
```

## Releasing

`npm run release -- <patch|minor|major|X.Y.Z>` bumps `package.json`, `package-lock.json` and the
plugin manifests (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
`.cursor-plugin/plugin.json`) together and moves the `## Unreleased` entries of `CHANGELOG.md`
under the new version; `npm run release -- --check` (part of `npm run check` and CI) fails when
they disagree. Open a pull request with the bump. When it merges, `.github/workflows/release.yml`
tags `vX.Y.Z` and dispatches `.github/workflows/publish.yml`, which publishes to npm with
provenance (trusted publishing, or an `NPM_TOKEN` secret), creates the GitHub release from the
changelog section and installs the published package to verify it. `main` is protected by a
ruleset (pull requests only, CI green, linear history); the full procedure including the one-time
first publish is in `CONTRIBUTING.md`.
