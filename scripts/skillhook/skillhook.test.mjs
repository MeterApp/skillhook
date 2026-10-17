// node --test scripts/skillhook/*.test.mjs (part of `npm test`). Pure functions only: no gh, git,
// network or ~/.skillhook.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { route } from "./ingress.mjs";
import { DEFAULT_REQUIRED_CHECKS, isRelease, mergeDecision, requiredChecks, requiredChecksFromRules } from "./merge-queue.mjs";
import { ciCheck, compareVersions, healthTransition, publishCheck } from "./health.mjs";
import { MARKER, stateDir } from "./runtime.mjs";

const repository = { full_name: "MeterApp/skillhook" };
const maintainer = { user: { type: "User" }, author_association: "OWNER" };

describe("ingress route", () => {
  it("syncs on a push to main only", () => {
    assert.equal(route({ repository, ref: "refs/heads/main" }, "push"), "sync");
    assert.equal(route({ repository, ref: "refs/heads/feature" }, "push"), null);
    assert.equal(route({ repository, ref: "refs/tags/v1.0.0" }, "push"), null);
  });
  it("ignores other repositories", () => {
    assert.equal(route({ repository: { full_name: "MeterApp/skillhook-cloud" }, ref: "refs/heads/main" }, "push"), null);
    assert.equal(route({ ref: "refs/heads/main" }, "push"), null);
  });
  it("runs labelled tasks once, from the labeled event", () => {
    const issue = { labels: [{ name: "incident" }], state: "open", ...maintainer };
    assert.equal(route({ repository, action: "labeled", label: { name: "incident" }, issue }, "issues"), "task");
    assert.equal(route({ repository, action: "labeled", label: { name: "ceo-task" }, issue }, "issues"), "task");
    assert.equal(route({ repository, action: "labeled", label: { name: "bug" }, issue }, "issues"), null);
    assert.equal(route({ repository, action: "opened", issue: { ...issue, body: "@claude" } }, "issues"), null);
  });
  it("never runs needs-human or closed issues", () => {
    const labels = [{ name: "incident" }, { name: "needs-human" }];
    assert.equal(route({ repository, action: "labeled", label: { name: "incident" }, issue: { labels, state: "open" } }, "issues"), null);
    assert.equal(route({ repository, action: "labeled", label: { name: "incident" }, issue: { labels: [], state: "closed" } }, "issues"), null);
  });
  it("answers maintainer @claude mentions but not its own replies, bots or strangers", () => {
    const comment = (body, extra = {}) => ({ repository, action: "created", issue: { labels: [], state: "open" }, comment: { ...maintainer, body, ...extra } });
    assert.equal(route(comment("@claude please look"), "issue_comment"), "task");
    assert.equal(route(comment("@claude please look"), "pull_request_review_comment"), "task");
    assert.equal(route(comment("cc @claudette"), "issue_comment"), null);
    assert.equal(route(comment(`${MARKER}\n@claude`), "issue_comment"), null);
    assert.equal(route(comment("@claude", { author_association: "NONE" }), "issue_comment"), null);
    assert.equal(route(comment("@claude", { user: { type: "Bot" } }), "issue_comment"), null);
    assert.equal(route({ ...comment("@claude"), action: "edited" }, "issue_comment"), null);
    assert.equal(route({ repository, action: "submitted", pull_request: { labels: [], state: "open" }, review: { ...maintainer, body: "@claude fix the nits" } }, "pull_request_review"), "task");
  });
});

describe("merge decision", () => {
  const head = "a".repeat(40);
  const green = DEFAULT_REQUIRED_CHECKS.map((name) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS" }));
  const pr = { state: "OPEN", headRefOid: head, baseRefName: "main", isDraft: false, labels: [], reviewDecision: null, statusCheckRollup: green, mergeStateStatus: "CLEAN", files: [{ filename: "src/x.ts", patch: "+x" }] };
  it("is ready only with an accepted head and every required check green", () => {
    assert.equal(mergeDecision(pr, [head]).state, "ready");
    assert.equal(mergeDecision({ ...pr, headRefOid: "b".repeat(40) }, [head]).state, "needs_review");
    assert.equal(mergeDecision({ ...pr, headRefOid: "b".repeat(40) }, [head, "b".repeat(40)]).state, "ready");
    assert.equal(mergeDecision({ ...pr, statusCheckRollup: green.slice(1) }, [head]).state, "waiting");
    assert.equal(mergeDecision({ ...pr, statusCheckRollup: [...green, { __typename: "CheckRun", name: "CodeQL", status: "COMPLETED", conclusion: "FAILURE" }] }, [head]).state, "waiting");
  });
  it("blocks needs-human, drafts, changes requested and releases", () => {
    assert.equal(mergeDecision({ ...pr, labels: [{ name: "needs-human" }] }, [head]).state, "blocked");
    assert.equal(mergeDecision({ ...pr, isDraft: true }, [head]).state, "blocked");
    assert.equal(mergeDecision({ ...pr, reviewDecision: "CHANGES_REQUESTED" }, [head]).state, "blocked");
    assert.equal(mergeDecision({ ...pr, files: [{ filename: "package.json", patch: '-  "version": "0.12.0",\n+  "version": "0.12.1",' }] }, [head]).state, "blocked");
  });
  it("asks for a branch update when main moved", () => {
    assert.equal(mergeDecision({ ...pr, mergeStateStatus: "BEHIND" }, [head]).state, "behind");
    assert.equal(mergeDecision({ ...pr, mergeStateStatus: "BLOCKED" }, [head]).state, "waiting");
  });
  it("recognises a release only by a moved version line", () => {
    assert.equal(isRelease([{ filename: "package.json", patch: '+    "zod": "^4.7.0"' }]), false);
    assert.equal(isRelease([{ filename: "src/version.ts", patch: '+  "version": "1"' }]), false);
    assert.equal(isRelease([{ filename: ".claude-plugin/plugin.json", patch: ' {\n-  "version": "0.12.0",' }]), true);
  });
  it("reads required checks from the environment, then the ruleset, then the defaults", () => {
    assert.deepEqual(requiredChecks({ SKILLHOOK_CLI_REQUIRED_CHECKS: "A, B" }, () => { throw new Error("unused"); }), ["A", "B"]);
    const rules = [{ type: "pull_request" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "X" }, { context: "X" }, { context: "Y" }] } }];
    assert.deepEqual(requiredChecksFromRules(rules), ["X", "Y"]);
    assert.deepEqual(requiredChecks({}, () => rules), ["X", "Y"]);
    assert.deepEqual(requiredChecks({}, () => { throw new Error("offline"); }), DEFAULT_REQUIRED_CHECKS);
  });
});

describe("health", () => {
  it("compares versions", () => {
    assert.equal(compareVersions("0.12.0", "0.11.9"), 1);
    assert.equal(compareVersions("0.12.0", "0.12.0"), 0);
    assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
    assert.equal(compareVersions("0.9.10", "0.10.0"), -1);
  });
  it("judges CI by the latest finished run that was not cancelled", () => {
    const runs = [
      { status: "in_progress", conclusion: "", headSha: "c" },
      { status: "completed", conclusion: "cancelled", headSha: "b" },
      { status: "completed", conclusion: "failure", headSha: "a" },
    ];
    assert.equal(ciCheck(runs).ok, false);
    assert.equal(ciCheck([{ status: "completed", conclusion: "success", headSha: "a" }]).ok, true);
    assert.deepEqual([ciCheck([]).ok, ciCheck([]).soft], [true, true]);
  });
  it("gives a merged release time to publish", () => {
    const now = new Date("2026-10-17T12:00:00Z");
    assert.equal(publishCheck({ mainVersion: "0.12.0", npmVersion: "0.12.0", changedAt: "2026-10-01T00:00:00Z", now }).ok, true);
    assert.equal(publishCheck({ mainVersion: "0.12.0", npmVersion: "0.11.0", changedAt: "2026-10-17T11:30:00Z", now }).ok, true);
    assert.equal(publishCheck({ mainVersion: "0.12.0", npmVersion: "0.11.0", changedAt: "2026-10-17T10:00:00Z", now }).ok, false);
    assert.equal(publishCheck({ mainVersion: "0.11.0", npmVersion: "0.12.0", changedAt: "2026-10-17T10:00:00Z", now }).ok, false);
  });
  it("opens on a failure, comments while failing and closes on a pass", () => {
    let step = healthTransition({}, true);
    assert.equal(step.action, "none");
    step = healthTransition(step.state, false);
    assert.equal(step.action, "open");
    step = healthTransition({ ...step.state, open_issue: 7 }, false);
    assert.deepEqual([step.action, step.issue], ["comment", 7]);
    step = healthTransition(step.state, true);
    assert.deepEqual([step.action, step.issue, step.state.open_issue], ["close", 7, null]);
  });
});

describe("runtime", () => {
  it("keeps host state under SKILLHOOK_HOME", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "skillhook-cli-ops-"));
    try {
      assert.equal(stateDir({ SKILLHOOK_HOME: home }), path.join(home, "skillhook-cli"));
      assert.equal(fs.statSync(path.join(home, "skillhook-cli")).isDirectory(), true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
