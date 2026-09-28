import { adminRequest, findRunningServer } from "../client.js";
import { formatHealth, runHealth, type HealthReport } from "../health.js";
import { bool, CommandError, type Ctx } from "./shared.js";

/**
 * `skillhook health`: doctor plus the deep probes (MCP servers, plugins, `codex doctor`, disk, last runs), grouped.
 * Through the running server when there is one (its cached report, `--refresh` for a fresh one), otherwise in-process.
 */
export async function healthCommand(ctx: Ctx): Promise<number> {
  const deep = !bool(ctx.flags, "quick");
  const network = ctx.flags.network !== false;
  const refresh = bool(ctx.flags, "refresh");
  const running = bool(ctx.flags, "local") ? undefined : await findRunningServer(ctx.paths);
  let report: HealthReport & { cached?: boolean };
  if (running) {
    const params = new URLSearchParams({ deep: deep ? "1" : "0", network: network ? "1" : "0", ...(refresh ? { refresh: "1" } : {}) });
    const response = await adminRequest<HealthReport & { cached?: boolean; error?: string; message?: string }>(running.baseUrl, ctx.secrets(), `/health/checks?${params.toString()}`, { timeoutMs: 180_000 });
    if (response.status >= 400) throw new CommandError(`Could not get the health report from ${running.baseUrl}: ${String(response.body.error)}: ${String(response.body.message)}`);
    report = response.body;
  } else {
    report = await runHealth(ctx.paths, { env: ctx.io.env, deep, network });
  }
  const source = running ? `\n(from the server at ${running.baseUrl}${report.cached ? ", cached; --refresh probes again" : ""})` : "";
  ctx.print(`${formatHealth(report)}${source}`, report);
  return report.ok ? 0 : 1;
}
