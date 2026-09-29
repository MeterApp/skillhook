import { adminRequest, findRunningServer } from "../client.js";
import { RunnerNameSchema, type RunnerName } from "../config.js";
import { createOps, planReplay, publicJob, ReplayError, runSkillLocally } from "../ops.js";
import { bool, CommandError, formatDuration, num, str, UsageError, type Ctx } from "./shared.js";

/**
 * `skillhook deliveries replay <id>` and `skillhook jobs replay <id>`: through the running server's admin API when
 * there is one (the job shows up in its queue), otherwise in this process.
 */
export async function replayCommand(ctx: Ctx, source: "delivery" | "job", id: string | undefined, usage: string): Promise<number> {
  if (!id) throw new UsageError(`Missing ${source} id`, usage);
  const runner = str(ctx.flags, "runner");
  if (runner && !RunnerNameSchema.safeParse(runner).success) throw new UsageError("--runner must be claude, codex or shell", usage);
  const overrides = { runner: runner as RunnerName | undefined, model: str(ctx.flags, "model"), effort: str(ctx.flags, "effort") };
  const skipFilters = bool(ctx.flags, "skip-filters");
  const force = bool(ctx.flags, "force");
  const wait = num(ctx.flags, "wait");
  const running = await findRunningServer(ctx.paths);
  if (running) {
    const response = await adminRequest<Record<string, unknown>>(running.baseUrl, ctx.secrets(), `/${source === "delivery" ? "deliveries" : "jobs"}/${id}/replay`, { method: "POST", body: { skip_filters: skipFilters, force, ...overrides, wait: wait ?? 0 } });
    const body = response.body;
    let human: string;
    if (response.status >= 400) human = `✗ ${String(body.error)}: ${String(body.message)}`;
    else if (body.skipped) human = `Not replayed: ${String(body.reason)} (pass --skip-filters to run anyway)`;
    else human = [`${body.status === "queued" || body.status === "succeeded" ? "✓" : "✗"} job ${String(body.job_id)} ${String(body.status)}${body.outcome ? ` (${String(body.outcome)})` : ""}`, ...(body.error && body.status !== "queued" ? [`error: ${String(body.error)}`] : []), ...(body.result ? ["", String(body.result)] : [])].join("\n");
    ctx.print(human, { via: "server", http_status: response.status, ...body });
    const ran = response.status < 400 && !body.skipped && !["failed", "timed_out", "cancelled", "interrupted"].includes(String(body.status));
    return ran ? 0 : 1;
  }
  const ops = createOps(ctx.paths, { env: ctx.io.env });
  let plan: ReturnType<typeof planReplay>;
  try {
    plan = planReplay(ops, { source, id, skipFilters, force, overrides });
  } catch (error) {
    if (error instanceof ReplayError) throw new CommandError(error.message);
    throw error;
  }
  if (!plan.ok) {
    ctx.print(`Not replayed: ${plan.reason} (pass --skip-filters to run anyway)`, { via: "local", ok: true, skipped: true, reason: plan.reason });
    return 1;
  }
  if (!ctx.json) ctx.warn(`▶ replaying ${source} ${id} through ${plan.skill.name} (no server running: in this process)`);
  const job = await runSkillLocally(ops, { ...plan.input, waitMs: wait ? wait * 1000 : undefined });
  const ok = job.status === "succeeded";
  const lines = [
    `${ok ? "✓" : "✗"} ${job.status}${job.outcome ? ` (${job.outcome})` : ""}${job.duration_ms !== undefined ? ` in ${formatDuration(job.duration_ms)}` : ""}`,
    ...(job.error ? [`error: ${job.error}`] : []),
    ...(job.result ? ["", job.result] : []),
    "",
    `job: ${ops.store.pathsFor(job.id).dir}`,
  ];
  ctx.print(lines.join("\n"), { via: "local", ok, job: publicJob(job), job_dir: ops.store.pathsFor(job.id).dir });
  return ok ? 0 : 1;
}
