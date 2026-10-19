// Signed GitHub webhook → work on this repository (hook skillhook-github-ingress). Skillhook's
// `github` auth preset has verified the signature, and the hook's `when` the repository, before
// this runs.
//
//   push to main                         → fast-forward the served checkout
//   issue labelled incident | ceo-task   → queue skillhook-agent
//   maintainer comment/review "@claude"  → queue skillhook-agent
//
// Everything else is nothing_to_do. Agent replies carry the MARKER so they never trigger another run.
//
// `--sweep` (hook skillhook-task-sweep, Cloud schedule every 30 minutes) is the backstop for a lost
// webhook or a stalled run: open `incident` / `ceo-task` issues without `needs-human` that have no
// open PR referencing them and no dispatch younger than the agent's timeout are dispatched again
// (at most SWEEP_MAX per run), and the job's `data` carries the delivery numbers of
// docs/autonomous-delivery.md in the fleet repo.
import fs from "node:fs";
import path from "node:path";
import { fail, ghJson, isMain, MARKER, outcome, readJson, REPO, saveJson, stateDir, sync } from "./runtime.mjs";

export const TASK_LABELS = ["incident", "ceo-task"];
export const AGENT_HOOK = "skillhook-agent";
/** skillhook-agent's `timeout_seconds` in skillhook.yaml: a dispatch younger than this is still being worked. */
export const AGENT_TIMEOUT_MS = 3600 * 1000;
export const SWEEP_MAX = 3;
/** A task unworked for longer than this makes the sweep `partial` (Skillhook Cloud inbox and alerts). */
export const STALL_MS = 2 * 3600 * 1000;
const HOUR = 3600 * 1000;
const MAINTAINERS = ["OWNER", "MEMBER", "COLLABORATOR"];
const MENTION_EVENTS = { issues: "opened", issue_comment: "created", pull_request_review_comment: "created", pull_request_review: "submitted" };

/** "sync", "task" or null for one GitHub delivery. Pure. */
export function route(payload, event) {
  if (payload?.repository?.full_name !== REPO) return null;
  if (event === "push") return payload.ref === "refs/heads/main" ? "sync" : null;
  const issue = payload.issue ?? payload.pull_request;
  const labels = issue?.labels?.map((l) => l.name) ?? [];
  if (labels.includes("needs-human") || issue?.state === "closed") return null;
  // The labeled event owns labelled tasks; an issue opened with the label must not run twice.
  if (event === "issues" && payload.action === "labeled") return TASK_LABELS.includes(payload.label?.name) ? "task" : null;
  if (event === "issues" && payload.action === "opened" && labels.some((l) => TASK_LABELS.includes(l))) return null;
  if (MENTION_EVENTS[event] === undefined || payload.action !== MENTION_EVENTS[event]) return null;
  const item = event === "pull_request_review" ? payload.review : event === "issues" ? payload.issue : payload.comment;
  if (item?.user?.type !== "User" || item.performed_via_github_app) return null;
  if (!MAINTAINERS.includes(item.author_association)) return null;
  const text = `${item.title ?? ""}\n${item.body ?? ""}`;
  if (text.includes(MARKER)) return null;
  return /@claude\b/i.test(text) ? "task" : null;
}

function receiptsDir() {
  const dir = path.join(stateDir(), "dispatch");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Every dispatch receipt on this host: `{ key, state, job, issue, at }` (older receipts have no issue or at). */
export function readReceipts(dir = receiptsDir()) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => {
    try {
      return { key: name.slice(0, -5), ...JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/** Queues skillhook-agent once per receipt key (a webhook delivery id, or `sweep-<issue>-<UTC hour>`). */
async function dispatch(payload, event, key, issue = payload?.issue?.number ?? payload?.pull_request?.number ?? null) {
  const home = process.env.SKILLHOOK_HOME;
  if (!home) throw new Error("SKILLHOOK_HOME is not set");
  if (!/^[a-zA-Z0-9-]+$/.test(key)) throw new Error("Invalid delivery ID");
  const receipt = path.join(receiptsDir(), `${key}.json`);
  const saved = readJson(receipt, null);
  if (saved) {
    // A replayed delivery never queues a second agent; an interrupted dispatch needs a look.
    return saved.job
      ? { outcome: "nothing_to_do", summary: "Delivery already dispatched", job: saved.job }
      : { outcome: "needs_human", summary: "An earlier dispatch of this delivery has an uncertain result; check `skillhook jobs list` before replaying" };
  }
  const at = new Date().toISOString();
  fs.writeFileSync(receipt, JSON.stringify({ state: "dispatching", issue, at }), { mode: 0o600, flag: "wx" });
  const server = JSON.parse(fs.readFileSync(path.join(home, "server.json"), "utf8"));
  const response = await fetch(`http://127.0.0.1:${server.port}/skills/${AGENT_HOOK}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload: { github: payload, event, delivery: key } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Dispatch to ${AGENT_HOOK} failed (${response.status})`);
  const result = await response.json();
  const job = result.job_id ?? result.job?.id ?? result.id;
  saveJson(receipt, { state: "dispatched", job, issue, at });
  return { outcome: "completed", summary: `Queued ${AGENT_HOOK}`, job };
}

/** Issue numbers a PR references: GitHub's closing references plus any `#<n>` in its title or body. Pure. */
export function referencedIssues(pr) {
  const numbers = new Set((pr.closingIssuesReferences ?? []).map((ref) => ref.number));
  for (const match of `${pr.title ?? ""}\n${pr.body ?? ""}`.matchAll(/(?:^|[^\w/&])#(\d+)\b/g)) numbers.add(Number(match[1]));
  return numbers;
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const hours = (ms) => Math.round((ms / HOUR) * 10) / 10;

/**
 * What one sweep does and reports. Pure: `issues` are open task issues (number, createdAt, labels),
 * `openPrs` / `mergedPrs` come from `gh pr list`, `taskIssues` maps issue number → createdAt for the
 * issue-to-merge time, `receipts` from readReceipts.
 */
export function sweepPlan({ issues, openPrs, mergedPrs = [], taskIssues = new Map(), receipts, now = new Date(), max = SWEEP_MAX, timeoutMs = AGENT_TIMEOUT_MS }) {
  const t = now.getTime();
  const tasks = issues.filter((issue) => {
    const labels = issue.labels.map((l) => l.name ?? l);
    return labels.some((l) => TASK_LABELS.includes(l)) && !labels.includes("needs-human");
  });
  const withPr = new Set(openPrs.flatMap((pr) => [...referencedIssues(pr)]));
  const recent = new Set(receipts.filter((r) => r.issue != null && r.at && t - Date.parse(r.at) < timeoutMs).map((r) => Number(r.issue)));
  const unworked = tasks.filter((issue) => !withPr.has(issue.number) && !recent.has(issue.number))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const oldest = unworked.length ? t - Date.parse(unworked[0].createdAt) : 0;
  const since = t - 7 * 24 * HOUR;
  const merged = mergedPrs.filter((pr) => (pr.body ?? "").includes(MARKER) && Date.parse(pr.mergedAt) >= since);
  const toMerge = merged.flatMap((pr) => [...referencedIssues(pr)].filter((n) => taskIssues.has(n)).map((n) => Date.parse(pr.mergedAt) - Date.parse(taskIssues.get(n))));
  return {
    due: unworked.slice(0, max),
    stalled: unworked.filter((issue) => t - Date.parse(issue.createdAt) > STALL_MS).map((issue) => issue.number),
    data: {
      tasks_open: tasks.length,
      tasks_unworked: unworked.length,
      oldest_unworked_hours: hours(oldest),
      dispatched: 0,
      agent_prs_open: openPrs.filter((pr) => (pr.body ?? "").includes(MARKER)).length,
      agent_prs_merged_7d: merged.length,
      median_issue_to_merge_hours_7d: toMerge.length ? hours(median(toMerge)) : null,
    },
  };
}

/** `sweep-<issue>-<UTC hour>`: one sweep dispatch per issue per hour, whatever the schedule does. */
export function sweepKey(issue, now = new Date()) {
  return `sweep-${issue}-${now.toISOString().slice(0, 13).replace(/[-T]/g, "")}`;
}

async function sweep() {
  const now = new Date();
  const fields = "number,title,body,labels,createdAt,url,closingIssuesReferences";
  const issueFields = "number,title,labels,state,createdAt,url";
  const listIssues = (label, state) => ghJson(["issue", "list", "-R", REPO, "--label", label, "--state", state, "--limit", "200", "--json", issueFields]);
  const open = new Map(TASK_LABELS.flatMap((label) => listIssues(label, "open")).map((issue) => [issue.number, issue]));
  const taskIssues = new Map(TASK_LABELS.flatMap((label) => listIssues(label, "all")).map((issue) => [issue.number, issue.createdAt]));
  const openPrs = ghJson(["pr", "list", "-R", REPO, "--state", "open", "--limit", "200", "--json", fields]);
  const week = new Date(now.getTime() - 7 * 24 * HOUR).toISOString().slice(0, 10);
  const mergedPrs = ghJson(["pr", "list", "-R", REPO, "--state", "merged", "--search", `merged:>=${week}`, "--limit", "200", "--json", `${fields},mergedAt`]);
  const plan = sweepPlan({ issues: [...open.values()], openPrs, mergedPrs, taskIssues, receipts: readReceipts(), now });
  const jobs = [];
  for (const issue of plan.due) {
    const github = { repository: { full_name: REPO }, action: "sweep", issue: { number: issue.number, title: issue.title, labels: issue.labels, state: issue.state, html_url: issue.url } };
    const result = await dispatch(github, "sweep", sweepKey(issue.number, now), issue.number);
    if (result.job) jobs.push({ issue: issue.number, job: result.job });
    if (result.outcome === "completed") plan.data.dispatched += 1;
  }
  const { data, stalled } = plan;
  const headline = `${data.tasks_open} open, ${data.tasks_unworked} unworked, ${data.dispatched} dispatched`;
  return {
    outcome: stalled.length ? "partial" : data.tasks_open || data.dispatched ? "completed" : "nothing_to_do",
    headline,
    summary: stalled.length
      ? `${headline}. Unworked for more than 2 h: ${stalled.map((n) => `#${n}`).join(", ")}; the next sweep re-dispatches each one hourly until a PR references it, or a maintainer labels it needs-human.`
      : `${headline}. ${data.agent_prs_open} agent PRs open, ${data.agent_prs_merged_7d} merged in 7 days.`,
    links: plan.due.map((issue) => ({ url: issue.url, title: `#${issue.number} ${issue.title}`, kind: "issue" })),
    data: { ...data, stalled, jobs },
  };
}

async function main() {
  if (process.argv.includes("--sweep")) return outcome(await sweep());
  const payload = JSON.parse(fs.readFileSync(process.env.SKILLHOOK_PAYLOAD_PATH, "utf8"));
  const record = JSON.parse(fs.readFileSync(process.env.SKILLHOOK_EVENT_PATH, "utf8"));
  const event = record.headers?.["x-github-event"];
  const action = route(payload, event);
  if (process.argv.includes("--dry-run")) return outcome({ outcome: "completed", summary: "Dry run", action });
  if (!action) return outcome({ outcome: "nothing_to_do", summary: `GitHub ${event ?? "event"} does not request work on ${REPO}` });
  if (action === "sync") {
    const { before, after } = sync();
    return outcome({ outcome: "completed", summary: before === after ? "Served checkout already current" : `Served checkout ${before.slice(0, 7)} → ${after.slice(0, 7)}` });
  }
  const delivery = record.headers?.["x-github-delivery"] ?? process.env.SKILLHOOK_JOB_ID;
  outcome(await dispatch(payload, event, delivery));
}

if (isMain(import.meta.url)) {
  main().catch((error) => fail(error, "GitHub ingress failed; the delivery is kept for replay"));
}
