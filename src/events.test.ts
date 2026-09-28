import { describe, expect, it } from "vitest";
import { Events, EVENT_TYPES, type SkillhookEvent } from "./events.js";
import type { JobRecord } from "./jobs.js";
import type { Logger } from "./logger.js";

const job = (id: string): JobRecord => ({ id, skill: "s", status: "queued", trigger: "cli", runner: "shell", created_at: "2026-09-28T00:00:00.000Z", source: { ip: "127.0.0.1", method: "LOCAL", path: "/hooks/s", content_type: null } });

describe("Events", () => {
  it("delivers typed events with a monotonic seq to type listeners and any-listeners", () => {
    const events = new Events();
    const seen: string[] = [];
    const all: SkillhookEvent[] = [];
    const off = events.on("job.queued", (event) => seen.push(event.data.job.id));
    events.onAny((event) => all.push(event));
    const first = events.emit("job.queued", { job: job("a") });
    events.emit("job.finished", { job: job("a") });
    expect(first).toMatchObject({ seq: 1, type: "job.queued" });
    expect(Date.parse(first.at)).not.toBeNaN();
    expect(seen).toEqual(["a"]);
    expect(all.map((event) => [event.seq, event.type])).toEqual([
      [1, "job.queued"],
      [2, "job.finished"],
    ]);
    expect(events.seq()).toBe(2);
    expect(events.listenerCount("job.queued")).toBe(2);
    off();
    events.emit("job.queued", { job: job("b") });
    expect(seen).toEqual(["a"]);
    expect(events.listenerCount()).toBe(1);
  });

  it("supports once and unsubscribing an any-listener", () => {
    const events = new Events();
    let calls = 0;
    events.once("job.started", () => calls++);
    const offAny = events.onAny(() => calls++);
    events.emit("job.started", { job: job("a") });
    events.emit("job.started", { job: job("a") });
    expect(calls).toBe(3);
    offAny();
    events.emit("job.started", { job: job("a") });
    expect(calls).toBe(3);
  });

  it("logs a throwing listener and keeps delivering", () => {
    const errors: Record<string, unknown>[] = [];
    const logger: Logger = {
      level: "error",
      debug() {},
      info() {},
      warn() {},
      error(_msg, fields) {
        errors.push(fields ?? {});
      },
      child() {
        return logger;
      },
    };
    const events = new Events(logger);
    events.on("job.queued", () => {
      throw new Error("boom");
    });
    let reached = 0;
    events.on("job.queued", () => reached++);
    events.onAny(() => reached++);
    events.emit("job.queued", { job: job("a") });
    expect(reached).toBe(2);
    expect(errors).toEqual([{ type: "job.queued", seq: 1, error: "boom" }]);
  });

  it("names every event type once", () => {
    expect(EVENT_TYPES).toContain("job.finished");
    expect(EVENT_TYPES).toContain("skill.changed");
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });
});
