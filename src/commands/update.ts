import { findRunningServer } from "../client.js";
import { restartService, serviceStatus } from "../service.js";
import { run } from "../tailscale.js";
import { checkForUpdate, detectInstall, formatUpdateNotice, registryUrl, releaseNotesUrl } from "../update.js";
import { VERSION } from "../version.js";
import { bool, CommandError, type Ctx } from "./shared.js";

export const UPDATE_USAGE = `Usage: skillhook update [--install]

Asks the npm registry for the newest skillhook and prints how to get it.
  --install   upgrade with the package manager that installed skillhook (npm, pnpm, bun, yarn), then restart
              the background service when it is installed and has no jobs in progress

Every command also mentions a newer version once a day (cached in <home>/update-check.json). Turn that off with
SKILLHOOK_NO_UPDATE_CHECK=1, CI=1, or "update_check": false in skillhook.json; point it at a mirror with
SKILLHOOK_NPM_REGISTRY.`;

export async function updateCommand(ctx: Ctx): Promise<number> {
  if (bool(ctx.flags, "help", "h")) {
    ctx.io.stdout(`${UPDATE_USAGE}\n`);
    return 0;
  }
  const refreshOnly = bool(ctx.flags, "refresh"); // spawned in the background by other commands; only refreshes the cache
  const registry = registryUrl(ctx.io.env);
  const status = await checkForUpdate(ctx.paths, { env: ctx.io.env, force: true, timeoutMs: refreshOnly ? 15_000 : 8_000 });
  if (refreshOnly) return 0;

  const install = detectInstall();
  const data: Record<string, unknown> = {
    ok: true,
    current: status.current,
    latest: status.latest,
    available: status.available,
    checked_at: status.checked_at,
    registry,
    install: { method: install.method, command: install.display },
    release_notes: status.latest ? releaseNotesUrl(status.latest) : null,
  };
  if (status.latest === null) {
    ctx.print(`Could not reach ${registry} to check for updates (this is skillhook ${VERSION}).`, { ...data, ok: false });
    return 1;
  }
  const cachedNote = status.cached ? `\n(${registry} did not answer; this is what it said at ${status.checked_at})` : "";
  if (!bool(ctx.flags, "install")) {
    ctx.print(`${status.available ? formatUpdateNotice(status, install) : `skillhook ${VERSION} is the latest version.`}${cachedNote}`, { ...data, cached: status.cached });
    return 0;
  }
  if (!status.available) {
    ctx.print(`skillhook ${VERSION} is already the latest version.`, { ...data, installed: false });
    return 0;
  }
  const target = detectInstall(undefined, status.latest);
  if (!target.command) throw new CommandError(`skillhook ${VERSION} runs from ${target.method === "npx" ? "the npx cache" : "a source checkout"}; upgrade with: ${target.display}`);
  if (!ctx.json) ctx.warn(`Upgrading skillhook ${VERSION} → ${status.latest}: ${target.display}`);
  const result = await run(target.command[0] as string, target.command.slice(1), { timeoutMs: 300_000 });
  if (result.code !== 0) throw new CommandError(`${target.display} failed (exit ${result.code}):\n${(result.stderr || result.stdout).trim()}`);

  // A running service keeps executing the old code until it restarts; do that only when no job would be interrupted.
  let serviceNote: string | undefined;
  let restarted = false;
  const service = await serviceStatus(ctx.paths);
  if (service.running) {
    const running = await findRunningServer(ctx.paths);
    const busy = running?.health.queue ? running.health.queue.running + running.health.queue.queued : 0;
    if (busy > 0) serviceNote = `The background service still runs ${VERSION} and has ${busy} job(s) in progress; restart it later with: skillhook service restart`;
    else {
      const restart = await restartService();
      restarted = restart.ok;
      serviceNote = restart.ok ? `Background service restarted; it now runs ${status.latest}.` : `Could not restart the background service (${restart.output}). Run: skillhook service restart`;
    }
  }
  const lines = [`✓ Installed skillhook ${status.latest} (${target.display})`, ...(serviceNote ? [serviceNote] : []), `Release notes: ${releaseNotesUrl(status.latest)}`];
  ctx.print(lines.join("\n"), { ...data, installed: true, service_restarted: restarted, service_note: serviceNote ?? null });
  return 0;
}
