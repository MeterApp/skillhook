import { adminRequest, findRunningServer } from "../client.js";
import { createOps, publicJob, runSkillLocally, triggerViaServer } from "../ops.js";
import { nextRuns } from "../schedule.js";
import { buildSchedulePayload, listSchedules, ScheduleControlError, setPauseOffline, type ScheduleStatus } from "../scheduler.js";
import { CommandError, num, relativeTime, str, table, UsageError, type Ctx } from "./shared.js";

export const SCHEDULES_USAGE = `Usage:
  skillhook schedules list                 every skill or hook with a schedule: cron, zone, next and last run
  skillhook schedules next <name> [--count N]   the next N occurrences (default 5)
  skillhook schedules run <name> [--wait S]     fire a scheduled skill now, with the payload a scheduled run gets
  skillhook schedules pause <name> [--reason TEXT] [--until 2h|ISO]   stop it firing (webhooks still run) until resumed
  skillhook schedules resume <name>             fire again from the next slot (paused slots are not caught up)`;

export async function schedulesCommand(ctx: Ctx): Promise<number> {
  const [sub = "list", name] = ctx.args;
  switch (sub) {
    case "list":
    case "ls":
      return listCommand(ctx);
    case "next":
      return nextCommand(ctx, requireName(name));
    case "run":
    case "fire":
      return runCommand(ctx, requireName(name));
    case "pause":
      return pauseCommand(ctx, requireName(name), true);
    case "resume":
    case "unpause":
      return pauseCommand(ctx, requireName(name), false);
    default:
      throw new UsageError(`Unknown schedules subcommand "${sub}"`, SCHEDULES_USAGE);
  }
}

function requireName(name: string | undefined): string {
  if (!name) throw new UsageError("Missing skill name", SCHEDULES_USAGE);
  return name;
}

/** Live state from the running server when it has one, else the persisted state next to the jobs. */
async function schedules(ctx: Ctx): Promise<{ schedules: ScheduleStatus[]; via: "server" | "local"; serverRunning: boolean }> {
  const running = await findRunningServer(ctx.paths);
  if (running?.health.schedules) return { schedules: running.health.schedules, via: "server", serverRunning: true };
  return { schedules: listSchedules({ registry: ctx.registry(), jobsDir: ctx.store().jobsDir }), via: "local", serverRunning: Boolean(running) };
}

async function listCommand(ctx: Ctx): Promise<number> {
  const { schedules: rows, via, serverRunning } = await schedules(ctx);
  const now = Date.now();
  const lines: string[] = [];
  if (rows.length) {
    lines.push(
      table(
        rows.map((s) => [s.skill, !s.enabled ? `(disabled) ${s.cron}` : s.paused ? `(paused${s.paused.until ? ` until ${s.paused.until.slice(0, 16).replaceAll("T", " ")}Z` : ""}) ${s.cron}` : s.cron, s.timezone, s.next_due ? `${s.next_due.slice(0, 16).replaceAll("T", " ")}Z` : "never", s.last_fired_at ? relativeTime(s.last_fired_at, now) : "never", s.last_status ?? "", s.catch_up + (s.skipped ? ` (${s.skipped} skipped)` : ""), s.webhook ? "yes" : "no"]),
        ["skill", "cron", "timezone", "next (UTC)", "last run", "status", "catch_up", "webhook"],
      ),
    );
    if (!serverRunning) lines.push("", "No server is running: nothing fires until `skillhook serve` (or `skillhook service install`).");
    else if (via === "local") lines.push("", "The running server predates the scheduler; restart it (`skillhook service restart`) so these fire.");
  } else lines.push("No schedules. Add `schedule: \"*/30 * * * *\"` (or an object with cron, timezone, catch_up, overlap) to a skill's skillhook: block or a hook in skillhook.yaml.");
  ctx.print(lines.join("\n"), { schedules: rows, via, server_running: serverRunning });
  return 0;
}

function nextCommand(ctx: Ctx, name: string): number {
  const skill = ctx.registry().get(name);
  if (!skill) throw new CommandError(`No skill named "${name}"`);
  if (!skill.schedule) throw new CommandError(`Skill "${name}" has no schedule`);
  const count = num(ctx.flags, "count", "n") ?? 5;
  const runs = nextRuns(skill.schedule.spec, new Date(), skill.schedule.timezone, count);
  ctx.print([`${name}: ${skill.schedule.cron} (${skill.schedule.timezone})`, ...runs.map((d) => `  ${d.toISOString()}`)].join("\n"), { skill: name, cron: skill.schedule.cron, timezone: skill.schedule.timezone, next: runs.map((d) => d.toISOString()) });
  return 0;
}

async function runCommand(ctx: Ctx, name: string): Promise<number> {
  const ops = createOps(ctx.paths, { env: ctx.io.env });
  const skill = ops.registry.get(name);
  if (!skill) throw new CommandError(`No skill named "${name}"`);
  if (!skill.schedule) throw new CommandError(`Skill "${name}" has no schedule; use: skillhook run ${name}`);
  const now = new Date();
  const payload = buildSchedulePayload(skill, now, { firedAt: now, manual: true });
  const wait = num(ctx.flags, "wait") ?? 0;
  const viaServer = await triggerViaServer(ops, { skill, payload, headers: { "x-skillhook-schedule": skill.schedule.cron, "x-skillhook-timezone": skill.schedule.timezone }, waitSeconds: wait });
  if (viaServer) {
    const body = viaServer.body as Record<string, unknown>;
    ctx.print(`Fired ${name} on the running server: job ${String(body.job_id ?? "?")} ${String(body.status ?? body.error ?? "")}`, { via: "server", base_url: viaServer.baseUrl, http_status: viaServer.status, ...body });
    return viaServer.status < 300 ? 0 : 1;
  }
  const job = await runSkillLocally(ops, { skill, payload, trigger: "cli", waitMs: wait > 0 ? wait * 1000 : undefined });
  ctx.print(`Ran ${name} in-process: job ${job.id} ${job.status}${job.error ? ` (${job.error})` : ""}${job.result ? `\n\n${job.result}` : ""}`, { via: "local", job: publicJob(job), job_dir: ops.store.pathsFor(job.id).dir });
  return job.status === "succeeded" || job.status === "queued" || job.status === "running" ? 0 : 1;
}

/** `--until`: an ISO-8601 instant, or a duration from now (`30m`, `2h`, `1d`, `1w`). */
export function parseUntil(value: string | undefined, now = new Date()): string | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{1,5})([mhdw])$/.exec(value.trim());
  if (match) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] as "m" | "h" | "d" | "w"];
    return new Date(now.getTime() + Number(match[1]) * unit).toISOString();
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new UsageError(`--until must be an ISO-8601 instant or a duration like 2h: "${value}"`, SCHEDULES_USAGE);
  return new Date(at).toISOString();
}

async function pauseCommand(ctx: Ctx, name: string, pause: boolean): Promise<number> {
  const options = pause ? { reason: str(ctx.flags, "reason"), until: parseUntil(str(ctx.flags, "until")), by: "cli" } : { by: "cli" };
  const running = await findRunningServer(ctx.paths);
  let schedule: ScheduleStatus;
  let via: "server" | "local";
  if (running?.health.schedules) {
    const response = await adminRequest<{ ok?: boolean; schedule?: ScheduleStatus; message?: string; error?: string }>(running.baseUrl, ctx.secrets(), `/schedules/${encodeURIComponent(name)}/${pause ? "pause" : "resume"}`, { method: "POST", body: options, timeoutMs: 5_000 });
    if (response.status === 404 && response.body.error === "not_found" && !response.body.message?.includes("no skill")) throw new CommandError("The running server predates schedule pauses; update it (`skillhook update`) or stop it and run this again.");
    if (response.status >= 300 || !response.body.schedule) throw new CommandError(response.body.message ?? `the server answered ${response.status}`);
    schedule = response.body.schedule;
    via = "server";
  } else {
    if (running) throw new CommandError("The running server predates the scheduler; restart it (`skillhook service restart`) first.");
    try {
      schedule = setPauseOffline({ registry: ctx.registry(), jobsDir: ctx.store().jobsDir }, name, pause ? options : null);
    } catch (error) {
      if (error instanceof ScheduleControlError) throw new CommandError(error.message);
      throw error;
    }
    via = "local";
  }
  const text = pause ? `Paused ${name}${schedule.paused?.until ? ` until ${schedule.paused.until}` : " until resumed"}. Webhooks still run; slots that pass are not caught up.` : `Resumed ${name}: next run ${schedule.next_due ?? "never"}.`;
  ctx.print(text, { via, schedule });
  return 0;
}
