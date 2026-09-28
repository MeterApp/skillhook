import { createControlHandlers } from "../cloud/control.js";
import { CloudLink } from "../cloud/link.js";
import { localBaseUrl } from "../client.js";
import { ConfigRef } from "../config.js";
import { DeliveryLog } from "../delivery-log.js";
import { ADMIN_TOKEN_ENV, readEnvFile } from "../env.js";
import { Events } from "../events.js";
import { HealthCache } from "../health.js";
import { ReadinessCache } from "../readiness.js";
import { baseRunEnv } from "../runners/env.js";
import { JobQueue } from "../queue.js";
import { createLogger } from "../logger.js";
import { Scheduler } from "../scheduler.js";
import { clearServerState, createServer, writeServerState, type ServerControl } from "../server.js";
import { serviceStatus } from "../service.js";
import { errorMessage } from "../util.js";
import { checkForUpdate, detectInstall, releaseNotesUrl, UPDATE_CHECK_INTERVAL_MS } from "../update.js";
import { VERSION } from "../version.js";
import { bool, num, str, type Ctx } from "./shared.js";

export async function serveCommand(ctx: Ctx): Promise<number> {
  const events = new Events();
  // One live config object for everything in this process; reloads patch it in place (see ConfigRef).
  const configRef = new ConfigRef(ctx.paths, ctx.config(), {
    events,
    onChange: (applied, next) => {
      if (applied.includes("log_level") && !str(ctx.flags, "log-level")) logger.setLevel(next.log_level);
      if (applied.includes("jobs")) store.configure({ maxJobs: next.jobs.max_jobs, dedupeWindowSeconds: next.jobs.dedupe_window_seconds });
    },
  });
  const config = configRef.current;
  const port = num(ctx.flags, "port") ?? config.port;
  const host = str(ctx.flags, "host") ?? config.host;
  const logger = createLogger({ level: (str(ctx.flags, "log-level") as "info" | undefined) ?? config.log_level, format: bool(ctx.flags, "pretty") || (ctx.io.isTTY && !ctx.json) ? "pretty" : "json" });
  events.setLogger(logger);
  const registry = ctx.registry();
  registry.onChange((change) => events.emit("skill.changed", change));
  const store = ctx.store();
  const deliveryLog = new DeliveryLog(ctx.paths.jobsDir, () => config.deliveries);
  const secrets = () => ctx.secrets();
  const readiness = new ReadinessCache({ config: () => config, env: () => baseRunEnv({ secrets: secrets(), fileSecrets: readEnvFile(ctx.paths.envFile), processEnv: ctx.io.env }), ttlMs: () => config.health.readiness_cache_seconds * 1000, events });
  const queue = new JobQueue({ store, config, registry, secrets, fileSecrets: () => readEnvFile(ctx.paths.envFile), logger, events, readiness });
  const scheduler = new Scheduler({ registry, store, queue, config, logger, events });
  const startedAt = new Date().toISOString();
  let link: CloudLink | undefined;
  const health = new HealthCache(ctx.paths, { ttlMs: () => config.health.cache_seconds * 1000, options: () => ({ env: ctx.io.env, timeoutMs: config.health.probe_timeout_seconds * 1000, live: () => ({ started_at: startedAt, queue: queue.stats() }), cloud: () => link?.status() }), events });
  let shuttingDown = false;
  const stop = async (reason: string, options: { force: boolean; waitSeconds: number }) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { reason, running: queue.stats().running, force: options.force, wait_seconds: options.waitSeconds });
    events.emit("server.stopping", { reason, running: queue.stats().running });
    scheduler.stop();
    server.close();
    if (options.force) await queue.shutdown();
    else if ((await queue.drain(options.waitSeconds * 1000)) > 0) {
      logger.warn("jobs still running after the wait; terminating them", { running: queue.stats().running });
      await queue.shutdown();
    }
    await link?.stop(reason);
    clearServerState(ctx.paths);
    process.exit(0);
  };
  const control: ServerControl = {
    supervised: async () => {
      const status = await serviceStatus(ctx.paths);
      return status.running && status.pid === process.pid;
    },
    restart: (options) => void stop("restart", options),
  };
  const server = createServer({ config, paths: ctx.paths, store, queue, registry, secrets, logger, events, deliveryLog, health, readiness, configRef, control, cloud: () => link?.status(), schedules: () => scheduler.status() });

  const loaded = registry.list();
  for (const error of loaded.errors) logger.error("skill failed to load", { skill: error.name, error: error.error });
  for (const project of loaded.projects) if (!project.error) logger.info("project linked", { dir: project.dir, file: project.file, hooks: project.hooks.map((h) => h.name) });
  const current = secrets();
  for (const skill of loaded.skills) {
    if (!skill.webhook) continue; // schedule-only: nothing to deliver, no secret needed
    if (skill.auth.type === "none") logger.warn("skill has no authentication", { skill: skill.name });
    else if (!current[skill.auth.secret_env]) logger.warn("skill secret not set; deliveries will get 503", { skill: skill.name, secret_env: skill.auth.secret_env });
  }
  if (!current[ADMIN_TOKEN_ENV]) logger.warn("admin token not set; admin endpoints are only reachable from localhost", { env: ADMIN_TOKEN_ENV });

  const recovered = store.recoverOnStartup();
  if (recovered.interrupted.length) logger.warn("marked jobs interrupted from a previous run", { jobs: recovered.interrupted.map((j) => j.id) });
  for (const job of recovered.queued) queue.enqueue(job);
  scheduler.start();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  const state = { pid: process.pid, host, port: boundPort, started_at: startedAt, version: VERSION, public_url: config.public_url };
  writeServerState(ctx.paths, state);
  events.emit("server.started", { state });
  // The cloud link idles until `skillhook cloud connect` enabled it (docs/cloud.md); it re-reads the config every few seconds.
  const fileSecrets = () => readEnvFile(ctx.paths.envFile);
  const cloudControl = createControlHandlers({ paths: ctx.paths, config, configRef, secrets, fileSecrets, registry, store, deliveryLog, queue, events, logger, serverControl: control });
  link = new CloudLink({ paths: ctx.paths, config, secrets, fileSecrets, events, logger, registry, store, deliveryLog, schedules: () => scheduler.status(), health, readiness, serverState: () => state, localBaseUrl: () => localBaseUrl({ host, port: boundPort }), env: ctx.io.env, queueStats: () => queue.stats(), runningJobs: () => queue.stats().running_ids, control: cloudControl });
  link.start();
  logger.info("skillhook listening", { url: `http://${host}:${boundPort}`, public_url: config.public_url, skills: loaded.skills.map((s) => s.name), concurrency: config.concurrency, home: ctx.paths.home, version: VERSION });
  if (config.public_url) for (const skill of loaded.skills) logger.info("webhook url", { skill: skill.name, url: `${config.public_url}/hooks/${skill.name}` });

  // A long-running server is the one place a daily update check is free: log it, never act on it.
  const announceUpdate = async () => {
    try {
      const status = await checkForUpdate(ctx.paths, { env: ctx.io.env, config });
      if (status.available) logger.info("update available", { current: status.current, latest: status.latest, command: detectInstall(undefined, status.latest ?? "latest").display, release_notes: releaseNotesUrl(status.latest ?? "") });
    } catch {
      /* never fatal */
    }
  };
  void announceUpdate();
  setInterval(() => void announceUpdate(), UPDATE_CHECK_INTERVAL_MS).unref();

  // A manual edit of skillhook.json is picked up within a few seconds (`skillhook config set` also tells the server).
  setInterval(() => {
    const reload = configRef.poll((error) => logger.error("config file is invalid; keeping the running settings", { error: errorMessage(error) }));
    if (reload?.changed.length) logger.info("config reloaded", { applied: reload.applied, restart_required: reload.restart_required });
  }, 5_000).unref();
  process.on("SIGINT", () => void stop("SIGINT", { force: true, waitSeconds: 0 }));
  process.on("SIGTERM", () => void stop("SIGTERM", { force: true, waitSeconds: 0 }));
  await new Promise(() => {
    /* run until signalled */
  });
  return 0;
}
