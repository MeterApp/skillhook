// The commands that act on the machine, for a machine in `cloud.mode: control` (or with them in `cloud.allow_commands`):
// the same functions the CLI, the admin API and the MCP server call. The policy check happens before any of this runs
// (`commandAllowed` in the dispatcher); these handlers add what each action needs on top (config keys the cloud may
// never touch, skills that belong to a repository, secrets that must be sealed to whoever asked).
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AnswerError, answerJob } from "../answer.js";
import { ConfigError, updateConfig, type Config, type ConfigRef } from "../config.js";
import type { DeliveryLog } from "../delivery-log.js";
import { isSkillhookCredential, type Secrets } from "../env.js";
import type { Events } from "../events.js";
import type { JobStore } from "../jobs.js";
import type { Logger } from "../logger.js";
import { createAdhocJob, createManualJob } from "../manual.js";
import { generateSecretFor, resolveSecretName, setSecret, type Ops } from "../ops.js";
import type { Paths } from "../paths.js";
import type { JobQueue } from "../queue.js";
import type { SkillRegistry } from "../registry.js";
import { planReplay, ReplayError } from "../replay.js";
import type { RunOverrides } from "../run.js";
import { buildSchedulePayload } from "../scheduler.js";
import type { ServerControl } from "../server.js";
import { parseSkillDocument, SkillError } from "../skills.js";
import { applyUpdate, type ApplyUpdateResult } from "../update.js";
import { isValidSkillName } from "../util.js";
import { CommandError, type CommandHandler } from "./commands.js";
import { CLOUD_PRIVATE_KEY_ENV } from "./config.js";
import type { Command, CommandType } from "./protocol.js";
import { openSealed, SealError, sealForRecipient } from "./seal.js";

/** Top-level config keys the cloud may never change, whatever the mode: the bind address, what runs as the agent, and the link itself. */
export const CLOUD_DENIED_CONFIG_KEYS = ["$schema", "host", "port", "trust_proxy", "runners", "env_passthrough", "projects", "cloud"];

export interface ControlDeps {
  paths: Paths;
  config: Config;
  configRef?: ConfigRef;
  secrets: () => Secrets;
  fileSecrets: () => Secrets;
  registry: SkillRegistry;
  store: JobStore;
  deliveryLog?: DeliveryLog;
  queue: JobQueue;
  events?: Events;
  logger: Logger;
  /** Restart through launchd / systemd (what `POST /control/restart` uses). */
  serverControl?: ServerControl;
  /** Injectable for tests. */
  applyUpdate?: (options: { install: boolean }) => Promise<ApplyUpdateResult>;
}

type Args<T> = T;
type Overrides = { runner?: RunOverrides["runner"]; model?: string; effort?: string };

/** Who asked, as the job and the log will say it. */
function requester(command: Command): string {
  const by = command.requested_by;
  return (by?.name ?? by?.id ?? by?.kind ?? "cloud").slice(0, 200);
}

/** The machine's own credentials (the admin token, the cloud link's) are never generated or set from the cloud, by whatever name: a skill's or the variable's. */
function refuseOwnCredential(ops: Ops, name: string, verb: "generated" | "set"): void {
  const { env } = resolveSecretName(ops, name);
  if (isSkillhookCredential(env)) throw new CommandError("denied_by_policy", `${env} is this machine's own credential: it is not ${verb} from the cloud`);
}

function overridesOf(args: Overrides): RunOverrides {
  return { ...(args.runner ? { runner: args.runner } : {}), ...(args.model ? { model: args.model } : {}), ...(args.effort ? { effort: args.effort } : {}) };
}

export function createControlHandlers(deps: ControlDeps): Partial<Record<CommandType, CommandHandler>> {
  const ops: Ops = { paths: deps.paths, config: deps.config, secrets: deps.secrets, fileSecrets: deps.fileSecrets, registry: deps.registry, store: deps.store, deliveryLog: deps.deliveryLog as Ops["deliveryLog"], logger: deps.logger };
  const cloudHeaders = (command: Command, extra: Record<string, string> = {}) => ({ ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])), "user-agent": "skillhook-cloud", "x-skillhook-cloud-user": requester(command) });

  const replay = (source: "delivery" | "job", args: { id: string; skip_filters?: boolean; force?: boolean } & Overrides, command: Command) => {
    let plan: ReturnType<typeof planReplay>;
    try {
      plan = planReplay({ config: deps.config, store: deps.store, registry: deps.registry, deliveryLog: deps.deliveryLog }, { source, id: args.id, skipFilters: args.skip_filters, force: args.force, overrides: overridesOf(args) });
    } catch (error) {
      if (error instanceof ReplayError) throw new CommandError(error.status === 404 ? "not_found" : "conflict", error.message);
      throw error;
    }
    if (!plan.ok) return { result: { accepted: false, skipped: true, reason: plan.reason } };
    const job = createManualJob({ config: deps.config, store: deps.store }, { ...plan.input, headers: { ...(plan.input.headers ?? {}), "x-skillhook-cloud-user": requester(command) } });
    deps.queue.enqueue(job);
    return { result: { accepted: true, job_id: job.id, skill: job.skill, replay_of: job.replay_of } };
  };

  return {
    "skill.run": (args: Args<{ name: string; payload?: unknown; headers?: Record<string, string> } & Overrides>, command) => {
      const skill = deps.registry.get(args.name);
      if (!skill) throw new CommandError("not_found", `no skill named "${args.name}"`);
      if (!skill.enabled) throw new CommandError("conflict", `skill "${args.name}" is disabled`);
      const job = createManualJob({ config: deps.config, store: deps.store }, { skill, payload: args.payload ?? {}, headers: cloudHeaders(command, args.headers), trigger: "api", overrides: overridesOf(args), sourceMethod: "CLOUD" });
      deps.queue.enqueue(job);
      deps.logger.info("skill run from the cloud", { skill: skill.name, job: job.id, by: requester(command) });
      return { result: { accepted: true, job_id: job.id, skill: skill.name, runner: job.runner } };
    },

    "skill.test": (args: Args<{ skill_md: string; payload?: unknown; headers?: Record<string, string>; cwd?: string } & Overrides>, command) => {
      let created: ReturnType<typeof createAdhocJob>;
      try {
        created = createAdhocJob({ config: deps.config, store: deps.store }, { skillMd: args.skill_md, payload: args.payload ?? {}, headers: cloudHeaders(command, args.headers), overrides: { ...overridesOf(args), ...(args.cwd ? { cwd: args.cwd } : {}) } });
      } catch (error) {
        if (error instanceof SkillError) throw new CommandError("invalid_args", error.message);
        throw error;
      }
      deps.queue.enqueue(created.job);
      deps.logger.info("test run from the cloud", { skill: created.skill.name, job: created.job.id, by: requester(command) });
      return { result: { accepted: true, job_id: created.job.id, skill: created.skill.name, adhoc: true } };
    },

    "delivery.replay": (args: Args<{ id: string; skip_filters?: boolean; force?: boolean } & Overrides>, command) => replay("delivery", args, command),
    "job.replay": (args: Args<{ id: string; skip_filters?: boolean } & Overrides>, command) => replay("job", args, command),

    "job.cancel": (args: Args<{ id: string }>) => {
      const job = deps.store.get(args.id);
      if (!job) throw new CommandError("not_found", `unknown job ${args.id}`);
      if (!deps.queue.cancel(args.id)) throw new CommandError("conflict", `job ${args.id} is ${job.status}, not queued or running on this server`);
      return { result: { cancelled: true, job_id: args.id } };
    },

    "job.answer": (args: Args<{ id: string; answer: string; option?: string; by?: string; resume?: "auto" | "never" }>, command) => {
      try {
        const answered = answerJob(ops, { jobId: args.id, text: args.answer, option: args.option, by: args.by ?? requester(command), resume: args.resume }, { queue: deps.queue, events: deps.events });
        return { result: { job_id: args.id, delivered: answered.delivered, answer: answered.answer, resume_job_id: answered.resumeJob?.id ?? null } };
      } catch (error) {
        if (error instanceof AnswerError) throw new CommandError(error.status === 404 ? "not_found" : "conflict", error.message);
        throw error;
      }
    },

    "config.patch": (args: Args<{ set?: Record<string, unknown>; unset?: string[] }>) => {
      const keys = [...Object.keys(args.set ?? {}), ...(args.unset ?? [])];
      if (!keys.length) throw new CommandError("invalid_args", "nothing to change: give set and/or unset");
      const denied = keys.filter((key) => CLOUD_DENIED_CONFIG_KEYS.includes(key.split(".")[0] ?? ""));
      if (denied.length) throw new CommandError("denied_by_policy", `the cloud may not change ${denied.join(", ")} (${CLOUD_DENIED_CONFIG_KEYS.join(", ")} are changed on the machine only)`);
      try {
        updateConfig(deps.paths, { set: args.set, unset: args.unset });
      } catch (error) {
        if (error instanceof ConfigError) throw new CommandError("invalid_args", error.message);
        throw error;
      }
      const reload = deps.configRef?.reload();
      return { result: { applied: reload?.applied ?? [], restart_required_keys: reload?.restart_required ?? [], pending_restart: reload?.pending_restart ?? [] } };
    },

    "service.restart": async (args: Args<{ when?: "idle" | "now"; wait_seconds?: number }>, command) => {
      const control = deps.serverControl;
      if (!control) throw new CommandError("unavailable", "this server cannot restart itself");
      if (!(await control.supervised())) throw new CommandError("conflict", "this server is not run by launchd or systemd, so nothing would start it again");
      const when = args.when ?? "idle";
      const options = when === "now" ? { force: true, waitSeconds: 0 } : { force: false, waitSeconds: args.wait_seconds ?? 600 };
      deps.logger.warn("restart requested from the cloud", { when, by: requester(command) });
      // The answer goes out first; the restart happens once the cloud has it (or shortly after, if it never says so).
      return { result: { restarting: true, when, wait_seconds: options.waitSeconds, running: deps.queue.stats().running }, after: () => control.restart(options) };
    },

    "schedule.run": (args: Args<{ name: string }>, command) => {
      const skill = deps.registry.get(args.name);
      if (!skill) throw new CommandError("not_found", `no skill named "${args.name}"`);
      if (!skill.schedule) throw new CommandError("conflict", `skill "${args.name}" has no schedule`);
      const now = new Date();
      const payload = buildSchedulePayload(skill, now, { firedAt: now, manual: true });
      const job = createManualJob({ config: deps.config, store: deps.store }, { skill, payload, headers: cloudHeaders(command, { "x-skillhook-schedule": skill.schedule.cron, "x-skillhook-timezone": skill.schedule.timezone }), trigger: "api", sourceMethod: "CLOUD" });
      deps.queue.enqueue(job);
      return { result: { accepted: true, job_id: job.id, skill: skill.name } };
    },

    "update.install": async () => {
      const result = await (deps.applyUpdate ?? ((o: { install: boolean }) => applyUpdate(deps.paths, { install: o.install, restartService: false })))({ install: true });
      if (!result.ok) throw new CommandError("unavailable", result.error ?? "the update could not be installed");
      return { result };
    },

    "secret.generate": (args: Args<{ name: string; force?: boolean; recipient_key?: string }>) => {
      if (!args.recipient_key) throw new CommandError("invalid_args", "recipient_key is required: a generated secret travels only sealed to whoever asked for it");
      refuseOwnCredential(ops, args.name, "generated");
      const generated = generateSecretFor(ops, args.name, { force: args.force });
      if (!generated.generated) return { result: { secret_env: generated.env, existed: true, generated: false, note: "already set; pass force to rotate it" } };
      let sealed;
      try {
        sealed = sealForRecipient(generated.generated, args.recipient_key);
      } catch (error) {
        if (error instanceof SealError) throw new CommandError("invalid_args", `recipient_key: ${error.message}`);
        throw error;
      }
      return { result: { secret_env: generated.env, existed: generated.existed, generated: true }, sealed, sensitive: true };
    },

    "secret.set": (args: Args<{ name: string; sealed: { ciphertext: string; nonce: string; ephemeral_public_key: string } }>) => {
      refuseOwnCredential(ops, args.name, "set");
      const privateKey = deps.fileSecrets()[CLOUD_PRIVATE_KEY_ENV];
      if (!privateKey) throw new CommandError("unavailable", `this machine has no ${CLOUD_PRIVATE_KEY_ENV} (pair it again to create one)`);
      let value: string;
      try {
        value = openSealed(args.sealed, privateKey);
      } catch (error) {
        if (error instanceof SealError) throw new CommandError("invalid_args", error.message);
        throw error;
      }
      const { env } = setSecret(ops, args.name, value);
      return { result: { secret_env: env, set: true } };
    },

    "skill.put": (args: Args<{ name: string; content: string; allow_unauthenticated?: boolean }>, command) => {
      if (!isValidSkillName(args.name)) throw new CommandError("invalid_args", `"${args.name}" is not a valid skill name`);
      const existing = deps.registry.get(args.name);
      if (existing && existing.source.type !== "home") throw new CommandError("conflict", `"${args.name}" comes from ${existing.source.type === "project" ? "a linked repository" : existing.source.type}; change it there`);
      const dir = path.join(deps.paths.skillsDir, args.name);
      let skill: ReturnType<typeof parseSkillDocument>;
      try {
        skill = parseSkillDocument(args.content, dir);
      } catch (error) {
        if (error instanceof SkillError) throw new CommandError("invalid_args", error.message);
        throw error;
      }
      if (skill.auth.type === "none" && skill.webhook && !args.allow_unauthenticated) throw new CommandError("invalid_args", "this skill has auth: none (anyone with the URL could run it); pass allow_unauthenticated to install it anyway");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), args.content);
      const secretEnv = "secret_env" in skill.auth ? skill.auth.secret_env : undefined;
      deps.logger.info("skill written from the cloud", { skill: args.name, created: !existing, by: requester(command) });
      return { result: { name: args.name, file: path.join(dir, "SKILL.md"), created: !existing, secret_env: secretEnv ?? null, secret_configured: secretEnv ? Boolean(deps.secrets()[secretEnv]) : null } };
    },

    "skill.delete": (args: Args<{ name: string }>, command) => {
      const skill = deps.registry.get(args.name);
      if (!skill) throw new CommandError("not_found", `no skill named "${args.name}"`);
      if (skill.source.type !== "home") throw new CommandError("conflict", `"${args.name}" comes from ${skill.source.type === "project" ? "a linked repository" : skill.source.type}; remove it there`);
      const dir = path.dirname(skill.file);
      if (path.dirname(dir) !== path.resolve(deps.paths.skillsDir)) throw new CommandError("conflict", `"${args.name}" is not a directory of ${deps.paths.skillsDir}`);
      // Kept, not deleted: the directory moves under the jobs directory (outside the link's spool, which a disconnect clears), where a person can restore it.
      const target = path.join(deps.paths.jobsDir, ".removed-skills", `${args.name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      mkdirSync(path.dirname(target), { recursive: true });
      try {
        renameSync(dir, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        cpSync(dir, target, { recursive: true });
        rmSync(dir, { recursive: true, force: true });
      }
      deps.logger.warn("skill removed from the cloud", { skill: args.name, kept_at: target, by: requester(command) });
      return { result: { removed: true, name: args.name, kept_at: target, restorable: existsSync(target) } };
    },
  };
}
