// Commands the cloud sends, run one at a time: arguments validated against the protocol, the machine's policy
// consulted (`commandAllowed`), the same functions the CLI and the MCP server call, results redacted and scrubbed.
// Read commands are here; control commands (running skills, answering jobs, changing config, restarting) come with the
// control handlers in `deps.control` and answer `unsupported_command` until a version provides them.
import { readFileSync } from "node:fs";
import { HOT_CONFIG_KEYS, RESTART_CONFIG_KEYS, type Config } from "../config.js";
import { readDeliveryBody, type DeliveryLog } from "../delivery-log.js";
import type { Secrets } from "../env.js";
import type { HealthCache } from "../health.js";
import type { JobStore } from "../jobs.js";
import type { Logger } from "../logger.js";
import type { Paths } from "../paths.js";
import { readProgress } from "../progress.js";
import type { ReadinessCache } from "../readiness.js";
import type { SkillRegistry } from "../registry.js";
import type { ScheduleStatus } from "../scheduler.js";
import { publicJob, skillSummary, type ServerState } from "../server.js";
import { readServiceLog, serviceStatus } from "../service.js";
import { collectStats, parseSince } from "../stats.js";
import { currentExposures, findTailscale, tailscaleStatus } from "../tailscale.js";
import { updateStatusFromCache } from "../update.js";
import { errorMessage, nowIso } from "../util.js";
import { commandAllowed, type CloudPolicy } from "./config.js";
import type { CommandLedger } from "./outbox.js";
import { COMMAND_CLASS, parseCommandArgs, type Command, type CommandErrorCode, type CommandResult, type CommandType, type Snapshot } from "./protocol.js";
import { redactUpload, scrubSecrets, secretValues } from "./redact.js";

export class CommandError extends Error {
  constructor(
    public readonly code: CommandErrorCode,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export interface CommandDeps {
  paths: Paths;
  config: Config;
  secrets: () => Secrets;
  fileSecrets: () => Secrets;
  registry: SkillRegistry;
  store: JobStore;
  deliveryLog?: DeliveryLog;
  schedules?: () => ScheduleStatus[];
  health?: HealthCache;
  readiness?: ReadinessCache;
  serverState?: () => ServerState | undefined;
  logger: Logger;
  policy: () => CloudPolicy;
  ledger: CommandLedger;
  snapshot: () => Snapshot;
  /** Whether payload bodies may leave the machine (`cloud.upload_payloads` and the cloud's hint). */
  uploadPayloads: () => boolean;
  uploadArtifacts: () => boolean;
  /** Control handlers (skill.run, job.answer, config.patch, …), when this version has them. */
  control?: Partial<Record<CommandType, CommandHandler>>;
}

export type CommandHandler = (args: never, command: Command, deps: CommandDeps) => Promise<CommandOutcome> | CommandOutcome;
export interface CommandOutcome {
  result: unknown;
  sensitive?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 90_000;
const ARTIFACT_INLINE_DEFAULT = 256 * 1024;

type Args<T> = T;

const readHandlers: Partial<Record<CommandType, CommandHandler>> = {
  ping: () => ({ result: { pong: true, server_time: nowIso() } }),
  "health.get": async (args: Args<{ deep?: boolean; refresh?: boolean }>, _c, deps) => {
    if (!deps.health) throw new CommandError("unavailable", "this server has no health cache");
    const { report, cached } = await deps.health.get({ deep: args.deep ?? true, refresh: args.refresh, network: false });
    return { result: { ...report, cached } };
  },
  "snapshot.get": (_a, _c, deps) => ({ result: deps.snapshot() }),
  "runners.get": async (args: Args<{ refresh?: boolean }>, _c, deps) => {
    if (!deps.readiness) throw new CommandError("unavailable", "this server has no readiness checks");
    return { result: { runners: await deps.readiness.all({ refresh: args.refresh }), default_runner: deps.config.defaults.runner } };
  },
  "skills.list": (_a, _c, deps) => {
    const loaded = deps.registry.list();
    const secrets = deps.secrets();
    return { result: { skills: loaded.skills.map((s) => skillSummary(s, deps.config, secrets)), errors: loaded.errors } };
  },
  "skill.get": (args: Args<{ name: string }>, _c, deps) => {
    const skill = deps.registry.get(args.name);
    if (!skill) throw new CommandError("not_found", `no skill named "${args.name}"`);
    let content: string | undefined;
    try {
      content = readFileSync(skill.file, "utf8");
    } catch {
      content = undefined;
    }
    return { result: { ...skillSummary(skill, deps.config, deps.secrets()), file: skill.file, content } };
  },
  "delivery.list": (args: Args<{ skill?: string; outcome?: never; since?: string; after?: string; limit?: number }>, _c, deps) => {
    if (!deps.deliveryLog) throw new CommandError("unavailable", "this server has no delivery log");
    const page = deps.deliveryLog.list({ skill: args.skill, outcome: args.outcome, since: args.since, after: args.after, limit: args.limit ?? 50 });
    return { result: { deliveries: page.deliveries, next_after: page.next_after } };
  },
  "delivery.get": (args: Args<{ id: string; include_body?: boolean }>, _c, deps) => {
    if (!deps.deliveryLog) throw new CommandError("unavailable", "this server has no delivery log");
    const delivery = deps.deliveryLog.get(args.id);
    if (!delivery) throw new CommandError("not_found", `unknown delivery ${args.id}`);
    const body = args.include_body && deps.uploadPayloads() ? readDeliveryBody(deps.deliveryLog, deps.store, delivery) : undefined;
    return { result: { delivery, ...(body ? { body } : {}), ...(args.include_body && !deps.uploadPayloads() ? { body_withheld: "cloud.upload_payloads is false on this machine" } : {}) } };
  },
  "job.list": (args: Args<{ skill?: string; status?: never; outcome?: never; failure?: never; trigger?: never; waiting?: boolean; since?: string; after?: string; limit?: number }>, _c, deps) => {
    const page = deps.store.listPage({ skill: args.skill, status: args.status, outcome: args.outcome, failure: args.failure, trigger: args.trigger, waiting: args.waiting || undefined, since: args.since, after: args.after, limit: args.limit ?? 50 });
    return { result: { jobs: page.jobs.map(publicJob), next_after: page.next_after } };
  },
  "job.get": (args: Args<{ id: string; include?: ("stdout" | "stderr" | "prompt" | "result" | "payload" | "event" | "response")[] }>, _c, deps) => {
    const job = deps.store.get(args.id);
    if (!job) throw new CommandError("not_found", `unknown job ${args.id}`);
    const artifacts: Record<string, string | undefined> = {};
    if (deps.uploadArtifacts()) for (const name of args.include ?? []) artifacts[name] = deps.store.readArtifact(job.id, name, 64 * 1024);
    const progress = readProgress(deps.store.pathsFor(job.id).dir, { timelineLimit: 100 });
    return { result: { job: publicJob(job), artifacts, ...(progress.timeline.length || progress.question ? { progress } : {}), ...(args.include?.length && !deps.uploadArtifacts() ? { artifacts_withheld: "cloud.upload_artifacts is false on this machine" } : {}) } };
  },
  "job.artifact": (args: Args<{ id: string; name: "stdout" | "stderr" | "prompt" | "result" | "payload" | "event" | "response"; max_inline_bytes?: number }>, _c, deps) => {
    if (!deps.uploadArtifacts()) throw new CommandError("denied_by_policy", "cloud.upload_artifacts is false on this machine");
    const job = deps.store.get(args.id);
    if (!job) throw new CommandError("not_found", `unknown job ${args.id}`);
    const max = args.max_inline_bytes ?? ARTIFACT_INLINE_DEFAULT;
    const text = deps.store.readArtifact(job.id, args.name, max);
    if (text === undefined) throw new CommandError("not_found", `job ${args.id} has no ${args.name}`);
    return { result: { job_id: job.id, name: args.name, text, truncated: text.startsWith("…") } };
  },
  "job.progress.get": (args: Args<{ id: string }>, _c, deps) => {
    const job = deps.store.get(args.id);
    if (!job) throw new CommandError("not_found", `unknown job ${args.id}`);
    return { result: { job_id: job.id, status: job.status, ...readProgress(deps.store.pathsFor(job.id).dir, { timelineLimit: 200 }) } };
  },
  "stats.get": (args: Args<{ since?: string; until?: string; skill?: string }>, _c, deps) => {
    const since = parseSince(args.since);
    if (args.since && !since) throw new CommandError("invalid_args", "since must be like 24h, 7d or an ISO-8601 instant");
    const until = parseSince(args.until);
    if (args.until && !until) throw new CommandError("invalid_args", "until must be an ISO-8601 instant");
    return { result: collectStats(deps.store, deps.deliveryLog, { since, until, skill: args.skill }) };
  },
  "config.get": (_a, _c, deps) => ({ result: { config: deps.config, hot_keys: HOT_CONFIG_KEYS, restart_keys: RESTART_CONFIG_KEYS } }),
  "secret.list": (_a, _c, deps) => ({ result: { names: Object.keys(deps.fileSecrets()).sort() } }),
  "service.status": async (_a, _c, deps) => ({ result: { service: await serviceStatus(deps.paths), this_pid: process.pid } }),
  "logs.tail": (args: Args<{ lines?: number }>, _c, deps) => {
    const text = readServiceLog(deps.paths, args.lines ?? 200);
    return { result: { lines: text ? text.replace(/\n$/, "").split("\n") : [] } };
  },
  "schedules.list": (_a, _c, deps) => ({ result: { schedules: deps.schedules?.() ?? [] } }),
  "update.check": (_a, _c, deps) => ({ result: { ...updateStatusFromCache(deps.paths), note: "from the daily check's cache; the machine does not ask the registry for the cloud" } }),
  "expose.status": async () => {
    const binary = findTailscale();
    const status = binary ? await tailscaleStatus(binary) : undefined;
    const exposures = binary && status?.backendState === "Running" ? await currentExposures(binary) : [];
    return { result: { tailscale: binary ? { found: true, backend_state: status?.backendState ?? null, dns_name: status?.dnsName ?? null } : { found: false }, exposures } };
  },
};

function timeoutFor(command: Command): number {
  if (command.timeout_ms) return Math.min(600_000, command.timeout_ms);
  return command.type === "health.get" || command.type === "skill.run" || command.type === "skill.test" ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

export interface CommandDispatcher {
  /** Runs (or refuses) one command and records the result in the ledger. A command seen before returns its cached result. */
  run(command: Command): Promise<CommandResult>;
}

export function createCommandDispatcher(deps: CommandDeps): CommandDispatcher {
  const finish = (command: Command, startedAt: string, outcome: { ok: true; result: unknown; sensitive?: boolean } | { ok: false; error: { code: CommandErrorCode; message: string; hint?: string } }): CommandResult => {
    const finished = nowIso();
    const values = secretValues(deps.fileSecrets());
    const base = { command_id: command.id, started_at: startedAt, finished_at: finished, duration_ms: Math.max(0, Date.parse(finished) - Date.parse(startedAt)) };
    const result: CommandResult = outcome.ok
      ? { ...base, ok: true, result: outcome.sensitive ? outcome.result : scrubSecrets(redactUpload(outcome.result), values), ...(outcome.sensitive ? { sensitive: true } : {}) }
      : { ...base, ok: false, error: { ...outcome.error, message: scrubSecrets(outcome.error.message, values) } };
    deps.ledger.complete(result);
    return result;
  };

  return {
    async run(command) {
      const cached = deps.ledger.cachedResult(command.id);
      if (cached) return cached;
      if (deps.ledger.seen(command.id)) return finish(command, nowIso(), { ok: false, error: { code: "duplicate", message: "this command already ran; its result was sensitive and is not kept" } });
      const startedAt = nowIso();
      if (command.expires_at && Date.parse(command.expires_at) < Date.now()) return finish(command, startedAt, { ok: false, error: { code: "expired", message: `expired at ${command.expires_at}` } });
      const policy = commandAllowed(command.type, deps.policy());
      if (!policy.allowed) return finish(command, startedAt, { ok: false, error: { code: "denied_by_policy", message: policy.reason ?? "refused by this machine's policy", hint: "cloud.mode / cloud.allow_commands in skillhook.json on the machine decide" } });
      const parsed = parseCommandArgs(command.type, command.args);
      if (!parsed) return finish(command, startedAt, { ok: false, error: { code: "unsupported_command", message: `unknown command ${command.type}` } });
      if (!parsed.ok) return finish(command, startedAt, { ok: false, error: { code: "invalid_args", message: parsed.message } });
      const handler = readHandlers[command.type] ?? deps.control?.[command.type];
      if (!handler) return finish(command, startedAt, { ok: false, error: { code: "unsupported_command", message: `${command.type} (${COMMAND_CLASS[command.type]}) is not available in this version of skillhook`, hint: "update skillhook on the machine" } });
      deps.logger.info("cloud command", { command: command.id, type: command.type, by: command.requested_by?.name ?? command.requested_by?.kind });
      try {
        const outcome = await Promise.race([
          Promise.resolve(handler(parsed.args as never, command, deps)),
          new Promise<never>((_, reject) => setTimeout(() => reject(new CommandError("timeout", `${command.type} took longer than ${timeoutFor(command)} ms`)), timeoutFor(command)).unref()),
        ]);
        return finish(command, startedAt, { ok: true, result: outcome.result, sensitive: outcome.sensitive });
      } catch (error) {
        if (error instanceof CommandError) return finish(command, startedAt, { ok: false, error: { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) } });
        deps.logger.error("cloud command failed", { command: command.id, type: command.type, error: errorMessage(error) });
        return finish(command, startedAt, { ok: false, error: { code: "internal", message: errorMessage(error) } });
      }
    },
  };
}
