import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JobStore } from "./jobs.js";
import type { WebhookEvent } from "./payload.js";
import { tempHome } from "./test-support/helpers.js";

function event(skill: string, payload: unknown): WebhookEvent {
  return { id: "", skill, trigger: "webhook", received_at: new Date().toISOString(), method: "POST", path: `/hooks/${skill}`, query: {}, headers: {}, source_ip: "1.1.1.1", content_type: "application/json", content_length: 2, body_kind: "json", payload };
}

function store(maxJobs = 100) {
  const paths = tempHome();
  return new JobStore(paths.jobsDir, { maxJobs, dedupeWindowSeconds: 60 });
}

describe("JobStore", () => {
  it("creates job directories with payload and event files", () => {
    const s = store();
    const job = s.create({ skill: "a", trigger: "webhook", runner: "claude", source: { ip: "1.1.1.1", method: "POST", path: "/hooks/a", content_type: "application/json" }, event: event("a", { x: 1 }) });
    const paths = s.pathsFor(job.id);
    expect(JSON.parse(readFileSync(paths.payload, "utf8"))).toEqual({ x: 1 });
    expect(s.readEvent(job.id).skill).toBe("a");
    expect(s.get(job.id)?.status).toBe("queued");
    expect(s.get("nope")).toBeUndefined();
  });

  it("updates records, stores full results on disk and truncates inline", () => {
    const s = store();
    const job = s.create({ skill: "a", trigger: "cli", runner: "codex", source: { ip: "", method: "LOCAL", path: "", content_type: null }, event: event("a", {}) });
    const big = "x".repeat(30_000);
    const updated = s.update(job.id, { status: "succeeded", result: big, pid: 5 });
    expect(updated.result?.length).toBeLessThan(21_000);
    expect(readFileSync(s.pathsFor(job.id).result, "utf8").trim()).toBe(big);
    expect(s.update(job.id, { pid: undefined }).pid).toBeUndefined();
    expect(s.readArtifact(job.id, "result")?.trim()).toBe(big);
    expect(s.readArtifact(job.id, "stdout")).toBeUndefined();
  });

  it("lists newest first with filters", async () => {
    const s = store();
    const src = { ip: "", method: "POST", path: "", content_type: null };
    const a = s.create({ skill: "a", trigger: "webhook", runner: "claude", source: src, event: event("a", {}) });
    await new Promise((r) => setTimeout(r, 1100));
    const b = s.create({ skill: "b", trigger: "webhook", runner: "claude", source: src, event: event("b", {}) });
    s.update(b.id, { status: "failed" });
    expect(s.list().map((j) => j.id)).toEqual([b.id, a.id]);
    expect(s.list({ skill: "a" }).map((j) => j.id)).toEqual([a.id]);
    expect(s.list({ status: ["failed"] }).map((j) => j.id)).toEqual([b.id]);
    expect(s.list({ limit: 1 })).toHaveLength(1);
  });

  it("remembers deliveries within the window", () => {
    const s = store();
    expect(s.seenDelivery("a", "d1")).toBeUndefined();
    s.rememberDelivery("a", "d1", "job-1", 1_000_000);
    expect(s.seenDelivery("a", "d1", 1_000_000 + 30_000)).toBe("job-1");
    expect(s.seenDelivery("a", "d1", 1_000_000 + 61_000)).toBeUndefined();
    expect(s.seenDelivery("b", "d1", 1_000_000)).toBeUndefined();
  });

  it("recovers on startup and prunes finished jobs beyond the limit", async () => {
    const s = store(2);
    const src = { ip: "", method: "POST", path: "", content_type: null };
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const job = s.create({ skill: "a", trigger: "webhook", runner: "claude", source: src, event: event("a", {}) });
      ids.push(job.id);
      s.update(job.id, { status: i === 0 ? "running" : i === 1 ? "queued" : "succeeded" });
      await new Promise((r) => setTimeout(r, 1100));
    }
    const recovered = s.recoverOnStartup();
    expect(recovered.interrupted.map((j) => j.id)).toEqual([ids[0]]);
    expect(recovered.queued.map((j) => j.id)).toEqual([ids[1]]);
    expect(s.get(ids[0] as string)?.status).toBe("interrupted");
    const fourth = s.create({ skill: "a", trigger: "webhook", runner: "claude", source: src, event: event("a", {}) });
    expect(existsSync(s.pathsFor(fourth.id).dir)).toBe(true);
    expect(s.ids().length).toBeLessThanOrEqual(3);
  });
});
