import { coerceConfigValue, readRawConfig, setConfigValue } from "../config.js";
import { getPath } from "../util.js";
import { UsageError, type Ctx } from "./shared.js";

const USAGE = `Usage:
  skillhook config show            effective config (defaults applied)
  skillhook config get <key>       e.g. defaults.model
  skillhook config set <key> <value>
  skillhook config unset <key>
  skillhook config path`;

export function configCommand(ctx: Ctx): number {
  const [sub = "show", key, ...rest] = ctx.args;
  switch (sub) {
    case "show": {
      const config = ctx.config();
      ctx.print(JSON.stringify(config, null, 2), config);
      return 0;
    }
    case "get": {
      if (!key) throw new UsageError("Missing key", USAGE);
      const value = getPath(ctx.config(), key);
      ctx.print(typeof value === "string" ? value : JSON.stringify(value, null, 2), { key, value });
      return 0;
    }
    case "set": {
      if (!key || rest.length === 0) throw new UsageError("Usage: skillhook config set <key> <value>", USAGE);
      const value = coerceConfigValue(rest.join(" "));
      const raw = setConfigValue(ctx.paths, key, value);
      ctx.print(`Set ${key} = ${JSON.stringify(value)} in ${ctx.paths.configFile}`, { ok: true, key, value, config: raw });
      return 0;
    }
    case "unset": {
      if (!key) throw new UsageError("Missing key", USAGE);
      const raw = setConfigValue(ctx.paths, key, undefined);
      ctx.print(`Removed ${key} from ${ctx.paths.configFile}`, { ok: true, key, config: raw });
      return 0;
    }
    case "path":
      ctx.print(ctx.paths.configFile, { file: ctx.paths.configFile, home: ctx.paths.home, raw: readRawConfig(ctx.paths) });
      return 0;
    default:
      throw new UsageError(`Unknown config subcommand "${sub}"`, USAGE);
  }
}
