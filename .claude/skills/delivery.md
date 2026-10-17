# Delivery and human escalation

Jonathan authorizes routine, reversible work on the skillhook CLI through review, green checks and a
squash merge. A PR is an intermediate result, not the finish line. Read the latest `AGENTS.md` first.

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
is `partial` with the queue receipt, never `needs_human`.

## Bring a human in only when needed

Escalate (label `needs-human`, plus one Skillhook job question with options and a recommendation) only for:

- **Releases**: a version bump, an npm publish, a deprecation or unpublish, a tag.
- **Security**: auth, secret handling, the agent environment allow-list, anything that sends data off
  the machine (`AGENTS.md`: outbound requests are opt-in and enumerated), a reported vulnerability.
- **Breaking changes** to the CLI, the HTTP API, `skillhook.yaml` / SKILL.md formats or the cloud protocol.
- **Money and customers**: Skillhook Cloud plans, prices and any message to a user.
- **Missing access** only a human can grant.

Apply decisions already recorded in the issue; do not ask twice. Prepare the concrete change before you
ask. Never put credentials or personal data in an issue, a PR or a question.
