// In-process event bus for `serve`. The queue, scheduler, registry and server publish state changes here;
// `GET /events` (SSE), `GET /jobs/<id>/events` and, later, the cloud link subscribe. A listener that throws
// is logged and never breaks the publisher, and there is no listener cap (every `?wait=` request adds one).
import type { DeliveryRecord } from "./delivery-log.js";
import type { HealthChange, HealthReport } from "./health.js";
import type { JobRecord } from "./jobs.js";
import type { Logger } from "./logger.js";
import type { JobAnswer, JobQuestion, ProgressEntry } from "./progress.js";
import type { RunnerReadiness } from "./readiness.js";
import type { Config, RunnerName } from "./config.js";
import type { SkipReason } from "./scheduler.js";
import type { ServerState } from "./server.js";
import type { SkillSource } from "./skills.js";
import { errorMessage, nowIso } from "./util.js";

export interface EventMap {
  "server.started": { state: ServerState };
  "server.stopping": { reason: string; running: number };
  /** Every request to `/hooks/<skill>`, whatever became of it (see `DeliveryRecord.outcome`). */
  "delivery.received": { delivery: DeliveryRecord };
  "job.queued": { job: JobRecord };
  "job.started": { job: JobRecord };
  /** A field was captured while the job runs (`pid`, `session_id`, `resume_command`). */
  "job.updated": { job: JobRecord; fields: (keyof JobRecord)[] };
  /** A cancel request was accepted; `job.finished` follows once the process is gone. */
  "job.cancelled": { job: JobRecord; state: "queued" | "running" };
  "job.finished": { job: JobRecord };
  /** The agent reported progress or a note (`progress.jsonl` grew). */
  "job.progress": { job: JobRecord; entry: ProgressEntry };
  /** The agent asked a person something and is waiting (or finished saying a person must act). */
  "job.waiting_human": { job: JobRecord; question: JobQuestion };
  /** A person answered: `live` reached the waiting agent, `resumed` started a new job continuing the session, `recorded` was only stored. */
  "job.answered": { job: JobRecord; answer: JobAnswer; delivered: "live" | "resumed" | "recorded"; resume_job_id?: string };
  "schedule.registered": { skill: string; cron: string; timezone: string; next_due: string | null };
  "schedule.fired": { skill: string; slot: string; job: JobRecord; caught_up: boolean };
  "schedule.skipped": { skill: string; slot: string; reason: SkipReason };
  /** Noticed by the registry on `get()` / `list()` once it has been primed by a first `list()`. */
  "skill.changed": { name: string; action: "added" | "changed" | "removed"; source: SkillSource };
  /** A fresh health report whose checks differ from the previous one (or the first report of that flavour). */
  "health.changed": { report: HealthReport; changed: HealthChange[] };
  /** A runner became usable or stopped being so (installed, logged in), as the readiness check before jobs sees it. */
  "runners.changed": { runner: RunnerName; readiness: RunnerReadiness; previous?: RunnerReadiness };
  /** `skillhook.json` changed and the server re-read it: `applied` took effect now, `restart_required` at the next start. */
  "config.changed": { changed: (keyof Config)[]; applied: (keyof Config)[]; restart_required: (keyof Config)[]; pending_restart: (keyof Config)[]; config: Config };
}

export type EventType = keyof EventMap;

export const EVENT_TYPES: EventType[] = ["server.started", "server.stopping", "delivery.received", "job.queued", "job.started", "job.updated", "job.cancelled", "job.finished", "job.progress", "job.waiting_human", "job.answered", "schedule.registered", "schedule.fired", "schedule.skipped", "skill.changed", "health.changed", "runners.changed", "config.changed"];

export interface SkillhookEvent<K extends EventType = EventType> {
  /** Increases by one per event in this process; `GET /events` sends it as the SSE id. */
  seq: number;
  type: K;
  at: string;
  data: EventMap[K];
}

export type EventListener<K extends EventType = EventType> = (event: SkillhookEvent<K>) => void;
type AnyListener = (event: SkillhookEvent) => void;

export class Events {
  private readonly byType = new Map<EventType, Set<AnyListener>>();
  private readonly any = new Set<AnyListener>();
  private counter = 0;

  constructor(private logger?: Logger) {}

  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  emit<K extends EventType>(type: K, data: EventMap[K]): SkillhookEvent<K> {
    const event: SkillhookEvent<K> = { seq: ++this.counter, type, at: nowIso(), data };
    const typed = this.byType.get(type);
    if (typed) for (const fn of [...typed]) this.call(fn, event as SkillhookEvent);
    for (const fn of [...this.any]) this.call(fn, event as SkillhookEvent);
    return event;
  }

  /** Subscribes to one event type; returns the unsubscribe function. */
  on<K extends EventType>(type: K, fn: EventListener<K>): () => void {
    let set = this.byType.get(type);
    if (!set) {
      set = new Set();
      this.byType.set(type, set);
    }
    const listener = fn as unknown as AnyListener;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  once<K extends EventType>(type: K, fn: EventListener<K>): () => void {
    const off = this.on(type, (event) => {
      off();
      fn(event);
    });
    return off;
  }

  /** Subscribes to every event (what `GET /events` and the cloud link use). */
  onAny(fn: AnyListener): () => void {
    this.any.add(fn);
    return () => {
      this.any.delete(fn);
    };
  }

  listenerCount(type?: EventType): number {
    if (type) return (this.byType.get(type)?.size ?? 0) + this.any.size;
    let total = this.any.size;
    for (const set of this.byType.values()) total += set.size;
    return total;
  }

  /** The seq of the last event emitted (0 before the first). */
  seq(): number {
    return this.counter;
  }

  private call(fn: AnyListener, event: SkillhookEvent): void {
    try {
      fn(event);
    } catch (error) {
      this.logger?.error("event listener failed", { type: event.type, seq: event.seq, error: errorMessage(error) });
    }
  }
}
