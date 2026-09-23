import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { loadSecrets } from "./env.js";
import { JobStore, type JobRecord } from "./jobs.js";
import { silentLogger } from "./logger.js";
import { JobQueue } from "./queue.js";
import { SkillRegistry } from "./registry.js";
import { buildSchedulePayload, CATCH_UP_MAX_SLOTS, dueSlots, listSchedules, readScheduleStates, Scheduler, scheduleStateFile } from "./scheduler.js";
import { tempHome, writeConfigFile, writeSkill } from "./test-support/helpers.js";
import { readJsonFileOr, writeJsonFile } from "./util.js";

const at = (iso: string) => new Date(iso);
const SHELL = (command: string) => `skillhook:\n  runner: shell\n  shell:\n    command: ["sh", "-c", ${JSON.stringify(command)}]\n`;

function harness(skills: Record<string, string>, projects: string[] = []) {
  const paths = tempHome("skillhook-scheduler-");
  writeConfigFile(paths, { concurrency: 4 });
  for (const [name, frontmatter] of Object.entries(skills)) writeSkill(paths, name, frontmatter);
  const config = loadConfig(paths);
  const registry = new SkillRegistry(paths.skillsDir, { projects: () => projects });
  const store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 86_400 });
  const secrets = () => loadSecrets(paths, {});
  const queue = new JobQueue({ store, config, registry, secrets, fileSecrets: secrets, logger: silentLogger });
  let clock = at("2026-09-23T10:00:30Z");
  const scheduler = new Scheduler({ registry, store, queue, config, logger: silentLogger, now: () => clock, tickMs: 60 * 60 * 1000 });
  const setClock = (iso: string) => {
    clock = at(iso);
  };
  const finished = async (job: JobRecord, timeoutMs = 15_000) => (await queue.waitFor(job.id, timeoutMs)) ?? store.require(job.id);
  return { paths, config, registry, store, queue, scheduler, setClock, finished, close: async () => (scheduler.stop(), queue.shutdown()) };
}

describe("dueSlots", () => {
  it("lists the slots after the last one, newest first, capped", () => {
    const h = harness({ s: `description: s\n${SHELL("echo hi")}  schedule: "*/30 * * * *"\n` });
    const schedule = h.registry.get("s")?.schedule;
    expect(schedule).toBeDefined();
    expect(dueSlots(schedule!, at("2026-09-23T10:00:30Z"), at("2026-09-23T12:10:00Z")).map((d) => d.toISOString())).toEqual(["2026-09-23T12:00:00.000Z", "2026-09-23T11:30:00.000Z", "2026-09-23T11:00:00.000Z", "2026-09-23T10:30:00.000Z"]);
    expect(dueSlots(schedule!, at("2026-09-23T10:00:30Z"), at("2026-09-23T10:29:00Z"))).toEqual([]);
    expect(dueSlots(schedule!, at("2026-09-20T00:00:00Z"), at("2026-09-23T00:00:00Z"), 5)).toHaveLength(5);
    return h.close();
  });
});

describe("Scheduler", () => {
  it("waits for the next slot when it first sees a schedule, then fires each slot exactly once", async () => {
    const h = harness({ minutely: `description: every minute\n${SHELL("echo scheduled")}  schedule: "* * * * *"\n` });
    h.scheduler.start(); // ticks at 10:00:30: the schedule is registered, nothing is due yet
    expect(readScheduleStates(h.paths.jobsDir).minutely?.last_slot).toBe("2026-09-23T10:00:30.000Z");
    h.setClock("2026-09-23T10:00:50Z");
    expect(h.scheduler.tick().fired).toEqual([]);
    h.setClock("2026-09-23T10:01:05Z");
    const first = h.scheduler.tick();
    expect(first.fired).toHaveLength(1);
    expect(first.skipped).toEqual([]);
    const job = first.fired[0] as JobRecord;
    expect(job).toMatchObject({ skill: "minutely", trigger: "schedule", runner: "shell", delivery_id: "schedule:2026-09-23T10:01", source: { method: "SCHEDULE", path: "/hooks/minutely" } });
    const event = h.store.readEvent(job.id);
    expect(event.trigger).toBe("schedule");
    expect(event.headers["x-skillhook-schedule"]).toBe("* * * * *");
    expect(event.payload).toMatchObject({ scheduled_for: "2026-09-23T10:01:00.000Z", schedule: { cron: "* * * * *", timezone: "UTC", slot: "2026-09-23T10:01", fired_at: "2026-09-23T10:01:05.000Z", caught_up: false, manual: false } });
    // The same minute again, and a moment later in the same minute: nothing new.
    expect(h.scheduler.tick().fired).toEqual([]);
    h.setClock("2026-09-23T10:01:40Z");
    expect(h.scheduler.tick().fired).toEqual([]);
    const done = await h.finished(job);
    expect(done.status).toBe("succeeded");
    expect(done.result).toBe("scheduled");
    const state = readScheduleStates(h.paths.jobsDir).minutely;
    expect(state).toMatchObject({ last_slot: "2026-09-23T10:01:00.000Z", last_job: job.id, last_status: "succeeded", last_fired_at: "2026-09-23T10:01:05.000Z" });
    const status = h.scheduler.status(at("2026-09-23T10:01:40Z")).find((s) => s.skill === "minutely");
    expect(status).toMatchObject({ cron: "* * * * *", timezone: "UTC", catch_up: "latest", overlap: "skip", enabled: true, webhook: true, next_due: "2026-09-23T10:02:00.000Z", last_job: job.id, last_status: "succeeded", skipped: 0 });
    await h.close();
  });

  it("catches up the latest missed slot by default and reports the others as skipped", async () => {
    const h = harness({ half: `description: half-hourly\n${SHELL("echo half")}  schedule: "*/30 * * * *"\n` });
    h.scheduler.tick(); // registered at 10:00:30
    h.setClock("2026-09-23T12:10:00Z");
    const result = h.scheduler.tick();
    expect(result.fired.map((j) => j.delivery_id)).toEqual(["schedule:2026-09-23T12:00"]);
    expect(result.skipped.map((s) => [s.slot, s.reason])).toEqual([
      ["2026-09-23T11:30:00.000Z", "caught_up"],
      ["2026-09-23T11:00:00.000Z", "caught_up"],
      ["2026-09-23T10:30:00.000Z", "caught_up"],
    ]);
    const payload = readJsonFileOr<{ schedule: { caught_up: boolean } }>(h.store.pathsFor((result.fired[0] as JobRecord).id).payload, { schedule: { caught_up: false } });
    expect(payload.schedule.caught_up).toBe(true); // ten minutes late is past the grace period
    expect(readScheduleStates(h.paths.jobsDir).half).toMatchObject({ last_slot: "2026-09-23T12:00:00.000Z", skipped: 3 });
    await h.finished(result.fired[0] as JobRecord);
    await h.close();
  });

  it("catch_up: all fires every missed slot, oldest first, up to the cap", async () => {
    const h = harness({ all: `description: all\n${SHELL("echo all")}  schedule:\n    cron: "*/30 * * * *"\n    catch_up: all\n` });
    h.scheduler.tick();
    h.setClock("2026-09-23T12:10:00Z");
    const result = h.scheduler.tick();
    expect(result.fired.map((j) => j.delivery_id)).toEqual(["schedule:2026-09-23T10:30", "schedule:2026-09-23T11:00", "schedule:2026-09-23T11:30", "schedule:2026-09-23T12:00"]);
    for (const job of result.fired) await h.finished(job);
    // A day away: only the newest CATCH_UP_MAX_SLOTS run.
    h.setClock("2026-09-24T12:10:00Z");
    const later = h.scheduler.tick();
    expect(later.fired).toHaveLength(CATCH_UP_MAX_SLOTS);
    expect(later.fired[0]?.delivery_id).toBe("schedule:2026-09-24T00:30");
    expect(later.fired[later.fired.length - 1]?.delivery_id).toBe("schedule:2026-09-24T12:00");
    expect(later.skipped).toHaveLength(48 - CATCH_UP_MAX_SLOTS);
    expect(later.skipped.every((s) => s.reason === "caught_up")).toBe(true);
    for (const job of later.fired) await h.finished(job, 30_000);
    await h.close();
  });

  it("catch_up: none skips slots older than the grace period and fires fresh ones", async () => {
    const h = harness({ none: `description: none\n${SHELL("echo none")}  schedule:\n    cron: "*/30 * * * *"\n    catch_up: none\n` });
    h.scheduler.tick();
    h.setClock("2026-09-23T12:10:00Z");
    const stale = h.scheduler.tick();
    expect(stale.fired).toEqual([]);
    expect(stale.skipped.map((s) => s.reason)).toEqual(["too_old", "caught_up", "caught_up", "caught_up"]);
    h.setClock("2026-09-23T12:31:00Z");
    const fresh = h.scheduler.tick();
    expect(fresh.fired.map((j) => j.delivery_id)).toEqual(["schedule:2026-09-23T12:30"]);
    await h.finished(fresh.fired[0] as JobRecord);
    await h.close();
  });

  it("skips a slot while the previous run is still in flight, unless overlap is queue", async () => {
    const h = harness({
      slow: `description: slow\n${SHELL("sleep 2; echo slow")}  schedule: "* * * * *"\n`,
      queued: `description: queued\n${SHELL("sleep 2; echo queued")}  schedule:\n    cron: "* * * * *"\n    overlap: queue\n`,
    });
    h.scheduler.tick();
    h.setClock("2026-09-23T10:01:05Z");
    const first = h.scheduler.tick();
    expect(first.fired.map((j) => j.skill).sort()).toEqual(["queued", "slow"]);
    h.setClock("2026-09-23T10:02:05Z");
    const second = h.scheduler.tick();
    expect(second.skipped).toEqual([{ skill: "slow", slot: "2026-09-23T10:02:00.000Z", reason: "in_flight" }]);
    expect(second.fired.map((j) => j.skill)).toEqual(["queued"]);
    expect(h.queue.inFlight("queued")?.status).toBeDefined();
    expect(readScheduleStates(h.paths.jobsDir).slow).toMatchObject({ last_slot: "2026-09-23T10:02:00.000Z", skipped: 1 });
    for (const job of [...first.fired, ...second.fired]) await h.finished(job, 20_000);
    h.setClock("2026-09-23T10:03:05Z");
    expect(h.scheduler.tick().fired.map((j) => j.skill).sort()).toEqual(["queued", "slow"]);
    for (const job of h.store.list({ status: ["queued", "running"] })) await h.finished(job, 20_000);
    await h.close();
  });

  it("never fires a slot twice, even when the state file is lost or an hour repeats", async () => {
    const h = harness({
      fall: `description: fall back\n${SHELL("echo fall")}  schedule:\n    cron: "30 1 * * *"\n    timezone: America/New_York\n`,
    });
    h.setClock("2026-11-01T05:00:00Z"); // 01:00 EDT on the fall-back day
    h.scheduler.tick();
    h.setClock("2026-11-01T05:31:00Z"); // 01:31 EDT: the first 01:30
    const first = h.scheduler.tick();
    expect(first.fired.map((j) => j.delivery_id)).toEqual(["schedule:2026-11-01T01:30"]);
    await h.finished(first.fired[0] as JobRecord);
    h.setClock("2026-11-01T06:31:00Z"); // 01:31 EST: the second 01:30 of the day
    const second = h.scheduler.tick();
    expect(second.fired).toEqual([]);
    expect(second.skipped).toEqual([{ skill: "fall", slot: "2026-11-01T06:30:00.000Z", reason: "duplicate" }]);
    // A second scheduler over the same store with an older state file still trusts the delivery index.
    writeJsonFile(scheduleStateFile(h.paths.jobsDir), { fall: { last_slot: "2026-11-01T05:00:00.000Z" } });
    const again = new Scheduler({ registry: h.registry, store: h.store, queue: h.queue, config: h.config, logger: silentLogger, now: () => at("2026-11-01T05:40:00Z") });
    const replay = again.tick();
    expect(replay.fired).toEqual([]);
    expect(replay.skipped.map((s) => s.reason)).toEqual(["duplicate"]);
    await h.close();
  });

  it("ignores disabled skills, runs schedule-only skills, and merges the static payload", async () => {
    const h = harness({
      off: `description: off\n${SHELL("echo off")}  enabled: false\n  schedule: "* * * * *"\n`,
      only: `description: only\n${SHELL("echo only")}  webhook: false\n  schedule:\n    cron: "* * * * *"\n    payload: { reason: digest, scheduled_for: overwritten }\n`,
    });
    h.scheduler.tick();
    h.setClock("2026-09-23T10:01:05Z");
    const result = h.scheduler.tick();
    expect(result.fired.map((j) => j.skill)).toEqual(["only"]);
    const payload = h.store.readEvent((result.fired[0] as JobRecord).id).payload as Record<string, unknown>;
    expect(payload.reason).toBe("digest");
    expect(payload.scheduled_for).toBe("2026-09-23T10:01:00.000Z"); // skillhook's fields win over the static payload
    expect(buildSchedulePayload(h.registry.get("only")!, at("2026-09-23T10:05:00Z"), { manual: true })).toMatchObject({ reason: "digest", scheduled_for: "2026-09-23T10:05:00.000Z", schedule: { manual: true } });
    expect(() => buildSchedulePayload(h.registry.get("off")!, at("2026-09-23T10:05:00Z"))).not.toThrow();
    const statuses = h.scheduler.status(at("2026-09-23T10:01:05Z"));
    expect(statuses.find((s) => s.skill === "off")).toMatchObject({ enabled: false, next_due: null });
    expect(statuses.find((s) => s.skill === "only")).toMatchObject({ enabled: true, webhook: false, next_due: "2026-09-23T10:02:00.000Z" });
    expect(listSchedules({ registry: h.registry, jobsDir: h.paths.jobsDir }, at("2026-09-23T10:01:05Z")).map((s) => s.skill).sort()).toEqual(["off", "only"]);
    await h.finished(result.fired[0] as JobRecord);
    await h.close();
  });

  it("picks up a schedule added to a linked skillhook.yaml without a restart", async () => {
    const paths = tempHome("skillhook-scheduler-project-");
    const repo = path.join(paths.home, "repo");
    mkdirSync(repo, { recursive: true });
    const yaml = path.join(repo, "skillhook.yaml");
    writeFileSync(yaml, "hooks:\n  sweep:\n    run: echo swept\n    webhook: false\n    schedule: \"0 0 1 1 *\"\n");
    const h = harness({}, [repo]);
    h.scheduler.tick();
    h.setClock("2026-09-23T10:01:05Z");
    expect(h.scheduler.tick().fired).toEqual([]);
    writeFileSync(yaml, "hooks:\n  sweep:\n    run: echo swept\n    webhook: false\n    schedule: \"* * * * *\"\n");
    const future = new Date(Date.now() + 5000);
    utimesSync(yaml, future, future);
    h.setClock("2026-09-23T10:02:05Z");
    const result = h.scheduler.tick();
    expect(result.fired.map((j) => [j.skill, j.runner, j.delivery_id])).toEqual([["sweep", "shell", "schedule:2026-09-23T10:02"]]);
    const done = await h.finished(result.fired[0] as JobRecord);
    expect(done).toMatchObject({ status: "succeeded", result: "swept", cwd: repo });
    await h.close();
  });
});
