import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeliveryLog, readDeliveryBody, type DeliveryInput, type DeliveryLogOptions } from "./delivery-log.js";
import { JobStore } from "./jobs.js";
import { tempHome } from "./test-support/helpers.js";

function input(over: Partial<DeliveryInput> = {}): DeliveryInput {
  return { skill: "hello", received_at: new Date().toISOString(), outcome: "accepted", http_status: 202, ip: "127.0.0.1", method: "POST", path: "/hooks/hello", query: {}, headers: { "content-type": "application/json" }, content_type: "application/json", bytes: 2, body_kind: "json", duration_ms: 3, ...over };
}

function log(jobsDir: string, options: DeliveryLogOptions = { max: 2000, store_bodies: true, body_max_bytes: 65_536 }): DeliveryLog {
  return new DeliveryLog(jobsDir, () => options);
}

describe("DeliveryLog", () => {
  it("records, lists newest first with filters and a cursor, and finds by id", () => {
    const paths = tempHome();
    const l = log(paths.jobsDir);
    const a = l.record(input({ received_at: "2026-09-28T10:00:00.000Z" }));
    const b = l.record(input({ skill: "gh", outcome: "rejected", http_status: 401, code: "invalid_signature", received_at: "2026-09-28T10:00:01.000Z" }));
    const c = l.record(input({ outcome: "skipped", http_status: 200, code: "skipped", reason: "payload.action equals \"created\": got \"deleted\"", received_at: "2026-09-28T10:00:02.000Z" }));
    expect(l.count()).toBe(3);
    expect(l.list().deliveries.map((d) => d.id)).toEqual([c.id, b.id, a.id]);
    expect(l.list().next_after).toBeNull();
    expect(l.list({ skill: "hello" }).deliveries.map((d) => d.id)).toEqual([c.id, a.id]);
    expect(l.list({ outcome: "rejected" }).deliveries.map((d) => d.id)).toEqual([b.id]);
    expect(l.list({ outcome: ["rejected", "skipped"] }).deliveries.map((d) => d.id)).toEqual([c.id, b.id]);
    expect(l.list({ since: "2026-09-28T10:00:01.000Z" }).deliveries.map((d) => d.id)).toEqual([c.id, b.id]);
    const first = l.list({ limit: 2 });
    expect(first.deliveries.map((d) => d.id)).toEqual([c.id, b.id]);
    expect(first.next_after).toBe(b.id);
    const second = l.list({ limit: 2, after: first.next_after as string });
    expect(second.deliveries.map((d) => d.id)).toEqual([a.id]);
    expect(second.next_after).toBeNull();
    expect(l.list({ after: "20200101T000000Z-aaaaaa" }).deliveries).toEqual([]); // a cursor older than everything (and gone)
    expect(l.get(b.id)?.code).toBe("invalid_signature");
    expect(l.get("nope")).toBeUndefined();
    expect(l.stats()).toEqual({ total: 3, last_received_at: "2026-09-28T10:00:02.000Z" });
    expect(l.record(input({ headers: { "x-long": "v".repeat(600) } })).headers["x-long"]).toHaveLength(513);
    // Another instance (another process) reads what was appended.
    expect(log(paths.jobsDir).list({ limit: 3 }).deliveries.map((d) => d.id)).toEqual([expect.any(String), c.id, b.id]);
  });

  it("keeps bodies only for refused deliveries, capped, and serves accepted ones from the job", () => {
    const paths = tempHome();
    const store = new JobStore(paths.jobsDir, { maxJobs: 10, dedupeWindowSeconds: 60 });
    const l = log(paths.jobsDir, { max: 2000, store_bodies: true, body_max_bytes: 5 });
    const accepted = l.record(input({ rawBody: Buffer.from("payload"), job_id: "x" }));
    expect(accepted).toMatchObject({ body_stored: false, bytes: 2 });
    const rejected = l.record(input({ outcome: "rejected", http_status: 401, rawBody: Buffer.from("secret-body") }));
    expect(rejected).toMatchObject({ body_stored: true, body_truncated: true });
    expect(l.readBody(rejected.id)).toEqual({ bytes: Buffer.from("secre"), truncated: true });
    expect(readDeliveryBody(l, store, rejected)).toEqual({ encoding: "utf8", text: "secre", truncated: true, source: "log" });
    const skipped = l.record(input({ outcome: "skipped", http_status: 200, rawBody: Buffer.from("hey") }));
    expect(readDeliveryBody(l, store, skipped)).toEqual({ encoding: "utf8", text: "hey", truncated: false, source: "log" });
    const binary = l.record(input({ outcome: "error", http_status: 500, rawBody: Buffer.from([0xff, 0xfe, 0x00]) }));
    expect(readDeliveryBody(l, store, binary)).toEqual({ encoding: "base64", text: Buffer.from([0xff, 0xfe, 0x00]).toString("base64"), truncated: false, source: "log" });
    expect(l.readBody(accepted.id)).toBeUndefined();
    expect(l.readBody("nope")).toBeUndefined();
    const off = log(paths.jobsDir, { max: 2000, store_bodies: false, body_max_bytes: 5 });
    expect(off.record(input({ outcome: "rejected", http_status: 401, rawBody: Buffer.from("x") })).body_stored).toBe(false);
    const job = store.create({ skill: "hello", trigger: "webhook", runner: "claude", source: { ip: "1", method: "POST", path: "/hooks/hello", content_type: "application/json" }, event: { id: "", skill: "hello", trigger: "webhook", received_at: "", method: "POST", path: "/hooks/hello", query: {}, headers: {}, source_ip: "1", content_type: "application/json", content_length: 9, body_kind: "json", payload: { a: 1 } } });
    const viaJob = l.record(input({ job_id: job.id }));
    const body = readDeliveryBody(l, store, viaJob);
    expect(body).toMatchObject({ encoding: "utf8", truncated: false, source: "job" });
    expect(JSON.parse(body?.text ?? "")).toEqual({ a: 1 });
    expect(readDeliveryBody(l, store, l.record(input({ outcome: "duplicate", http_status: 200 })))).toBeUndefined();
  });

  it("compacts to the newest records, drops their bodies, and skips torn lines", () => {
    const paths = tempHome();
    const l = log(paths.jobsDir, { max: 4, store_bodies: true, body_max_bytes: 100 });
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(l.record(input({ outcome: "rejected", http_status: 401, rawBody: Buffer.from(`b${i}`), received_at: `2026-09-28T10:00:0${i}.000Z` })).id);
    // The 7th record takes the log past 1.5 × max, so it is compacted to the newest four.
    expect(l.count()).toBe(4);
    expect(l.list().deliveries.map((d) => d.id)).toEqual(ids.slice(3).reverse());
    expect(readdirSync(path.join(l.dir, "bodies")).sort()).toEqual(ids.slice(3).map((id) => `${id}.bin`).sort());
    expect(readFileSync(path.join(l.dir, "deliveries.jsonl"), "utf8").trim().split("\n")).toHaveLength(4);
    appendFileSync(path.join(l.dir, "deliveries.jsonl"), '{"id":"torn');
    expect(log(paths.jobsDir).count()).toBe(4);
    expect(l.compact(2)).toBe(2);
    expect(l.count()).toBe(2);
    expect(readdirSync(path.join(l.dir, "bodies"))).toHaveLength(2);
  });
});
