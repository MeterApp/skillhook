---
name: incident-triage
description: Handle an incident on the skillhook CLI opened by the skillhook-health hook (or a human) - CI failing on main, @meterapp/skillhook not published or npm ahead of main, or a broken release reported by users - by restoring main and the package first, then finding the root cause and fixing or escalating it.
---

# incident-triage

Reached from `skillhook-task` for an issue labelled `incident`. `skillhook-health` opens one when a
daily check fails and closes it after a healthy run. Order: restore, then root cause, then prevention.
Read `.claude/skills/delivery.md` first. Never hide the failure. You own the incident until main and the
package are healthy again and the cause is fixed: restore and fix in this run, don't hand it back as a
recommendation.

## 1. Read

```bash
gh issue view <n> --comments
gh run list -R MeterApp/skillhook --workflow ci.yml --branch main --limit 5
gh run list -R MeterApp/skillhook --workflow publish.yml --limit 3
gh run view <run-id> --log-failed
npm view @meterapp/skillhook dist-tags versions --json
```

| Failing check | Usual cause | First move |
| --- | --- | --- |
| `ci` | a merge broke a test or the build; a dependency update; a flaky test | reproduce with `npm run check` in your worktree |
| `publish` (main ahead of npm) | `publish.yml` failed (npm auth, provenance, a version already on npm) | read the publish run's failed log |
| `publish` (npm ahead of main) | a manual publish, or a revert of a release on main | escalate: never publish or unpublish |

## 2. Restore

- **CI red on main**: if one merged PR caused it and the fix is not obvious, open a PR that reverts it
  (`git revert <sha>`), say so on the incident and on the original PR, and queue it like any other
  routine change. A revert of a release PR is a release decision: `needs-human`.
- **Publish failed**: re-running the workflow is a publication: label `needs-human` with the failed step
  and the exact error, and recommend the fix (for example a missing npm token or trusted publisher).
- **A published version is broken for users**: prepare the fix PR and ask (`needs-human`) whether to cut
  a patch release or deprecate the version. Never deprecate or unpublish yourself.

## 3. Root cause and prevention

`git log --since="3 days ago" --oneline` and the merged PRs of that window. Fix with a PR that adds the
test that would have caught it, per `AGENTS.md`. Never "fix" by deleting or skipping a test, loosening a
check or editing `scripts/skillhook/health.mjs` to stop the alert. Summarize cause, fix and prevention
on the incident issue; the health hook closes it once a run passes.

## 4. Measure and verify

The fix PR carries the `## Measure` block from `delivery.md`, usually `metric: skillhook-health <check>`,
`baseline: failing (<date>, incident #<n>)`, `target: passing by <next daily run>`, `read with: gh run list
-R MeterApp/skillhook --workflow ci.yml --branch main --limit 1` (or `npm view @meterapp/skillhook version`).
After the merge, confirm CI on main is green with that command and say so on the incident.
