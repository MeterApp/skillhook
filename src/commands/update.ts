import { applyUpdate, checkForUpdate, detectInstall, formatUpdateNotice, registryUrl } from "../update.js";
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
  if (bool(ctx.flags, "refresh")) {
    // Spawned in the background by other commands; only refreshes the cache.
    await checkForUpdate(ctx.paths, { env: ctx.io.env, force: true, timeoutMs: 15_000 });
    return 0;
  }
  const install = bool(ctx.flags, "install");
  if (install && !ctx.json) ctx.warn(`Checking ${registryUrl(ctx.io.env)} …`);
  const result = await applyUpdate(ctx.paths, { env: ctx.io.env, install, timeoutMs: 8_000 });
  const data: Record<string, unknown> = { ...result, install: result.install };
  if (result.latest === null) {
    ctx.print(`Could not reach ${result.registry} to check for updates (this is skillhook ${VERSION}).`, { ...data, ok: false });
    return 1;
  }
  const cachedNote = result.cached ? `\n(${result.registry} did not answer; this is what it said at ${result.checked_at})` : "";
  if (!install) {
    ctx.print(`${result.available ? formatUpdateNotice({ current: result.current, latest: result.latest, available: true, checked_at: result.checked_at, disabled: false, cached: result.cached }, detectInstall()) : `skillhook ${VERSION} is the latest version.`}${cachedNote}`, data);
    return 0;
  }
  if (!result.available) {
    ctx.print(`skillhook ${VERSION} is already the latest version.`, { ...data, installed: false });
    return 0;
  }
  if (!result.ok || !result.installed) throw new CommandError(result.error ?? "the update could not be installed");
  const lines = [`✓ Installed skillhook ${result.latest} (${result.install.command})`, ...(result.service_note ? [result.service_note] : []), `Release notes: ${result.release_notes ?? ""}`];
  ctx.print(lines.join("\n"), data);
  return 0;
}
