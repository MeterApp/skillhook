// Every request to `POST|PUT /hooks/<skill>` leaves a record here, whatever became of it: accepted (a job was
// created), duplicate, folded into an in-flight job, skipped by a `when` filter, rejected (401, 404, 413, 429, 503…),
// a Slack challenge, or an internal error. Accepted deliveries point at their job (the payload lives there); the
// refused ones may keep their body so an operator can see what arrived and replay it later. Storage, under the jobs
// directory like everything the server writes: `jobs/.delivery-log/deliveries.jsonl` (append-only, compacted to the
// last `deliveries.max` records) and `jobs/.delivery-log/bodies/<id>.bin`. Not to be confused with
// `jobs/.deliveries.json`, the dedupe index of provider delivery ids.
import { isUtf8 } from "node:buffer";
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { newJobId } from "./ids.js";
import type { JobStore } from "./jobs.js";
import type { BodyKind } from "./payload.js";
import { ensureDir, isPlainObject } from "./util.js";

export type DeliveryOutcome = "accepted" | "duplicate" | "in_flight" | "skipped" | "rejected" | "challenge" | "error";
export const DELIVERY_OUTCOMES: DeliveryOutcome[] = ["accepted", "duplicate", "in_flight", "skipped", "rejected", "challenge", "error"];

export interface DeliveryRecord {
  id: string;
  /** The skill named in the URL, as requested (also when no such skill exists). */
  skill: string;
  received_at: string;
  outcome: DeliveryOutcome;
  /** What the sender was answered at decision time (a `?wait=` request may end as `200` with the result instead of `202`). */
  http_status: number;
  /** The error code of a rejected delivery; `duplicate`, `in_flight`, `skipped`, `challenge` or `internal_error` otherwise; absent when accepted. */
  code?: string;
  reason?: string;
  /** Provider delivery id or `dedupe` value, when one was found. */
  delivery_id?: string;
  /** The job created (accepted) or the one the delivery was folded into (duplicate, in_flight). */
  job_id?: string;
  ip: string;
  method: string;
  path: string;
  /** `token` and `wait` removed. */
  query: Record<string, string>;
  /** Redacted like `event.json`; long values shortened. */
  headers: Record<string, string>;
  user_agent?: string;
  content_type: string | null;
  bytes: number;
  body_kind?: BodyKind;
  body_stored: boolean;
  body_truncated?: boolean;
  /** Milliseconds from arrival to the decision (a `?wait=` is not counted). */
  duration_ms: number;
  /** `ingress`: handed over by the cloud link from a hosted URL (docs/cloud.md); `http` (or absent) otherwise. */
  via?: "http" | "ingress";
  /** The cloud's id of a hosted-ingress delivery. */
  ingress_id?: string;
}

export type DeliveryInput = Omit<DeliveryRecord, "id" | "body_stored" | "body_truncated"> & { rawBody?: Buffer };

export interface DeliveryLogOptions {
  max: number;
  store_bodies: boolean;
  body_max_bytes: number;
}

export interface DeliveryFilter {
  skill?: string;
  outcome?: DeliveryOutcome | DeliveryOutcome[];
  /** Only deliveries received at or after this instant (ISO-8601). */
  since?: string;
  /** Only deliveries older than the one with this id (the `next_after` of the previous page). */
  after?: string;
  limit?: number;
}

export interface DeliveryPage {
  deliveries: DeliveryRecord[];
  next_after: string | null;
}

export interface DeliveryBody {
  encoding: "utf8" | "base64";
  text: string;
  truncated: boolean;
  /** `log`: kept by the delivery log; `job`: the accepted delivery's payload in its job directory. */
  source: "log" | "job";
}

/** Outcomes whose body the log keeps; an accepted delivery's payload is in its job directory. */
const BODY_OUTCOMES = new Set<DeliveryOutcome>(["skipped", "rejected", "error"]);
const HEADER_VALUE_MAX = 512;

export function deliveryLogDir(jobsDir: string): string {
  return path.join(jobsDir, ".delivery-log");
}

function capHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name] = value.length > HEADER_VALUE_MAX ? `${value.slice(0, HEADER_VALUE_MAX)}…` : value;
  return out;
}

export class DeliveryLog {
  readonly dir: string;
  private readonly file: string;
  private readonly bodiesDir: string;
  private records: DeliveryRecord[] | null = null;

  /** `options` is a getter so a live configuration change applies to the next record. */
  constructor(
    jobsDir: string,
    private readonly options: () => DeliveryLogOptions,
  ) {
    this.dir = deliveryLogDir(jobsDir);
    this.file = path.join(this.dir, "deliveries.jsonl");
    this.bodiesDir = path.join(this.dir, "bodies");
  }

  private load(): DeliveryRecord[] {
    if (this.records) return this.records;
    const out: DeliveryRecord[] = [];
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (isPlainObject(parsed) && typeof parsed.id === "string") out.push(parsed as unknown as DeliveryRecord);
        } catch {
          /* a line torn by a crash mid-write */
        }
      }
    }
    this.records = out;
    return out;
  }

  private bodyFile(id: string): string {
    return path.join(this.bodiesDir, `${id}.bin`);
  }

  /** Appends one record (and its body when the outcome and the options say so); compacts the file when it grew past 1.5× `max`. */
  record(input: DeliveryInput): DeliveryRecord {
    const options = this.options();
    const { rawBody, ...rest } = input;
    const record: DeliveryRecord = { ...rest, id: newJobId(), headers: capHeaders(rest.headers), body_stored: false };
    ensureDir(this.dir);
    if (rawBody && rawBody.length > 0 && options.store_bodies && BODY_OUTCOMES.has(record.outcome)) {
      ensureDir(this.bodiesDir);
      const kept = rawBody.length > options.body_max_bytes ? rawBody.subarray(0, options.body_max_bytes) : rawBody;
      writeFileSync(this.bodyFile(record.id), kept, { mode: 0o600 });
      record.body_stored = true;
      if (kept.length < rawBody.length) record.body_truncated = true;
    }
    const records = this.load();
    records.push(record);
    if (!existsSync(this.file)) writeFileSync(this.file, "", { mode: 0o600 });
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
    if (records.length > options.max * 1.5) this.compact(options.max);
    return record;
  }

  /** Newest first. `after` continues a page (by position in the log; by id order when that record is gone). */
  list(filter: DeliveryFilter = {}): DeliveryPage {
    const records = this.load();
    const outcomes = filter.outcome ? (Array.isArray(filter.outcome) ? filter.outcome : [filter.outcome]) : undefined;
    const since = filter.since ? Date.parse(filter.since) : undefined;
    const limit = Math.max(1, filter.limit ?? 50);
    let start = records.length - 1;
    if (filter.after) {
      let index = -1;
      for (let i = records.length - 1; i >= 0; i--) {
        if ((records[i] as DeliveryRecord).id === filter.after) {
          index = i;
          break;
        }
      }
      if (index >= 0) start = index - 1;
      else while (start >= 0 && (records[start] as DeliveryRecord).id >= filter.after) start--;
    }
    const out: DeliveryRecord[] = [];
    for (let i = start; i >= 0 && out.length < limit; i--) {
      const record = records[i] as DeliveryRecord;
      if (since !== undefined && Date.parse(record.received_at) < since) continue;
      if (filter.skill && record.skill !== filter.skill) continue;
      if (outcomes && !outcomes.includes(record.outcome)) continue;
      out.push(record);
    }
    return { deliveries: out, next_after: out.length >= limit ? (out[out.length - 1] as DeliveryRecord).id : null };
  }

  get(id: string): DeliveryRecord | undefined {
    const records = this.load();
    for (let i = records.length - 1; i >= 0; i--) if ((records[i] as DeliveryRecord).id === id) return records[i];
    return undefined;
  }

  /** The body kept for a refused delivery, if any. */
  readBody(id: string): { bytes: Buffer; truncated: boolean } | undefined {
    const record = this.get(id);
    if (!record?.body_stored) return undefined;
    const file = this.bodyFile(id);
    if (!existsSync(file)) return undefined;
    return { bytes: readFileSync(file), truncated: record.body_truncated === true };
  }

  count(): number {
    return this.load().length;
  }

  /** What `GET /health` shows. */
  stats(): { total: number; last_received_at: string | null } {
    const records = this.load();
    return { total: records.length, last_received_at: records.length ? (records[records.length - 1] as DeliveryRecord).received_at : null };
  }

  /** Keeps the newest `keep` records, rewrites the file atomically and deletes the bodies of dropped records. Returns how many were dropped. */
  compact(keep = this.options().max): number {
    const records = this.load();
    const dropped = records.length > keep ? records.splice(0, records.length - keep) : [];
    ensureDir(this.dir);
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), { mode: 0o600 });
    renameSync(tmp, this.file);
    for (const record of dropped) if (record.body_stored) rmSync(this.bodyFile(record.id), { force: true });
    if (existsSync(this.bodiesDir)) {
      const live = new Set(records.filter((record) => record.body_stored).map((record) => `${record.id}.bin`));
      for (const name of readdirSync(this.bodiesDir)) if (!live.has(name)) rmSync(path.join(this.bodiesDir, name), { force: true });
    }
    return dropped.length;
  }
}

function encodeBody(bytes: Buffer, truncated: boolean, source: DeliveryBody["source"]): DeliveryBody {
  if (isUtf8(bytes)) return { encoding: "utf8", text: bytes.toString("utf8"), truncated, source };
  return { encoding: "base64", text: bytes.toString("base64"), truncated, source };
}

/** The body of a delivery: what the log kept for a refused one, or the payload of the job an accepted one created. */
export function readDeliveryBody(log: DeliveryLog, store: Pick<JobStore, "pathsFor">, delivery: DeliveryRecord): DeliveryBody | undefined {
  const kept = log.readBody(delivery.id);
  if (kept) return encodeBody(kept.bytes, kept.truncated, "log");
  if (delivery.job_id) {
    const paths = store.pathsFor(delivery.job_id);
    if (existsSync(paths.body)) return encodeBody(readFileSync(paths.body), false, "job");
    if (existsSync(paths.payload)) return encodeBody(readFileSync(paths.payload), false, "job");
  }
  return undefined;
}
