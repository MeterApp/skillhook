# Delivery and human escalation

Jonathan authorizes routine, reversible work on the skillhook CLI through review, green checks and a
squash merge. A PR is an intermediate result, not the finish line. Read the latest `AGENTS.md` first.
This is the repository's copy of the fleet standard `docs/autonomous-delivery.md` (MeterApp's SaaS
fleet repo).

## Own the outcome

You own the result, not a report about it. Audit the current state, pick the highest-value and simplest
solution, and carry it out with your own cross-functional judgement (engineering, product, docs,
operations) and every tool you have. Default to action: no recommendations, questions or approval
requests for anything the escalation list below does not name.

- **Execute, don't delegate to an issue.** Work you find is done in the same run: your private worktree
  (`prepare-agent.mjs`), the change, tests, a PR, a review of the diff, the reviewed head in the merge
  queue, and verification after it merges. Open a tracking issue (`ceo-task`, with the `## Measure`
  block below) only for work that cannot finish in this run; the run that opens it either starts it or
  leaves it to `skillhook-task-sweep`, which re-dispatches unworked tasks every 30 minutes.
- **Split independent pieces.** For more than one independent piece, spawn subagents (Claude `Agent`
  tool, Codex sub-tasks), each in its own worktree from `node scripts/skillhook/prepare-agent.mjs sub-<piece>`,
  one writer per set of files; you integrate and review their PRs.
- **Babysit to completion.** After queueing, the merge queue merges green reviewed heads; you, or the
  sweep's next dispatch, repair failing checks, resolve conflicts, answer review comments and re-enqueue a
  changed head. After the merge, verify with free read-only checks: CI on main is green
  (`gh run list -R MeterApp/skillhook --workflow ci.yml --branch main --limit 1`), the served checkout
  synced (`skillhook-repo-sync`), and for a released change the published package
  (`npm view @meterapp/skillhook version`) once a maintainer releases it.

## Every change is measurable

Each PR body and each tracking issue carries:

```
## Measure
metric: <name, as in the skillhook-task-sweep / skillhook-health job data, `skillhook stats`, or a named query>
baseline: <value> (<date>, <source>)
target: <value or direction> by <date>
read with: <command that prints the current value>
```

Useful sources here: the sweep's job `data` (`tasks_unworked`, `agent_prs_merged_7d`,
`median_issue_to_merge_hours_7d`), `skillhook-health` checks, CI duration and flake rate
(`gh run list`), npm downloads (`curl -s https://api.npmjs.org/downloads/point/last-week/@meterapp/skillhook`),
open issues by label, and `skillhook stats` for engine behaviour (jobs by outcome, failure kinds). If
nothing existing can show the effect, the same PR adds the metric (a field in a `scripts/skillhook/`
script's `data`, a number in `src/stats.ts` with its unit test) so the next run can read it.

## Finish routine work

Review the complete diff against the request and any feedback, and run `npm run check`. Fix ordinary
test, merge-conflict and documentation problems yourself. Do not spend a run waiting for CI: register
the reviewed head with the durable merge queue and move on.

```bash
node scripts/skillhook/merge-queue.mjs enqueue <PR-number> <reviewed-40-character-head-SHA> "Request met, diff reviewed, npm run check passed; routine reversible change"
```

The host keeps that approval for that exact head and re-checks it every 15 minutes
(`skillhook-merge-queue`). It requires every check main's ruleset requires (`Node.js 22`, `Node.js 24`,
`Package`, read live), no failed check (CodeQL included) and resolved review threads. Because main
requires up-to-date branches, the queue merges main into a branch that fell behind and waits for CI
again; any other new commit on the branch needs a fresh review and a new `enqueue`. It refuses drafts,
`needs-human`, changes requested and release PRs, and never uses `--admin`. Never bypass or weaken it.

Record the PR, head, evidence, queue state and next checkpoint in the job response. "CI still running"
is `partial` with the queue receipt, the next checkpoint and its owner (the merge queue, then the
sweep), never `needs_human`.

## Bring a human in only when needed

Everything not on this list is done, not asked. Escalate (label `needs-human`, plus one Skillhook job
question with options and a recommendation) only for:

- **Releases**: a version bump, an npm publish, a deprecation or unpublish, a tag.
- **Security**: auth, secret handling, the agent environment allow-list, anything that sends data off
  the machine (`AGENTS.md`: outbound requests are opt-in and enumerated), a reported vulnerability.
- **Breaking changes** to the CLI, the HTTP API, `skillhook.yaml` / SKILL.md formats or the cloud protocol.
- **Money and customers**: Skillhook Cloud plans, prices and any message to a user.
- **Missing access** only a human can grant.

Apply decisions already recorded in the issue; do not ask twice. Prepare the concrete change before you
ask. Never put credentials or personal data in an issue, a PR or a question.
