import { mergedPath } from "../runners/env.js";
import { applyUpdate, checkForUpdate, detectInstall, formatUpdateNotice, refreshPlugins, registryUrl, runBackgroundUpdate, type PluginRefresh } from "../update.js";
import { readJsonFileOr } from "../util.js";
import { VERSION } from "../version.js";
import { bool, CommandError, type Ctx } from "./shared.js";

export const UPDATE_USAGE = `Usage: skillhook update [--install [--no-plugins]]

Asks the npm registry for the newest skillhook and prints how to get it.
  --install      upgrade now with the package manager that installed skillhook (npm, pnpm, bun, yarn, Volta), restart
                 the background service when it is installed and has no jobs in progress, and update the skillhook
                 plugin wherever Claude Code or Codex has it installed
  --no-plugins   with --install, leave the Claude Code and Codex plugins alone

skillhook also updates itself: at most once an hour a command asks the registry in the background (cached in
<home>/update-check.json) and installs a newer version the same way; the next command runs it, and the service restarts
itself onto it once no job is running. "auto_update": false in skillhook.json only reports a newer version (after
interactive commands, in doctor and in the server log); SKILLHOOK_NO_UPDATE_CHECK=1, CI=1 or "update_check": false turn
the check off as well. SKILLHOOK_NPM_REGISTRY points it at a mirror.`;

/** The person's own environment, for their Claude Code and Codex (not the job environment the runners get). */
function personEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") out[key] = value;
  out.PATH = mergedPath(env.PATH);
  return out;
}

async function updatePlugins(ctx: Ctx): Promise<PluginRefresh[]> {
  if (ctx.flags.plugins === false) return [];
  let commands = { claude: "claude" as string | string[], codex: "codex" as string | string[] };
  try {
    const config = ctx.config();
    commands = { claude: config.runners.claude.command, codex: config.runners.codex.command };
  } catch {
    /* an invalid skillhook.json does not stop the plugin update: the defaults are on PATH */
  }
  return refreshPlugins({ ...commands, env: personEnv(ctx.io.env) });
}

export async function updateCommand(ctx: Ctx): Promise<number> {
  if (bool(ctx.flags, "refresh")) {
    // Started detached by other commands and by `serve`: the registry check and, with auto_update, the install.
    await runBackgroundUpdate(ctx.paths, { env: ctx.io.env, config: readJsonFileOr<{ update_check?: boolean; auto_update?: boolean }>(ctx.paths.configFile, {}) });
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
  if (result.available && (!result.ok || !result.installed)) throw new CommandError(result.error ?? "the update could not be installed");
  const lines = result.available
    ? [`✓ Installed skillhook ${result.latest} (${result.install.command})`, ...(result.service_note ? [result.service_note] : []), `Release notes: ${result.release_notes ?? ""}`]
    : [`skillhook ${VERSION} is already the latest version.`];
  const plugins = await updatePlugins(ctx);
  for (const entry of plugins) lines.push(`${entry.ok ? "✓" : "✗"} ${entry.host}: ${entry.id} — ${entry.detail}`);
  if (plugins.some((entry) => entry.host === "Claude Code" && entry.ok)) {
    lines.push("Restart Claude Code (or run /reload-plugins) to load the plugin. To have Claude Code keep it current: /plugin → Marketplaces → choose the marketplace → Enable auto-update.");
  }
  const failed = plugins.some((entry) => !entry.ok);
  ctx.print(lines.join("\n"), { ...data, installed: result.installed, plugins, ...(failed ? { ok: false } : {}) });
  return failed ? 1 : 0;
}
