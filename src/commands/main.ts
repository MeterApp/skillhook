import { ConfigError } from "../config.js";
import { SkillError } from "../skills.js";
import { errorMessage } from "../util.js";
import { VERSION } from "../version.js";
import { CommandError, createCtx, parseArgs, UsageError, type CliIO, type Ctx } from "./shared.js";
import { initCommand } from "./init.js";
import { serveCommand } from "./serve.js";
import { skillsCommand } from "./skills.js";
import { secretCommand } from "./secret.js";
import { runCommand } from "./run.js";
import { sendCommand } from "./send.js";
import { jobsCommand } from "./jobs.js";
import { exposeCommand, urlCommand } from "./expose.js";
import { serviceCommand } from "./service.js";
import { doctorCommand } from "./doctor.js";
import { configCommand } from "./config.js";
import { mcpCommand } from "./mcp.js";
import { updateCommand } from "./update.js";
import { linkCommand, projectsCommand, unlinkCommand } from "./projects.js";
import { schedulesCommand } from "./schedules.js";
import { planUpdateNotice, spawnBackgroundRefresh } from "../update.js";
import { readJsonFileOr } from "../util.js";

export const HELP = `skillhook ${VERSION} — webhook in, agent out.

Usage: skillhook <command> [options]

Setup
  init [--runner claude|codex|shell] [--model M] [--port N] [--force]   Create ~/.skillhook: config, secrets, hello skill
  doctor                                                   Check node, config, secrets, skills, claude/codex login, Tailscale, server, service
  serve [--port N] [--host H] [--log-level L] [--pretty]   Run the webhook server in the foreground
  service install|uninstall|status|restart|logs [--lines N] [--follow]   Run the server at login (launchd / systemd --user)
  expose tailscale [--serve] [--port N] | status | off     Permanent HTTPS URL via Tailscale Funnel (or tailnet-only Serve)
  expose cloudflare | ngrok                                Recipes for other tunnels
  url [skill] [--public|--local]                           Print webhook URLs
  update [--install]                                       Check npm for a newer skillhook; --install upgrades and restarts the service

Skills (SKILL.md files in ~/.skillhook/skills/<name>/)
  skills list | show <name> | new <name> [options] | add <example> [--as NAME] | examples | validate [name] | path <name>
  secret set <NAME|skill|admin> [--value V|--stdin] | generate <NAME|skill|admin> [--force] | list | unset <NAME>

Projects (a repository's skillhook.yaml: webhook name → shell command, SKILL.md or prompt, version-controlled with the code)
  link [dir] [--no-secret] | unlink <dir>                 Serve the hooks a repository declares (default dir: .); stop serving them
  projects [list] | init [dir] [--force]                  List linked projects and their hooks; write a starter skillhook.yaml and link it

Running
  run <skill> [--payload JSON|@file|-] [--header "K: v"]... [--runner R] [--model M] [--effort E] [--cwd DIR] [--wait S] [--dry-run]
  send <skill> [--payload …] [--wait S] [--url BASE|--public|--local] [--header "K: v"]...   POST a signed test webhook
  schedules list | next <name> [--count N] | run <name> [--wait S]   Skills with a schedule: next and last runs; fire one now
  jobs list [--skill S] [--status ST] [--limit N] | show <id> [--result|--prompt|--stdout|--stderr] | logs <id> [-f]
  jobs cancel <id> | resume <id> [--exec] | path <id> | prune [--keep N]

Agents
  mcp [--print-config]                                     MCP server over stdio (tools for Claude Code, Codex, Cursor, …)
  config show | get <key> | set <key> <value> | unset <key> | path

Global options: --dir <path> (default $SKILLHOOK_HOME or ~/.skillhook), --json, --help, --version
Each subcommand prints its own usage on a mistake. Docs: https://github.com/MeterApp/skillhook
`;

type Command = (ctx: Ctx) => Promise<number | void> | number | void;

const COMMANDS: Record<string, Command> = {
  init: initCommand,
  serve: serveCommand,
  skills: skillsCommand,
  skill: skillsCommand,
  secret: secretCommand,
  secrets: secretCommand,
  run: runCommand,
  send: sendCommand,
  jobs: jobsCommand,
  job: jobsCommand,
  expose: exposeCommand,
  url: urlCommand,
  urls: urlCommand,
  service: serviceCommand,
  doctor: doctorCommand,
  config: configCommand,
  mcp: mcpCommand,
  update: updateCommand,
  upgrade: updateCommand,
  link: linkCommand,
  unlink: unlinkCommand,
  projects: projectsCommand,
  project: projectsCommand,
  schedules: schedulesCommand,
  schedule: schedulesCommand,
};

/** Commands whose output must stay clean, or that handle update checks themselves. */
const NO_UPDATE_NOTICE = new Set(["serve", "mcp", "update", "upgrade", "version", "help"]);

export function nodeVersionProblem(version: string = process.versions.node): string | undefined {
  const major = Number(version.split(".")[0]);
  if (major >= 22) return undefined;
  return `skillhook needs Node 22 or newer; this is Node ${version}. Install a current Node from https://nodejs.org (or with your version manager) and run the command again.`;
}

/**
 * Once a day, in the background, ask npm whether a newer skillhook exists; when one is already known, say so on stderr
 * after the command's own output. Only for humans at a terminal: never with --json, never in CI, never for scripts.
 */
function noticeUpdate(ctx: Ctx, command: string): void {
  if (!ctx.io.isTTY || ctx.json || NO_UPDATE_NOTICE.has(command)) return;
  try {
    const rawConfig = readJsonFileOr<{ update_check?: boolean }>(ctx.paths.configFile, {});
    const plan = planUpdateNotice(ctx.paths, { env: ctx.io.env, config: rawConfig });
    if (plan.notice) ctx.io.stderr(`\n${plan.notice}\n`);
    if (plan.stale) spawnBackgroundRefresh(ctx.paths, ctx.io.env);
  } catch {
    /* a failed update check never fails the command */
  }
}

export function defaultIO(): CliIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    isTTY: Boolean(process.stdin.isTTY),
  };
}

export async function main(argv: string[], io: CliIO = defaultIO()): Promise<number> {
  const nodeProblem = nodeVersionProblem();
  if (nodeProblem) {
    io.stderr(`${nodeProblem}\n`);
    return 1;
  }
  const { flags, positionals } = parseArgs(argv);
  const [name, ...rest] = positionals;
  if (flags.version === true || flags.v === true || name === "version") {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (!name || name === "help" || ((flags.help === true || flags.h === true) && !name)) {
    io.stdout(HELP);
    return name || flags.help === true || flags.h === true ? 0 : 1;
  }
  const command = COMMANDS[name];
  if (!command) {
    io.stderr(`Unknown command "${name}".\n\n${HELP}`);
    return 1;
  }
  const ctx = createCtx(flags, rest, io);
  try {
    const code = await command(ctx);
    noticeUpdate(ctx, name);
    return typeof code === "number" ? code : 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n${error.usage ? `\n${error.usage}\n` : ""}`);
      return 2;
    }
    if (error instanceof CommandError) {
      if (ctx.json) io.stdout(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
      else io.stderr(`${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof ConfigError || error instanceof SkillError) {
      if (ctx.json) io.stdout(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
      else io.stderr(`${error.message}\n`);
      return 1;
    }
    io.stderr(`error: ${errorMessage(error)}\n`);
    if (io.env.SKILLHOOK_DEBUG) io.stderr(`${(error as Error).stack ?? ""}\n`);
    return 1;
  }
}
