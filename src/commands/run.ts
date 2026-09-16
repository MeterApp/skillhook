import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunnerNameSchema, type RunnerName } from "../config.js";
import { JobStore } from "../jobs.js";
import { createLogger } from "../logger.js";
import { buildManualEvent, createManualJob, createOps, runSkillLocally } from "../ops.js";
import { prepareRun } from "../run.js";
import { formatCommand } from "../runners/types.js";
import { bool, CommandError, formatDuration, list, num, parseHeaderFlags, readPayloadArg, str, UsageError, type Ctx } from "./shared.js";

const USAGE = `Usage: skillhook run <skill> [--payload JSON|@file|-] [--header "Name: value"]... [--runner claude|codex|shell]
                           [--model M] [--effort E] [--cwd DIR] [--dry-run] [--json]

Runs the skill in this process exactly as a webhook would, without HTTP or authentication.
--dry-run prints the runner command and the prompt instead of executing.`;

export async function runCommand(ctx: Ctx): Promise<number> {
  const [name] = ctx.args;
  if (!name) throw new UsageError("Missing skill name", USAGE);
  const runner = str(ctx.flags, "runner");
  if (runner && !RunnerNameSchema.safeParse(runner).success) throw new UsageError("--runner must be claude, codex or shell", USAGE);
  const ops = createOps(ctx.paths, { env: ctx.io.env, logger: ctx.json ? undefined : createLogger({ format: "pretty", level: "warn" }) });
  const skill = ops.registry.get(name);
  if (!skill) throw new CommandError(`No skill named "${name}" in ${ctx.paths.skillsDir}`);
  const { payload } = await readPayloadArg(ctx, str(ctx.flags, "payload", "p"));
  const headers = parseHeaderFlags(list(ctx.flags, "header", "H"));
  const overrides = { runner: runner as RunnerName | undefined, model: str(ctx.flags, "model"), effort: str(ctx.flags, "effort"), cwd: str(ctx.flags, "cwd") };

  if (bool(ctx.flags, "dry-run")) {
    const scratch = new JobStore(mkdtempSync(path.join(tmpdir(), "skillhook-dry-")), { maxJobs: 10, dedupeWindowSeconds: 1 });
    const job = createManualJob(ops, { skill, payload, headers, trigger: "cli", overrides }, scratch);
    const prepared = prepareRun({ skill, config: ops.config, secrets: ops.secrets(), fileSecrets: ops.fileSecrets(), store: scratch, job, event: buildManualEvent({ skill, payload, headers, trigger: "cli" }, job.id), cwd: overrides.cwd, writePrompt: false });
    const envNames = Object.keys(prepared.invocation.env).sort();
    const human = [
      `# dry run: ${skill.name} via ${prepared.runner.name}${prepared.ctx.model ? ` (${prepared.ctx.model})` : ""}`,
      `cwd: ${prepared.invocation.cwd}`,
      `timeout: ${prepared.ctx.timeoutSeconds}s`,
      `env: ${envNames.join(", ")}`,
      "",
      "command:",
      formatCommand(prepared.invocation),
      "",
      prepared.runner.name === "codex" ? "stdin (guardrails + prompt):" : "system prompt addition (--append-system-prompt):",
      prepared.runner.name === "codex" ? "" : prepared.built.guardrails,
      prepared.runner.name === "codex" ? "" : "\nstdin (prompt):",
      prepared.invocation.stdin ?? "",
    ].join("\n");
    ctx.print(human, { dry_run: true, skill: skill.name, runner: prepared.runner.name, model: prepared.ctx.model ?? null, effort: prepared.ctx.effort ?? null, cwd: prepared.invocation.cwd, timeout_seconds: prepared.ctx.timeoutSeconds, command: [prepared.invocation.command, ...prepared.invocation.args], env_names: envNames, guardrails: prepared.built.guardrails, prompt: prepared.built.prompt, stdin: prepared.invocation.stdin });
    return 0;
  }

  const job = await runSkillLocally(ops, {
    skill,
    payload,
    headers,
    trigger: "cli",
    overrides,
    waitMs: num(ctx.flags, "wait") ? (num(ctx.flags, "wait") as number) * 1000 : undefined,
    onStart: (j) => {
      if (!ctx.json) ctx.warn(`▶ job ${j.id}: ${skill.name} via ${j.runner}${j.model ? ` (${j.model})` : ""} — ${ops.store.pathsFor(j.id).dir}`);
    },
  });
  const ok = job.status === "succeeded";
  const human = [
    `${ok ? "✓" : "✗"} ${job.status}${job.duration_ms !== undefined ? ` in ${formatDuration(job.duration_ms)}` : ""}${job.cost_usd ? ` ($${job.cost_usd.toFixed(4)})` : ""}`,
    ...(job.error ? [`error: ${job.error}`] : []),
    ...(job.result ? ["", job.result] : []),
    ...(job.resume_command ? ["", `resume: ${job.resume_command}`] : []),
    "",
    `job: ${ops.store.pathsFor(job.id).dir}`,
  ].join("\n");
  ctx.print(human, { ok, job, job_dir: ops.store.pathsFor(job.id).dir });
  return ok ? 0 : 1;
}
