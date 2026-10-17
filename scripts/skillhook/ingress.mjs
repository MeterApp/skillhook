// Signed GitHub webhook → work on this repository (hook skillhook-github-ingress). Skillhook's
// `github` auth preset has verified the signature, and the hook's `when` the repository, before
// this runs.
//
//   push to main                         → fast-forward the served checkout
//   issue labelled incident | ceo-task   → queue skillhook-agent
//   maintainer comment/review "@claude"  → queue skillhook-agent
//
// Everything else is nothing_to_do. Agent replies carry the MARKER so they never trigger another run.
import fs from "node:fs";
import path from "node:path";
import { fail, isMain, MARKER, outcome, readJson, REPO, saveJson, stateDir, sync } from "./runtime.mjs";

export const TASK_LABELS = ["incident", "ceo-task"];
export const AGENT_HOOK = "skillhook-agent";
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

async function dispatch(payload, event, delivery) {
  const home = process.env.SKILLHOOK_HOME;
  if (!home) throw new Error("SKILLHOOK_HOME is not set");
  if (!/^[a-zA-Z0-9-]+$/.test(delivery)) throw new Error("Invalid delivery ID");
  const dir = path.join(stateDir(), "dispatch");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const receipt = path.join(dir, `${delivery}.json`);
  const saved = readJson(receipt, null);
  if (saved) {
    // A replayed delivery never queues a second agent; an interrupted dispatch needs a look.
    return saved.job
      ? { outcome: "nothing_to_do", summary: "Delivery already dispatched", job: saved.job }
      : { outcome: "needs_human", summary: "An earlier dispatch of this delivery has an uncertain result; check `skillhook jobs list` before replaying" };
  }
  fs.writeFileSync(receipt, JSON.stringify({ state: "dispatching" }), { mode: 0o600, flag: "wx" });
  const server = JSON.parse(fs.readFileSync(path.join(home, "server.json"), "utf8"));
  const response = await fetch(`http://127.0.0.1:${server.port}/skills/${AGENT_HOOK}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload: { github: payload, event, delivery } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Dispatch to ${AGENT_HOOK} failed (${response.status})`);
  const result = await response.json();
  const job = result.job_id ?? result.job?.id ?? result.id;
  saveJson(receipt, { state: "dispatched", job });
  return { outcome: "completed", summary: `Queued ${AGENT_HOOK}`, job };
}

async function main() {
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
