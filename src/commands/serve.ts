import { ADMIN_TOKEN_ENV, readEnvFile } from "../env.js";
import { JobQueue } from "../queue.js";
import { createLogger } from "../logger.js";
import { clearServerState, createServer, writeServerState } from "../server.js";
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
  const server = createServer({ config, paths: ctx.paths, store, queue, registry, secrets, logger });

  const loaded = registry.list();
  for (const error of loaded.errors) logger.error("skill failed to load", { skill: error.name, error: error.error });
  const current = secrets();
  for (const skill of loaded.skills) {
    if (skill.auth.type === "none") logger.warn("skill has no authentication", { skill: skill.name });
    else if (!current[skill.auth.secret_env]) logger.warn("skill secret not set; deliveries will get 503", { skill: skill.name, secret_env: skill.auth.secret_env });
  }
  if (!current[ADMIN_TOKEN_ENV]) logger.warn("admin token not set; admin endpoints are only reachable from localhost", { env: ADMIN_TOKEN_ENV });

  const recovered = store.recoverOnStartup();
  if (recovered.interrupted.length) logger.warn("marked jobs interrupted from a previous run", { jobs: recovered.interrupted.map((j) => j.id) });
  for (const job of recovered.queued) queue.enqueue(job);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  writeServerState(ctx.paths, { pid: process.pid, host, port: boundPort, started_at: new Date().toISOString(), version: VERSION, public_url: config.public_url });
  logger.info("skillhook listening", { url: `http://${host}:${boundPort}`, public_url: config.public_url, skills: loaded.skills.map((s) => s.name), concurrency: config.concurrency, home: ctx.paths.home, version: VERSION });
  if (config.public_url) for (const skill of loaded.skills) logger.info("webhook url", { skill: skill.name, url: `${config.public_url}/hooks/${skill.name}` });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal, running: queue.stats().running });
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
