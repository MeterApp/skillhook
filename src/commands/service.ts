import { installService, readServiceLog, restartService, serviceStatus, uninstallService } from "../service.js";
import { sleep } from "../util.js";
import { bool, num, UsageError, type Ctx } from "./shared.js";

const USAGE = `Usage:
  skillhook service install     run \`skillhook serve\` at login and keep it alive (launchd on macOS, systemd --user on Linux)
  skillhook service uninstall
  skillhook service status
  skillhook service restart
  skillhook service logs [--lines N] [--follow]`;

export async function serviceCommand(ctx: Ctx): Promise<number> {
  const [sub = "status"] = ctx.args;
  switch (sub) {
    case "install": {
      const result = await installService(ctx.paths);
      if (!result.ok) {
        ctx.print(`Could not install the service:\n${result.output}`, { ok: false, file: result.file, output: result.output });
        return 1;
      }
      await sleep(1500);
      const status = await serviceStatus(ctx.paths);
      const lines = [`✓ Installed ${status.platform} service (${result.file})`, `  ${status.running ? `running (pid ${status.pid})` : "not running yet"}`, `  logs: ${status.logFile}`, "", "Check with: skillhook doctor   |   stop with: skillhook service uninstall"];
      ctx.print(lines.join("\n"), { ok: true, file: result.file, status, output: result.output });
      return 0;
    }
    case "uninstall":
    case "remove": {
      const result = await uninstallService();
      ctx.print(result.ok ? "Service removed" : `Could not remove service: ${result.output}`, { ok: result.ok, output: result.output });
      return result.ok ? 0 : 1;
    }
    case "restart": {
      const result = await restartService();
      ctx.print(result.ok ? "Service restarted" : `Could not restart service: ${result.output}`, { ok: result.ok, output: result.output });
      return result.ok ? 0 : 1;
    }
    case "status": {
      const status = await serviceStatus(ctx.paths);
      const text = status.platform === "unsupported" ? "No launchd/systemd on this platform" : `${status.platform}: ${status.installed ? "installed" : "not installed"}${status.running ? `, running (pid ${status.pid})` : status.installed ? ", not running" : ""}\n  file: ${status.file}\n  logs: ${status.logFile}`;
      ctx.print(text, status);
      return status.installed ? 0 : 1;
    }
    case "logs":
    case "log": {
      const lines = num(ctx.flags, "lines", "n") ?? 100;
      ctx.io.stdout(`${readServiceLog(ctx.paths, lines)}\n`);
      if (bool(ctx.flags, "follow", "f")) {
        let last = readServiceLog(ctx.paths, 100000).length;
        while (true) {
          await sleep(1000);
          const all = readServiceLog(ctx.paths, 100000);
          if (all.length > last) {
            ctx.io.stdout(all.slice(last));
            last = all.length;
          } else if (all.length < last) last = all.length;
        }
      }
      return 0;
    }
    default:
      throw new UsageError(`Unknown service subcommand "${sub}"`, USAGE);
  }
}
