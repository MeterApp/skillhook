---
name: company-daily
description: The daily operating loop of __REPO__ - reconciles and finishes unfinished agent work, reads what happened since yesterday (issues, pull requests, checks, failed jobs), writes a short report, and proposes up to three next steps as issues for a person to hand over. Use for the scheduled __PROJECT__-daily hook.
---

# company-daily

Read `.claude/skills/company-rules.md` first and follow it. A person reads your final answer, not your terminal:
everything you did or decided must be in it.

## 1. Finish what is unfinished (before anything new)

```bash
SINCE=$(date -u -v-1d +%FT%TZ 2>/dev/null || date -u -d '1 day ago' +%FT%TZ)   # macOS, then Linux
gh pr list --state open --search "__PROJECT__-agent in:body" --json number,title,url,isDraft,mergeStateStatus,statusCheckRollup
gh issue list --state open --label agent --json number,title,url,createdAt
skillhook jobs list --since "$SINCE" --limit 30
```

- An agent pull request with a failing check or a conflict: fix it (in a worktree, on its branch) and push.
- An agent pull request with review comments from a person: address them.
- An issue labelled `agent` with no pull request and no running job: its run was lost or failed. Do it now, the way
  `.claude/skills/company-task/SKILL.md` describes, at most two per day.
- A failed or timed-out job since yesterday: read why (`skillhook jobs show <id>`). Fix the cause if it is in this
  repository's hooks or skills; otherwise note it for the report.

## 2. Read the day

- Merged since yesterday: `gh pr list --state merged --search "merged:>=<yesterday>"`.
- New and updated issues: `gh issue list --search "updated:>=<yesterday>"`.
- The default branch's checks: `gh run list --branch <default branch> --limit 10`. A red default branch comes before
  everything else: find the cause and open a fix.
- Open issues labelled `needs-human` or `incident` that nobody answered: list them, oldest first.

Add your own sources here (analytics, error tracker, support inbox) once the agents have access to them.

## 3. Propose, do not self-assign

Pick at most three things that would most improve the product or the codebase tomorrow, from what you read: a bug
several people hit, a flaky test, a missing check that let a regression through. For each, open an issue (not
labelled `agent`) with the evidence, what done would look like, and how to measure it. Do not open one that
duplicates an open issue; comment on that one instead. A person hands a proposal over by adding the `agent` label.

<!-- To let the daily loop act on its own proposals, change this section: e.g. "label the first proposal `agent`
     yourself". Keep "Needs a person" in company-rules.md in force. -->

## 4. Report

Your final answer is the report, in this order and nothing else:

1. **Needs you**: every open question for a person, each with its link. "Nothing" if none.
2. **Done since yesterday**: merged and opened pull requests, issues closed, with links.
3. **Still open**: agent work in flight and what it waits for.
4. **Proposed**: the issues you opened today, one line each.
5. **Problems**: failed jobs, a red default branch, anything that looked wrong.

Finish with the outcome `needs_human` when section 1 is not empty, else `completed`.
