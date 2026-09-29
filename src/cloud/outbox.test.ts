import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempHome } from "../test-support/helpers.js";
import { cloudStateDir, CommandLedger, IngressLedger, Outbox } from "./outbox.js";
import type { CommandResult } from "./protocol.js";

function result(id: string, sensitive = false): CommandResult {
  return { command_id: id, ok: true, result: { n: id }, started_at: "2026-09-28T12:00:00.000Z", finished_at: "2026-09-28T12:00:00.010Z", duration_ms: 10, ...(sensitive ? { sensitive: true } : {}) };
}

describe("Outbox", () => {
  it("numbers events, hands out the oldest first and forgets what the cloud acknowledged", () => {
    const { jobsDir } = tempHome("skillhook-outbox-");
    const outbox = new Outbox(jobsDir, () => ({ maxEvents: 100 }));
    const a = outbox.append("m1", "job.queued", { n: 1 });
    const b = outbox.append("m1", "job.started", { n: 2 });
    outbox.append("m1", "job.finished", { n: 3 });
    expect(a).toMatchObject({ id: "m1:1", seq: 1, machine_id: "m1", type: "job.queued", data: { n: 1 } });
    expect(b.seq).toBe(2);
    expect(outbox.depth()).toBe(3);
    expect(outbox.pending(2).map((e) => e.seq)).toEqual([1, 2]);
    // A byte budget stops the batch early, but never below one event.
    expect(outbox.pending(10, 10).map((e) => e.seq)).toEqual([1]);
    expect(outbox.ack(2)).toBe(2);
    expect(outbox.pending(10).map((e) => e.seq)).toEqual([3]);
    expect((statSync(path.join(cloudStateDir(jobsDir), "outbox.jsonl")).mode & 0o777).toString(8)).toBe("600");
  });

  it("survives a restart, skips a torn last line and keeps numbering where it left off", () => {
    const { jobsDir } = tempHome("skillhook-outbox-");
    const first = new Outbox(jobsDir, () => ({ maxEvents: 100 }));
    first.append("m1", "job.queued", { n: 1 });
    first.append("m1", "job.queued", { n: 2 });
    first.ack(1);
    appendFileSync(path.join(cloudStateDir(jobsDir), "outbox.jsonl"), '{"id":"m1:3","seq":3,"ts":"2026-09-28T12:00:00.000Z","machine_id":"m1","type":"job.qu');
    const second = new Outbox(jobsDir, () => ({ maxEvents: 100 }));
    expect(second.pending(10).map((e) => e.seq)).toEqual([2]);
    expect(second.seq()).toBe(2);
    expect(second.append("m1", "job.finished", {}).seq).toBe(3);
  });

  it("drops the oldest events beyond its bound, and a single event on purpose, counting both", () => {
    const { jobsDir } = tempHome("skillhook-outbox-");
    const outbox = new Outbox(jobsDir, () => ({ maxEvents: 3 }));
    for (let i = 1; i <= 5; i++) outbox.append("m1", "job.queued", { i });
    expect(outbox.pending(10).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(outbox.droppedTotal()).toBe(2);
    expect(outbox.drop(4)).toBe(true);
    expect(outbox.drop(99)).toBe(false);
    expect(outbox.pending(10).map((e) => e.seq)).toEqual([3, 5]);
    expect(outbox.droppedTotal()).toBe(3);
    // Compaction rewrites the file with only what is pending.
    outbox.compact();
    const lines = readFileSync(path.join(cloudStateDir(jobsDir), "outbox.jsonl"), "utf8").trim().split("\n");
    expect(lines.map((line) => (JSON.parse(line) as { seq: number }).seq)).toEqual([3, 5]);
    outbox.purge();
    expect(outbox.depth()).toBe(0);
    expect(existsSync(path.join(cloudStateDir(jobsDir), "outbox.jsonl"))).toBe(false);
  });
});

describe("CommandLedger", () => {
  it("remembers which commands ran, keeps results until acknowledged and never caches a sensitive one", () => {
    const { jobsDir } = tempHome("skillhook-ledger-");
    const ledger = new CommandLedger(jobsDir);
    expect(ledger.seen("c1")).toBe(false);
    ledger.complete(result("c1"));
    ledger.complete(result("c2", true));
    expect(ledger.seen("c1")).toBe(true);
    expect(ledger.seen("c2")).toBe(true);
    expect(ledger.cachedResult("c1")).toMatchObject({ command_id: "c1" });
    expect(ledger.cachedResult("c2")).toBeUndefined();
    expect(ledger.pendingResults(10).map((r) => r.command_id)).toEqual(["c1", "c2"]);
    ledger.ackResults(["c2"]);
    expect(ledger.pendingResults(10).map((r) => r.command_id)).toEqual(["c1"]);
    // Across a restart.
    const again = new CommandLedger(jobsDir);
    expect(again.seen("c2")).toBe(true);
    expect(again.pendingResults(10).map((r) => r.command_id)).toEqual(["c1"]);
    again.purge();
    expect(new CommandLedger(jobsDir).seen("c1")).toBe(false);
  });
});

describe("IngressLedger", () => {
  it("answers a hosted delivery seen before and resends acknowledgements until a sync carried them", () => {
    const { jobsDir } = tempHome("skillhook-ledger-");
    const ledger = new IngressLedger(jobsDir);
    expect(ledger.known("i1")).toBeUndefined();
    ledger.record({ id: "i1", outcome: "accepted", http_status: 202, job_id: "20260928T120000Z-abcdef" });
    ledger.record({ id: "i2", outcome: "rejected", http_status: 401, code: "invalid_signature" });
    expect(ledger.known("i1")).toMatchObject({ outcome: "accepted" });
    expect(ledger.pendingAcks(10).map((a) => a.id)).toEqual(["i1", "i2"]);
    ledger.acksSent(["i1"]);
    expect(ledger.pendingAcks(10).map((a) => a.id)).toEqual(["i2"]);
    expect(new IngressLedger(jobsDir).known("i2")).toMatchObject({ code: "invalid_signature" });
  });
});
