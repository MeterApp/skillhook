import { adminRequest, findRunningServer } from "../client.js";
import { readEnvFile } from "../env.js";
import { checkReadiness, RUNNER_NAMES, type RunnerReadiness } from "../readiness.js";
import { baseRunEnv } from "../runners/env.js";
import { bool, CommandError, table, type Ctx } from "./shared.js";

/** `skillhook runners`: is each runner installed and logged in, as a job checks before it starts. */
export async function runnersCommand(ctx: Ctx): Promise<number> {
  const refresh = bool(ctx.flags, "refresh");
  const running = bool(ctx.flags, "local") ? undefined : await findRunningServer(ctx.paths);
  let runners: RunnerReadiness[];
  if (running) {
    const response = await adminRequest<{ runners: RunnerReadiness[]; error?: string; message?: string }>(running.baseUrl, ctx.secrets(), `/runners${refresh ? "?refresh=1" : ""}`, { timeoutMs: 60_000 });
    if (response.status >= 400) throw new CommandError(`Could not read the runners from ${running.baseUrl}: ${String(response.body.error)}: ${String(response.body.message)}`);
    runners = response.body.runners;
  } else {
    const config = ctx.config();
    const env = baseRunEnv({ secrets: ctx.secrets(), fileSecrets: readEnvFile(ctx.paths.envFile), processEnv: ctx.io.env });
    runners = await Promise.all(RUNNER_NAMES.map((runner) => checkReadiness(runner, config, env)));
  }
  const rows = runners.map((r) => [r.runner, r.ready ? "ready" : "not ready", r.version ?? "", r.authenticated === null ? "n/a" : r.authenticated ? `yes${r.method ? ` (${r.method})` : ""}` : "no", r.detail]);
  const hints = runners.filter((r) => r.hint).map((r) => `  → ${r.runner}: ${r.hint}`);
  const defaultRunner = ctx.config().defaults.runner;
  ctx.print([table(rows, ["runner", "state", "version", "authenticated", "detail"]), ...hints, ...(running ? [`(from the server at ${running.baseUrl}${refresh ? "" : "; --refresh probes again"})`] : [])].join("\n"), { runners, default_runner: defaultRunner, via: running ? "server" : "local" });
  return runners.find((r) => r.runner === defaultRunner)?.ready ? 0 : 1;
}
