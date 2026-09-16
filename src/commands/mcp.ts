import { existsSync } from "node:fs";
import { serveMcp } from "../mcp.js";
import { cliEntrypoint, stableNodePath } from "../service.js";
import { which } from "../tailscale.js";
import { PACKAGE } from "../version.js";
import { bool, type Ctx } from "./shared.js";

export async function mcpCommand(ctx: Ctx): Promise<number> {
  if (bool(ctx.flags, "print-config")) {
    const onPath = which("skillhook");
    const cli = cliEntrypoint();
    const command = onPath ? "skillhook" : cli.exists ? stableNodePath() : "npx";
    const args = onPath ? ["mcp"] : cli.exists ? [cli.path, "mcp"] : ["-y", PACKAGE.name, "mcp"];
    const dirArgs = ctx.io.env.SKILLHOOK_HOME || ctx.flags.dir ? ["--dir", ctx.paths.home] : [];
    const json = { mcpServers: { skillhook: { command, args: [...args, ...dirArgs] } } };
    const shell = [command, ...args, ...dirArgs].join(" ");
    const text = [
      "Claude Code:",
      `  claude mcp add skillhook -- ${shell}`,
      "Codex:",
      `  codex mcp add skillhook -- ${shell}`,
      "Cursor / Windsurf / others (mcp.json):",
      JSON.stringify(json, null, 2),
      "",
      `Or install the repo as a plugin (skills + MCP): /plugin marketplace add MeterApp/skillhook`,
    ].join("\n");
    ctx.print(text, { command, args: [...args, ...dirArgs], mcp_json: json, claude_code: `claude mcp add skillhook -- ${shell}`, codex: `codex mcp add skillhook -- ${shell}` });
    return 0;
  }
  if (!existsSync(ctx.paths.home)) ctx.warn(`[skillhook mcp] ${ctx.paths.home} does not exist yet; tools will create it on first use or run: skillhook init`);
  await serveMcp(ctx.paths);
  await new Promise(() => {
    /* serve until stdin closes */
  });
  return 0;
}
