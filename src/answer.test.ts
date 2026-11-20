import { describe, expect, it } from "vitest";
import { answerJob, closeJob } from "./answer.js";
import { loadConfig } from "./config.js";
import { isWaitingForHuman, JobStore } from "./jobs.js";
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

describe("closing a waiting job", () => {
  function setup() {
    const paths = tempHome();
    writeSkill(paths, "triage", "description: Triage a finding.\nskillhook:\n  auth: {type: none}");
    const config = loadConfig(paths);
    const store = new JobStore(paths.jobsDir, { maxJobs: 50, dedupeWindowSeconds: 60 });
    const registry = new SkillRegistry(paths.skillsDir);
    const skill = registry.get("triage")!;
    const job = createManualJob({ config, store }, { skill, payload: {}, trigger: "cli" });
    return { config, store, registry, job };
  }

  it("stops a needs_human job from waiting without answering or resuming it, and says so in job.updated", () => {
    const { config, store, registry, job } = setup();
    store.update(job.id, { status: "succeeded", outcome: "needs_human", response: { outcome: "needs_human", summary: "Should I revert?" } });
    const emitted: unknown[] = [];
    const events = { emit: (type: string, data: unknown) => emitted.push({ type, data }) } as never;
    const result = closeJob({ store }, { jobId: job.id, by: "ada", reason: "  The Sentry issue resolved itself.  " }, { events });
    expect(result.closed).toMatchObject({ by: "ada", reason: "The Sentry issue resolved itself." });
    const closed = store.require(job.id);
    expect(closed.closed?.at).toBeDefined();
    expect(closed.answer).toBeUndefined();
    expect(closed.resolved_by).toBeUndefined();
    expect(isWaitingForHuman(closed)).toBe(false);
    expect(store.list().filter((j) => j.resume_of === job.id)).toHaveLength(0);
    expect(store.listPage({ waiting: true }).jobs.map((j) => j.id)).not.toContain(job.id);
    expect(emitted).toEqual([{ type: "job.updated", data: { job: closed, fields: ["closed"] } }]);
    // Closed is final: neither a second close nor a late answer reopens it.
    expect(() => closeJob({ store }, { jobId: job.id })).toThrow("not waiting for a person");
    expect(() => answerJob({ config, store, registry }, { jobId: job.id, text: "revert" })).toThrow("not waiting for a person");
  });

  it("closes a finished job's unanswered question", () => {
    const { store, job } = setup();
    store.update(job.id, { status: "failed", question: { id: "q1", text: "Which database?", asked_at: new Date().toISOString() } });
    expect(closeJob({ store }, { jobId: job.id }).job.closed).toBeDefined();
    expect(isWaitingForHuman(store.require(job.id))).toBe(false);
  });

  it("refuses unknown, running and not-waiting jobs", () => {
    const { store, job } = setup();
    expect(() => closeJob({ store }, { jobId: "nope" })).toThrow(expect.objectContaining({ code: "unknown_job", status: 404 }));
    store.update(job.id, { status: "running", question: { id: "q1", text: "Go?", asked_at: new Date().toISOString() } });
    expect(() => closeJob({ store }, { jobId: job.id })).toThrow(expect.objectContaining({ code: "running", status: 409 }));
    store.update(job.id, { status: "succeeded", question: undefined, outcome: "completed" });
    expect(() => closeJob({ store }, { jobId: job.id })).toThrow(expect.objectContaining({ code: "not_waiting", status: 409 }));
  });
});
