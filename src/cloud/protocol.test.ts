import { describe, expect, it } from "vitest";
import { DELIVERY_OUTCOMES } from "../delivery-log.js";
import { EVENT_TYPES } from "../events.js";
import { HEALTH_GROUPS } from "../health.js";
import { JOB_STATUSES } from "../jobs.js";
import { TRIGGERS } from "../payload.js";
import { PROGRESS_STATES } from "../progress.js";
import { RUNNER_NAMES } from "../readiness.js";
import { JOB_OUTCOMES } from "../response.js";
import { FAILURE_KINDS } from "../runners/failure.js";
import * as protocol from "./protocol.js";
import { CLOUD_EVENT_TYPES, COMMAND_ARGS, COMMAND_CLASS, COMMAND_TYPES, CommandResultSchema, EventEnvelopeSchema, IngressItemSchema, LIMITS, PAIRING_CODE_RE, PairRequestSchema, PairResponseSchema, parseCommandArgs, PROTOCOL_VERSION, SyncErrorSchema, SyncRequestSchema, SyncResponseSchema } from "./protocol.js";

const machine = { id: "m_1", hostname: "mac.local", os: "darwin", arch: "arm64", skillhook_version: "0.5.0", node_version: "22.0.0", started_at: "2026-09-28T12:00:00.000Z" };
const status = { queue: { running: 1, queued: 0 }, running_jobs: ["20260928T120000Z-abcdef"], link: { state: "connected" as const, mode: "observe" as const, outbox_depth: 0, dropped_total: 0, watched_jobs: 0 } };

describe("protocol vocabulary", () => {
  it("matches what skillhook itself uses", () => {
    expect([...protocol.RUNNER_NAMES]).toEqual(RUNNER_NAMES);
    expect([...protocol.JOB_STATUSES]).toEqual(JOB_STATUSES);
    expect([...protocol.JOB_OUTCOMES]).toEqual(JOB_OUTCOMES);
    expect([...protocol.TRIGGERS]).toEqual(TRIGGERS);
    expect([...protocol.DELIVERY_OUTCOMES]).toEqual(DELIVERY_OUTCOMES);
    expect([...protocol.FAILURE_KINDS]).toEqual(FAILURE_KINDS);
    expect([...protocol.PROGRESS_STATES]).toEqual(PROGRESS_STATES);
    expect([...protocol.CHECK_STATUSES]).toEqual(["ok", "warn", "fail", "skip"]);
    expect(HEALTH_GROUPS.length).toBeGreaterThan(0);
    // Every server event has a cloud counterpart (plus the link's own and job.output); server.* stays local.
    for (const type of EVENT_TYPES) if (!type.startsWith("server.")) expect(CLOUD_EVENT_TYPES).toContain(type);
    expect(CLOUD_EVENT_TYPES).toContain("link.started");
    expect(CLOUD_EVENT_TYPES).toContain("job.output");
    expect(Object.keys(COMMAND_ARGS).sort()).toEqual([...COMMAND_TYPES].sort());
    expect(Object.keys(COMMAND_CLASS).sort()).toEqual([...COMMAND_TYPES].sort());
    expect(PROTOCOL_VERSION).toBe(1);
    expect(LIMITS.max_events_per_sync).toBe(200);
  });

  it("validates command arguments per type", () => {
    expect(parseCommandArgs("ping", undefined)).toEqual({ ok: true, args: {} });
    expect(parseCommandArgs("job.answer", { id: "j1", answer: "yes", option: "A" })).toMatchObject({ ok: true });
    expect(parseCommandArgs("job.answer", { id: "j1" })).toMatchObject({ ok: false, message: expect.stringContaining("answer") });
    expect(parseCommandArgs("skill.run", { name: "hello", payload: { a: 1 }, model: "sonnet" })).toMatchObject({ ok: true });
    expect(parseCommandArgs("skill.run", { name: "hello", runner: "gemini" })).toMatchObject({ ok: false });
    expect(parseCommandArgs("config.patch", { set: { concurrency: 3 }, extra: 1 })).toMatchObject({ ok: false });
    expect(parseCommandArgs("nope", {})).toBeUndefined();
  });
});

describe("protocol messages", () => {
  it("round-trips a sync request and response", () => {
    const request = SyncRequestSchema.parse({
      protocol_version: 1,
      sent_at: "2026-09-28T12:00:00.000Z",
      wait: true,
      machine,
      status,
      events: [{ id: "m_1:7", seq: 7, ts: "2026-09-28T12:00:00.000Z", machine_id: "m_1", type: "job.finished", data: { job: { id: "x" } } }],
      command_results: [{ command_id: "c1", ok: true, result: { pong: true }, started_at: "2026-09-28T12:00:00.000Z", finished_at: "2026-09-28T12:00:00.100Z", duration_ms: 100 }],
      ingress_acks: [{ id: "i1", outcome: "accepted", http_status: 202, job_id: "20260928T120000Z-abcdef" }],
      ack: { commands_received: ["c1"] },
    });
    expect(request.events[0]?.type).toBe("job.finished");
    expect(() => SyncRequestSchema.parse({ ...request, protocol_version: 2 })).toThrow();
    expect(() => SyncRequestSchema.parse({ ...request, extra: true })).toThrow();
    expect(() => EventEnvelopeSchema.parse({ id: "x", seq: 0, ts: "2026-09-28T12:00:00.000Z", machine_id: "m", type: "job.finished", data: {} })).toThrow();
    expect(EventEnvelopeSchema.parse({ id: "rnd", seq: null, ts: "2026-09-28T12:00:00.000Z", machine_id: "m", type: "job.output", data: { chunk: "x" } }).seq).toBeNull();
    const response = SyncResponseSchema.parse({
      ok: true,
      protocol_version: 1,
      min_protocol_version: 1,
      server_time: "2026-09-28T12:00:01.000Z",
      ack: { events_through: 7, command_results: ["c1"] },
      commands: [{ id: "c2", type: "job.answer", args: { id: "j", answer: "yes" }, issued_at: "2026-09-28T12:00:00.000Z", requested_by: { kind: "user", name: "ada" } }],
      ingress: [{ id: "i2", skill: "hello", received_at: "2026-09-28T12:00:00.000Z", method: "POST", path: "/hooks/hello", query: {}, headers: { "x-hub-signature-256": "sha256=…" }, body_base64: "e30=", content_type: "application/json", source_ip: "203.0.113.5" }],
      next_poll_ms: 0,
      hints: { mode: "interactive", upload_payloads: false, ingress_urls: { hello: "https://hooks.example/i/abc" } },
    });
    expect(response.commands[0]?.type).toBe("job.answer");
    expect(() => SyncResponseSchema.parse({ ...response, hints: { upload_payloads: true } })).toThrow(); // hints only reduce
    expect(() => SyncResponseSchema.parse({ ...response, commands: [{ id: "c3", type: "rm.rf", issued_at: "2026-09-28T12:00:00.000Z" }] })).toThrow();
    expect(SyncErrorSchema.parse({ ok: false, error: "upgrade_required", min_protocol_version: 2 }).error).toBe("upgrade_required");
    expect(IngressItemSchema.safeParse({ id: "i", skill: "hello", received_at: "2026-09-28T12:00:00.000Z", method: "GET", path: "/", query: {}, headers: {}, body_base64: "", content_type: null, source_ip: "1.1.1.1" }).success).toBe(false);
    expect(CommandResultSchema.parse({ command_id: "c", ok: false, error: { code: "denied_by_policy", message: "no" }, started_at: "2026-09-28T12:00:00.000Z", finished_at: "2026-09-28T12:00:00.000Z", duration_ms: 0 }).error?.code).toBe("denied_by_policy");
  });

  it("pairs with a code or a token, never both", () => {
    const base = { protocol_version: 1, machine: { hostname: "mac", os: "darwin", arch: "arm64", skillhook_version: "0.5.0", node_version: "22", started_at: "2026-09-28T12:00:00.000Z" }, requested_mode: "control" as const };
    expect(PairRequestSchema.parse({ ...base, code: "ABCD-2345" }).code).toBe("ABCD-2345");
    expect(PairRequestSchema.parse({ ...base, token: "t".repeat(32) }).token).toHaveLength(32);
    expect(PairRequestSchema.safeParse({ ...base, code: "ABCD-2345", token: "t".repeat(32) }).success).toBe(false);
    expect(PairRequestSchema.safeParse({ ...base }).success).toBe(false);
    expect(PairRequestSchema.safeParse({ ...base, code: "abcd-2345" }).success).toBe(false);
    expect(PAIRING_CODE_RE.test("ABCD-0123")).toBe(false); // no 0/1/I/O
    const response = PairResponseSchema.parse({ ok: true, machine_id: "m_9", machine_token: "x".repeat(40), mode: "control", account: { org: "Meter", plan: "free" }, dashboard_url: "https://cloud.example/o/meter", protocol_version: 1, min_protocol_version: 1 });
    expect(response.account).toMatchObject({ org: "Meter", plan: "free" });
  });
});
