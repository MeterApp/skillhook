import { describe, expect, it } from "vitest";
import { DELIVERY_OUTCOMES } from "../delivery-log.js";
import { EVENT_TYPES } from "../events.js";
import { HEALTH_GROUPS } from "../health.js";
import { JOB_STATUSES } from "../jobs.js";
import { TRIGGERS } from "../payload.js";
import { PROGRESS_STATES } from "../progress.js";
import { RUNNER_NAMES } from "../readiness.js";
import { HEADLINE_MAX, LINK_KINDS, LINKS_MAX, OPTION_MAX, OPTIONS_MAX, TITLE_MAX } from "../reporting.js";
import { JOB_OUTCOMES } from "../response.js";
import { FAILURE_KINDS } from "../runners/failure.js";
import * as protocol from "./protocol.js";
import { CLOUD_EVENT_TYPES, COMMAND_ARGS, COMMAND_CLASS, COMMAND_TYPES, CommandResultSchema, EventEnvelopeSchema, IngressItemSchema, IssueDiagnosticsSchema, IssueReportRequestSchema, IssueReportResponseSchema, LIMITS, PAIRING_CODE_RE, PairRequestSchema, PairResponseSchema, parseCommandArgs, PROTOCOL_VERSION, SyncErrorSchema, SyncRequestSchema, SyncResponseSchema } from "./protocol.js";

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
    expect([...protocol.LINK_KINDS]).toEqual(LINK_KINDS);
    expect(protocol.REPORT_LIMITS).toEqual({ max_links: LINKS_MAX, max_title: TITLE_MAX, max_headline: HEADLINE_MAX, max_options: OPTIONS_MAX, max_option: OPTION_MAX });
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
    // Issue reports are additive: new vocabulary and a limit, the version stays 1.
    expect([...protocol.ISSUE_KINDS]).toEqual(["bug", "question", "feature", "other"]);
    expect([...protocol.ISSUE_SEVERITIES]).toEqual(["low", "normal", "high", "urgent"]);
    expect(LIMITS.max_issue_report_bytes).toBe(64 * 1024);
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

  it("carries an issue report within its limits", () => {
    const diagnostics = {
      skillhook_version: "0.6.0",
      node_version: "22.12.0",
      os: "darwin",
      arch: "arm64",
      mode: "observe",
      link: { state: "degraded", reason: "network", last_error: "fetch failed" },
      runners: [
        { runner: "claude", ready: true },
        { runner: "codex", ready: false },
      ],
      health: { ok: false, summary: { ok: 9, warn: 1, fail: 1, skip: 3 }, failing: [{ id: "claude", status: "fail", message: "not logged in" }, { id: "server", status: "warn" }] },
    };
    const report = { title: "Deliveries fail since the update", body: "Every GitHub delivery gets 401.", kind: "bug", severity: "high", contact_email: "ada@example.com", job_id: "20260929T101500Z-a1b2c3", delivery_id: "d_1", skill: "triage", diagnostics, report_id: "5f0c2b1e-8d4a-4c3e-9b7a-2e1d0c9b8a76" };
    expect(IssueReportRequestSchema.parse(report)).toEqual(report);
    expect(IssueReportRequestSchema.parse({ title: "Only a title" })).toEqual({ title: "Only a title" }); // kind and severity default on the cloud
    // Diagnostics keep what a newer machine adds; the request itself is strict.
    expect(IssueDiagnosticsSchema.parse({ ...diagnostics, uptime_seconds: 60, link: { ...diagnostics.link, since: "x" } })).toMatchObject({ uptime_seconds: 60, link: { since: "x" } });
    expect(IssueDiagnosticsSchema.parse({})).toEqual({});
    const invalid: [string, unknown][] = [
      ["empty title", { title: "" }],
      ["long title", { title: "t".repeat(201) }],
      ["long body", { title: "t", body: "b".repeat(20_001) }],
      ["unknown kind", { title: "t", kind: "complaint" }],
      ["unknown severity", { title: "t", severity: "critical" }],
      ["not an email", { title: "t", contact_email: "ada at example" }],
      ["long email", { title: "t", contact_email: `${"a".repeat(310)}@example.com` }],
      ["long skill name", { title: "t", skill: "s".repeat(65) }],
      ["empty job id", { title: "t", job_id: "" }],
      ["unknown field", { title: "t", payload: { a: 1 } }],
      ["short report id", { title: "t", report_id: "abc1234" }],
      ["long report id", { title: "t", report_id: "r".repeat(101) }],
      ["report id with other characters", { title: "t", report_id: "report id/1" }],
      ["unknown link state", { title: "t", diagnostics: { link: { state: "online" } } }],
      ["long link error", { title: "t", diagnostics: { link: { state: "degraded", last_error: "e".repeat(501) } } }],
      ["unknown runner", { title: "t", diagnostics: { runners: [{ runner: "gemini", ready: true }] } }],
      ["four runners", { title: "t", diagnostics: { runners: [...diagnostics.runners, ...diagnostics.runners] } }],
      ["summary with extra counts", { title: "t", diagnostics: { health: { ok: true, summary: { ok: 1, warn: 0, fail: 0, skip: 0, info: 1 } } } }],
      ["51 failing checks", { title: "t", diagnostics: { health: { ok: false, summary: { ok: 0, warn: 51, fail: 0, skip: 0 }, failing: Array.from({ length: 51 }, (_, i) => ({ id: `c${i}`, status: "warn" })) } } }],
      ["long check message", { title: "t", diagnostics: { health: { ok: false, summary: { ok: 0, warn: 1, fail: 0, skip: 0 }, failing: [{ id: "c", status: "warn", message: "m".repeat(501) }] } } }],
      ["long check id", { title: "t", diagnostics: { health: { ok: false, summary: { ok: 0, warn: 1, fail: 0, skip: 0 }, failing: [{ id: "c".repeat(201), status: "warn" }] } } }],
      ["long version", { title: "t", diagnostics: { skillhook_version: "v".repeat(65) } }],
      ["long arch", { title: "t", diagnostics: { arch: "a".repeat(33) } }],
    ];
    for (const [what, value] of invalid) expect(IssueReportRequestSchema.safeParse(value).success, what).toBe(false);
    const answer = { ok: true, issue_id: "iss_42", number: 42, url: "https://cloud.example/o/meter/issues/42", acknowledged: true };
    expect(IssueReportResponseSchema.parse(answer)).toEqual(answer);
    expect(IssueReportResponseSchema.safeParse({ ...answer, number: 0 }).success).toBe(false);
    expect(IssueReportResponseSchema.safeParse({ ...answer, url: "not a url" }).success).toBe(false);
    expect(IssueReportResponseSchema.safeParse({ ...answer, acknowledged: undefined }).success).toBe(false);
    expect(IssueReportResponseSchema.safeParse({ ...answer, ok: false }).success).toBe(false);
    expect(IssueReportResponseSchema.safeParse({ ...answer, extra: 1 }).success).toBe(false);
    // Errors have the agent API's shape.
    expect(SyncErrorSchema.parse({ ok: false, error: "rate_limited", message: "at most 10 reports an hour", retry_after_ms: 90_000 }).retry_after_ms).toBe(90_000);
  });
});
