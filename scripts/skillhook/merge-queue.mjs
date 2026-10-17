// The durable merge queue for reviewed agent PRs (.claude/skills/delivery.md, hook skillhook-merge-queue).
//
//   node scripts/skillhook/merge-queue.mjs enqueue <PR> <reviewed-40-char-head-SHA> "<review reason>"
//   node scripts/skillhook/merge-queue.mjs            # reconcile: squash-merge ready, unchanged heads
//
// Records live in ~/.skillhook/skillhook-cli/merge-queue/<PR>.json. The queue delivers, it does not
// review: it merges only the exact head an agent reviewed (plus merges of main into it that the
// queue made itself, because main requires branches to be up to date), only with every required
// check green, never a draft, a needs-human PR, one with changes requested, or a release (a version
// bump publishes to npm when it merges), and never with --admin.
import fs from "node:fs";
import path from "node:path";
import { fail, gh, ghJson, isMain, outcome, readJson, REPO, saveJson, stateDir } from "./runtime.mjs";

/** The CI jobs main's ruleset requires (ci.yml job names); used when the live ruleset cannot be read. */
export const DEFAULT_REQUIRED_CHECKS = ["Node.js 22", "Node.js 24", "Package"];
/** Files whose `"version"` line moves only in a release PR. */
export const VERSION_FILES = ["package.json", "package-lock.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json"];

export function requiredChecksFromRules(rules) {
  const checks = (rules ?? []).filter((r) => r.type === "required_status_checks").flatMap((r) => r.parameters?.required_status_checks ?? []);
  const names = checks.map((c) => c?.context).filter((c) => typeof c === "string" && c.trim());
  return [...new Set(names)];
}

/** SKILLHOOK_CLI_REQUIRED_CHECKS (comma-separated) wins, then main's live ruleset, then the CI defaults. */
export function requiredChecks(env = process.env, readRules = () => ghJson(["api", `repos/${REPO}/rules/branches/main`])) {
  const fromEnv = String(env.SKILLHOOK_CLI_REQUIRED_CHECKS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  try {
    const live = requiredChecksFromRules(readRules());
    if (live.length) return live;
  } catch {
    // Fall through to the defaults; they are main's checks at the time of writing.
  }
  return DEFAULT_REQUIRED_CHECKS;
}

/** True when a PR's files move a version number: a release, which a maintainer merges. Pure. */
export function isRelease(files) {
  return files.some((f) => VERSION_FILES.includes(f.filename) && /^[+-]\s*"version"\s*:/m.test(f.patch ?? ""));
}

/**
 * What to do with one queued PR. `accepted` is the reviewed head plus the heads the queue produced by
 * merging main into it. Pure; `pr` is `gh pr view --json` output plus `files` (the PR's changed files).
 */
export function mergeDecision(pr, accepted, required = DEFAULT_REQUIRED_CHECKS) {
  if (pr.state === "MERGED") return { state: "merged" };
  if (pr.state !== "OPEN") return { state: "closed" };
  if (!accepted.includes(pr.headRefOid)) return { state: "needs_review", reason: "Head changed since the agent's review" };
  if (pr.baseRefName !== "main" || pr.isDraft || pr.labels.some((l) => l.name === "needs-human")) return { state: "blocked", reason: "Draft, needs-human or not based on main" };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { state: "blocked", reason: "Changes requested" };
  if (pr.files && isRelease(pr.files)) return { state: "blocked", reason: "Release PR (moves the version, publishes to npm on merge): a maintainer merges it" };
  const checks = pr.statusCheckRollup ?? [];
  const passed = (c) => (c.__typename === "StatusContext" ? c.state === "SUCCESS" : c.status === "COMPLETED" && ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.conclusion));
  const failed = (c) => (c.__typename === "StatusContext" ? ["FAILURE", "ERROR"].includes(c.state) : ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(c.conclusion));
  if (checks.some(failed)) return { state: "waiting", reason: `Check failed: ${checks.filter(failed).map((c) => c.name ?? c.context).join(", ")}` };
  for (const name of required) {
    const matches = checks.filter((c) => (c.name ?? c.context) === name);
    if (!matches.length || !matches.every(passed)) return { state: "waiting", reason: `${name} is missing or not finished` };
  }
  if (pr.mergeStateStatus === "BEHIND") return { state: "behind", reason: "Branch is behind main (main requires up-to-date branches)" };
  if (["DIRTY", "BLOCKED", "DRAFT", "UNKNOWN"].includes(pr.mergeStateStatus)) return { state: "waiting", reason: `Merge state ${pr.mergeStateStatus}` };
  return { state: "ready" };
}

const FIELDS = "number,url,state,isDraft,headRefOid,baseRefName,mergeStateStatus,reviewDecision,statusCheckRollup,labels";
function readPr(number) {
  const pr = ghJson(["pr", "view", String(number), "-R", REPO, "--json", FIELDS]);
  pr.files = ghJson(["api", "--paginate", "--slurp", `repos/${REPO}/pulls/${number}/files?per_page=100`]).flat();
  return pr;
}

function queueDir() {
  const dir = path.join(stateDir(), "merge-queue");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function acceptedHeads(record) {
  return [record.expectedHead, ...(record.syncedHeads ?? [])];
}

export function enqueueMerge(number, expectedHead, reason) {
  if (!/^\d+$/.test(String(number)) || !/^[a-f0-9]{40}$/.test(String(expectedHead)) || !String(reason ?? "").trim()) {
    throw new Error("Usage: enqueue <PR number> <reviewed 40-character head SHA> \"<review reason>\"");
  }
  const decision = mergeDecision(readPr(number), [expectedHead], requiredChecks());
  if (["needs_review", "blocked", "closed"].includes(decision.state)) throw new Error(decision.reason ?? decision.state);
  const file = path.join(queueDir(), `${number}.json`);
  const previous = readJson(file, {});
  const history = [...(previous.history ?? []), ...(previous.expectedHead ? [{ head: previous.expectedHead, state: previous.state, reviewedAt: previous.reviewedAt, reviewReason: previous.reviewReason }] : [])];
  const record = { number: Number(number), expectedHead, syncedHeads: [], reviewReason: reason, reviewedAt: new Date().toISOString(), ...decision, history };
  saveJson(file, record);
  return record;
}

/** Merges main into the PR branch (GitHub's update-branch) and records the new head if it is exactly that merge. */
function updateBranch(record, head) {
  gh(["api", "-X", "PUT", `repos/${REPO}/pulls/${record.number}/update-branch`, "-f", `expected_head_sha=${head}`]);
  for (let i = 0; i < 10; i += 1) {
    const next = ghJson(["pr", "view", String(record.number), "-R", REPO, "--json", "headRefOid"]).headRefOid;
    if (next !== head) {
      const parents = ghJson(["api", `repos/${REPO}/commits/${next}`, "--jq", "[.parents[].sha]"]);
      if (parents.length === 2 && parents[0] === head) return next;
      throw new Error("Branch moved to a commit the queue did not make");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  return null;
}

export function reconcileMerges() {
  const dir = queueDir();
  const required = requiredChecks();
  const results = [];
  for (const name of fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)).sort()) {
    const file = path.join(dir, name);
    const record = readJson(file, null);
    if (!record || ["merged", "closed"].includes(record.state)) continue;
    let next;
    try {
      const pr = readPr(record.number);
      const decision = mergeDecision(pr, acceptedHeads(record), required);
      next = { ...record, ...decision, reason: decision.reason, checkedAt: new Date().toISOString() };
      if (decision.state === "behind") {
        const synced = updateBranch(record, pr.headRefOid);
        next = { ...next, state: "waiting", reason: "Merged main into the branch; waiting for CI", syncedHeads: synced ? [...(record.syncedHeads ?? []), synced] : record.syncedHeads };
      } else if (decision.state === "ready") {
        gh(["pr", "merge", String(record.number), "-R", REPO, "--squash", "--match-head-commit", pr.headRefOid]);
        const merged = ghJson(["pr", "view", String(record.number), "-R", REPO, "--json", "state"]).state === "MERGED";
        next = { ...next, state: merged ? "merged" : "waiting", reason: merged ? undefined : "Merge did not complete; retrying next run" };
      }
    } catch (error) {
      next = { ...record, state: "error", reason: `GitHub read or merge failed (${String(error.message).split("\n")[0].slice(0, 200)}); retrying next run`, checkedAt: new Date().toISOString() };
    }
    saveJson(file, next);
    results.push({ number: next.number, state: next.state, reason: next.reason });
  }
  return results;
}

if (isMain(import.meta.url)) {
  // `enqueue` runs inside an agent's job: print only, never overwrite that agent's response file.
  const env = process.argv[2] === "enqueue" ? { ...process.env, SKILLHOOK_RESPONSE_PATH: "" } : process.env;
  try {
    if (process.argv.includes("--dry-run")) {
      outcome({ outcome: "completed", summary: "Dry run: would squash-merge reviewed, unchanged heads whose required checks are green", required: requiredChecks(process.env, () => []) }, env);
    } else {
      if (process.argv[2] === "enqueue") enqueueMerge(process.argv[3], process.argv[4], process.argv[5]);
      const results = reconcileMerges();
      const pending = results.filter((r) => !["merged", "closed"].includes(r.state));
      outcome({ outcome: pending.length ? "partial" : results.length ? "completed" : "nothing_to_do", summary: `Merge queue: ${results.length} checked, ${results.filter((r) => r.state === "merged").length} merged, ${pending.length} pending`, results }, env);
    }
  } catch (error) {
    fail(error, "Merge queue failed; check the arguments and this host's gh login", env);
  }
}
