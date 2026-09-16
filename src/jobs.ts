import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunnerName } from "./config.js";
import { isJobId, newJobId } from "./ids.js";
import type { Trigger, WebhookEvent } from "./payload.js";
import { payloadJson } from "./prompt.js";
import { ensureDir, nowIso, readJsonFileOr, truncate, writeJsonFile } from "./util.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "interrupted";
export const TERMINAL_STATUSES: JobStatus[] = ["succeeded", "failed", "timed_out", "cancelled", "interrupted"];
export const JOB_STATUSES: JobStatus[] = ["queued", "running", ...TERMINAL_STATUSES];

export interface JobSource {
  ip: string;
  method: string;
  path: string;
  content_type: string | null;
  user_agent?: string;
}

export interface JobRecord {
  id: string;
  skill: string;
  status: JobStatus;
  trigger: Trigger;
  runner: RunnerName;
  model?: string;
  effort?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  cwd?: string;
  command?: string[];
  pid?: number;
  exit_code?: number | null;
  signal?: string | null;
  session_id?: string;
  /** Command a human can run to continue the agent session. */
  resume_command?: string;
  cost_usd?: number;
  usage?: unknown;
  num_turns?: number;
  /** Final agent message (truncated in job.json; complete in result.md). */
  result?: string;
  error?: string;
  delivery_id?: string;
  /** Hash of payload + query for in-flight de-duplication of webhook deliveries (see `deliveryFingerprint`). */
  fingerprint?: string;
  source: JobSource;
}

export interface JobPaths {
  dir: string;
  job: string;
  payload: string;
  event: string;
  prompt: string;
  stdout: string;
  stderr: string;
  result: string;
  lastMessage: string;
  body: string;
}

export interface CreateJobInput {
  id?: string;
  skill: string;
  trigger: Trigger;
  runner: RunnerName;
  model?: string;
  effort?: string;
  source: JobSource;
  delivery_id?: string;
  fingerprint?: string;
  event: WebhookEvent;
  rawBody?: Buffer;
}

export interface JobFilter {
  skill?: string;
  status?: JobStatus | JobStatus[];
  limit?: number;
}

export type JobArtifact = "stdout" | "stderr" | "prompt" | "result" | "payload" | "event";
export const JOB_ARTIFACTS: JobArtifact[] = ["stdout", "stderr", "prompt", "result", "payload", "event"];

const RESULT_INLINE_MAX = 20_000;

interface DeliveryIndex {
  [key: string]: { job: string; at: number };
}

/** Every job is a directory under `jobs/`; `job.json` is the record, siblings are the artifacts. */
export class JobStore {
  private readonly deliveriesFile: string;
  private deliveries: DeliveryIndex | null = null;

  constructor(
    public readonly jobsDir: string,
    private readonly options: { maxJobs: number; dedupeWindowSeconds: number },
  ) {
    ensureDir(jobsDir);
    this.deliveriesFile = path.join(jobsDir, ".deliveries.json");
  }

  pathsFor(id: string): JobPaths {
    const dir = path.join(this.jobsDir, id);
    return {
      dir,
      job: path.join(dir, "job.json"),
      payload: path.join(dir, "payload.json"),
      event: path.join(dir, "event.json"),
      prompt: path.join(dir, "prompt.md"),
      stdout: path.join(dir, "stdout.log"),
      stderr: path.join(dir, "stderr.log"),
      result: path.join(dir, "result.md"),
      lastMessage: path.join(dir, "last-message.md"),
      body: path.join(dir, "body.bin"),
    };
  }

  create(input: CreateJobInput): JobRecord {
    const id = input.id ?? newJobId();
    const paths = this.pathsFor(id);
    mkdirSync(paths.dir, { recursive: true });
    const record: JobRecord = {
      id,
      skill: input.skill,
      status: "queued",
      trigger: input.trigger,
      runner: input.runner,
      model: input.model,
      effort: input.effort,
      created_at: nowIso(),
      delivery_id: input.delivery_id,
      fingerprint: input.fingerprint,
      source: input.source,
    };
    writeFileSync(paths.payload, `${payloadJson(input.event.payload)}\n`, { mode: 0o600 });
    writeJsonFile(paths.event, { ...input.event, id, skill: input.skill });
    if (input.rawBody && input.event.body_kind === "binary") writeFileSync(paths.body, input.rawBody, { mode: 0o600 });
    writeJsonFile(paths.job, record);
    this.prune();
    return record;
  }

  get(id: string): JobRecord | undefined {
    if (!isJobId(id)) return undefined;
    const file = this.pathsFor(id).job;
    if (!existsSync(file)) return undefined;
    return readJsonFileOr<JobRecord | undefined>(file, undefined);
  }

  require(id: string): JobRecord {
    const job = this.get(id);
    if (!job) throw new Error(`Unknown job ${id}`);
    return job;
  }

  update(id: string, patch: Partial<JobRecord>): JobRecord {
    const current = this.require(id);
    const next: JobRecord = { ...current, ...patch };
    if (typeof patch.result === "string") {
      writeFileSync(this.pathsFor(id).result, `${patch.result}\n`, { mode: 0o600 });
      next.result = truncate(patch.result, RESULT_INLINE_MAX);
    }
    for (const key of Object.keys(next) as (keyof JobRecord)[]) if (next[key] === undefined) delete next[key];
    writeJsonFile(this.pathsFor(id).job, next);
    return next;
  }

  readEvent(id: string): WebhookEvent {
    return JSON.parse(readFileSync(this.pathsFor(id).event, "utf8")) as WebhookEvent;
  }

  readArtifact(id: string, artifact: JobArtifact, maxBytes = 512 * 1024): string | undefined {
    const file = this.pathsFor(id)[artifact];
    if (!existsSync(file)) return undefined;
    const size = statSync(file).size;
    const text = readFileSync(file, "utf8");
    return size > maxBytes ? `… [${size - maxBytes} bytes omitted]\n${text.slice(text.length - maxBytes)}` : text;
  }

  ids(): string[] {
    if (!existsSync(this.jobsDir)) return [];
    return readdirSync(this.jobsDir)
      .filter((name) => isJobId(name))
      .sort()
      .reverse();
  }

  list(filter: JobFilter = {}): JobRecord[] {
    const statuses = filter.status ? (Array.isArray(filter.status) ? filter.status : [filter.status]) : undefined;
    const limit = filter.limit ?? 50;
    const out: JobRecord[] = [];
    for (const id of this.ids()) {
      const job = this.get(id);
      if (!job) continue;
      if (filter.skill && job.skill !== filter.skill) continue;
      if (statuses && !statuses.includes(job.status)) continue;
      out.push(job);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Called once at server start: running jobs from a previous process are lost; queued ones are re-run. */
  recoverOnStartup(): { interrupted: JobRecord[]; queued: JobRecord[] } {
    const interrupted: JobRecord[] = [];
    const queued: JobRecord[] = [];
    for (const id of this.ids()) {
      const job = this.get(id);
      if (!job) continue;
      if (job.status === "running") interrupted.push(this.update(id, { status: "interrupted", finished_at: nowIso(), error: "server restarted while the job was running" }));
      else if (job.status === "queued") queued.push(job);
    }
    return { interrupted, queued: queued.reverse() };
  }

  private loadDeliveries(): DeliveryIndex {
    if (!this.deliveries) this.deliveries = readJsonFileOr<DeliveryIndex>(this.deliveriesFile, {});
    return this.deliveries;
  }

  private saveDeliveries(): void {
    if (this.deliveries) writeJsonFile(this.deliveriesFile, this.deliveries);
  }

  /** Returns the job that already handled this delivery id (within the de-dupe window), if any. */
  seenDelivery(skill: string, deliveryId: string, now = Date.now()): string | undefined {
    const entry = this.loadDeliveries()[`${skill}::${deliveryId}`];
    if (!entry) return undefined;
    if (now - entry.at > this.options.dedupeWindowSeconds * 1000) return undefined;
    return entry.job;
  }

  rememberDelivery(skill: string, deliveryId: string, jobId: string, now = Date.now()): void {
    const index = this.loadDeliveries();
    const cutoff = now - this.options.dedupeWindowSeconds * 1000;
    for (const [key, entry] of Object.entries(index)) if (entry.at < cutoff) delete index[key];
    index[`${skill}::${deliveryId}`] = { job: jobId, at: now };
    this.saveDeliveries();
  }

  /** Deletes the oldest finished jobs beyond `max_jobs`. Returns how many were removed. */
  prune(keep = this.options.maxJobs): number {
    const ids = this.ids();
    if (ids.length <= keep) return 0;
    let removed = 0;
    for (const id of ids.slice(keep).reverse()) {
      const job = this.get(id);
      if (job && !TERMINAL_STATUSES.includes(job.status)) continue;
      rmSync(this.pathsFor(id).dir, { recursive: true, force: true });
      removed++;
      if (ids.length - removed <= keep) break;
    }
    return removed;
  }

  remove(id: string): boolean {
    const paths = this.pathsFor(id);
    if (!existsSync(paths.dir)) return false;
    rmSync(paths.dir, { recursive: true, force: true });
    return true;
  }
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
