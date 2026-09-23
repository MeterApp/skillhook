# Scheduled hooks: `schedule:`

Most skills should be webhooks: the event arrives, the skill runs once with that event's data. Some work has no event: a sweep that applies defaults to whatever is overdue, a weekday digest, a weekly report, a nightly clean-up. For those, a skill or a hook in `skillhook.yaml` takes a `schedule:` and the running server fires it on time, in the time zone you name, without anything calling a URL. The schedule lives next to the hook it drives, so which skill runs when is a pull request, `git pull` deploys it, and every machine that links the repository fires the same schedules.

Related: [skills.md](skills.md) (the rest of the `skillhook:` block), [projects.md](projects.md) (`skillhook.yaml`), [operations.md](operations.md) (keeping the machine awake, `doctor`), [api.md](api.md) (`/health` and `schedule_only`).

## The field

```yaml
hooks:
  overdue-sweep:
    run: node tools/sweep.mjs
    schedule: "*/30 * * * *"              # shorthand: a cron expression, read in UTC
    webhook: false                        # schedule-only: no URL, no secret

  weekday-digest:
    skill: .claude/skills/digest
    schedule:
      cron: "5 9 * * 1-5"                 # minute hour day-of-month month day-of-week, or @hourly @daily @midnight @weekly @monthly @yearly
      timezone: America/New_York          # IANA zone the expression is read in (default UTC)
      catch_up: latest                    # slots missed while stopped or asleep: latest (default) | all (up to 24) | none
      overlap: skip                       # previous run still queued or running at the next slot: skip (default) | queue
      payload: { channel: "#ops" }        # static fields merged into every scheduled payload
    webhook: false
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `schedule` | string, object, or `false` | none | A cron expression (UTC), the object above, or `false` to cancel a schedule a hook would inherit from its `SKILL.md`. |
| `schedule.cron` | string | required | Five fields with `*`, lists (`1,15`), ranges (`9-17`), steps (`*/15`, `1-30/5`), month and day names (`jan`, `mon`), `7` for Sunday; or an alias. When both day fields are restricted a date matches if either does (Vixie semantics). |
| `schedule.timezone` | IANA name | `UTC` | `Europe/Berlin`, `America/New_York`, … An unknown name stops the skill from loading. |
| `schedule.catch_up` | `latest` \| `all` \| `none` | `latest` | What to do with slots that passed while no server was running. |
| `schedule.overlap` | `skip` \| `queue` | `skip` | What to do when a slot comes due while a job of this skill is still queued or running. |
| `schedule.payload` | object | none | Merged into the payload under skillhook's own fields (which win). |
| `webhook` | boolean | `true` | `false` makes the skill schedule-only: `POST /hooks/<name>` answers `404 schedule_only`, no secret is required, `doctor` and `skills validate` do not ask for one. |

The same keys work in a `SKILL.md`'s `skillhook:` block (`~/.skillhook/skills/<name>`) and on a hook in `skillhook.yaml`. A `skill:` hook inherits the schedule of its `SKILL.md`; set `schedule: false` on the hook to run that SKILL.md from a webhook only, so two hooks that share one SKILL.md do not both fire. Unknown keys inside `schedule` are rejected like any other typo in the block.

A `schedule:` and a webhook can coexist: the skill then runs for every delivery *and* at each slot. Keep `webhook: false` for pure timers so a forgotten secret cannot fail `doctor` and an attacker who guesses the name gets nothing but a 404.

## What a scheduled run looks like

The job is the same as a webhook job: a directory under `jobs/`, the same runner, the same guardrails, visible in `skillhook jobs list` and the admin API. What differs:

- `trigger` is `schedule` (`{{trigger}}`, `SKILLHOOK_TRIGGER`), `source.method` is `SCHEDULE`, and `delivery_id` is `schedule:<slot>` where the slot is the wall-clock minute in the hook's zone, for example `schedule:2026-09-24T09:05`.
- The payload is skillhook's, not a sender's:

```json
{
  "channel": "#ops",
  "scheduled_for": "2026-09-24T13:05:00.000Z",
  "schedule": {
    "cron": "5 9 * * 1-5",
    "timezone": "America/New_York",
    "slot": "2026-09-24T09:05",
    "fired_at": "2026-09-24T13:05:07.412Z",
    "caught_up": false,
    "manual": false
  }
}
```

  `scheduled_for` is the slot as an ISO instant; `schedule.slot` is the same minute as the zone's wall clock; `caught_up` is true when the run is making up for a slot that passed more than five minutes ago; `manual` is true for `skillhook schedules run`. `{{payload.scheduled_for}}` works in a `SKILL.md` body, and a `run:` command reads the payload from stdin or `$SKILLHOOK_PAYLOAD_PATH` as usual.
- The guardrails tell the agent it was started by a schedule, that there is no external sender, and that the payload only says which slot fired.
- Two request headers are recorded on the event for `when:` filters and `{{headers.*}}`: `x-skillhook-schedule` (the cron expression) and `x-skillhook-timezone`.

## When slots fire

The server checks the clock every 15 seconds and fires every enabled schedule whose next slot has passed. A slot is identified by its wall-clock minute in the hook's zone and remembered in the delivery index, so a second tick, a restart, or the repeated hour of a fall-back night never runs it twice. On a spring-forward night a wall-clock minute that does not exist (02:30 on the day clocks jump from 01:59 to 03:00) is skipped, as a wall clock would.

A schedule the server sees for the first time (a new hook, or a newly enabled one) waits for its next slot; it does not run immediately. From then on, when the server was stopped or the machine slept through one or more slots, `catch_up` decides:

| `catch_up` | Missed slots |
|---|---|
| `latest` (default) | Run once, for the most recent missed slot. The others are counted as skipped. Right for sweeps, digests and anything idempotent. |
| `all` | Run once per missed slot, oldest first, up to 24; older ones are skipped. Right when each slot means distinct work (an hourly export per hour). |
| `none` | Run only a slot that is at most five minutes old; skip anything older. Right for reminders that are pointless late. |

When a slot comes due while a job of the same skill is still queued or running, `overlap: skip` (default) skips the slot and `overlap: queue` puts the new job behind the running one (per-skill `concurrency` still applies). A batch of caught-up slots is one decision: the batch queues behind itself.

Everything the scheduler did is in the server log (`schedule registered`, `schedule fired`, `schedule slots skipped`, `schedule slot skipped; previous run still in flight`) and in `jobs/.schedules.json`, which keeps the last slot handled, the last job and its status per skill.

Schedules need an awake machine, exactly like webhooks: on a Mac, `sudo pmset -a sleep 0` (`skillhook doctor` warns when a scheduled machine can sleep). The server does not need to be awake for the *exact* minute, only afterwards: a slot missed during a nap is caught up at wake according to `catch_up`.

## Seeing and testing schedules

```bash
skillhook schedules list                 # cron, zone, next due (UTC), last run, its status, skipped count, webhook yes/no
```

```bash
skillhook schedules next weekday-digest --count 3   # the next three occurrences
```

```bash
skillhook schedules run weekday-digest --wait 60    # fire it now with a scheduled payload (manual: true); through the running server when there is one
```

```bash
skillhook run weekday-digest --payload '{"scheduled_for":"2026-09-24T13:05:00Z"}' --dry-run   # the prompt and command a scheduled run would get
```

`skillhook skills list` shows `(schedule <cron>)` in the URL column for schedule-only hooks, `skillhook skills show <name>` prints the schedule and its next run, `GET /skills` carries `schedule: {cron, timezone, catch_up, overlap, next_run_at}` and `webhook`, and `GET /health` (admin) lists every schedule with `next_due`, `last_slot`, `last_fired_at`, `last_job`, `last_status` and `skipped`. The MCP tool is `list_schedules`.

`skillhook doctor` adds a `schedules` line (every schedule with its next run) and, on macOS, a `sleep` line that warns when `pmset` reports a sleep timer.

## Examples

A repository's timers next to its webhooks:

```yaml
hooks:
  reconcile:
    skill: .agents/skills/reconcile
    auth: { type: bearer }               # still callable by hand or from CI
    schedule: { cron: "17 * * * *", catch_up: latest }

  weekly-review:
    skill: .agents/skills/weekly-review
    model: opus
    timeout_seconds: 1800
    webhook: false
    schedule:
      cron: "0 16 * * 5"
      timezone: America/New_York
      catch_up: latest

  nightly-export:
    run: ./scripts/export.sh
    env: [EXPORT_TOKEN]
    webhook: false
    schedule:
      cron: "30 3 * * *"
      timezone: Europe/Berlin
      catch_up: all                      # every missed night gets its own export
```

A machine-local skill:

```yaml
---
name: inbox-digest
description: Summarizes what arrived overnight and writes the digest to the job directory. Runs every weekday morning.
skillhook:
  model: sonnet
  webhook: false
  schedule:
    cron: "0 8 * * 1-5"
    timezone: Europe/Berlin
---

It is {{payload.schedule.slot}} in {{payload.schedule.timezone}}. Summarize …
```

## Upgrading

`schedule` and `webhook` are new block keys. A server older than the version that introduced them rejects a `skillhook.yaml` that uses them as a whole (every hook in that file answers 404) and a `SKILL.md` that uses them as invalid, because unknown keys have always been errors. Upgrade every machine that links the repository (`skillhook update --install`) before merging a `schedule:` into it.
