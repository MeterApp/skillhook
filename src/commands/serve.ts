import { ADMIN_TOKEN_ENV, readEnvFile } from "../env.js";
import { JobQueue } from "../queue.js";
import { createLogger } from "../logger.js";
import { Scheduler } from "../scheduler.js";
import { clearServerState, createServer, writeServerState } from "../server.js";
import { checkForUpdate, detectInstall, releaseNotesUrl, UPDATE_CHECK_INTERVAL_MS } from "../update.js";
import { VERSION } from "../version.js";
import { bool, num, str, type Ctx } from "./shared.js";

export async function serveCommand(ctx: Ctx): Promise<number> {
  const config = { ...ctx.config() };
  const port = num(ctx.flags, "port") ?? config.port;
  const host = str(ctx.flags, "host") ?? config.host;
  const logger = createLogger({ level: (str(ctx.flags, "log-level") as "info" | undefined) ?? config.log_level, format: bool(ctx.flags, "pretty") || (ctx.io.isTTY && !ctx.json) ? "pretty" : "json" });
  const registry = ctx.registry();
  const store = ctx.store();
  const secrets = () => ctx.secrets();
  const queue = new JobQueue({ store, config, registry, secrets, fileSecrets: () => readEnvFile(ctx.paths.envFile), logger });
  const scheduler = new Scheduler({ registry, store, queue, config, logger });
  const server = createServer({ config, paths: ctx.paths, store, queue, registry, secrets, logger, schedules: () => scheduler.status() });

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
  writeServerState(ctx.paths, { pid: process.pid, host, port: boundPort, started_at: new Date().toISOString(), version: VERSION, public_url: config.public_url });
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

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal, running: queue.stats().running });
    scheduler.stop();
    server.close();
    await queue.shutdown();
    clearServerState(ctx.paths);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await new Promise(() => {
    /* run until signalled */
  });
  return 0;
}
