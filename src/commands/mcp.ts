import { existsSync } from "node:fs";
import { serveCloudMcp } from "../cloud/bridge.js";
import { jobFromEnv, serveJobMcp } from "../mcp-job.js";
import { serveMcp } from "../mcp.js";
import { cliEntrypoint, stableNodePath } from "../service.js";
import { which } from "../tailscale.js";
import { PACKAGE } from "../version.js";
import { bool, CommandError, str, type Ctx } from "./shared.js";

export const MCP_USAGE = `Usage: skillhook mcp [--print-config]
       skillhook mcp --cloud
       skillhook mcp --job [ID]

Serves skillhook's tools over stdio to Claude Code, Codex, Cursor and other MCP clients; --print-config prints the
commands and the JSON that register it. --cloud serves Skillhook Cloud's tools instead (every machine of the
organisation, as the dashboard shows and runs them) with the API key of skillhook cloud login; the skillhook plugin
registers both. --job serves one run's job API (progress, questions, the outcome): the runners start it with
$SKILLHOOK_JOB_ID and $SKILLHOOK_JOB_DIR set.`;

export async function mcpCommand(ctx: Ctx): Promise<number> {
  if (ctx.flags.job !== undefined) {
    // The runners start this for every run (`--mcp-config` / `mcp_servers.skillhook_job`) with the job in the environment.
    const target = jobFromEnv(ctx.io.env, ctx.paths.jobsDir, str(ctx.flags, "job", "job-id"));
    if (!target) throw new CommandError("skillhook mcp --job serves one run's job API: it needs SKILLHOOK_JOB_ID and SKILLHOOK_JOB_DIR in the environment (the runner sets them), or --job <id> under this home");
    await serveJobMcp(target);
    await new Promise(() => {
      /* serve until stdin closes */
    });
    return 0;
  }
  if (bool(ctx.flags, "print-config")) {
    const onPath = which("skillhook");
    const cli = cliEntrypoint();
    const command = onPath ? "skillhook" : cli.exists ? stableNodePath() : "npx";
    const args = onPath ? ["mcp"] : cli.exists ? [cli.path, "mcp"] : ["-y", PACKAGE.name, "mcp"];
    const dirArgs = ctx.io.env.SKILLHOOK_HOME || ctx.flags.dir ? ["--dir", ctx.paths.home] : [];
    const cloudArgs = [...args, "--cloud", ...dirArgs];
    const json = { mcpServers: { skillhook: { command, args: [...args, ...dirArgs] }, "skillhook-cloud": { command, args: cloudArgs } } };
    const shell = [command, ...args, ...dirArgs].join(" ");
    const cloudShell = [command, ...cloudArgs].join(" ");
    const text = [
      "Claude Code:",
      `  claude mcp add skillhook -- ${shell}`,
      `  claude mcp add skillhook-cloud -- ${cloudShell}   # the organisation's fleet, after skillhook cloud login`,
      "Codex:",
      `  codex mcp add skillhook -- ${shell}`,
      `  codex mcp add skillhook-cloud -- ${cloudShell}`,
      "Cursor / Windsurf / others (mcp.json):",
      JSON.stringify(json, null, 2),
      "",
      `Or install the repo as a plugin (skills + both servers): /plugin marketplace add MeterApp/skillhook`,
    ].join("\n");
    ctx.print(text, { command, args: [...args, ...dirArgs], cloud_args: cloudArgs, mcp_json: json, claude_code: `claude mcp add skillhook -- ${shell}`, codex: `codex mcp add skillhook -- ${shell}` });
    return 0;
  }
  if (bool(ctx.flags, "cloud")) {
    await serveCloudMcp(ctx.paths, ctx.io.env);
    await new Promise(() => {
      /* serve until stdin closes */
    });
    return 0;
  }
  if (!existsSync(ctx.paths.home)) ctx.warn(`[skillhook mcp] ${ctx.paths.home} does not exist yet; tools will create it on first use or run: skillhook init`);
  await serveMcp(ctx.paths);
  await new Promise(() => {
    /* serve until stdin closes */
  });
  return 0;
}
