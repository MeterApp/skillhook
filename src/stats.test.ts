import { describe, expect, it } from "vitest";
import { DeliveryLog, type DeliveryRecord } from "./delivery-log.js";
import { JobStore, type JobRecord } from "./jobs.js";
import type { WebhookEvent } from "./payload.js";
import { collectStats, computeStats, formatStats, parseSince, percentiles, tokensOf } from "./stats.js";
import { tempHome } from "./test-support/helpers.js";

function job(partial: Partial<JobRecord> & { id: string; skill: string; status: JobRecord["status"] }): JobRecord {
  return { trigger: "webhook", runner: "claude", created_at: `2026-09-28T12:00:00.000Z`, source: { ip: "1.1.1.1", method: "POST", path: `/hooks/${partial.skill}`, content_type: null }, ...partial } as JobRecord;
}

function delivery(partial: Partial<DeliveryRecord> & { skill: string; outcome: DeliveryRecord["outcome"]; http_status: number }): DeliveryRecord {
  return { id: "20260928T120000Z-aaaaaa", received_at: "2026-09-28T12:00:00.000Z", ip: "1.1.1.1", method: "POST", path: `/hooks/${partial.skill}`, query: {}, headers: {}, content_type: "application/json", bytes: 2, body_stored: false, duration_ms: 1, ...partial } as DeliveryRecord;
}

describe("stats helpers", () => {
  it("parses relative and absolute windows", () => {
    const now = Date.parse("2026-09-28T12:00:00.000Z");
    expect(parseSince("24h", now)).toBe("2026-09-27T12:00:00.000Z");
    expect(parseSince("7d", now)).toBe("2026-09-21T12:00:00.000Z");
    expect(parseSince("30m", now)).toBe("2026-09-28T11:30:00.000Z");
    expect(parseSince("2w", now)).toBe("2026-09-14T12:00:00.000Z");
    expect(parseSince("1.5h", now)).toBe("2026-09-28T10:30:00.000Z");
    expect(parseSince("2026-09-01T00:00:00Z", now)).toBe("2026-09-01T00:00:00.000Z");
    expect(parseSince(undefined)).toBeUndefined();
    expect(parseSince("yesterday")).toBeUndefined();
    expect(parseSince("-3h")).toBeUndefined();
    expect(parseSince("h")).toBeUndefined();
  });

  it("computes nearest-rank percentiles and reads token usage from both CLIs", () => {
    expect(percentiles([])).toBeNull();
    expect(percentiles([5])).toEqual({ count: 1, p50: 5, p95: 5, avg: 5, max: 5 });
    expect(percentiles([10, 1, 100, 50, 20])).toEqual({ count: 5, p50: 20, p95: 100, avg: 36, max: 100 });
    expect(percentiles(Array.from({ length: 100 }, (_, i) => i + 1))).toMatchObject({ p50: 50, p95: 95, max: 100 });
    expect(tokensOf({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7 })).toEqual({ input: 10, output: 5, cached_input: 7 });
    expect(tokensOf({ input_tokens: 12, cached_input_tokens: 3, output_tokens: 6 })).toEqual({ input: 12, output: 6, cached_input: 3 });
    expect(tokensOf(undefined)).toEqual({ input: 0, output: 0, cached_input: 0 });
  });
});

describe("computeStats", () => {
  const jobs = [
    job({ id: "j1", skill: "a", status: "succeeded", created_at: "2026-09-28T12:00:00.000Z", started_at: "2026-09-28T12:00:01.000Z", finished_at: "2026-09-28T12:00:11.000Z", duration_ms: 10_000, cost_usd: 0.5, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 }, outcome: "completed", response: { outcome: "completed", summary: "done" } }),
    job({ id: "j2", skill: "a", status: "succeeded", created_at: "2026-09-28T12:05:00.000Z", started_at: "2026-09-28T12:05:03.000Z", duration_ms: 30_000, cost_usd: 0.25, outcome: "needs_human", response: { outcome: "needs_human", summary: "?" } }),
    job({ id: "j3", skill: "b", status: "failed", runner: "codex", trigger: "api", created_at: "2026-09-28T12:10:00.000Z", started_at: "2026-09-28T12:10:00.500Z", duration_ms: 2_000, failure: { kind: "rate_limit", retryable: true }, usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 6 } }),
    job({ id: "j4", skill: "b", status: "running", trigger: "schedule", created_at: "2026-09-28T12:20:00.000Z", started_at: "2026-09-28T12:20:00.000Z", question: { id: "q", text: "?", asked_at: "2026-09-28T12:21:00.000Z" } }),
    job({ id: "j5", skill: "c", status: "queued", runner: "shell", trigger: "cli", created_at: "2026-09-28T12:30:00.000Z" }),
    job({ id: "j6", skill: "a", status: "timed_out", created_at: "2026-09-28T12:40:00.000Z", started_at: "2026-09-28T12:40:02.000Z", duration_ms: 900_000, failure: { kind: "timeout", retryable: false } }),
  ];
  const deliveries = [
    delivery({ id: "d1", skill: "a", outcome: "accepted", http_status: 202, job_id: "j1" }),
    delivery({ id: "d2", skill: "a", outcome: "rejected", http_status: 401, received_at: "2026-09-28T12:01:00.000Z" }),
    delivery({ id: "d3", skill: "b", outcome: "skipped", http_status: 200, received_at: "2026-09-28T12:02:00.000Z" }),
    delivery({ id: "d4", skill: "zzz", outcome: "rejected", http_status: 404, received_at: "2026-09-28T12:03:00.000Z" }),
  ];

  it("aggregates jobs and deliveries, overall and per skill", () => {
    const report = computeStats({ jobs, deliveries, since: "2026-09-28T00:00:00.000Z", now: new Date("2026-09-28T13:00:00.000Z") });
    expect(report.window).toEqual({ since: "2026-09-28T00:00:00.000Z", until: null, skill: null });
    expect(report.generated_at).toBe("2026-09-28T13:00:00.000Z");
    expect(report.jobs).toMatchObject({ total: 6, finished: 4, queued: 1, running: 1, success_rate: 0.5, completion_rate: 0.25, waiting_for_human: 2, cost_usd: 0.75, tokens: { input: 112, output: 26, cached_input: 53 } });
    expect(report.jobs.by_status).toMatchObject({ succeeded: 2, failed: 1, timed_out: 1, running: 1, queued: 1, cancelled: 0 });
    expect(report.jobs.by_outcome).toMatchObject({ completed: 1, needs_human: 1, failed: 2, unknown: 0 });
    expect(report.jobs.by_trigger).toMatchObject({ webhook: 3, api: 1, schedule: 1, cli: 1 });
    expect(report.jobs.by_runner).toEqual({ claude: 4, codex: 1, shell: 1 });
    expect(report.jobs.by_failure_kind).toMatchObject({ rate_limit: 1, timeout: 1, auth: 0 });
    expect(report.jobs.duration_ms).toEqual({ count: 4, p50: 10_000, p95: 900_000, avg: 235_500, max: 900_000 });
    expect(report.jobs.queue_wait_ms).toMatchObject({ count: 5, p50: 1000, max: 3000 });
    expect(report.deliveries).toEqual({ total: 4, by_outcome: { accepted: 1, duplicate: 0, in_flight: 0, skipped: 1, rejected: 2, challenge: 0, error: 0 }, by_http_status: { "202": 1, "401": 1, "200": 1, "404": 1 }, accepted_rate: 0.25, last_received_at: "2026-09-28T12:03:00.000Z" });
    expect(Object.keys(report.skills)).toEqual(["a", "b", "c", "zzz"]);
    expect(report.skills.a).toMatchObject({ jobs: 3, deliveries: 2, success_rate: 0.667, cost_usd: 0.75, last_job: { id: "j6", status: "timed_out", outcome: "failed" } });
    expect(report.skills.a?.duration_ms).toMatchObject({ count: 3, p50: 30_000 });
    expect(report.skills.zzz).toMatchObject({ jobs: 0, deliveries: 1, success_rate: null, last_job: null });
    const one = computeStats({ jobs, deliveries, skill: "b" });
    expect(one.window.skill).toBe("b");
    expect(one.jobs.total).toBe(2);
    expect(one.deliveries.total).toBe(1);
    expect(Object.keys(one.skills)).toEqual(["b"]);
    const text = formatStats(report);
    expect(text).toContain("jobs (since 2026-09-28T00:00:00.000Z): 6 total");
    expect(text).toContain("success 50%");
    expect(text).toContain("2 waiting for a person");
    expect(text).toContain("failures: rate_limit 1 · timeout 1");
    expect(text).toContain("duration: p50 10.0s · p95 15m · max 15m · queue wait p50 1.0s");
    expect(text).toContain("cost: $0.7500 · tokens in 112 / out 26 / cached 53");
    expect(text).toContain("deliveries: 4 total");
    expect(text).toContain("by skill:");
    expect(text).toContain("  a    3 job(s), 2 deliverie(s), success 67%");
    const empty = computeStats({ jobs: [], deliveries: [] });
    expect(empty.jobs).toMatchObject({ total: 0, success_rate: null, completion_rate: null, duration_ms: null, queue_wait_ms: null });
    expect(formatStats(empty)).toContain("jobs (all time): 0 total · none · success n/a");
  });

  it("collects from the store and the delivery log within a window", () => {
    const paths = tempHome("skillhook-stats-");
    const store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 60 });
    const log = new DeliveryLog(paths.jobsDir, () => ({ max: 100, store_bodies: false, body_max_bytes: 100 }));
    const event: WebhookEvent = { id: "", skill: "s", trigger: "webhook", received_at: new Date().toISOString(), method: "POST", path: "/hooks/s", query: {}, headers: {}, source_ip: "1.1.1.1", content_type: "application/json", content_length: 2, body_kind: "json", payload: {} };
    const src = { ip: "1.1.1.1", method: "POST", path: "/hooks/s", content_type: null };
    const old = store.create({ id: "20260901T000000Z-oldold", skill: "s", trigger: "webhook", runner: "claude", source: src, event });
    store.update(old.id, { status: "succeeded", outcome: "completed", duration_ms: 5 });
    const fresh = store.create({ skill: "s", trigger: "webhook", runner: "claude", source: src, event });
    store.update(fresh.id, { status: "failed", failure: { kind: "auth", retryable: false }, duration_ms: 7 });
    log.record({ skill: "s", received_at: "2026-09-01T00:00:00.000Z", outcome: "accepted", http_status: 202, job_id: old.id, ip: "1.1.1.1", method: "POST", path: "/hooks/s", query: {}, headers: {}, content_type: "application/json", bytes: 2, duration_ms: 1 });
    log.record({ skill: "s", received_at: new Date().toISOString(), outcome: "rejected", http_status: 401, ip: "1.1.1.1", method: "POST", path: "/hooks/s", query: {}, headers: {}, content_type: "application/json", bytes: 2, duration_ms: 1 });
    const all = collectStats(store, log);
    expect(all.jobs.total).toBe(2);
    expect(all.deliveries.total).toBe(2);
    const recent = collectStats(store, log, { since: parseSince("24h") });
    expect(recent.jobs.total).toBe(1);
    expect(recent.jobs.by_failure_kind.auth).toBe(1);
    expect(recent.deliveries).toMatchObject({ total: 1, by_outcome: { rejected: 1 } });
    expect(collectStats(store, undefined, { skill: "nope" }).jobs.total).toBe(0);
  });
});
