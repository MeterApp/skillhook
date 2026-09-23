import { findRunningServer } from "../client.js";
import { createOps, publicJob, runSkillLocally, triggerViaServer } from "../ops.js";
import { nextRuns } from "../schedule.js";
import { buildSchedulePayload, listSchedules, type ScheduleStatus } from "../scheduler.js";
import { CommandError, num, relativeTime, table, UsageError, type Ctx } from "./shared.js";

const USAGE = `Usage:
  skillhook schedules list                 every skill or hook with a schedule: cron, zone, next and last run
  skillhook schedules next <name> [--count N]   the next N occurrences (default 5)
  skillhook schedules run <name> [--wait S]     fire a scheduled skill now, with the payload a scheduled run gets`;

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
    default:
      throw new UsageError(`Unknown schedules subcommand "${sub}"`, USAGE);
  }
}

function requireName(name: string | undefined): string {
  if (!name) throw new UsageError("Missing skill name", USAGE);
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
        rows.map((s) => [s.skill, s.enabled ? s.cron : `(disabled) ${s.cron}`, s.timezone, s.next_due ? `${s.next_due.slice(0, 16).replaceAll("T", " ")}Z` : "never", s.last_fired_at ? relativeTime(s.last_fired_at, now) : "never", s.last_status ?? "", s.catch_up + (s.skipped ? ` (${s.skipped} skipped)` : ""), s.webhook ? "yes" : "no"]),
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
