# Changelog

All notable changes to skillhook, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org). Describe changes under **Unreleased** as they land; `npm run release -- <patch|minor|major>` moves them under a new version, and the Release and Publish workflows tag it, publish it to npm and turn the section into the GitHub release notes.

## Unreleased

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
