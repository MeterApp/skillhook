// Fires `schedule:` hooks. A short wall-clock tick (monotonic timers stop while a machine sleeps) compares
// `Date.now()` with each schedule's slots since the last one it handled, applies the hook's `catch_up` and
// `overlap` policy, and creates a job through the same store and queue a webhook uses. A slot is identified by
// its wall-clock minute in the hook's zone (`schedule:<slot>` as the delivery id), so a restart, a second tick,
// or the repeated hour of a fall-back day never fires it twice. State lives in `jobs/.schedules.json`.
import path from "node:path";
import type { Config } from "./config.js";
import type { Events } from "./events.js";
import type { JobRecord, JobStatus, JobStore } from "./jobs.js";
import type { Logger } from "./logger.js";
import { createManualJob } from "./ops.js";
import type { JobQueue } from "./queue.js";
import type { SkillRegistry } from "./registry.js";
import { nextRun, previousRun, slotKey } from "./schedule.js";
import type { NormalizedSchedule, Skill } from "./skills.js";
import { errorMessage, isPlainObject, isValidSkillName, readJsonFileOr, writeJsonFile } from "./util.js";

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
  /** Slots that were due but not run (still in flight, caught up, too old, paused, or already fired by an earlier process). */
  skipped?: number;
  /** Set while the schedule is paused (`skillhook schedules pause`, `POST /schedules/<name>/pause`, the cloud's `schedule.pause`). Lives here, not in the skill's file, so a repository pull or a restart keeps it. */
  paused?: SchedulePause;
}
/** Who paused a schedule, why, and until when (absent: until someone resumes it). */
export interface SchedulePause {
  at: string;
  by?: string;
  reason?: string;
  until?: string;
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
  /** Set while the schedule is paused; its slots pass without a job and are not caught up on resume. */
  paused: SchedulePause | null;
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
  // Keyed by skill name: a null prototype, and only valid names, so no key can reach Object.prototype.
  const states: ScheduleStates = Object.create(null) as ScheduleStates;
  if (!isPlainObject(raw)) return states;
  for (const [name, value] of Object.entries(raw)) if (isValidSkillName(name) && isPlainObject(value)) states[name] = value as ScheduleState;
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

/** The pause in force at `now`: none once its `until` has passed. */
export function activePause(state: ScheduleState | undefined, now = new Date()): SchedulePause | undefined {
  const paused = state?.paused;
  if (!paused) return undefined;
  if (paused.until && Date.parse(paused.until) <= now.getTime()) return undefined;
  return paused;
}

export function scheduleStatus(skill: Skill, state: ScheduleState | undefined, now = new Date()): ScheduleStatus | undefined {
  const schedule = skill.schedule;
  if (!schedule) return undefined;
  const paused = activePause(state, now);
  const from = paused?.until ? new Date(Math.max(now.getTime(), Date.parse(paused.until) - 1)) : now;
  const next = skill.enabled && !(paused && !paused.until) ? nextRun(schedule.spec, from, schedule.timezone) : undefined;
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
    paused: paused ?? null,
  };
}

/** Thrown by `pause` / `resume` for a skill that does not exist or has no schedule. */
export class ScheduleControlError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invalid_args",
    message: string,
  ) {
    super(message);
  }
}

export interface PauseOptions {
  by?: string;
  reason?: string;
  /** An ISO-8601 instant in the future; absent pauses until someone resumes. */
  until?: string;
}

/** Validates a pause request against the registry and builds the record; shared by the server and the offline CLI. */
export function buildPause(registry: SkillRegistry, name: string, options: PauseOptions, now = new Date()): SchedulePause {
  requireScheduled(registry, name);
  let until: string | undefined;
  if (options.until !== undefined) {
    const at = Date.parse(options.until);
    if (Number.isNaN(at)) throw new ScheduleControlError("invalid_args", "until must be an ISO-8601 instant");
    if (at <= now.getTime()) throw new ScheduleControlError("invalid_args", "until must be in the future");
    until = new Date(at).toISOString();
  }
  return { at: now.toISOString(), ...(options.by ? { by: options.by.slice(0, 200) } : {}), ...(options.reason ? { reason: options.reason.slice(0, 500) } : {}), ...(until ? { until } : {}) };
}

/** The state of one schedule, created when missing; never for a key that is not a skill name (`__proto__`, say). */
function stateFor(states: ScheduleStates, name: string): ScheduleState {
  if (!isValidSkillName(name) || name === "__proto__" || name === "constructor" || name === "prototype") throw new ScheduleControlError("not_found", `no skill named "${name}"`);
  if (!Object.hasOwn(states, name)) Object.defineProperty(states, name, { value: {}, enumerable: true, writable: true, configurable: true });
  return states[name] as ScheduleState;
}

function requireScheduled(registry: SkillRegistry, name: string): Skill {
  if (!isValidSkillName(name)) throw new ScheduleControlError("not_found", `no skill named "${name}"`);
  const skill = registry.get(name);
  if (!skill) throw new ScheduleControlError("not_found", `no skill named "${name}"`);
  if (!skill.schedule) throw new ScheduleControlError("conflict", `skill "${name}" has no schedule`);
  return skill;
}

/**
 * Pause or resume with no server running: the state file is written directly (a running server owns it in memory, so
 * the CLI goes through `POST /schedules/<name>/pause` instead). Returns the schedule's new status.
 */
export function setPauseOffline(input: { registry: SkillRegistry; jobsDir: string }, name: string, pause: PauseOptions | null, now = new Date()): ScheduleStatus {
  const skill = requireScheduled(input.registry, name);
  const states = readScheduleStates(input.jobsDir);
  const state = stateFor(states, name);
  if (pause) state.paused = buildPause(input.registry, name, pause, now);
  else delete state.paused;
  writeJsonFile(scheduleStateFile(input.jobsDir), states);
  return scheduleStatus(skill, state, now) as ScheduleStatus;
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
  /** Where `schedule.registered`, `schedule.fired` and `schedule.skipped` are published. */
  events?: Events;
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
      this.deps.logger.error("could not write schedule state", { file: this.file, error: errorMessage(error) }, error);
    }
  }

  /** Enabled skills with a schedule; a registry that fails to list (unreadable config) skips this tick rather than crashing the server. */
  private scheduled(): Skill[] {
    try {
      return this.deps.registry.list().skills.filter((skill) => skill.enabled && skill.schedule !== undefined);
    } catch (error) {
      this.deps.logger.error("scheduler could not list skills", { error: errorMessage(error) }, error);
      return [];
    }
  }

  private safeTick(): void {
    try {
      this.tick();
    } catch (error) {
      this.deps.logger.error("scheduler tick failed", { error: errorMessage(error) }, error);
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

  /** Stops the schedule from firing (webhooks still run) until `resume`, or until `options.until`. Slots that pass while paused are not caught up. */
  pause(name: string, options: PauseOptions = {}, now = this.now()): ScheduleStatus {
    const pause = buildPause(this.deps.registry, name, options, now);
    const state = stateFor(this.states, name);
    state.paused = pause;
    this.save();
    this.deps.logger.warn("schedule paused", { skill: name, by: pause.by, reason: pause.reason, until: pause.until });
    return scheduleStatus(this.deps.registry.get(name) as Skill, state, now) as ScheduleStatus;
  }

  resume(name: string, options: { by?: string } = {}, now = this.now()): ScheduleStatus {
    const skill = requireScheduled(this.deps.registry, name);
    const state = stateFor(this.states, name);
    const was = state.paused;
    delete state.paused;
    // The slots that passed while paused are gone: the schedule picks up at its next slot.
    if (was) state.last_slot = now.toISOString();
    this.save();
    this.deps.logger.info("schedule resumed", { skill: name, by: options.by, was_paused: Boolean(was) });
    return scheduleStatus(skill, state, now) as ScheduleStatus;
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
        const nextDue = nextRun(schedule.spec, now, schedule.timezone)?.toISOString() ?? null;
        this.deps.logger.info("schedule registered", { skill: skill.name, cron: schedule.cron, timezone: schedule.timezone, next_due: nextDue });
        this.deps.events?.emit("schedule.registered", { skill: skill.name, cron: schedule.cron, timezone: schedule.timezone, next_due: nextDue });
        continue;
      }
      const lastSlot = new Date(state.last_slot);
      if (Number.isNaN(lastSlot.getTime())) {
        state.last_slot = now.toISOString();
        dirty = true;
        continue;
      }
      if (state.paused && !activePause(state, now)) {
        // The pause ran out: slots up to its end were paused, the schedule fires from the next one.
        const until = state.paused.until as string;
        delete state.paused;
        if (Date.parse(until) > lastSlot.getTime()) state.last_slot = new Date(Date.parse(until) - 1).toISOString();
        dirty = true;
        this.deps.logger.info("schedule pause ended", { skill: skill.name, until });
        continue;
      }
      const due = dueSlots(schedule, lastSlot, now); // newest first
      if (!due.length) continue;
      dirty = true;
      if (state.paused) {
        // Paused slots pass quietly: no job, no event per slot (a week of a 10-minute schedule would be a thousand).
        state.skipped = (state.skipped ?? 0) + due.length;
        state.last_slot = (due[0] as Date).toISOString();
        continue;
      }
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
      for (const entry of skipped) this.deps.events?.emit("schedule.skipped", entry);
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
    this.deps.events?.emit("schedule.fired", { skill: skill.name, slot: slot.toISOString(), job, caught_up: caughtUp });
    return { job };
  }
}
