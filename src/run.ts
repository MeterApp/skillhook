import { writeFileSync } from "node:fs";
import type { Config, RunnerName } from "./config.js";
import type { Secrets } from "./env.js";
import type { JobRecord, JobStore } from "./jobs.js";
import type { WebhookEvent } from "./payload.js";
import { buildPrompt, type BuiltPrompt } from "./prompt.js";
import { buildRunEnv, getRunner, type RunContext, type Runner, type RunnerInvocation } from "./runners/index.js";
import type { Skill } from "./skills.js";
import { expandTilde, isDirectory } from "./util.js";

export interface RunSettings {
  runner: RunnerName;
  model?: string;
  effort?: string;
  timeoutSeconds: number;
  cwd: string;
}

export interface RunOverrides {
  runner?: RunnerName;
  model?: string;
  effort?: string;
  cwd?: string;
}

/** Skill config wins over server defaults; explicit CLI/API overrides win over both. */
export function resolveRunSettings(skill: Skill, config: Config, overrides: RunOverrides = {}): RunSettings {
  const runner = overrides.runner ?? skill.config.runner ?? config.defaults.runner;
  const model = overrides.model ?? skill.config.model ?? config.defaults.model;
  const effort = overrides.effort ?? skill.config.effort ?? config.defaults.effort;
  const timeoutSeconds = skill.config.timeout_seconds ?? config.defaults.timeout_seconds;
  const cwd = expandTilde(overrides.cwd ?? skill.config.cwd ?? config.defaults.cwd ?? skill.dir);
  return { runner, model, effort, timeoutSeconds, cwd };
}

export interface PreparedRun {
  runner: Runner;
  ctx: RunContext;
  invocation: RunnerInvocation;
  built: BuiltPrompt;
}

export interface PrepareRunInput {
  skill: Skill;
  config: Config;
  secrets: Secrets;
  /** Secrets from the .env file only (see buildRunEnv). */
  fileSecrets?: Secrets;
  store: JobStore;
  job: JobRecord;
  event: WebhookEvent;
  cwd?: string;
  /** When false (dry runs) prompt.md is not written. */
  writePrompt?: boolean;
}

export function prepareRun(input: PrepareRunInput): PreparedRun {
  const { skill, config, job } = input;
  const settings = resolveRunSettings(skill, config, { runner: job.runner, model: job.model, effort: job.effort, cwd: input.cwd });
  if (!isDirectory(settings.cwd)) throw new Error(`Working directory does not exist: ${settings.cwd} (skill "${skill.name}" cwd)`);
  const paths = input.store.pathsFor(job.id);
  const built = buildPrompt({
    skill,
    event: input.event,
    jobId: job.id,
    jobDir: paths.dir,
    payloadPath: paths.payload,
    eventPath: paths.event,
    inlineMaxBytes: config.jobs.inline_payload_max_bytes,
  });
  if (input.writePrompt !== false) writeFileSync(paths.prompt, built.prompt, { mode: 0o600 });
  const jobVars: Record<string, string> = {
    SKILLHOOK_JOB_ID: job.id,
    SKILLHOOK_JOB_DIR: paths.dir,
    SKILLHOOK_SKILL: skill.name,
    SKILLHOOK_SKILL_DIR: skill.dir,
    SKILLHOOK_PAYLOAD_PATH: paths.payload,
    SKILLHOOK_EVENT_PATH: paths.event,
    SKILLHOOK_PROMPT_PATH: paths.prompt,
    SKILLHOOK_TRIGGER: input.event.trigger,
    SKILLHOOK_RUNNER: settings.runner,
  };
  const env = buildRunEnv({ secrets: input.secrets, fileSecrets: input.fileSecrets, skill, config, jobVars });
  const runner = getRunner(settings.runner);
  const ctx: RunContext = {
    skill,
    config,
    jobId: job.id,
    jobDir: paths.dir,
    prompt: built.prompt,
    guardrails: built.guardrails,
    cwd: settings.cwd,
    env,
    model: settings.model,
    effort: settings.effort,
    timeoutSeconds: settings.timeoutSeconds,
    paths: { payloadPath: paths.payload, eventPath: paths.event, promptPath: paths.prompt, lastMessagePath: paths.lastMessage },
  };
  return { runner, ctx, invocation: runner.build(ctx), built };
}
