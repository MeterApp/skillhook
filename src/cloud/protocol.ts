// The wire protocol between a machine (`skillhook serve` with the cloud link) and Skillhook Cloud, as zod schemas.
// Pure: no `node:` imports, so `@meterapp/skillhook/protocol` can be imported by the cloud (Next.js, edge runtimes) to
// validate and type every message. The vocabulary skillhook itself uses (statuses, outcomes, triggers, …) is repeated
// here as literals; `src/cloud/protocol.test.ts` fails when the two drift. See docs/cloud-protocol.md.
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  /** Events per sync request. */
  max_events_per_sync: 200,
  /** Bytes per sync request body. */
  max_sync_bytes: 4 * 1024 * 1024,
  max_command_results: 50,
  max_commands: 50,
  /** Hosted-ingress deliveries per sync response. */
  max_ingress_items: 20,
  /** One hosted-ingress request body (what `POST /hooks/<skill>` accepts by default). */
  max_ingress_body_bytes: 1024 * 1024,
  /** A webhook payload uploaded with `delivery.received`. */
  max_payload_upload_bytes: 256 * 1024,
  /** A job result inlined in `job.finished` (the rest stays in the job directory). */
  max_result_inline_bytes: 8 * 1024,
  /** One artifact uploaded through `PUT /api/agent/artifacts/<job>/<name>`, in chunks. */
  max_artifact_bytes: 32 * 1024 * 1024,
  artifact_chunk_bytes: 1024 * 1024,
  max_watched_jobs: 5,
  /** How long the cloud may hold an idle sync request. */
  long_poll_seconds: 25,
  /** One `POST /api/agent/issues` body (a problem report from `skillhook cloud report`). */
  max_issue_report_bytes: 64 * 1024,
} as const;

// ---------------------------------------------------------------------------
// Vocabulary (kept in sync with skillhook by a test)
// ---------------------------------------------------------------------------

export const RUNNER_NAMES = ["claude", "codex", "shell"] as const;
export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "timed_out", "cancelled", "interrupted"] as const;
export const JOB_OUTCOMES = ["completed", "partial", "needs_human", "nothing_to_do", "failed", "unknown"] as const;
export const TRIGGERS = ["webhook", "cli", "mcp", "api", "schedule", "replay", "test", "resume"] as const;
export const DELIVERY_OUTCOMES = ["accepted", "duplicate", "in_flight", "skipped", "rejected", "challenge", "error"] as const;
export const FAILURE_KINDS = ["auth", "usage_limit", "rate_limit", "budget", "max_turns", "not_found", "timeout", "crash", "unknown"] as const;
export const CHECK_STATUSES = ["ok", "warn", "fail", "skip"] as const;
export const PROGRESS_STATES = ["working", "blocked", "waiting_human", "done"] as const;

export const MACHINE_MODES = ["observe", "control"] as const;
export type MachineMode = (typeof MACHINE_MODES)[number];
export const LINK_STATES = ["disabled", "connecting", "connected", "degraded", "disconnected"] as const;
export type LinkState = (typeof LINK_STATES)[number];
export const LINK_REASONS = ["token_missing", "token_revoked", "machine_disabled", "insecure_url", "upgrade_required", "network", "server_error", "protocol_error", "env_disabled"] as const;
export type LinkReason = (typeof LINK_REASONS)[number];

/** Event types a machine uploads (the `EventMap` of skillhook plus the link's own and `job.output`). */
export const CLOUD_EVENT_TYPES = [
  "link.started",
  "link.stopped",
  "delivery.received",
  "job.queued",
  "job.started",
  "job.updated",
  "job.finished",
  "job.cancelled",
  "job.progress",
  "job.waiting_human",
  "job.answered",
  "job.output",
  "schedule.registered",
  "schedule.fired",
  "schedule.skipped",
  "skill.changed",
  "config.changed",
  "health.changed",
  "health.report",
  "runners.changed",
] as const;
export type CloudEventType = (typeof CLOUD_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const COMMAND_TYPES = [
  "ping",
  "health.get",
  "snapshot.get",
  "runners.get",
  "skills.list",
  "skill.get",
  "skill.put",
  "skill.delete",
  "skill.run",
  "skill.test",
  "delivery.list",
  "delivery.get",
  "delivery.replay",
  "job.list",
  "job.get",
  "job.artifact",
  "job.watch",
  "job.unwatch",
  "job.cancel",
  "job.replay",
  "job.answer",
  "job.progress.get",
  "stats.get",
  "config.get",
  "config.patch",
  "secret.list",
  "secret.generate",
  "secret.set",
  "service.status",
  "service.restart",
  "logs.tail",
  "schedules.list",
  "schedule.run",
  "update.check",
  "update.install",
  "expose.status",
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

/** `read`: allowed in both modes. `control`: needs `cloud.mode: control` or an allow-list entry. `allow_list`: only with an explicit allow-list entry. */
export type CommandClass = "read" | "control" | "allow_list";
export const COMMAND_CLASS: Record<CommandType, CommandClass> = {
  ping: "read",
  "health.get": "read",
  "snapshot.get": "read",
  "runners.get": "read",
  "skills.list": "read",
  "skill.get": "read",
  "skill.put": "control",
  "skill.delete": "control",
  "skill.run": "control",
  "skill.test": "control",
  "delivery.list": "read",
  "delivery.get": "read",
  "delivery.replay": "control",
  "job.list": "read",
  "job.get": "read",
  "job.artifact": "read",
  "job.watch": "read",
  "job.unwatch": "read",
  "job.cancel": "control",
  "job.replay": "control",
  "job.answer": "control",
  "job.progress.get": "read",
  "stats.get": "read",
  "config.get": "read",
  "config.patch": "control",
  "secret.list": "read",
  "secret.generate": "control",
  "secret.set": "allow_list",
  "service.status": "read",
  "service.restart": "control",
  "logs.tail": "read",
  "schedules.list": "read",
  "schedule.run": "control",
  "update.check": "read",
  "update.install": "control",
  "expose.status": "read",
};

const name = z.string().min(1).max(64);
const id = z.string().min(1).max(200);
const iso = z.string().min(20).max(40);
const runner = z.enum(RUNNER_NAMES);
const runOverrides = { runner: runner.optional(), model: z.string().max(200).optional(), effort: z.string().max(50).optional() };
const listWindow = { since: z.string().max(40).optional(), after: id.optional(), limit: z.number().int().min(1).max(500).optional() };

/** What each command's `args` must look like (validated on the machine before anything runs). */
export const COMMAND_ARGS = {
  ping: z.object({}).strict(),
  "health.get": z.object({ deep: z.boolean().optional(), refresh: z.boolean().optional() }).strict(),
  "snapshot.get": z.object({}).strict(),
  "runners.get": z.object({ refresh: z.boolean().optional() }).strict(),
  "skills.list": z.object({}).strict(),
  "skill.get": z.object({ name }).strict(),
  "skill.put": z.object({ name, content: z.string().min(1).max(512 * 1024), allow_unauthenticated: z.boolean().optional() }).strict(),
  "skill.delete": z.object({ name }).strict(),
  "skill.run": z.object({ name, payload: z.unknown().optional(), headers: z.record(z.string(), z.string()).optional(), ...runOverrides }).strict(),
  "skill.test": z.object({ skill_md: z.string().min(1).max(512 * 1024), payload: z.unknown().optional(), headers: z.record(z.string(), z.string()).optional(), cwd: z.string().max(4096).optional(), ...runOverrides }).strict(),
  "delivery.list": z.object({ skill: name.optional(), outcome: z.enum(DELIVERY_OUTCOMES).optional(), ...listWindow }).strict(),
  "delivery.get": z.object({ id, include_body: z.boolean().optional() }).strict(),
  "delivery.replay": z.object({ id, skip_filters: z.boolean().optional(), force: z.boolean().optional(), ...runOverrides }).strict(),
  "job.list": z.object({ skill: name.optional(), status: z.enum(JOB_STATUSES).optional(), outcome: z.enum(JOB_OUTCOMES).optional(), failure: z.enum(FAILURE_KINDS).optional(), trigger: z.enum(TRIGGERS).optional(), waiting: z.boolean().optional(), ...listWindow }).strict(),
  "job.get": z.object({ id, include: z.array(z.enum(["stdout", "stderr", "prompt", "result", "payload", "event", "response"])).max(7).optional() }).strict(),
  "job.artifact": z.object({ id, name: z.enum(["stdout", "stderr", "prompt", "result", "payload", "event", "response"]), max_inline_bytes: z.number().int().min(0).max(LIMITS.max_artifact_bytes).optional() }).strict(),
  "job.watch": z.object({ id, ttl_s: z.number().int().min(10).max(3600).optional(), stream: z.enum(["stdout", "stderr"]).optional() }).strict(),
  "job.unwatch": z.object({ id }).strict(),
  "job.cancel": z.object({ id }).strict(),
  "job.replay": z.object({ id, skip_filters: z.boolean().optional(), ...runOverrides }).strict(),
  "job.answer": z.object({ id, answer: z.string().min(1).max(20_000), option: z.string().max(200).optional(), by: z.string().max(200).optional(), resume: z.enum(["auto", "never"]).optional() }).strict(),
  "job.progress.get": z.object({ id }).strict(),
  "stats.get": z.object({ since: z.string().max(40).optional(), until: z.string().max(40).optional(), skill: name.optional() }).strict(),
  "config.get": z.object({}).strict(),
  "config.patch": z.object({ set: z.record(z.string(), z.unknown()).optional(), unset: z.array(z.string().max(200)).max(100).optional() }).strict(),
  "secret.list": z.object({}).strict(),
  "secret.generate": z.object({ name: z.string().min(1).max(100), force: z.boolean().optional(), recipient_key: z.string().max(200).optional() }).strict(),
  "secret.set": z.object({ name: z.string().min(1).max(100), sealed: z.object({ recipient_key: z.string().max(200).optional(), ephemeral_public_key: z.string().min(1).max(200), nonce: z.string().min(1).max(64), ciphertext: z.string().min(1).max(64 * 1024) }).strict() }).strict(),
  "service.status": z.object({}).strict(),
  "service.restart": z.object({ when: z.enum(["idle", "now"]).optional(), wait_seconds: z.number().int().min(0).max(600).optional() }).strict(),
  "logs.tail": z.object({ lines: z.number().int().min(1).max(2000).optional() }).strict(),
  "schedules.list": z.object({}).strict(),
  "schedule.run": z.object({ name }).strict(),
  "update.check": z.object({}).strict(),
  "update.install": z.object({}).strict(),
  "expose.status": z.object({}).strict(),
} satisfies Record<CommandType, z.ZodType>;

export const COMMAND_ERROR_CODES = ["unsupported_command", "denied_by_policy", "invalid_args", "not_found", "conflict", "timeout", "expired", "duplicate", "too_large", "unavailable", "internal"] as const;
export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number];

export const CommandSchema = z
  .object({
    id,
    type: z.enum(COMMAND_TYPES),
    args: z.unknown().optional(),
    issued_at: iso,
    expires_at: iso.optional(),
    timeout_ms: z.number().int().positive().max(600_000).optional(),
    requested_by: z.object({ kind: z.enum(["user", "api_key", "oauth", "system"]), id: z.string().max(200).optional(), name: z.string().max(200).optional() }).strict().optional(),
  })
  .strict();
export type Command = z.infer<typeof CommandSchema>;

export const CommandErrorSchema = z.object({ code: z.enum(COMMAND_ERROR_CODES), message: z.string().max(4000), hint: z.string().max(2000).optional() }).strict();

/** A value only the requester can read: X25519 + HKDF-SHA256 + AES-256-GCM to `recipient_key` (see docs/cloud-protocol.md). */
export const SealedSchema = z.object({ recipient_key: z.string().min(1).max(200), ephemeral_public_key: z.string().min(1).max(200), nonce: z.string().min(1).max(64), ciphertext: z.string().min(1) }).strict();
export type Sealed = z.infer<typeof SealedSchema>;

export const CommandResultSchema = z
  .object({
    command_id: id,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: CommandErrorSchema.optional(),
    /** The result must not be persisted in the clear by the cloud (a generated secret). */
    sensitive: z.boolean().optional(),
    sealed: SealedSchema.optional(),
    started_at: iso,
    finished_at: iso,
    duration_ms: z.number().int().min(0),
  })
  .strict();
export type CommandResult = z.infer<typeof CommandResultSchema>;

// ---------------------------------------------------------------------------
// Machine, status, snapshot
// ---------------------------------------------------------------------------

export const MachineInfoSchema = z
  .object({
    id,
    hostname: z.string().max(255),
    os: z.string().max(64),
    arch: z.string().max(32),
    skillhook_version: z.string().max(64),
    node_version: z.string().max(64),
    started_at: iso,
    public_url: z.string().url().max(2048).optional(),
  })
  .strict();
export type MachineInfo = z.infer<typeof MachineInfoSchema>;

export const LinkStatusSchema = z
  .object({
    state: z.enum(LINK_STATES),
    reason: z.enum(LINK_REASONS).optional(),
    mode: z.enum(MACHINE_MODES),
    outbox_depth: z.number().int().min(0),
    dropped_total: z.number().int().min(0),
    watched_jobs: z.number().int().min(0),
  })
  .strict();
export type LinkStatus = z.infer<typeof LinkStatusSchema>;

export const StatusSchema = z
  .object({
    queue: z.object({ running: z.number().int().min(0), queued: z.number().int().min(0) }).strict(),
    running_jobs: z.array(id).max(1000),
    link: LinkStatusSchema,
  })
  .strict();
export type Status = z.infer<typeof StatusSchema>;

const summary = z.object({ ok: z.number().int().min(0), warn: z.number().int().min(0), fail: z.number().int().min(0), skip: z.number().int().min(0) }).strict();

/** Records the cloud stores as JSON keep unknown fields (a newer machine may say more): `.loose()`. */
export const SkillSummarySchema = z.object({ name, description: z.string().optional(), enabled: z.boolean(), runner, source: z.object({ type: z.string() }).loose() }).loose();

export const SnapshotSchema = z
  .object({
    server: z.object({ started_at: iso, version: z.string(), host: z.string(), port: z.number().int(), public_url: z.string().optional() }).loose().optional(),
    skills: z.array(SkillSummarySchema).max(1000),
    skill_errors: z.array(z.object({ name: z.string(), error: z.string() }).loose()).max(1000),
    projects: z.array(z.object({ dir: z.string(), file: z.string().optional(), hooks: z.array(z.string()) }).loose()).max(200),
    schedules: z.array(z.object({ skill: name }).loose()).max(1000),
    /** The effective config with secrets never present (they live in `.env`), redacted of nothing else. */
    config: z.record(z.string(), z.unknown()),
    health: z.object({ ok: z.boolean(), summary, generated_at: iso, deep: z.boolean() }).loose().optional(),
    runners: z.array(z.object({ runner, ready: z.boolean() }).loose()).max(3).optional(),
    stats: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const EventEnvelopeSchema = z
  .object({
    /** `<machine_id>:<seq>` (durable events) or a random id (transient `job.output`). */
    id: z.string().min(1).max(300),
    /** Per-machine, increasing by one per durable event; null for transient events. */
    seq: z.number().int().min(1).nullable(),
    ts: iso,
    machine_id: id,
    type: z.enum(CLOUD_EVENT_TYPES),
    data: z.unknown(),
  })
  .strict();
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Hosted ingress
// ---------------------------------------------------------------------------

export const IngressItemSchema = z
  .object({
    id,
    skill: name,
    received_at: iso,
    method: z.enum(["POST", "PUT"]),
    path: z.string().max(200),
    query: z.record(z.string(), z.string()),
    /** Raw request headers (the machine verifies signatures with its own secret). */
    headers: z.record(z.string(), z.string()),
    body_base64: z.string().max(Math.ceil((LIMITS.max_ingress_body_bytes * 4) / 3) + 4),
    content_type: z.string().max(200).nullable(),
    source_ip: z.string().max(64),
  })
  .strict();
export type IngressItem = z.infer<typeof IngressItemSchema>;

export const IngressAckSchema = z
  .object({
    id,
    outcome: z.enum(DELIVERY_OUTCOMES),
    http_status: z.number().int().min(100).max(599),
    job_id: id.optional(),
    code: z.string().max(100).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type IngressAck = z.infer<typeof IngressAckSchema>;

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export const SyncRequestSchema = z
  .object({
    protocol_version: z.literal(PROTOCOL_VERSION),
    /** The machine's clock; the cloud derives skew from it. */
    sent_at: iso,
    /** Nothing pending: the cloud may hold the request up to `LIMITS.long_poll_seconds`. */
    wait: z.boolean(),
    machine: MachineInfoSchema,
    status: StatusSchema,
    /** On connect and every `cloud.snapshot_interval_seconds`. */
    snapshot: SnapshotSchema.optional(),
    events: z.array(EventEnvelopeSchema).max(LIMITS.max_events_per_sync),
    command_results: z.array(CommandResultSchema).max(LIMITS.max_command_results),
    ingress_acks: z.array(IngressAckSchema).max(LIMITS.max_ingress_items * 5),
    ack: z.object({ commands_received: z.array(id).max(500) }).strict(),
  })
  .strict();
export type SyncRequest = z.infer<typeof SyncRequestSchema>;

/** Hints only ever make the machine do less, or tell it where its hosted URLs are. */
export const HintsSchema = z
  .object({
    snapshot_interval_s: z.number().int().min(10).max(86_400).optional(),
    health_interval_s: z.number().int().min(60).max(86_400).optional(),
    upload_payloads: z.literal(false).optional(),
    upload_artifacts: z.literal(false).optional(),
    max_event_bytes: z.number().int().min(1024).optional(),
    max_batch_events: z.number().int().min(1).max(LIMITS.max_events_per_sync).optional(),
    /** `interactive`: someone is watching, poll fast; `idle`: `next_poll_ms` is the pace, no long-poll. */
    mode: z.enum(["interactive", "idle"]).optional(),
    /** Per skill, the hosted webhook URL the cloud serves for it. */
    ingress_urls: z.record(z.string(), z.string().url()).optional(),
  })
  .strict();
export type Hints = z.infer<typeof HintsSchema>;

export const SyncResponseSchema = z
  .object({
    ok: z.literal(true),
    protocol_version: z.number().int().min(1),
    min_protocol_version: z.number().int().min(1),
    server_time: iso,
    ack: z.object({ events_through: z.number().int().min(0), command_results: z.array(id).max(LIMITS.max_command_results) }).strict(),
    commands: z.array(CommandSchema).max(LIMITS.max_commands),
    ingress: z.array(IngressItemSchema).max(LIMITS.max_ingress_items),
    next_poll_ms: z.number().int().min(0).max(3_600_000),
    hints: HintsSchema.optional(),
    /** A new machine token; the old one stays valid until `old_valid_until`. */
    rotate: z.object({ token: z.string().min(16), old_valid_until: iso }).strict().optional(),
    /** A line for the server log (a deprecation, an incident). */
    notice: z.string().max(2000).optional(),
  })
  .strict();
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

export const SYNC_ERROR_CODES = ["invalid_token", "machine_disabled", "upgrade_required", "rate_limited", "payload_too_large", "invalid_request", "server_error"] as const;
export const SyncErrorSchema = z
  .object({
    ok: z.literal(false),
    error: z.enum(SYNC_ERROR_CODES),
    message: z.string().max(2000).optional(),
    retry_after_ms: z.number().int().min(0).optional(),
    min_protocol_version: z.number().int().min(1).optional(),
  })
  .strict();
export type SyncError = z.infer<typeof SyncErrorSchema>;

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export const PAIRING_CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

export const PairRequestSchema = z
  .object({
    protocol_version: z.literal(PROTOCOL_VERSION),
    /** A code from the dashboard's pairing page (10 minutes, one use), or a machine token issued there. */
    code: z.string().regex(PAIRING_CODE_RE).optional(),
    token: z.string().min(16).max(500).optional(),
    machine: MachineInfoSchema.omit({ id: true }).extend({ previous_machine_id: id.optional() }).strict(),
    requested_mode: z.enum(MACHINE_MODES),
    /** The machine's X25519 public key (base64url), for sealed values. */
    public_key: z.string().max(200).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.code) !== Boolean(v.token), { message: "exactly one of code or token" });
export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairResponseSchema = z
  .object({
    ok: z.literal(true),
    machine_id: id,
    /** Shown once; the machine stores it in `.env` as SKILLHOOK_CLOUD_TOKEN. */
    machine_token: z.string().min(16).max(500),
    mode: z.enum(MACHINE_MODES),
    account: z.object({ org: z.string().max(200), org_slug: z.string().max(200).optional(), user: z.string().max(320).optional() }).loose(),
    dashboard_url: z.string().url().max(2048),
    protocol_version: z.number().int().min(1),
    min_protocol_version: z.number().int().min(1),
  })
  .strict();
export type PairResponse = z.infer<typeof PairResponseSchema>;

// ---------------------------------------------------------------------------
// Issue reports
// ---------------------------------------------------------------------------

export const ISSUE_KINDS = ["bug", "question", "feature", "other"] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];
export const ISSUE_SEVERITIES = ["low", "normal", "high", "urgent"] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

/** Facts the machine already has, attached to a report unless the person says no; scrubbed of every `.env` value. Never payloads, logs, prompts or job output. */
export const IssueDiagnosticsSchema = z
  .object({
    skillhook_version: z.string().max(64).optional(),
    node_version: z.string().max(64).optional(),
    os: z.string().max(64).optional(),
    arch: z.string().max(32).optional(),
    mode: z.enum(MACHINE_MODES).optional(),
    link: z.object({ state: z.enum(LINK_STATES), reason: z.enum(LINK_REASONS).optional(), last_error: z.string().max(500).optional() }).loose().optional(),
    runners: z.array(z.object({ runner, ready: z.boolean() }).loose()).max(3).optional(),
    /** The health summary and the checks that fail or warn (`id` is the check's name, `message` its detail). */
    health: z.object({ ok: z.boolean(), summary, failing: z.array(z.object({ id: z.string().max(200), status: z.enum(CHECK_STATUSES), message: z.string().max(500).optional() }).loose()).max(50).optional() }).loose().optional(),
  })
  .loose();
export type IssueDiagnostics = z.infer<typeof IssueDiagnosticsSchema>;

/** `POST /api/agent/issues` with the machine token: a person on a paired machine reports a problem to the Skillhook team. */
export const IssueReportRequestSchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().max(20_000).optional(),
    /** The cloud files a report without one as `bug`. */
    kind: z.enum(ISSUE_KINDS).optional(),
    /** The cloud files a report without one as `normal`. */
    severity: z.enum(ISSUE_SEVERITIES).optional(),
    contact_email: z.string().email().max(320).optional(),
    /** The machine's own job id. */
    job_id: id.optional(),
    delivery_id: id.optional(),
    skill: name.optional(),
    diagnostics: IssueDiagnosticsSchema.optional(),
    /** A client-generated idempotency key; a retry with the same report_id returns the original report instead of filing a second one. */
    report_id: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/).optional(),
  })
  .strict();
export type IssueReportRequest = z.infer<typeof IssueReportRequestSchema>;

/** The same answer for a new report and for a retry of one (the same `report_id`). */
export const IssueReportResponseSchema = z
  .object({
    ok: z.literal(true),
    issue_id: id,
    number: z.number().int().min(1),
    url: z.string().url().max(2048),
    /** A confirmation email went out. */
    acknowledged: z.boolean(),
  })
  .strict();
export type IssueReportResponse = z.infer<typeof IssueReportResponseSchema>;

/** Parses `args` for a command type; `undefined` for an unknown type. */
export function parseCommandArgs(type: string, args: unknown): { ok: true; args: unknown } | { ok: false; message: string } | undefined {
  const schema = (COMMAND_ARGS as Record<string, z.ZodType>)[type];
  if (!schema) return undefined;
  const result = schema.safeParse(args ?? {});
  return result.success ? { ok: true, args: result.data } : { ok: false, message: z.prettifyError(result.error) };
}
