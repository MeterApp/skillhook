import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, RunnerName } from "./config.js";
import type { Secrets } from "./env.js";
import type { JobRecord, JobStore } from "./jobs.js";
import type { WebhookEvent } from "./payload.js";
import { DEFAULT_HUMAN_WAIT_SECONDS } from "./progress.js";
import { buildPrompt, type BuiltPrompt } from "./prompt.js";
import { responseSchemaFor } from "./response.js";
import { buildRunEnv, getRunner, type AgentApiServer, type RunContext, type Runner, type RunnerInvocation } from "./runners/index.js";
import { shellQuote } from "./runners/types.js";
import type { Skill } from "./skills.js";
import { expandTilde, isDirectory } from "./util.js";

/** The name the agent sees the job API under (`--mcp-config` / `mcp_servers.skillhook_job`). */
export const AGENT_API_SERVER_NAME = "skillhook-job";

/**
 * How to start this very CLI from a child process: `SKILLHOOK_BIN` in the server's environment (a command line, used
 * by tests and unusual installs), else `node <install>/dist/cli.js` when the compiled CLI exists. Undefined when
 * running from source without a build: the job API is then reachable only through `skillhook` on PATH.
 */
export function resolveSkillhookBin(processEnv: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } | undefined {
  const explicit = processEnv.SKILLHOOK_BIN?.trim();
  if (explicit) {
    const [command, ...args] = explicit.split(/\s+/);
    if (command) return { command, args };
  }
  const here = fileURLToPath(import.meta.url); // dist/run.js or src/run.ts
  const cli = path.join(path.resolve(path.dirname(here), ".."), "dist", "cli.js");
  return existsSync(cli) ? { command: process.execPath, args: [cli] } : undefined;
}

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
  /** The server's environment (default `process.env`); tests pass their own. */
  processEnv?: NodeJS.ProcessEnv;
}

export function prepareRun(input: PrepareRunInput): PreparedRun {
  const { skill, config, job } = input;
  const settings = resolveRunSettings(skill, config, { runner: job.runner, model: job.model, effort: job.effort, cwd: input.cwd });
  if (!isDirectory(settings.cwd)) throw new Error(`Working directory does not exist: ${settings.cwd} (skill "${skill.name}" cwd)`);
  const paths = input.store.pathsFor(job.id);
  const home = path.dirname(input.store.jobsDir);
  const bin = resolveSkillhookBin(input.processEnv);
  const agentApiMode = skill.config.agent_api ?? (settings.runner === "shell" ? "cli" : "mcp");
  const humanWaitSeconds = skill.config.human_wait_seconds ?? DEFAULT_HUMAN_WAIT_SECONDS;
  const resume = job.resume && job.answer ? { originalJob: job.resume_of ?? job.id, question: job.question, answer: job.answer, fresh: false } : job.resume_of && job.answer ? { originalJob: job.resume_of, question: job.question, answer: job.answer, fresh: true } : undefined;
  const built = buildPrompt({
    skill,
    event: input.event,
    jobId: job.id,
    jobDir: paths.dir,
    payloadPath: paths.payload,
    eventPath: paths.event,
    responsePath: paths.response,
    inlineMaxBytes: config.jobs.inline_payload_max_bytes,
    agentApi: agentApiMode === "mcp" && !bin ? "cli" : agentApiMode,
    bin: bin ? [bin.command, ...bin.args].map(shellQuote).join(" ") : undefined,
    humanWaitSeconds,
    resume,
  });
  if (input.writePrompt !== false) {
    writeFileSync(paths.prompt, built.prompt, { mode: 0o600 });
    if (skill.config.response?.mode === "structured") writeFileSync(paths.responseSchema, `${JSON.stringify(responseSchemaFor(skill), null, 2)}\n`, { mode: 0o600 });
  }
  const jobVars: Record<string, string> = {
    SKILLHOOK_JOB_ID: job.id,
    SKILLHOOK_JOB_DIR: paths.dir,
    SKILLHOOK_SKILL: skill.name,
    SKILLHOOK_SKILL_DIR: skill.dir,
    SKILLHOOK_PAYLOAD_PATH: paths.payload,
    SKILLHOOK_EVENT_PATH: paths.event,
    SKILLHOOK_PROMPT_PATH: paths.prompt,
    SKILLHOOK_RESPONSE_PATH: paths.response,
    SKILLHOOK_TRIGGER: input.event.trigger,
    SKILLHOOK_RUNNER: settings.runner,
    SKILLHOOK_HOME: home,
    SKILLHOOK_HUMAN_WAIT_SECONDS: String(humanWaitSeconds),
    ...(bin ? { SKILLHOOK_BIN: [bin.command, ...bin.args].map(shellQuote).join(" ") } : {}),
  };
  const env = buildRunEnv({ secrets: input.secrets, fileSecrets: input.fileSecrets, skill, config, jobVars, processEnv: input.processEnv });
  const runner = getRunner(settings.runner);
  const agentApi: AgentApiServer | undefined =
    agentApiMode === "mcp" && bin && settings.runner !== "shell"
      ? { name: AGENT_API_SERVER_NAME, command: bin.command, args: [...bin.args, "mcp", "--job", "--dir", home], env: { SKILLHOOK_JOB_ID: job.id, SKILLHOOK_JOB_DIR: paths.dir, SKILLHOOK_HOME: home, SKILLHOOK_HUMAN_WAIT_SECONDS: String(humanWaitSeconds) } }
      : undefined;
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
    paths: { payloadPath: paths.payload, eventPath: paths.event, promptPath: paths.prompt, lastMessagePath: paths.lastMessage, responsePath: paths.response, responseSchemaPath: paths.responseSchema },
    agentApi,
    resume: job.resume ? { sessionId: job.resume.session_id } : undefined,
  };
  return { runner, ctx, invocation: runner.build(ctx), built };
}
