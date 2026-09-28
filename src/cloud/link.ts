// The cloud link: one outbound sync loop from `skillhook serve` to Skillhook Cloud. Events from the bus are redacted
// and spooled to the outbox; each sync uploads what is pending, receives commands and hosted-ingress deliveries, runs
// them, and reports back next time. Nothing runs unless `cloud.enabled` is true, a token is in `.env` and
// `SKILLHOOK_NO_CLOUD` is not set; the loop re-reads those every iteration, so `skillhook cloud connect` and
// `disconnect` take effect within seconds. See docs/cloud.md and docs/cloud-protocol.md.
import { randomInt } from "node:crypto";
import type { Config } from "../config.js";
import { readDeliveryBody, type DeliveryLog } from "../delivery-log.js";
import { upsertEnvVar, type Secrets } from "../env.js";
import type { Events, EventType, SkillhookEvent } from "../events.js";
import type { HealthCache } from "../health.js";
import type { JobRecord, JobStore } from "../jobs.js";
import type { Logger } from "../logger.js";
import type { Paths } from "../paths.js";
import type { ReadinessCache } from "../readiness.js";
import type { SkillRegistry } from "../registry.js";
import type { ScheduleStatus } from "../scheduler.js";
import { publicJob, type ServerState } from "../server.js";
import { errorMessage, nowIso } from "../util.js";
import { createCommandDispatcher, type CommandDeps, type CommandDispatcher, type CommandHandler } from "./commands.js";
import { CLOUD_TOKEN_ENV, cloudDisabledByEnv, isSecureCloudUrl, resolveCloudUrl, type CloudPolicy } from "./config.js";
import { CloudHttpError, cloudRequest } from "./http.js";
import { processIngressItem } from "./ingress.js";
import { CommandLedger, IngressLedger, Outbox } from "./outbox.js";
import { machineInfo } from "./pair.js";
import { LIMITS, PROTOCOL_VERSION, SyncResponseSchema, type CloudEventType, type CommandType, type Hints, type LinkReason, type LinkState, type LinkStatus, type SyncRequest, type SyncResponse } from "./protocol.js";
import { capText, redactUpload, scrubSecrets, secretValues } from "./redact.js";
import { buildSnapshot } from "./snapshot.js";

export interface CloudLinkDeps {
  paths: Paths;
  /** The live config (`ConfigRef.current`); `cloud.*` is read on every iteration. */
  config: Config;
  secrets: () => Secrets;
  fileSecrets: () => Secrets;
  events: Events;
  logger: Logger;
  registry: SkillRegistry;
  store: JobStore;
  deliveryLog?: DeliveryLog;
  schedules?: () => ScheduleStatus[];
  health?: HealthCache;
  readiness?: ReadinessCache;
  serverState: () => ServerState | undefined;
  /** The local server's base URL for hosted-ingress deliveries. */
  localBaseUrl: () => string | undefined;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Control command handlers (skill.run, job.answer, config.patch, …), when this version provides them. */
  control?: Partial<Record<CommandType, CommandHandler>>;
  /** The queue's numbers for the status line. */
  queueStats?: () => { running: number; queued: number };
  runningJobs?: () => string[];
  /** For tests: shorter waits. */
  timing?: Partial<LinkTiming>;
}

export interface LinkTiming {
  disabledPollMs: number;
  syncTimeoutMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  revokedRetryMs: number;
  upgradeRetryMs: number;
  stopSyncTimeoutMs: number;
}

/** A single event larger than this is replaced by a note (it would never fit a request). */
const MAX_EVENT_BYTES = 1024 * 1024;
const PROGRESS_COALESCE_MS = 5_000;

const DEFAULT_TIMING: LinkTiming = { disabledPollMs: 5_000, syncTimeoutMs: 35_000, backoffMinMs: 1_000, backoffMaxMs: 60_000, revokedRetryMs: 300_000, upgradeRetryMs: 600_000, stopSyncTimeoutMs: 3_000 };

export interface LinkStatusView extends LinkStatus {
  enabled: boolean;
  url: string;
  machine_id: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  connected_since: string | null;
  syncs: number;
  ingress_urls: Record<string, string>;
  events_seq: number;
}

/** Event types that travel; `server.*` stays local. */
const UPLOADED: Set<string> = new Set(["delivery.received", "job.queued", "job.started", "job.updated", "job.finished", "job.cancelled", "job.progress", "job.waiting_human", "job.answered", "schedule.registered", "schedule.fired", "schedule.skipped", "skill.changed", "config.changed", "health.changed", "runners.changed"]);

export class CloudLink {
  private state: LinkState = "disabled";
  private reason?: LinkReason;
  private running = false;
  private readonly outbox: Outbox;
  private readonly commandLedger: CommandLedger;
  private readonly ingressLedger: IngressLedger;
  private readonly dispatcher: CommandDispatcher;
  private readonly timing: LinkTiming;
  private unsubscribe?: () => void;
  private wakeUp?: () => void;
  private inflight?: AbortController;
  private failures = 0;
  private maxBatch: number = LIMITS.max_events_per_sync;
  /** The events of the request in flight, to know which one to give up on when even one alone is too large. */
  private lastBatch: number[] = [];
  /** Commands received in the last response, acknowledged in the next request. */
  private receivedCommands: string[] = [];
  /** Per job, the last `job.progress` uploaded, to send at most one progress line per job every few seconds. */
  private readonly progressSent = new Map<string, { at: number; state: string }>();
  private hints: Hints = {};
  private lastSnapshotAt = 0;
  private lastHealthAt = 0;
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;
  private connectedSince: string | null = null;
  private syncs = 0;
  private needsStartEvent = true;
  private loopDone?: Promise<void>;

  constructor(private readonly deps: CloudLinkDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.outbox = new Outbox(deps.paths.jobsDir, () => ({ maxEvents: deps.config.cloud.outbox_max_events }));
    this.commandLedger = new CommandLedger(deps.paths.jobsDir);
    this.ingressLedger = new IngressLedger(deps.paths.jobsDir);
    const commandDeps: CommandDeps = {
      paths: deps.paths,
      config: deps.config,
      secrets: deps.secrets,
      fileSecrets: deps.fileSecrets,
      registry: deps.registry,
      store: deps.store,
      deliveryLog: deps.deliveryLog,
      schedules: deps.schedules,
      health: deps.health,
      readiness: deps.readiness,
      serverState: deps.serverState,
      logger: deps.logger,
      policy: () => this.policy(),
      ledger: this.commandLedger,
      snapshot: () => this.snapshot(),
      uploadPayloads: () => this.uploadPayloads(),
      uploadArtifacts: () => this.uploadArtifacts(),
      control: deps.control,
    };
    this.dispatcher = createCommandDispatcher(commandDeps);
  }

  // ---- what the rest of the server may ask

  status(): LinkStatusView {
    const cloud = this.deps.config.cloud;
    return {
      state: this.state,
      ...(this.reason ? { reason: this.reason } : {}),
      mode: cloud.mode,
      outbox_depth: this.outbox.depth(),
      dropped_total: this.outbox.droppedTotal(),
      watched_jobs: 0,
      enabled: cloud.enabled && !cloudDisabledByEnv(this.env()),
      url: resolveCloudUrl(this.env(), cloud),
      machine_id: cloud.machine_id ?? null,
      last_sync_at: this.lastSyncAt,
      last_error: this.lastError,
      connected_since: this.connectedSince,
      syncs: this.syncs,
      ingress_urls: this.hints.ingress_urls ?? {},
      events_seq: this.outbox.seq(),
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.deps.events.onAny((event) => {
      // A config change may have enabled, disabled or re-pointed the link: look again now rather than at the next tick.
      if (event.type === "config.changed") this.wake();
      this.spool(event);
    });
    this.loopDone = this.loop().catch((error: unknown) => this.deps.logger.error("cloud link loop ended", { error: errorMessage(error) }));
  }

  /** Stops the loop; when connected, one last sync carries `link.stopped` and whatever is pending (bounded by `stopSyncTimeoutMs`). */
  async stop(reason = "shutdown"): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.wake();
    this.inflight?.abort();
    // A command still running (a deep health probe) must not hold up a shutdown for long.
    await Promise.race([this.loopDone, new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
    if (this.state === "connected" || this.state === "degraded") {
      const machineId = this.deps.config.cloud.machine_id;
      if (machineId) this.outbox.append(machineId, "link.stopped", { reason, at: nowIso() });
      try {
        await this.sync({ wait: false, timeoutMs: this.timing.stopSyncTimeoutMs });
      } catch {
        /* best effort */
      }
    }
    this.setState("disconnected");
  }

  /** Ends the current sleep or idle long-poll: something new is pending. */
  wake(): void {
    this.wakeUp?.();
    if (this.inflight && this.inflightIdle) this.inflight.abort();
  }

  // ---- internals

  private inflightIdle = false;

  private env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  private policy(): CloudPolicy {
    const cloud = this.deps.config.cloud;
    return { mode: cloud.mode, allow_commands: cloud.allow_commands, deny_commands: cloud.deny_commands };
  }

  private uploadPayloads(): boolean {
    return this.deps.config.cloud.upload_payloads && this.hints.upload_payloads !== false;
  }

  private uploadArtifacts(): boolean {
    return this.deps.config.cloud.upload_artifacts && this.hints.upload_artifacts !== false;
  }

  private setState(state: LinkState, reason?: LinkReason, error?: string): void {
    const changed = state !== this.state || reason !== this.reason;
    // Coming back after a stop, a disable or a revoked token is a new session for the cloud.
    if (state === "disabled" || state === "disconnected") this.needsStartEvent = true;
    this.state = state;
    this.reason = reason;
    if (error !== undefined) this.lastError = error;
    if (state === "connected" && !this.connectedSince) this.connectedSince = nowIso();
    if (state !== "connected" && state !== "degraded") this.connectedSince = null;
    if (changed) this.deps.logger[state === "connected" ? "info" : "warn"]("cloud link", { state, reason, error, url: this.status().url });
  }

  private snapshot() {
    return buildSnapshot({ config: this.deps.config, secrets: this.deps.secrets, fileSecrets: this.deps.fileSecrets, registry: this.deps.registry, store: this.deps.store, deliveryLog: this.deps.deliveryLog, schedules: this.deps.schedules, health: this.deps.health, readiness: this.deps.readiness, serverState: this.deps.serverState });
  }

  /** Progress lines of one job are coalesced: a change of state always travels, the same state at most every 5 s. */
  private coalesced(event: SkillhookEvent): boolean {
    if (event.type === "job.finished") {
      this.progressSent.delete((event as SkillhookEvent<"job.finished">).data.job.id);
      return false;
    }
    if (event.type !== "job.progress") return false;
    const { job, entry } = (event as SkillhookEvent<"job.progress">).data;
    if (entry.type !== "progress") return false; // notes and outcomes always travel
    const last = this.progressSent.get(job.id);
    const now = Date.now();
    if (last && last.state === entry.state && now - last.at < PROGRESS_COALESCE_MS) return true;
    this.progressSent.set(job.id, { at: now, state: entry.state });
    return false;
  }

  /** Redacts and spools one bus event, when the link is active. */
  private spool(event: SkillhookEvent): void {
    const cloud = this.deps.config.cloud;
    if (!cloud.enabled || !cloud.machine_id || cloudDisabledByEnv(this.env()) || !UPLOADED.has(event.type)) return;
    if (this.coalesced(event)) return;
    try {
      let data = this.prepare(event);
      const bytes = Buffer.byteLength(JSON.stringify(data) ?? "");
      if (bytes > MAX_EVENT_BYTES) data = { oversized: true, bytes, note: "this event was larger than the link sends; the full record stays on the machine" };
      this.outbox.append(cloud.machine_id, event.type as CloudEventType, data);
      this.wake();
    } catch (error) {
      this.deps.logger.warn("could not spool event for the cloud", { type: event.type, error: errorMessage(error) });
    }
  }

  private jobForUpload(job: JobRecord): Record<string, unknown> {
    const record = redactUpload(publicJob(job));
    if (typeof record.result === "string") {
      const capped = capText(record.result, LIMITS.max_result_inline_bytes);
      record.result = capped.text;
      if (capped.truncated) record.result_truncated = true;
    }
    return record;
  }

  private prepare(event: SkillhookEvent): unknown {
    const values = secretValues(this.deps.fileSecrets());
    const as = <K extends EventType>(_type: K) => event as SkillhookEvent<K>;
    let data: unknown;
    switch (event.type) {
      case "delivery.received": {
        const delivery = as("delivery.received").data.delivery;
        let body: unknown;
        if (this.uploadPayloads() && this.deps.deliveryLog && delivery.bytes <= LIMITS.max_payload_upload_bytes) {
          try {
            body = readDeliveryBody(this.deps.deliveryLog, this.deps.store, delivery);
          } catch {
            body = undefined;
          }
        }
        data = { delivery: redactUpload(delivery), ...(body ? { body } : {}) };
        break;
      }
      case "job.queued":
      case "job.started":
      case "job.finished":
        data = { job: this.jobForUpload(as("job.finished").data.job) };
        break;
      case "job.updated": {
        const { job, fields } = as("job.updated").data;
        data = { job: this.jobForUpload(job), fields: fields.filter((f) => f !== "command") };
        break;
      }
      case "job.cancelled": {
        const { job, state } = as("job.cancelled").data;
        data = { job: this.jobForUpload(job), state };
        break;
      }
      case "job.progress": {
        const { job, entry } = as("job.progress").data;
        data = { job: this.jobForUpload(job), entry };
        break;
      }
      case "job.waiting_human": {
        const { job, question } = as("job.waiting_human").data;
        data = { job: this.jobForUpload(job), question };
        break;
      }
      case "job.answered": {
        const { job, answer, delivered, resume_job_id } = as("job.answered").data;
        data = { job: this.jobForUpload(job), answer, delivered, ...(resume_job_id ? { resume_job_id } : {}) };
        break;
      }
      case "schedule.fired": {
        const { skill, slot, caught_up, job } = as("schedule.fired").data;
        data = { skill, slot, caught_up, job: this.jobForUpload(job) };
        break;
      }
      case "config.changed": {
        const { changed, applied, restart_required, pending_restart, config } = as("config.changed").data;
        data = { changed, applied, restart_required, pending_restart, config };
        break;
      }
      case "health.changed": {
        const { changed, report } = as("health.changed").data;
        data = { changed, summary: report.summary, ok: report.ok, deep: report.deep, generated_at: report.generated_at };
        break;
      }
      default:
        data = redactUpload(event.data);
    }
    return scrubSecrets(data, values);
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref();
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self.wakeUp === done) self.wakeUp = undefined;
        resolve();
      }
      this.wakeUp = done;
    });
  }

  private backoffMs(): number {
    const base = Math.min(this.timing.backoffMaxMs, this.timing.backoffMinMs * 2 ** Math.min(6, this.failures));
    return base > 1 ? randomInt(Math.floor(base / 2), base + 1) : base;
  }

  private async loop(): Promise<void> {
    this.outbox.load();
    while (this.running) {
      const cloud = this.deps.config.cloud;
      if (cloudDisabledByEnv(this.env())) {
        this.setState("disabled", "env_disabled");
        await this.sleep(this.timing.disabledPollMs);
        continue;
      }
      if (!cloud.enabled) {
        this.setState("disabled");
        await this.sleep(this.timing.disabledPollMs);
        continue;
      }
      const token = this.deps.secrets()[CLOUD_TOKEN_ENV];
      if (!token || !cloud.machine_id) {
        this.setState("disconnected", "token_missing", cloud.machine_id ? `${CLOUD_TOKEN_ENV} is not set` : "not paired (run: skillhook cloud connect)");
        await this.sleep(this.timing.disabledPollMs);
        continue;
      }
      const url = resolveCloudUrl(this.env(), cloud);
      if (!isSecureCloudUrl(url, this.env())) {
        this.setState("disconnected", "insecure_url", `${url} is not https`);
        await this.sleep(this.timing.disabledPollMs * 6);
        continue;
      }
      let delay: number;
      try {
        if (this.state !== "connected" && this.state !== "degraded") this.setState("connecting");
        delay = await this.sync({ wait: true, timeoutMs: this.timing.syncTimeoutMs });
        this.failures = 0;
      } catch (error) {
        delay = this.handleFailure(error);
      }
      if (this.running) await this.sleep(delay);
    }
  }

  private handleFailure(error: unknown): number {
    if (error instanceof CloudHttpError) {
      if (error.status === 401) {
        this.setState("disconnected", "token_revoked", error.message);
        return this.timing.revokedRetryMs;
      }
      if (error.status === 403) {
        this.setState("disconnected", "machine_disabled", error.message);
        return this.timing.revokedRetryMs;
      }
      if (error.status === 426) {
        this.setState("disconnected", "upgrade_required", `the cloud needs protocol ${error.minProtocolVersion ?? "?"} (this skillhook speaks ${PROTOCOL_VERSION}); update skillhook`);
        return this.timing.upgradeRetryMs;
      }
      if (error.status === 413) {
        if (this.lastBatch.length <= 1) {
          const seq = this.lastBatch[0];
          if (seq !== undefined && this.outbox.drop(seq)) this.deps.logger.warn("the cloud refused an event even on its own; dropped it", { seq });
          return this.backoffMs();
        }
        this.maxBatch = Math.max(1, Math.floor(this.lastBatch.length / 2));
        this.deps.logger.warn("cloud refused the batch size; halving", { max_batch: this.maxBatch });
        return 0;
      }
      if (error.status === 429) {
        this.failures++;
        this.setState(this.failures >= 3 ? "degraded" : this.state === "connected" ? "connected" : "connecting", "server_error", error.message);
        return error.retryAfterMs ?? this.backoffMs();
      }
      if (error.code === "aborted") return 0; // woken up: something new is pending
      if (error.code === "network" || error.code === "timeout") {
        this.failures++;
        this.setState(this.failures >= 3 ? "degraded" : this.state, "network", error.message);
        return this.backoffMs();
      }
      this.failures++;
      this.setState(this.failures >= 3 ? "degraded" : this.state, error.status === 0 ? "network" : "server_error", error.message);
      return this.backoffMs();
    }
    if (error instanceof Error && error.name === "AbortError") return 0; // woken up
    this.failures++;
    this.setState(this.failures >= 3 ? "degraded" : this.state, "protocol_error", errorMessage(error));
    return this.backoffMs();
  }

  /** One request to the cloud; returns how long to wait before the next. */
  private async sync(options: { wait: boolean; timeoutMs: number }): Promise<number> {
    const cloud = this.deps.config.cloud;
    const machineId = cloud.machine_id as string;
    const token = this.deps.secrets()[CLOUD_TOKEN_ENV] as string;
    const url = resolveCloudUrl(this.env(), cloud);
    const now = Date.now();
    if (this.needsStartEvent) {
      this.outbox.append(machineId, "link.started", { at: nowIso(), version: PROTOCOL_VERSION, mode: cloud.mode });
      this.needsStartEvent = false;
    }
    const snapshotDue = now - this.lastSnapshotAt >= (this.hints.snapshot_interval_s ?? cloud.snapshot_interval_seconds) * 1000;
    if (this.deps.health && now - this.lastHealthAt >= (this.hints.health_interval_s ?? cloud.health_interval_seconds) * 1000) {
      this.lastHealthAt = now;
      void this.deps.health
        .get({ deep: true, network: false })
        .then(({ report }) => this.outbox.append(machineId, "health.report", scrubSecrets(report, secretValues(this.deps.fileSecrets()))))
        .catch((error: unknown) => this.deps.logger.warn("health report for the cloud failed", { error: errorMessage(error) }));
    }
    const events = this.outbox.pending(Math.min(this.maxBatch, this.hints.max_batch_events ?? LIMITS.max_events_per_sync), LIMITS.max_sync_bytes - 512 * 1024);
    const commandResults = this.commandLedger.pendingResults(LIMITS.max_command_results);
    const ingressAcks = this.ingressLedger.pendingAcks(LIMITS.max_ingress_items * 5);
    const commandsReceived = this.receivedCommands;
    const idle = options.wait && !events.length && !commandResults.length && !ingressAcks.length && !commandsReceived.length && !snapshotDue && this.hints.mode !== "idle";
    const state = this.deps.serverState();
    const request: SyncRequest = {
      protocol_version: PROTOCOL_VERSION,
      sent_at: nowIso(),
      wait: idle,
      machine: { id: machineId, ...machineInfo(state, cloud.enabled ? this.deps.config.public_url : undefined) },
      status: { queue: this.queueStats(), running_jobs: this.runningJobs(), link: { state: this.state === "connecting" || this.state === "disabled" || this.state === "disconnected" ? "connecting" : this.state, ...(this.reason ? { reason: this.reason } : {}), mode: cloud.mode, outbox_depth: this.outbox.depth(), dropped_total: this.outbox.droppedTotal(), watched_jobs: 0 } },
      ...(snapshotDue ? { snapshot: this.snapshot() } : {}),
      events,
      command_results: commandResults,
      ingress_acks: ingressAcks,
      ack: { commands_received: commandsReceived },
    };
    this.lastBatch = events.map((event) => event.seq ?? 0);
    this.inflight = new AbortController();
    this.inflightIdle = idle;
    let response: SyncResponse;
    try {
      const signal = this.inflight.signal;
      const fetchImpl = this.deps.fetchImpl ?? fetch;
      const answer = await cloudRequest(url, "/api/agent/sync", { token, body: request, timeoutMs: options.timeoutMs, fetchImpl: (input, init) => fetchImpl(input, { ...init, signal: signal.aborted ? signal : anySignal([signal, init?.signal ?? undefined]) }) });
      const parsed = SyncResponseSchema.safeParse(answer.body);
      if (!parsed.success) throw new CloudHttpError(answer.status, "protocol_error", "the cloud answered with something this version does not understand");
      response = parsed.data;
    } finally {
      this.inflight = undefined;
      this.inflightIdle = false;
    }
    this.syncs++;
    this.lastSyncAt = nowIso();
    this.lastError = null;
    if (snapshotDue) this.lastSnapshotAt = now;
    this.setState("connected");
    this.receivedCommands = response.commands.map((command) => command.id);
    if (this.maxBatch < LIMITS.max_events_per_sync && events.length >= this.maxBatch) this.maxBatch = Math.min(LIMITS.max_events_per_sync, this.maxBatch * 2);
    if (response.ack.events_through > 0) this.outbox.ack(response.ack.events_through);
    this.commandLedger.ackResults(response.ack.command_results);
    this.ingressLedger.acksSent(ingressAcks.map((a) => a.id));
    if (response.hints) this.hints = { ...this.hints, ...response.hints };
    if (response.notice) this.deps.logger.warn("notice from the cloud", { notice: response.notice });
    if (response.rotate) {
      upsertEnvVar(this.deps.paths.envFile, CLOUD_TOKEN_ENV, response.rotate.token);
      this.deps.logger.info("cloud token rotated", { old_valid_until: response.rotate.old_valid_until });
    }
    for (const command of response.commands) {
      if (!this.running) break;
      await this.dispatcher.run(command);
    }
    for (const item of response.ingress) {
      if (!this.running) break;
      await processIngressItem(item, { baseUrl: this.deps.localBaseUrl, enabled: () => this.deps.config.cloud.ingress, ledger: this.ingressLedger, logger: this.deps.logger, fetchImpl: this.deps.fetchImpl });
    }
    // Sync again at once when there is something new to say, but never spin on what the cloud did not take.
    const sentThrough = events.length ? (events[events.length - 1]?.seq ?? 0) : 0;
    const sentResults = new Set(commandResults.map((r) => r.command_id));
    const sentAcks = new Set(ingressAcks.map((a) => a.id));
    const moreEvents = this.outbox.depth() > 0 && (!events.length || response.ack.events_through >= sentThrough);
    const newResults = this.commandLedger.pendingResults(LIMITS.max_command_results).some((r) => !sentResults.has(r.command_id));
    const newAcks = this.ingressLedger.pendingAcks(LIMITS.max_ingress_items * 5).some((a) => !sentAcks.has(a.id));
    return moreEvents || newResults || newAcks || response.commands.length > 0 || response.ingress.length > 0 ? 0 : response.next_poll_ms;
  }

  private queueStats(): { running: number; queued: number } {
    const stats = this.deps.queueStats?.();
    return stats ? { running: stats.running, queued: stats.queued } : { running: 0, queued: 0 };
  }

  private runningJobs(): string[] {
    return this.deps.runningJobs?.() ?? [];
  }
}

/** A signal that aborts when any of the given ones does (undefined entries ignored). */
function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => Boolean(s));
  if (present.length === 1) return present[0]!;
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
