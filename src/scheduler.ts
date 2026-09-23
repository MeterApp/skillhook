// Fires `schedule:` hooks. A short wall-clock tick (monotonic timers stop while a machine sleeps) compares
// `Date.now()` with each schedule's slots since the last one it handled, applies the hook's `catch_up` and
// `overlap` policy, and creates a job through the same store and queue a webhook uses. A slot is identified by
// its wall-clock minute in the hook's zone (`schedule:<slot>` as the delivery id), so a restart, a second tick,
// or the repeated hour of a fall-back day never fires it twice. State lives in `jobs/.schedules.json`.
import path from "node:path";
import type { Config } from "./config.js";
import type { JobRecord, JobStatus, JobStore } from "./jobs.js";
import type { Logger } from "./logger.js";
import { createManualJob } from "./ops.js";
import type { JobQueue } from "./queue.js";
import type { SkillRegistry } from "./registry.js";
import { nextRun, previousRun, slotKey } from "./schedule.js";
import type { NormalizedSchedule, Skill } from "./skills.js";
import { errorMessage, isPlainObject, readJsonFileOr, writeJsonFile } from "./util.js";

/** How often the scheduler compares the wall clock with the next due slot. */
export const SCHEDULER_TICK_MS = 15_000;
/** `catch_up: none` still fires a slot this recent, so ordinary tick timing never loses one. */
export const CATCH_UP_GRACE_MS = 5 * 60_000;
/** `catch_up: all` fires at most this many missed slots, oldest first; older ones are skipped. */
export const CATCH_UP_MAX_SLOTS = 24;
/** How many missed slots a tick enumerates when it only reports them. */
const SKIP_REPORT_CAP = 100;

export interface ScheduleState {
  /** The most recent slot the scheduler has dealt with (fired or skipped); slots at or before it are never revisited. */
  last_slot?: string;
  last_fired_at?: string;
  last_job?: string;
  last_status?: JobStatus;
  /** Slots that were due but not run (still in flight, caught up, too old, or already fired by an earlier process). */
  skipped?: number;
}
export type ScheduleStates = Record<string, ScheduleState>;

export interface ScheduleStatus {
  skill: string;
  cron: string;
  timezone: string;
  catch_up: NormalizedSchedule["catch_up"];
  overlap: NormalizedSchedule["overlap"];
  enabled: boolean;
  webhook: boolean;
  next_due: string | null;
  last_slot: string | null;
  last_fired_at: string | null;
  last_job: string | null;
  last_status: JobStatus | null;
  skipped: number;
}

export type SkipReason = "in_flight" | "caught_up" | "too_old" | "duplicate";

export interface TickResult {
  fired: JobRecord[];
  skipped: { skill: string; slot: string; reason: SkipReason }[];
}

export function scheduleStateFile(jobsDir: string): string {
  return path.join(jobsDir, ".schedules.json");
}

export function readScheduleStates(jobsDir: string): ScheduleStates {
  const raw = readJsonFileOr<unknown>(scheduleStateFile(jobsDir), {});
  if (!isPlainObject(raw)) return {};
  const states: ScheduleStates = {};
  for (const [name, value] of Object.entries(raw)) if (isPlainObject(value)) states[name] = value as ScheduleState;
  return states;
}

/** The payload of a scheduled run: the hook's static `payload` plus what fired. `{{payload.scheduled_for}}` is the slot as an ISO instant. */
export function buildSchedulePayload(skill: Skill, slot: Date, options: { firedAt?: Date; caughtUp?: boolean; manual?: boolean } = {}): Record<string, unknown> {
  const schedule = skill.schedule;
  if (!schedule) throw new Error(`skill "${skill.name}" has no schedule`);
  const firedAt = options.firedAt ?? new Date();
  return {
    ...(schedule.payload ?? {}),
    scheduled_for: slot.toISOString(),
    schedule: { cron: schedule.cron, timezone: schedule.timezone, slot: slotKey(slot, schedule.timezone), fired_at: firedAt.toISOString(), caught_up: options.caughtUp ?? false, manual: options.manual ?? false },
  };
}

export function scheduleStatus(skill: Skill, state: ScheduleState | undefined, now = new Date()): ScheduleStatus | undefined {
  const schedule = skill.schedule;
  if (!schedule) return undefined;
  const next = skill.enabled ? nextRun(schedule.spec, now, schedule.timezone) : undefined;
  return {
    skill: skill.name,
    cron: schedule.cron,
    timezone: schedule.timezone,
    catch_up: schedule.catch_up,
    overlap: schedule.overlap,
    enabled: skill.enabled,
    webhook: skill.webhook,
    next_due: next?.toISOString() ?? null,
    last_slot: state?.last_slot ?? null,
    last_fired_at: state?.last_fired_at ?? null,
    last_job: state?.last_job ?? null,
    last_status: state?.last_status ?? null,
    skipped: state?.skipped ?? 0,
  };
}

/** Every scheduled skill with its persisted state: what `skillhook schedules list` and the MCP tool show when no server is running. */
export function listSchedules(input: { registry: SkillRegistry; jobsDir: string }, now = new Date()): ScheduleStatus[] {
  const states = readScheduleStates(input.jobsDir);
  return input.registry
    .list()
    .skills.map((skill) => scheduleStatus(skill, states[skill.name], now))
    .filter((status): status is ScheduleStatus => status !== undefined);
}

/** Slots strictly after `after` and at or before `until`, newest first, at most `limit` of them. */
export function dueSlots(schedule: NormalizedSchedule, after: Date, until: Date, limit = SKIP_REPORT_CAP): Date[] {
  const out: Date[] = [];
  let cursor: Date | undefined = previousRun(schedule.spec, until, schedule.timezone);
  while (cursor && cursor.getTime() > after.getTime() && out.length < limit) {
    out.push(cursor);
    cursor = previousRun(schedule.spec, new Date(cursor.getTime() - 60_000), schedule.timezone);
  }
  return out;
}

export interface SchedulerDeps {
  registry: SkillRegistry;
  store: JobStore;
  queue: JobQueue;
  config: Config;
  logger: Logger;
  /** The clock; tests pass a fixed one. */
  now?: () => Date;
  tickMs?: number;
}

export class Scheduler {
  private states: ScheduleStates;
  private timer: NodeJS.Timeout | undefined;
  private readonly file: string;
  private readonly onFinished = (job: JobRecord): void => {
    if (job.trigger !== "schedule") return;
    const state = this.states[job.skill];
    if (!state || state.last_job !== job.id) return;
    state.last_status = job.status;
    this.save();
  };

  constructor(private readonly deps: SchedulerDeps) {
    this.file = scheduleStateFile(deps.store.jobsDir);
    this.states = readScheduleStates(deps.store.jobsDir);
  }

  /** Ticks now and then every `tickMs`; the timer never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.deps.queue.on("finished", this.onFinished);
    this.safeTick();
    this.timer = setInterval(() => this.safeTick(), this.deps.tickMs ?? SCHEDULER_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.deps.queue.off("finished", this.onFinished);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private save(): void {
    try {
      writeJsonFile(this.file, this.states);
    } catch (error) {
      this.deps.logger.error("could not write schedule state", { file: this.file, error: errorMessage(error) });
    }
  }

  /** Enabled skills with a schedule; a registry that fails to list (unreadable config) skips this tick rather than crashing the server. */
  private scheduled(): Skill[] {
    try {
      return this.deps.registry.list().skills.filter((skill) => skill.enabled && skill.schedule !== undefined);
    } catch (error) {
      this.deps.logger.error("scheduler could not list skills", { error: errorMessage(error) });
      return [];
    }
  }

  private safeTick(): void {
    try {
      this.tick();
    } catch (error) {
      this.deps.logger.error("scheduler tick failed", { error: errorMessage(error) });
    }
  }

  status(now = this.now()): ScheduleStatus[] {
    const out: ScheduleStatus[] = [];
    let skills: Skill[];
    try {
      skills = this.deps.registry.list().skills;
    } catch {
      return out;
    }
    for (const skill of skills) {
      const status = scheduleStatus(skill, this.states[skill.name], now);
      if (status) out.push(status);
    }
    return out;
  }

  /** One pass over every schedule. Exported for tests; the server calls it on its timer. */
  tick(now = this.now()): TickResult {
    const result: TickResult = { fired: [], skipped: [] };
    let dirty = false;
    for (const skill of this.scheduled()) {
      const schedule = skill.schedule as NormalizedSchedule;
      let state = this.states[skill.name];
      if (!state) {
        state = {};
        this.states[skill.name] = state;
      }
      if (!state.last_slot) {
        // A schedule seen for the first time waits for its next slot; catch-up only covers gaps after that.
        state.last_slot = now.toISOString();
        dirty = true;
        this.deps.logger.info("schedule registered", { skill: skill.name, cron: schedule.cron, timezone: schedule.timezone, next_due: nextRun(schedule.spec, now, schedule.timezone)?.toISOString() ?? null });
        continue;
      }
      const lastSlot = new Date(state.last_slot);
      if (Number.isNaN(lastSlot.getTime())) {
        state.last_slot = now.toISOString();
        dirty = true;
        continue;
      }
      const due = dueSlots(schedule, lastSlot, now); // newest first
      if (!due.length) continue;
      dirty = true;
      const latest = due[0] as Date;
      let toFire: Date[];
      if (schedule.catch_up === "all") toFire = due.slice(0, CATCH_UP_MAX_SLOTS).reverse();
      else if (schedule.catch_up === "none") toFire = now.getTime() - latest.getTime() <= CATCH_UP_GRACE_MS ? [latest] : [];
      else toFire = [latest];
      const skipped: TickResult["skipped"] = [];
      for (const slot of due) {
        if (toFire.includes(slot)) continue;
        skipped.push({ skill: skill.name, slot: slot.toISOString(), reason: schedule.catch_up === "none" && slot === latest ? "too_old" : "caught_up" });
      }
      if (skipped.length) this.deps.logger.warn("schedule slots skipped", { skill: skill.name, count: skipped.length, catch_up: schedule.catch_up, oldest: (due[due.length - 1] as Date).toISOString(), newest: latest.toISOString() });
      // One overlap decision per tick: a batch of caught-up slots queues behind itself, it is not a collision.
      const inFlight = toFire.length && schedule.overlap !== "queue" ? this.deps.queue.inFlight(skill.name) : undefined;
      if (inFlight) {
        for (const slot of toFire) skipped.push({ skill: skill.name, slot: slot.toISOString(), reason: "in_flight" });
        this.deps.logger.warn("schedule slot skipped; previous run still in flight", { skill: skill.name, slots: toFire.map((slot) => slotKey(slot, schedule.timezone)), job: inFlight.id, status: inFlight.status });
      } else {
        for (const slot of toFire) {
          const caughtUp = slot.getTime() !== latest.getTime() || now.getTime() - slot.getTime() > CATCH_UP_GRACE_MS;
          const outcome = this.fire(skill, schedule, state, slot, now, caughtUp);
          if (outcome.job) result.fired.push(outcome.job);
          else skipped.push({ skill: skill.name, slot: slot.toISOString(), reason: outcome.reason });
        }
      }
      state.skipped = (state.skipped ?? 0) + skipped.length;
      result.skipped.push(...skipped);
      state.last_slot = latest.toISOString();
    }
    if (dirty) this.save();
    return result;
  }

  private fire(skill: Skill, schedule: NormalizedSchedule, state: ScheduleState, slot: Date, now: Date, caughtUp: boolean): { job: JobRecord } | { job?: undefined; reason: SkipReason } {
    const key = `schedule:${slotKey(slot, schedule.timezone)}`;
    const existing = this.deps.store.seenDelivery(skill.name, key, now.getTime());
    if (existing) {
      // Fired by an earlier process, or the second occurrence of a fall-back hour.
      this.deps.logger.info("schedule slot already fired", { skill: skill.name, slot: key, job: existing });
      return { reason: "duplicate" };
    }
    const payload = buildSchedulePayload(skill, slot, { firedAt: now, caughtUp });
    const job = createManualJob({ config: this.deps.config, store: this.deps.store }, { skill, payload, trigger: "schedule", deliveryId: key, sourceMethod: "SCHEDULE", headers: { "x-skillhook-schedule": schedule.cron, "x-skillhook-timezone": schedule.timezone } });
    this.deps.store.rememberDelivery(skill.name, key, job.id, now.getTime());
    state.last_fired_at = now.toISOString();
    state.last_job = job.id;
    state.last_status = "queued";
    this.deps.logger.info("schedule fired", { skill: skill.name, job: job.id, slot: key, cron: schedule.cron, timezone: schedule.timezone, caught_up: caughtUp });
    this.deps.queue.enqueue(job);
    return { job };
  }
}
