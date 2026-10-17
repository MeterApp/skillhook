// Hook skillhook-health (daily): is the skillhook CLI's delivery pipeline healthy?
//
//   ci       the latest finished CI run on main succeeded
//   publish  npm's `latest` for @meterapp/skillhook equals package.json on main (a release merged
//            less than PUBLISH_GRACE_MINUTES ago is still publishing, not a failure)
//   incidents  open `incident` issues, reported (they do not change the verdict)
//
// Opens one `incident` issue when a check fails, comments on it while it keeps failing and closes it
// once a run passes. The incident label routes the issue to skillhook-agent through the ingress.
// State: ~/.skillhook/skillhook-cli/health-state.json.
import path from "node:path";
import { fail, gh, ghJson, isMain, MARKER, outcome, PACKAGE, readJson, REPO, saveJson, stateDir } from "./runtime.mjs";

export const PUBLISH_GRACE_MINUTES = 60;
export const INCIDENT_TITLE = "Incident: skillhook CLI health check failing";
/** Daily cadence: one failed run opens the incident, one healthy run closes it. */
export const OPEN_AFTER = 1;
export const CLOSE_AFTER = 1;

/** Compares two x.y.z[-pre] versions; pre-releases sort before their release. Pure. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split("-", 2);
    return { nums: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** The latest finished, not cancelled/skipped CI run on main decides. Pure. */
export function ciCheck(runs) {
  const run = (runs ?? []).find((r) => r.status === "completed" && !["cancelled", "skipped"].includes(r.conclusion));
  if (!run) return { name: "ci", ok: true, soft: true, note: "No finished CI run on main" };
  return { name: "ci", ok: run.conclusion === "success", note: `${run.conclusion} on ${String(run.headSha).slice(0, 7)}`, url: run.url };
}

/** npm `latest` against package.json on main and when that file last changed. Pure. */
export function publishCheck({ mainVersion, npmVersion, changedAt, now = new Date() }) {
  const cmp = compareVersions(mainVersion, npmVersion);
  if (cmp === 0) return { name: "publish", ok: true, note: `${PACKAGE}@${npmVersion} is published` };
  if (cmp < 0) return { name: "publish", ok: false, note: `npm latest ${npmVersion} is ahead of main's ${mainVersion}` };
  const minutes = (now.getTime() - new Date(changedAt).getTime()) / 60_000;
  if (minutes < PUBLISH_GRACE_MINUTES) return { name: "publish", ok: true, soft: true, note: `${mainVersion} merged ${Math.round(minutes)} min ago; publishing` };
  return { name: "publish", ok: false, note: `main is at ${mainVersion} since ${changedAt} but npm latest is ${npmVersion}` };
}

/** Pure state transition: the next state and the action to take on the incident issue. */
export function healthTransition(previous, ok, now = new Date().toISOString()) {
  const state = { consecutive_failures: 0, consecutive_passes: 0, open_issue: null, last_change: null, ...previous };
  if (ok) {
    state.consecutive_passes += 1;
    state.consecutive_failures = 0;
    if (state.open_issue && state.consecutive_passes >= CLOSE_AFTER) return { state: { ...state, open_issue: null, last_change: now }, action: "close", issue: state.open_issue };
    return { state, action: "none" };
  }
  state.consecutive_failures += 1;
  state.consecutive_passes = 0;
  if (!state.open_issue && state.consecutive_failures >= OPEN_AFTER) return { state: { ...state, last_change: now }, action: "open" };
  if (state.open_issue) return { state, action: "comment", issue: state.open_issue };
  return { state, action: "none" };
}

export function healthBody(result) {
  const rows = result.checks.map((c) => `| ${c.name} | ${c.ok ? (c.soft ? "WARN" : "PASS") : "FAIL"} | ${String(c.note ?? "").replaceAll("|", "/")} | ${c.url ?? ""} |`);
  const incidents = result.incidents.map((i) => `- #${i.number} ${i.title}`);
  return [
    `Detected by the skillhook-health hook at ${result.checked_at}.`,
    "",
    "| check | result | note | link |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    incidents.length ? `Open incidents:\n${incidents.join("\n")}` : "No other open incidents.",
    "",
    "Follow `.claude/skills/incident-triage/SKILL.md`.",
  ].join("\n");
}

async function collect() {
  const runs = ghJson(["run", "list", "-R", REPO, "--workflow", "ci.yml", "--branch", "main", "--event", "push", "--limit", "10", "--json", "status,conclusion,headSha,url,createdAt"]);
  const pkg = ghJson(["api", `repos/${REPO}/contents/package.json?ref=main`]);
  const mainVersion = JSON.parse(Buffer.from(pkg.content, "base64").toString("utf8")).version;
  const changedAt = ghJson(["api", `repos/${REPO}/commits?path=package.json&sha=main&per_page=1`])[0]?.commit?.committer?.date;
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE.replace("/", "%2F")}`, { headers: { accept: "application/vnd.npm.install-v1+json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`npm registry answered ${response.status}`);
  const npmVersion = (await response.json())["dist-tags"]?.latest;
  const incidents = ghJson(["issue", "list", "-R", REPO, "--label", "incident", "--state", "open", "--json", "number,title,url,createdAt"]);
  const checks = [ciCheck(runs), publishCheck({ mainVersion, npmVersion, changedAt })];
  return { checked_at: new Date().toISOString(), ok: checks.every((c) => c.ok), checks, incidents, mainVersion, npmVersion };
}

function ensureLabel() {
  try {
    gh(["label", "create", "incident", "-R", REPO, "--color", "B60205", "--description", "Production problem; routed to skillhook-agent"]);
  } catch {
    // Already exists.
  }
}

function comment(issue, text) {
  gh(["issue", "comment", String(issue), "-R", REPO, "--body-file", "-"], { input: `${MARKER}\n${text}`, stdio: ["pipe", "pipe", "pipe"] });
}

async function main() {
  if (process.argv.includes("--dry-run")) return outcome({ outcome: "completed", summary: "Dry run: would check CI on main, npm vs package.json and open incidents" });
  const result = await collect();
  const stateFile = path.join(stateDir(), "health-state.json");
  const { state, action, issue } = healthTransition(readJson(stateFile, {}), result.ok);
  if (action === "open") {
    // Reuse an open health incident (state lost, or opened by hand) rather than file a duplicate.
    const existing = result.incidents.find((i) => i.title.startsWith(INCIDENT_TITLE));
    if (existing) {
      comment(existing.number, healthBody(result));
      state.open_issue = existing.number;
    } else {
      ensureLabel();
      const url = gh(["issue", "create", "-R", REPO, "--title", INCIDENT_TITLE, "--label", "incident", "--body-file", "-"], { input: `${MARKER}\n${healthBody(result)}`, stdio: ["pipe", "pipe", "pipe"] });
      state.open_issue = Number(new URL(url).pathname.split("/").at(-1));
    }
  }
  if (action === "comment") comment(issue, `Still failing (${state.consecutive_failures} consecutive runs).\n\n${healthBody(result)}`);
  if (action === "close") {
    comment(issue, `Recovered at ${result.checked_at}: every check passes. Link the fix or postmortem here if it is not linked yet.`);
    gh(["issue", "close", String(issue), "-R", REPO]);
  }
  saveJson(stateFile, state);
  const failing = result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.note}`);
  outcome({
    outcome: result.ok ? "completed" : "partial",
    summary: result.ok ? `skillhook CLI healthy (main ${result.mainVersion}, npm ${result.npmVersion}, ${result.incidents.length} open incidents)` : `skillhook CLI unhealthy: ${failing.join("; ")}${state.open_issue ? ` (incident #${state.open_issue})` : ""}`,
    action,
    checks: result.checks,
    incidents: result.incidents.map((i) => i.number),
  });
}

if (isMain(import.meta.url)) {
  main().catch((error) => fail(error, "Health check could not run; check this host's gh login and network"));
}
