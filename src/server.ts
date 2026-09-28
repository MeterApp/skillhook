import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { closeSync, openSync, readSync, statSync, unlinkSync } from "node:fs";
import { parseAuthorizationScheme, safeEqual, verifyRequest, type InboundRequest } from "./auth.js";
import type { Config } from "./config.js";
import { DELIVERY_OUTCOMES, readDeliveryBody, type DeliveryLog, type DeliveryOutcome } from "./delivery-log.js";
import { ADMIN_TOKEN_ENV, type Secrets } from "./env.js";
import { EVENT_TYPES, type Events } from "./events.js";
import { describeCondition, evaluateConditions } from "./filters.js";
import { newJobId } from "./ids.js";
import { isTerminal, JOB_ARTIFACTS, JOB_STATUSES, type JobArtifact, type JobRecord, type JobStatus, type JobStore } from "./jobs.js";
import type { Logger } from "./logger.js";
import { createManualJob } from "./manual.js";
import { deliveryFingerprint, parseBody, redactHeaders, TRIGGERS, type BodyKind, type Trigger, type WebhookEvent } from "./payload.js";
import { planReplay, ReplayError, replayOfFor, type ReplayPlan } from "./replay.js";
import { JOB_OUTCOMES, type JobOutcome } from "./response.js";
import type { JobQueue } from "./queue.js";
import { resolveRunSettings } from "./run.js";
import { RunnerNameSchema } from "./config.js";
import type { SkillRegistry } from "./registry.js";
import { nextRun } from "./schedule.js";
import type { ScheduleStatus } from "./scheduler.js";
import { describeAuth, SkillError, type Skill } from "./skills.js";
import { errorMessage, getPath, isPlainObject, isValidSkillName, nowIso, writeJsonFile } from "./util.js";
import { VERSION } from "./version.js";
import type { Paths } from "./paths.js";
import type { RunnerName } from "./config.js";

export interface ServerDeps {
  config: Config;
  paths: Paths;
  store: JobStore;
  queue: JobQueue;
  registry: SkillRegistry;
  secrets: () => Secrets;
  logger: Logger;
  /** Live schedule state for `/health` (admin); absent when the server runs without a scheduler. */
  schedules?: () => ScheduleStatus[];
  /** The process-wide event bus: `GET /events` streams it and `GET /jobs/<id>/events` follows one job on it. */
  events?: Events;
  /** Where every `/hooks/<skill>` request is recorded; `GET /deliveries` reads it. Absent: nothing is recorded. */
  deliveryLog?: DeliveryLog;
}

export interface ServerState {
  pid: number;
  host: string;
  port: number;
  started_at: string;
  version: string;
  public_url?: string;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Fixed-window counter per key; good enough to blunt brute force and accidental floods. */
export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}
  hit(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.buckets.size > 10_000) for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
      return true;
    }
    bucket.count++;
    return bucket.count <= this.limit;
  }
}

function lowerHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.");
}

/** Any of these means a proxy (Tailscale, cloudflared, ngrok, nginx) relayed the request, so it is not a local caller. */
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "forwarded", "via", "tailscale-user-login", "ngrok-trace-id"];

function clientIp(req: IncomingMessage, headers: Record<string, string>, trustProxy: boolean): { ip: string; viaProxy: boolean } {
  const remote = req.socket.remoteAddress ?? "unknown";
  const viaProxy = PROXY_HEADERS.some((name) => headers[name] !== undefined);
  const forwarded = headers["x-forwarded-for"] ?? headers["x-real-ip"] ?? headers["cf-connecting-ip"];
  if (trustProxy && isLoopback(remote) && forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return { ip: first, viaProxy: true };
  }
  return { ip: remote, viaProxy };
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > maxBytes) return reject(new HttpError(413, "payload_too_large", `body exceeds ${maxBytes} bytes`));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, "payload_too_large", `body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Reads the body of a request that was refused before its body was needed (an unknown skill), so the delivery log can
 * still keep it for replay. Gives up quietly on chunked or oversized bodies and after `timeoutMs`.
 */
function drainBody(req: IncomingMessage, maxBytes: number, timeoutMs = 2_000): Promise<Buffer | undefined> {
  if (req.readableEnded || req.destroyed) return Promise.resolve(undefined);
  const declared = Number(req.headers["content-length"]);
  if (!Number.isFinite(declared) || declared <= 0 || declared > maxBytes) return Promise.resolve(undefined);
  return Promise.race([readBody(req, maxBytes).catch(() => undefined), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs).unref())]);
}

/** `?limit=` for list routes: a positive integer, `fallback` when absent or invalid, never above `cap`. */
function pageLimit(url: URL, fallback = 50, cap = 500): number {
  const raw = Number(url.searchParams.get("limit") ?? fallback);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
  return Math.min(limit, cap);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(text);
}

/** How often `GET /jobs/<id>/events` looks for new output and a finished job. */
const STREAM_POLL_MS = 250;
/** A stream of a job that already produced more than this starts at the tail. */
const STREAM_TAIL_MAX = 512 * 1024;
const SSE_HEARTBEAT_MS = 15_000;

interface EventStream {
  send(message: { id?: string; event?: string; data: unknown }): void;
  /** Runs when the client goes away or `close()` is called. */
  onClose(fn: () => void): void;
  close(): void;
  readonly closed: boolean;
}

/** Starts a `text/event-stream` response: headers now, one `data:` block per message, a comment every 15 s to keep proxies awake. */
function openEventStream(req: IncomingMessage, res: ServerResponse): EventStream {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-accel-buffering": "no" });
  res.flushHeaders();
  res.write(": connected\n\n");
  let closed = false;
  const cleanups: (() => void)[] = [];
  const heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* cleanup must not throw */
      }
    }
    res.end();
  };
  res.on("close", close);
  req.on("error", close);
  return {
    send(message) {
      if (closed) return;
      let text = "";
      if (message.id !== undefined) text += `id: ${message.id}\n`;
      if (message.event) text += `event: ${message.event}\n`;
      text += `data: ${JSON.stringify(message.data)}\n\n`;
      res.write(text);
    },
    onClose(fn) {
      if (closed) fn();
      else cleanups.push(fn);
    },
    close,
    get closed() {
      return closed;
    },
  };
}

/** `length` bytes of `file` from `offset`, as text. */
function readFrom(file: string, offset: number, length: number): string {
  if (length <= 0) return "";
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function fileSize(file: string): number | undefined {
  try {
    return statSync(file).size;
  } catch {
    return undefined;
  }
}

function parseWait(url: URL, headers: Record<string, string>, max: number): number {
  let wait = url.searchParams.has("wait") ? Number(url.searchParams.get("wait")) : Number.NaN;
  if (!Number.isFinite(wait)) {
    const prefer = /wait=(\d+)/.exec(headers.prefer ?? "");
    wait = prefer ? Number(prefer[1]) : 0;
  }
  if (!Number.isFinite(wait) || wait <= 0) return 0;
  return Math.min(Math.floor(wait), max);
}

export function publicJob(job: JobRecord): Record<string, unknown> {
  const { command, ...rest } = job;
  void command;
  return rest;
}

export function skillSummary(skill: Skill, config: Config, secrets: Secrets): Record<string, unknown> {
  const settings = resolveRunSettings(skill, config);
  const secretEnv = "secret_env" in skill.auth ? skill.auth.secret_env : undefined;
  return {
    name: skill.name,
    description: skill.description,
    enabled: skill.enabled,
    runner: settings.runner,
    model: settings.model ?? null,
    effort: settings.effort ?? null,
    cwd: settings.cwd,
    timeout_seconds: settings.timeoutSeconds,
    path: `/hooks/${skill.name}`,
    auth: { type: skill.auth.type, secret_env: secretEnv ?? null, configured: secretEnv ? Boolean(secrets[secretEnv]) : true, how: describeAuth(skill.auth) },
    when: skill.config.when?.map(describeCondition) ?? [],
    webhook: skill.webhook,
    schedule: skill.schedule ? { cron: skill.schedule.cron, timezone: skill.schedule.timezone, catch_up: skill.schedule.catch_up, overlap: skill.schedule.overlap, next_run_at: skill.enabled ? (nextRun(skill.schedule.spec, new Date(), skill.schedule.timezone)?.toISOString() ?? null) : null } : null,
    dir: skill.dir,
    file: skill.file,
    source: skill.source,
  };
}

export function createServer(deps: ServerDeps): Server {
  const { config, store, queue, registry, logger } = deps;
  const requests = new RateLimiter(config.rate_limit.requests_per_minute);
  const authFailures = new RateLimiter(config.rate_limit.auth_failures_per_minute);
  const startedAt = Date.now();

  /** Admin = a valid admin token, or a direct loopback connection with no proxy headers and no token (the CLI on this machine). */
  function isAdmin(headers: Record<string, string>, req: IncomingMessage, viaProxy: boolean): boolean {
    const token = deps.secrets()[ADMIN_TOKEN_ENV];
    const presented = parseAuthorizationScheme(headers.authorization, "Bearer");
    if (token && presented && safeEqual(presented, token)) return true;
    return !viaProxy && isLoopback(req.socket.remoteAddress) && !presented;
  }

  function requireAdmin(headers: Record<string, string>, req: IncomingMessage, viaProxy: boolean, ip: string): void {
    if (isAdmin(headers, req, viaProxy)) return;
    const token = deps.secrets()[ADMIN_TOKEN_ENV];
    logger.warn("admin request rejected", { ip, path: req.url });
    if (!authFailures.hit(`auth:${ip}`)) throw new HttpError(429, "too_many_failures", "too many failed authentication attempts");
    throw new HttpError(401, "unauthorized", token ? "admin token required" : `admin endpoints need ${ADMIN_TOKEN_ENV} (run: skillhook secret generate admin)`);
  }

  function loadSkill(name: string): Skill {
    if (!isValidSkillName(name)) throw new HttpError(404, "unknown_skill", "unknown skill");
    let skill: Skill | undefined;
    try {
      skill = registry.get(name);
    } catch (error) {
      if (error instanceof SkillError) {
        logger.error("skill failed to load", { skill: name, error: error.message });
        throw new HttpError(500, "invalid_skill", "skill definition is invalid; check the server log");
      }
      throw error;
    }
    if (!skill || !skill.enabled) throw new HttpError(404, "unknown_skill", "unknown skill");
    return skill;
  }

  /** A schedule-only skill exists but has no webhook: the sender learns nothing beyond a 404. */
  function loadWebhookSkill(name: string): Skill {
    const skill = loadSkill(name);
    if (!skill.webhook) throw new HttpError(404, "schedule_only", "this hook runs on a schedule and has no webhook URL");
    return skill;
  }

  interface DeliveryDraft {
    skill: string;
    received_at: string;
    ip: string;
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    user_agent?: string;
    content_type: string | null;
    /** The declared length until the body has been read. */
    bytes: number;
    body_kind?: BodyKind;
    rawBody?: Buffer;
  }

  type RecordDelivery = (outcome: DeliveryOutcome, httpStatus: number, extra?: { code?: string; reason?: string; job_id?: string; delivery_id?: string }) => void;

  /**
   * Every `POST|PUT /hooks/<skill>` comes through here: `deliver` decides and answers the sender, and exactly one delivery
   * record is written whatever the outcome (a thrown HttpError included), then `delivery.received` is published.
   */
  async function handleWebhook(req: IncomingMessage, res: ServerResponse, url: URL, skillName: string, headers: Record<string, string>, ip: string, limited: boolean): Promise<void> {
    const started = Date.now();
    const query = Object.fromEntries(url.searchParams);
    delete query.token;
    delete query.wait;
    const draft: DeliveryDraft = { skill: skillName.slice(0, 200), received_at: nowIso(), ip, method: req.method ?? "POST", path: url.pathname, query, headers: redactHeaders(headers), user_agent: headers["user-agent"], content_type: headers["content-type"] ?? null, bytes: Number(headers["content-length"] ?? 0) || 0 };
    let recorded = false;
    const record: RecordDelivery = (outcome, httpStatus, extra = {}) => {
      if (recorded || !deps.deliveryLog) return;
      recorded = true;
      const saved = deps.deliveryLog.record({
        skill: draft.skill,
        received_at: draft.received_at,
        outcome,
        http_status: httpStatus,
        code: extra.code,
        reason: extra.reason,
        delivery_id: extra.delivery_id,
        job_id: extra.job_id,
        ip: draft.ip,
        method: draft.method,
        path: draft.path,
        query: draft.query,
        headers: draft.headers,
        user_agent: draft.user_agent,
        content_type: draft.content_type,
        bytes: draft.rawBody?.length ?? draft.bytes,
        body_kind: draft.body_kind,
        duration_ms: Date.now() - started,
        rawBody: draft.rawBody,
      });
      deps.events?.emit("delivery.received", { delivery: saved });
    };
    try {
      if (limited) throw new HttpError(429, "rate_limited", "too many requests");
      await deliver(req, res, url, skillName, headers, ip, draft, record);
    } catch (error) {
      if (error instanceof HttpError) {
        // Refused before the body was needed (unknown or invalid skill): read it anyway so the delivery can be replayed later.
        if (!draft.rawBody && config.deliveries.store_bodies && error.status !== 413 && error.status !== 429) draft.rawBody = await drainBody(req, Math.min(config.max_body_bytes, config.deliveries.body_max_bytes));
        record("rejected", error.status, { code: error.code, reason: error.message });
      } else {
        record("error", 500, { code: "internal_error", reason: errorMessage(error) });
      }
      throw error;
    }
  }

  async function deliver(req: IncomingMessage, res: ServerResponse, url: URL, skillName: string, headers: Record<string, string>, ip: string, draft: DeliveryDraft, record: RecordDelivery): Promise<void> {
    const skill = loadWebhookSkill(skillName);
    const rawBody = await readBody(req, config.max_body_bytes);
    draft.rawBody = rawBody;
    const inbound: InboundRequest = { headers, rawBody, query: url.searchParams, ip };
    const verdict = verifyRequest(skill.auth, deps.secrets(), inbound);
    if (!verdict.ok) {
      if (verdict.status === 503) {
        logger.error("skill secret missing", { skill: skill.name, reason: verdict.reason });
        throw new HttpError(503, "skill_not_configured", "skill is not configured on the server");
      }
      logger.warn("webhook rejected", { skill: skill.name, ip, code: verdict.code });
      if (!authFailures.hit(`auth:${ip}`)) throw new HttpError(429, "too_many_failures", "too many failed authentication attempts");
      throw new HttpError(verdict.status, verdict.code, verdict.reason);
    }
    if (skill.auth.type === "none") logger.warn("unauthenticated skill triggered", { skill: skill.name, ip });

    const { payload, kind } = parseBody(headers["content-type"], rawBody);
    draft.body_kind = kind;
    if (skill.auth.type === "slack" && isPlainObject(payload) && payload.type === "url_verification" && typeof payload.challenge === "string") {
      record("challenge", 200, { code: "challenge" });
      return send(res, 200, { challenge: payload.challenge });
    }

    let deliveryId = verdict.deliveryId;
    if (skill.config.dedupe?.header) deliveryId = headers[skill.config.dedupe.header.toLowerCase()] ?? deliveryId;
    if (skill.config.dedupe?.path) {
      const fromPayload = getPath(payload, skill.config.dedupe.path);
      if (fromPayload !== undefined && fromPayload !== null) deliveryId = String(fromPayload);
    }
    if (deliveryId) {
      const existing = store.seenDelivery(skill.name, deliveryId);
      if (existing) {
        logger.info("duplicate delivery ignored", { skill: skill.name, delivery_id: deliveryId, job: existing });
        record("duplicate", 200, { code: "duplicate", delivery_id: deliveryId, job_id: existing });
        return send(res, 200, { ok: true, duplicate: true, job_id: existing, status_url: `/jobs/${existing}` });
      }
    }

    const query = draft.query;
    const filter = evaluateConditions(skill.config.when, { payload, headers, query });
    if (!filter.ok) {
      const reason = `${describeCondition(filter.condition)}: ${filter.reason}`;
      logger.info("delivery skipped by filter", { skill: skill.name, condition: describeCondition(filter.condition), reason: filter.reason });
      record("skipped", 200, { code: "skipped", reason, delivery_id: deliveryId });
      return send(res, 200, { ok: true, skipped: true, reason });
    }

    const wait = parseWait(url, headers, config.max_wait_seconds);
    // Same skill, same payload and query, still queued or running: point the sender at that job instead of running it twice.
    const fingerprint = (skill.config.dedupe?.in_flight ?? config.jobs.dedupe_in_flight) ? deliveryFingerprint({ kind, payload, rawBody, query }) : undefined;
    if (fingerprint) {
      const inFlight = queue.findInFlight(skill.name, fingerprint);
      if (inFlight) {
        const current = store.get(inFlight.id) ?? inFlight;
        logger.info("identical delivery already in flight; not queued again", { skill: skill.name, job: current.id, status: current.status, ip, delivery_id: deliveryId });
        if (deliveryId) store.rememberDelivery(skill.name, deliveryId, current.id);
        record("in_flight", 200, { code: "in_flight", delivery_id: deliveryId, job_id: current.id });
        if (wait > 0) return respondWithJob(res, current, wait, { duplicate: true, in_flight: true });
        return send(res, 200, { ok: true, duplicate: true, in_flight: true, job_id: current.id, status: current.status, status_url: `/jobs/${current.id}` });
      }
    }

    const job = createJob({ skill, trigger: "webhook", payload, kind, rawBody, headers, query, ip, method: req.method ?? "POST", path: url.pathname, deliveryId, fingerprint });
    record("accepted", 202, { delivery_id: deliveryId, job_id: job.id });
    await respondWithJob(res, job, wait);
  }

  interface CreateJobArgs {
    skill: Skill;
    trigger: Trigger;
    payload: unknown;
    kind: WebhookEvent["body_kind"];
    rawBody?: Buffer;
    headers: Record<string, string>;
    query: Record<string, string>;
    ip: string;
    method: string;
    path: string;
    deliveryId?: string;
    fingerprint?: string;
    overrides?: { runner?: RunnerName; model?: string; effort?: string };
  }

  function createJob(args: CreateJobArgs): JobRecord {
    const settings = resolveRunSettings(args.skill, config, args.overrides);
    const id = newJobId();
    const event: WebhookEvent = {
      id,
      skill: args.skill.name,
      trigger: args.trigger,
      received_at: nowIso(),
      method: args.method,
      path: args.path,
      query: args.query,
      headers: redactHeaders(args.headers),
      source_ip: args.ip,
      content_type: args.headers["content-type"] ?? null,
      content_length: args.rawBody?.length ?? Buffer.byteLength(JSON.stringify(args.payload ?? null)),
      body_kind: args.kind,
      delivery_id: args.deliveryId,
      payload: args.payload,
    };
    const job = store.create({
      id,
      skill: args.skill.name,
      trigger: args.trigger,
      runner: settings.runner,
      model: settings.model,
      effort: settings.effort,
      source: { ip: args.ip, method: args.method, path: args.path, content_type: event.content_type, user_agent: args.headers["user-agent"] },
      delivery_id: args.deliveryId,
      fingerprint: args.fingerprint,
      event,
      rawBody: args.rawBody,
    });
    if (args.deliveryId) store.rememberDelivery(args.skill.name, args.deliveryId, job.id);
    logger.info("webhook accepted", { skill: args.skill.name, job: job.id, ip: args.ip, trigger: args.trigger, delivery_id: args.deliveryId, bytes: event.content_length });
    queue.enqueue(job);
    return job;
  }

  /** `POST /deliveries/<id>/replay` and `POST /jobs/<id>/replay`: the original request again, through the skill as it is now, as a new job. */
  async function replay(req: IncomingMessage, res: ServerResponse, url: URL, headers: Record<string, string>, source: "delivery" | "job", id: string): Promise<void> {
    const rawBody = await readBody(req, config.max_body_bytes);
    const body = rawBody.length ? (parseBody(headers["content-type"], rawBody).payload as Record<string, unknown>) : {};
    if (!isPlainObject(body)) throw new HttpError(400, "bad_request", "expected a JSON object body");
    if (body.runner !== undefined && !RunnerNameSchema.safeParse(body.runner).success) throw new HttpError(400, "bad_request", "runner must be claude, codex or shell");
    let plan: ReplayPlan;
    try {
      plan = planReplay({ config, store, registry, deliveryLog: deps.deliveryLog }, { source, id, skipFilters: body.skip_filters === true, force: body.force === true, overrides: { runner: body.runner as RunnerName | undefined, model: body.model as string | undefined, effort: body.effort as string | undefined } });
    } catch (error) {
      if (error instanceof ReplayError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
    const replayOf = replayOfFor(plan.origin);
    if (!plan.ok) {
      logger.info("replay skipped by filter", { skill: plan.skill.name, replay_of: replayOf, reason: plan.reason });
      return send(res, 200, { ok: true, skipped: true, reason: plan.reason, replay_of: replayOf });
    }
    const job = createManualJob({ config, store }, plan.input);
    logger.info("replay accepted", { skill: job.skill, job: job.id, replay_of: replayOf, trigger: job.trigger });
    queue.enqueue(job);
    const wait = Math.min(Number(body.wait ?? 0) || parseWait(url, headers, config.max_wait_seconds), config.max_wait_seconds);
    return respondWithJob(res, job, wait, { replay_of: replayOf });
  }

  /** `GET /jobs/<id>/events`: a `status` snapshot, then `stdout`/`stderr` chunks as the files grow and `status` updates from the bus, then `end`. */
  function streamJob(req: IncomingMessage, res: ServerResponse, url: URL, job: JobRecord): void {
    const wanted = (url.searchParams.get("streams") ?? "stdout").split(",").map((s) => s.trim()).filter(Boolean);
    for (const name of wanted) if (name !== "stdout" && name !== "stderr") throw new HttpError(400, "bad_request", `unknown stream "${name}" (stdout, stderr)`);
    const streams = wanted as ("stdout" | "stderr")[];
    const files = store.pathsFor(job.id);
    const offsets: Record<"stdout" | "stderr", number> = { stdout: 0, stderr: 0 };
    const stream = openEventStream(req, res);
    const pump = () => {
      for (const name of streams) {
        const size = fileSize(files[name]);
        if (size === undefined || size <= offsets[name]) continue;
        if (offsets[name] === 0 && size > STREAM_TAIL_MAX) offsets[name] = size - STREAM_TAIL_MAX;
        const chunk = readFrom(files[name], offsets[name], size - offsets[name]);
        offsets[name] = size;
        stream.send({ event: name, data: chunk });
      }
    };
    let ended = false;
    const end = (final: JobRecord) => {
      if (ended) return;
      ended = true;
      pump();
      stream.send({ event: "end", data: publicJob(final) });
      stream.close();
    };
    stream.send({ event: "status", data: publicJob(job) });
    if (isTerminal(job.status)) return end(job);
    const timer = setInterval(() => {
      pump();
      const current = store.get(job.id);
      if (!current) return end(job);
      if (isTerminal(current.status)) end(current);
    }, STREAM_POLL_MS);
    stream.onClose(() => clearInterval(timer));
    if (deps.events) {
      const off = deps.events.onAny((event) => {
        if (!event.type.startsWith("job.")) return;
        const data = event.data as { job?: JobRecord };
        if (data.job?.id !== job.id) return;
        if (event.type === "job.finished") end(data.job);
        else stream.send({ event: "status", data: publicJob(data.job) });
      });
      stream.onClose(off);
    }
  }

  /** `GET /jobs/<id>/artifacts/<name>`: the raw file, optionally only its last `?tail=` bytes. */
  function sendArtifact(res: ServerResponse, url: URL, job: JobRecord, name: string): void {
    if (!(JOB_ARTIFACTS as string[]).includes(name)) throw new HttpError(404, "unknown_artifact", `unknown artifact "${name}" (${JOB_ARTIFACTS.join(", ")})`);
    const file = store.pathsFor(job.id)[name as JobArtifact];
    const size = fileSize(file);
    if (size === undefined) throw new HttpError(404, "unknown_artifact", `artifact "${name}" has not been written`);
    const tailParam = Number(url.searchParams.get("tail") ?? 0);
    const tailBytes = Number.isFinite(tailParam) && tailParam > 0 ? Math.floor(tailParam) : 0;
    const offset = tailBytes && size > tailBytes ? size - tailBytes : 0;
    let isJson = name === "event";
    if (name === "payload") {
      try {
        isJson = store.readEvent(job.id).body_kind === "json";
      } catch {
        isJson = false;
      }
    }
    send(res, 200, readFrom(file, offset, size - offset), { "content-type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", "x-artifact-bytes": String(size), ...(offset ? { "x-artifact-truncated": "true" } : {}) });
  }

  async function respondWithJob(res: ServerResponse, job: JobRecord, wait: number, extra: Record<string, unknown> = {}): Promise<void> {
    if (wait > 0) {
      const finished = await queue.waitFor(job.id, wait * 1000);
      if (finished && finished.status !== "queued" && finished.status !== "running") {
        return send(res, 200, { ok: finished.status === "succeeded", ...extra, job_id: finished.id, status: finished.status, outcome: finished.outcome ?? null, result: finished.result ?? null, error: finished.error ?? null, response: finished.response ?? null, job: publicJob(finished) });
      }
      const current = finished ?? job;
      return send(res, 202, { ok: true, ...extra, job_id: current.id, status: current.status, status_url: `/jobs/${current.id}`, note: `still ${current.status} after ${wait}s` });
    }
    send(res, 202, { ok: true, ...extra, job_id: job.id, status: "queued", skill: job.skill, status_url: `/jobs/${job.id}` });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers = lowerHeaders(req);
    const { ip, viaProxy } = clientIp(req, headers, config.trust_proxy);
    const url = new URL(req.url ?? "/", "http://skillhook.local");
    const method = req.method ?? "GET";
    const segments = url.pathname.split("/").filter(Boolean);

    // A webhook over the limit is still recorded (as rejected), so the limiter's verdict travels into handleWebhook.
    const limited = !requests.hit(`req:${ip}`);
    const isDelivery = segments[0] === "hooks" && segments.length === 2 && (method === "POST" || method === "PUT");
    if (limited && !isDelivery) throw new HttpError(429, "rate_limited", "too many requests");

    if (segments.length === 0) {
      return send(res, 200, `skillhook ${VERSION}\n\nPOST /hooks/<skill> to trigger a skill.\n`);
    }
    if (segments[0] === "health" && segments.length === 1) {
      // Public callers learn only that the server is up; queue details need admin access.
      return send(res, 200, isAdmin(headers, req, viaProxy) ? { ok: true, version: VERSION, uptime_seconds: Math.round((Date.now() - startedAt) / 1000), queue: queue.stats(), ...(deps.schedules ? { schedules: deps.schedules() } : {}), ...(deps.deliveryLog ? { deliveries: deps.deliveryLog.stats() } : {}) } : { ok: true, version: VERSION });
    }
    if (segments[0] === "events" && segments.length === 1) {
      requireAdmin(headers, req, viaProxy, ip);
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "use GET");
      if (!deps.events) throw new HttpError(404, "not_found", "this server has no event stream");
      const types = (url.searchParams.get("types") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      for (const type of types) if (!(EVENT_TYPES as string[]).includes(type)) throw new HttpError(400, "bad_request", `unknown event type "${type}"`);
      const stream = openEventStream(req, res);
      const off = deps.events.onAny((event) => {
        if (types.length && !types.includes(event.type)) return;
        stream.send({ id: String(event.seq), event: event.type, data: event });
      });
      stream.onClose(off);
      return;
    }
    if (segments[0] === "hooks" && segments.length === 2) {
      let skillName: string;
      try {
        skillName = decodeURIComponent(segments[1] as string);
      } catch {
        throw new HttpError(404, "unknown_skill", "unknown skill");
      }
      if (method === "POST" || method === "PUT") return handleWebhook(req, res, url, skillName, headers, ip, limited);
      if (method === "GET" || method === "HEAD") {
        loadWebhookSkill(skillName);
        return send(res, 200, `skillhook: POST your webhook to this URL.\n`);
      }
      throw new HttpError(405, "method_not_allowed", "use POST");
    }
    if (segments[0] === "deliveries") {
      requireAdmin(headers, req, viaProxy, ip);
      if (!deps.deliveryLog) throw new HttpError(404, "not_found", "this server keeps no delivery log");
      if (segments.length === 1 && method === "GET") {
        const outcome = url.searchParams.get("outcome") ?? undefined;
        if (outcome && !(DELIVERY_OUTCOMES as string[]).includes(outcome)) throw new HttpError(400, "bad_request", `unknown outcome "${outcome}" (${DELIVERY_OUTCOMES.join(", ")})`);
        const since = url.searchParams.get("since") ?? undefined;
        if (since && Number.isNaN(Date.parse(since))) throw new HttpError(400, "bad_request", "since must be an ISO-8601 instant");
        return send(res, 200, deps.deliveryLog.list({ skill: url.searchParams.get("skill") ?? undefined, outcome: outcome as DeliveryOutcome | undefined, since, after: url.searchParams.get("after") ?? undefined, limit: pageLimit(url) }));
      }
      if (segments.length === 3 && segments[2] === "replay" && method === "POST") return replay(req, res, url, headers, "delivery", segments[1] as string);
      if (segments.length === 2 && method === "GET") {
        const delivery = deps.deliveryLog.get(segments[1] as string);
        if (!delivery) throw new HttpError(404, "unknown_delivery", "unknown delivery");
        const include = (url.searchParams.get("include") ?? "").split(",").filter(Boolean);
        return send(res, 200, { delivery, ...(include.includes("body") ? { body: readDeliveryBody(deps.deliveryLog, store, delivery) ?? null } : {}) });
      }
      throw new HttpError(404, "not_found", "not found");
    }
    if (segments[0] === "skills") {
      requireAdmin(headers, req, viaProxy, ip);
      if (segments.length === 1 && method === "GET") {
        const loaded = registry.list();
        return send(res, 200, { skills: loaded.skills.map((s) => skillSummary(s, config, deps.secrets())), errors: loaded.errors });
      }
      if (segments.length === 3 && segments[2] === "run" && method === "POST") {
        const skill = loadSkill(decodeURIComponent(segments[1] as string));
        const rawBody = await readBody(req, config.max_body_bytes);
        const body = rawBody.length ? (parseBody(headers["content-type"], rawBody).payload as Record<string, unknown>) : {};
        if (!isPlainObject(body)) throw new HttpError(400, "bad_request", "expected a JSON object body");
        const payload = body.payload ?? {};
        const extraHeaders = isPlainObject(body.headers) ? Object.fromEntries(Object.entries(body.headers).map(([k, v]) => [k.toLowerCase(), String(v)])) : {};
        const overrides = { runner: body.runner as RunnerName | undefined, model: body.model as string | undefined, effort: body.effort as string | undefined };
        const kind = typeof payload === "string" ? "text" : "json";
        const job = createJob({ skill, trigger: "api", payload, kind, headers: { ...extraHeaders, "user-agent": headers["user-agent"] ?? "skillhook-api" }, query: {}, ip, method: "POST", path: `/skills/${skill.name}/run`, overrides });
        const wait = Math.min(Number(body.wait ?? 0) || parseWait(url, headers, config.max_wait_seconds), config.max_wait_seconds);
        return respondWithJob(res, job, wait);
      }
      throw new HttpError(404, "not_found", "not found");
    }
    if (segments[0] === "jobs") {
      requireAdmin(headers, req, viaProxy, ip);
      if (segments.length === 1 && method === "GET") {
        const status = url.searchParams.get("status") ?? undefined;
        if (status && !(JOB_STATUSES as string[]).includes(status)) throw new HttpError(400, "bad_request", `unknown status "${status}" (${JOB_STATUSES.join(", ")})`);
        const trigger = url.searchParams.get("trigger") ?? undefined;
        if (trigger && !(TRIGGERS as string[]).includes(trigger)) throw new HttpError(400, "bad_request", `unknown trigger "${trigger}" (${TRIGGERS.join(", ")})`);
        const outcome = url.searchParams.get("outcome") ?? undefined;
        if (outcome && !(JOB_OUTCOMES as string[]).includes(outcome)) throw new HttpError(400, "bad_request", `unknown outcome "${outcome}" (${JOB_OUTCOMES.join(", ")})`);
        const since = url.searchParams.get("since") ?? undefined;
        if (since && Number.isNaN(Date.parse(since))) throw new HttpError(400, "bad_request", "since must be an ISO-8601 instant");
        const page = store.listPage({ skill: url.searchParams.get("skill") ?? undefined, status: status as JobStatus | undefined, trigger: trigger as Trigger | undefined, outcome: outcome as JobOutcome | undefined, since, after: url.searchParams.get("after") ?? undefined, limit: pageLimit(url) });
        return send(res, 200, { jobs: page.jobs.map(publicJob), queue: queue.stats(), next_after: page.next_after });
      }
      const id = segments[1] as string;
      const job = store.get(id);
      if (!job) throw new HttpError(404, "unknown_job", "unknown job");
      if (segments.length === 2 && method === "GET") {
        const include = (url.searchParams.get("include") ?? "").split(",").filter(Boolean) as ("stdout" | "stderr" | "prompt" | "result" | "payload" | "event")[];
        const artifacts: Record<string, string | undefined> = {};
        for (const name of include) artifacts[name] = store.readArtifact(id, name);
        return send(res, 200, { job: publicJob(job), ...(include.length ? { artifacts } : {}) });
      }
      if (segments.length === 3 && segments[2] === "events" && method === "GET") return streamJob(req, res, url, job);
      if (segments.length === 3 && segments[2] === "replay" && method === "POST") return replay(req, res, url, headers, "job", id);
      if (segments.length === 4 && segments[2] === "artifacts" && method === "GET") return sendArtifact(res, url, job, segments[3] as string);
      if (segments.length === 3 && segments[2] === "cancel" && method === "POST") {
        const cancelled = queue.cancel(id);
        return send(res, cancelled ? 200 : 409, { ok: cancelled, job_id: id, status: store.get(id)?.status });
      }
      throw new HttpError(404, "not_found", "not found");
    }
    throw new HttpError(404, "not_found", "not found");
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        send(res, error.status, { ok: false, error: error.code, message: error.message, ...error.extra });
        return;
      }
      logger.error("unhandled request error", { error: errorMessage(error), url: req.url });
      if (!res.headersSent) send(res, 500, { ok: false, error: "internal_error", message: "internal error" });
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 65_000;
  server.requestTimeout = Math.max(300_000, (config.max_wait_seconds + 30) * 1000);
  server.headersTimeout = 70_000;
  return server;
}

export function writeServerState(paths: Paths, state: ServerState): void {
  writeJsonFile(paths.serverStateFile, state);
}

export function clearServerState(paths: Paths): void {
  try {
    unlinkSync(paths.serverStateFile);
  } catch {
    /* absent */
  }
}
