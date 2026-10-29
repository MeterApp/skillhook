import { describe, expect, it } from "vitest";
import { answerJob } from "./answer.js";
import { loadConfig } from "./config.js";
import { JobStore } from "./jobs.js";
import { createManualJob } from "./manual.js";
import { SkillRegistry } from "./registry.js";
import { tempHome, writeSkill } from "./test-support/helpers.js";

describe("answers at the retention limit", () => {
  it("links a resume without pruning its answered parent, including after restart", () => {
    const paths = tempHome();
    writeSkill(paths, "approval", "description: Wait for approval.\nskillhook:\n  auth: {type: none}");
    const config = loadConfig(paths);
    const store = new JobStore(paths.jobsDir, { maxJobs: 1, dedupeWindowSeconds: 60 });
    const registry = new SkillRegistry(paths.skillsDir);
    const skill = registry.get("approval")!;
    const first = createManualJob({ config, store }, { skill, payload: { original: true }, trigger: "cli", jobId: "20260101T000000Z-aaaaaa" });
    store.update(first.id, { status: "succeeded", outcome: "needs_human", response: { outcome: "needs_human", summary: "Approve repair" } });
    const result = answerJob({ config, store, registry }, { jobId: first.id, text: "Proceed" });
    expect(result.delivered).toBe("resumed");
    expect(store.require(first.id)).toMatchObject({ resolved_by: result.resumeJob!.id, answer: { text: "Proceed" } });
    expect(store.require(result.resumeJob!.id)).toMatchObject({ status: "queued", resume_of: first.id });
    expect(() => answerJob({ config, store, registry }, { jobId: first.id, text: "Proceed" })).toThrow("not waiting for a person");
    expect(store.list().filter((job) => job.resume_of === first.id)).toHaveLength(1);
    const restarted = new JobStore(paths.jobsDir, { maxJobs: 1, dedupeWindowSeconds: 60 });
    expect(restarted.prune()).toBe(0);
    restarted.update(result.resumeJob!.id, { status: "running" });
    expect(restarted.prune()).toBe(0);
    restarted.update(result.resumeJob!.id, { status: "succeeded" });
    expect(restarted.prune()).toBe(1);
    expect(restarted.ids()).toHaveLength(1);
  });
});
