import { adminRequest, findRunningServer } from "../client.js";
import { coerceConfigValue, HOT_CONFIG_KEYS, readRawConfig, RESTART_CONFIG_KEYS, setConfigValue } from "../config.js";
import { getPath } from "../util.js";
import { CommandError, UsageError, type Ctx } from "./shared.js";

export const CONFIG_USAGE = `Usage:
  skillhook config show            effective config (defaults applied)
  skillhook config get <key>       e.g. defaults.model
  skillhook config set <key> <value>
  skillhook config unset <key>
  skillhook config reload          make the running server re-read skillhook.json (set/unset do this too)
  skillhook config path`;

interface ReloadAnswer {
  ok?: boolean;
  applied?: string[];
  restart_required?: boolean;
  restart_required_keys?: string[];
  pending_restart?: string[];
  error?: string;
  message?: string;
}

/** Tells the running server, if any, to re-read the file; returns what it said, or undefined without a server. */
async function notifyServer(ctx: Ctx): Promise<(ReloadAnswer & { base_url: string }) | undefined> {
  const running = await findRunningServer(ctx.paths);
  if (!running) return undefined;
  try {
    const response = await adminRequest<ReloadAnswer>(running.baseUrl, ctx.secrets(), "/config/reload", { method: "POST", timeoutMs: 10_000 });
    return { ...response.body, base_url: running.baseUrl };
  } catch (error) {
    return { ok: false, error: "unreachable", message: (error as Error).message, base_url: running.baseUrl };
  }
}

function describeReload(answer: (ReloadAnswer & { base_url: string }) | undefined): string {
  if (!answer) return "";
  if (answer.ok === false || answer.error) return `\nThe server at ${answer.base_url} did not reload: ${answer.error ?? ""}${answer.message ? ` ${answer.message}` : ""}`.trimEnd();
  const parts: string[] = [];
  if (answer.applied?.length) parts.push(`applied live: ${answer.applied.join(", ")}`);
  if (answer.restart_required_keys?.length) parts.push(`restart required for: ${answer.restart_required_keys.join(", ")} (skillhook service restart)`);
  if (!parts.length) parts.push(answer.pending_restart?.length ? `nothing new to apply; still pending a restart: ${answer.pending_restart.join(", ")}` : "the running server already had these values");
  return `\nServer at ${answer.base_url}: ${parts.join("; ")}`;
}

export async function configCommand(ctx: Ctx): Promise<number> {
  const [sub = "show", key, ...rest] = ctx.args;
  switch (sub) {
    case "show": {
      const config = ctx.config();
      ctx.print(JSON.stringify(config, null, 2), config);
      return 0;
    }
    case "get": {
      if (!key) throw new UsageError("Missing key", CONFIG_USAGE);
      const value = getPath(ctx.config(), key);
      ctx.print(typeof value === "string" ? value : JSON.stringify(value, null, 2), { key, value });
      return 0;
    }
    case "set": {
      if (!key || rest.length === 0) throw new UsageError("Usage: skillhook config set <key> <value>", CONFIG_USAGE);
      const value = coerceConfigValue(rest.join(" "));
      const raw = setConfigValue(ctx.paths, key, value);
      const server = await notifyServer(ctx);
      ctx.print(`Set ${key} = ${JSON.stringify(value)} in ${ctx.paths.configFile}${describeReload(server)}`, { ok: true, key, value, config: raw, server: server ?? null });
      return 0;
    }
    case "unset": {
      if (!key) throw new UsageError("Missing key", CONFIG_USAGE);
      const raw = setConfigValue(ctx.paths, key, undefined);
      const server = await notifyServer(ctx);
      ctx.print(`Removed ${key} from ${ctx.paths.configFile}${describeReload(server)}`, { ok: true, key, config: raw, server: server ?? null });
      return 0;
    }
    case "reload": {
      const server = await notifyServer(ctx);
      if (!server) throw new CommandError("No running server to reload (a server started later reads the file at start)");
      if (server.ok === false || server.error) throw new CommandError(`The server at ${server.base_url} did not reload: ${server.error ?? ""} ${server.message ?? ""}`.trim());
      ctx.print(describeReload(server).trim(), { ...server, hot_keys: HOT_CONFIG_KEYS, restart_keys: RESTART_CONFIG_KEYS });
      return 0;
    }
    case "path":
      ctx.print(ctx.paths.configFile, { file: ctx.paths.configFile, home: ctx.paths.home, raw: readRawConfig(ctx.paths), hot_keys: HOT_CONFIG_KEYS, restart_keys: RESTART_CONFIG_KEYS });
      return 0;
    default:
      throw new UsageError(`Unknown config subcommand "${sub}"`, CONFIG_USAGE);
  }
}
