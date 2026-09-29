import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunnerNameSchema, type RunnerName } from "../config.js";
import { JobStore, type JobRecord } from "../jobs.js";
import { createLogger } from "../logger.js";
import { buildManualEvent, createAdhocJob, createManualJob, createOps, runAdhocLocally, runSkillLocally } from "../ops.js";
import { prepareRun } from "../run.js";
import { formatCommand } from "../runners/types.js";
import type { Skill } from "../skills.js";
import { bool, CommandError, formatDuration, list, num, parseHeaderFlags, readPayloadArg, str, UsageError, type Ctx } from "./shared.js";

export const RUN_USAGE = `Usage: skillhook run <skill> [--payload JSON|@file|-] [--header "Name: value"]... [--runner claude|codex|shell]
                           [--model M] [--effort E] [--cwd DIR] [--wait S] [--dry-run] [--json]
       skillhook run --file SKILL.md | --stdin [same options]

Runs the skill in this process exactly as a webhook would, without HTTP or authentication.
--file / --stdin run a SKILL.md that is not installed: it is kept in the job directory and run from there (trigger test).
--dry-run prints the runner command and the prompt instead of executing.`;

export async function runCommand(ctx: Ctx): Promise<number> {
  const [name] = ctx.args;
  const file = str(ctx.flags, "file");
  const fromStdin = bool(ctx.flags, "stdin");
  if (!name && !file && !fromStdin) throw new UsageError("Missing skill name (or --file SKILL.md / --stdin)", RUN_USAGE);
  if (name && (file || fromStdin)) throw new UsageError("Give a skill name or --file/--stdin, not both", RUN_USAGE);
  if (file && fromStdin) throw new UsageError("--file and --stdin exclude each other", RUN_USAGE);
  const runner = str(ctx.flags, "runner");
  if (runner && !RunnerNameSchema.safeParse(runner).success) throw new UsageError("--runner must be claude, codex or shell", RUN_USAGE);
  const ops = createOps(ctx.paths, { env: ctx.io.env, logger: ctx.json ? undefined : createLogger({ format: "pretty", level: "warn" }) });
  let skillMd: string | undefined;
  if (file) {
    try {
      skillMd = readFileSync(file, "utf8");
    } catch (error) {
      throw new CommandError(`Cannot read ${file}: ${(error as Error).message}`);
    }
  } else if (fromStdin) {
    skillMd = ctx.io.stdin ? await ctx.io.stdin() : readFileSync(0, "utf8");
  }
  const installed = skillMd === undefined ? ops.registry.get(name as string) : undefined;
  if (skillMd === undefined && !installed) throw new CommandError(`No skill named "${name}" in ${ctx.paths.skillsDir}`);
  const payloadArg = str(ctx.flags, "payload", "p");
  if (fromStdin && payloadArg === "-") throw new UsageError("--payload - cannot be combined with --stdin (both read standard input)", RUN_USAGE);
  const { payload } = await readPayloadArg(ctx, payloadArg);
  const headers = parseHeaderFlags(list(ctx.flags, "header", "H"));
  const overrides = { runner: runner as RunnerName | undefined, model: str(ctx.flags, "model"), effort: str(ctx.flags, "effort"), cwd: str(ctx.flags, "cwd") };

  if (bool(ctx.flags, "dry-run")) {
    const scratch = new JobStore(mkdtempSync(path.join(tmpdir(), "skillhook-dry-")), { maxJobs: 10, dedupeWindowSeconds: 1 });
    let skill: Skill;
    let job: JobRecord;
    if (skillMd !== undefined) {
      const created = createAdhocJob({ config: ops.config, store: scratch }, { skillMd, payload, headers, overrides });
      skill = created.skill;
      job = created.job;
    } else {
      skill = installed as Skill;
      job = createManualJob(ops, { skill, payload, headers, trigger: "cli", overrides }, scratch);
    }
    const event = skillMd !== undefined ? scratch.readEvent(job.id) : buildManualEvent({ skill, payload, headers, trigger: "cli" }, job.id);
    const prepared = prepareRun({ skill, config: ops.config, secrets: ops.secrets(), fileSecrets: ops.fileSecrets(), store: scratch, job, event, cwd: overrides.cwd, writePrompt: false });
    const envNames = Object.keys(prepared.invocation.env).sort();
    const human = [
      `# dry run: ${skill.name} via ${prepared.runner.name}${prepared.ctx.model ? ` (${prepared.ctx.model})` : ""}${skillMd !== undefined ? " (ad-hoc SKILL.md)" : ""}`,
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
    ctx.print(human, { dry_run: true, skill: skill.name, adhoc: skillMd !== undefined, runner: prepared.runner.name, model: prepared.ctx.model ?? null, effort: prepared.ctx.effort ?? null, cwd: prepared.invocation.cwd, timeout_seconds: prepared.ctx.timeoutSeconds, command: [prepared.invocation.command, ...prepared.invocation.args], env_names: envNames, guardrails: prepared.built.guardrails, prompt: prepared.built.prompt, stdin: prepared.invocation.stdin });
    return 0;
  }

  const waitMs = num(ctx.flags, "wait") ? (num(ctx.flags, "wait") as number) * 1000 : undefined;
  const announce = (j: JobRecord, skillName: string) => {
    if (!ctx.json) ctx.warn(`▶ job ${j.id}: ${skillName} via ${j.runner}${j.model ? ` (${j.model})` : ""}${j.adhoc ? " (ad-hoc SKILL.md)" : ""} — ${ops.store.pathsFor(j.id).dir}`);
  };
  const job =
    skillMd !== undefined
      ? await runAdhocLocally(ops, { skillMd, payload, headers, overrides, waitMs, onStart: (j, skill) => announce(j, skill.name) })
      : await runSkillLocally(ops, { skill: installed as Skill, payload, headers, trigger: "cli", overrides, waitMs, onStart: (j) => announce(j, (installed as Skill).name) });
  const ok = job.status === "succeeded";
  const human = [
    `${ok ? "✓" : "✗"} ${job.status}${job.outcome ? ` (${job.outcome})` : ""}${job.duration_ms !== undefined ? ` in ${formatDuration(job.duration_ms)}` : ""}${job.cost_usd ? ` ($${job.cost_usd.toFixed(4)})` : ""}`,
    ...(job.error ? [`error: ${job.error}`] : []),
    ...(job.response ? [`outcome: ${job.response.outcome}: ${job.response.summary}`, ...(job.response.links?.length ? [`links: ${job.response.links.join(", ")}`] : [])] : []),
    ...(job.result ? ["", job.result] : []),
    ...(job.resume_command ? ["", `resume: ${job.resume_command}`] : []),
    "",
    `job: ${ops.store.pathsFor(job.id).dir}`,
  ].join("\n");
  ctx.print(human, { ok, job, job_dir: ops.store.pathsFor(job.id).dir });
  return ok ? 0 : 1;
}
