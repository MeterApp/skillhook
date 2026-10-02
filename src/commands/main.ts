import { ConfigError } from "../config.js";
import { SkillError } from "../skills.js";
import { errorMessage, printable } from "../util.js";
import { VERSION } from "../version.js";
import { bool, CommandError, createCtx, parseArgs, UsageError, type CliIO, type Ctx } from "./shared.js";
import { initCommand, INIT_USAGE } from "./init.js";
import { serveCommand, SERVE_USAGE } from "./serve.js";
import { skillsCommand, SKILLS_USAGE } from "./skills.js";
import { secretCommand, SECRET_USAGE } from "./secret.js";
import { runCommand, RUN_USAGE } from "./run.js";
import { sendCommand, SEND_USAGE } from "./send.js";
import { healthCommand, HEALTH_USAGE } from "./health.js";
import { jobCommand, jobUsage } from "./job.js";
import { jobsCommand, JOBS_USAGE } from "./jobs.js";
import { runnersCommand, RUNNERS_USAGE } from "./runners.js";
import { statsCommand, STATS_USAGE } from "./stats.js";
import { deliveriesCommand, DELIVERIES_USAGE } from "./deliveries.js";
import { exposeCommand, EXPOSE_USAGE, urlCommand, URL_USAGE } from "./expose.js";
import { serviceCommand, SERVICE_USAGE } from "./service.js";
import { doctorCommand, DOCTOR_USAGE } from "./doctor.js";
import { cloudCommand, CLOUD_USAGE } from "./cloud.js";
import { configCommand, CONFIG_USAGE } from "./config.js";
import { mcpCommand, MCP_USAGE } from "./mcp.js";
import { updateCommand, UPDATE_USAGE } from "./update.js";
import { linkCommand, projectsCommand, PROJECTS_USAGE, unlinkCommand } from "./projects.js";
import { schedulesCommand, SCHEDULES_USAGE } from "./schedules.js";
import { planUpdateNotice, spawnBackgroundRefresh } from "../update.js";
import { readJsonFileOr } from "../util.js";

export const HELP = `skillhook ${VERSION} — webhook in, agent out.

Usage: skillhook <command> [options]

Setup
  init [--runner claude|codex|shell] [--model M] [--port N] [--force]   Create ~/.skillhook: config, secrets, hello skill
  doctor                                                   Check node, config, secrets, skills, claude/codex login, Tailscale, server, service
  health [--quick] [--refresh] [--no-network] [--local]     Doctor plus MCP servers, plugins, codex doctor, disk and last runs, grouped; via the running server when there is one
  runners [--refresh] [--local]                            Is each runner installed and logged in: what every job checks before it starts
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
  run --file SKILL.md | --stdin [same options]             Run a SKILL.md that is not installed (kept with the job)
  send <skill> [--payload …] [--wait S] [--url BASE|--public|--local] [--header "K: v"]...   POST a signed test webhook
  schedules list | next <name> [--count N] | run <name> [--wait S]   Skills with a schedule: next and last runs; fire one now
  jobs list [--skill S] [--status ST] [--outcome O] [--failure K] [--trigger T] [--waiting] [--since ISO] [--after ID] [--limit N] | show <id> [--result|--prompt|--stdout|--stderr] | logs <id> [-f]
  jobs answer <id> "<answer>" [--option X] [--by NAME] [--no-resume] [--wait S]   Answer a job that asked (live) or ended needs_human (resumes the session)
  jobs cancel <id> | replay <id> [--skip-filters] [--wait S] | resume <id> [--exec] | path <id> | prune [--keep N]
  deliveries list [--skill S] [--outcome O] [--since ISO] [--after ID] [--limit N] | show <id> [--body]   Every webhook received, whatever became of it
  deliveries replay <id> [--force] [--skip-filters] [--runner R] [--model M] [--wait S]   Run a recorded delivery again (no signature check)
  stats [--since 24h|7d|ISO] [--until ISO] [--skill S]      Jobs by status, outcome, runner and failure; durations, cost, tokens; deliveries; per skill

Agents
  mcp [--print-config]                                     MCP server over stdio (tools for Claude Code, Codex, Cursor, …)
  mcp --cloud                                              Skillhook Cloud's tools over stdio: the whole organisation, with the key of cloud login
  mcp --job                                                The per-run job API as an MCP server (the runners start it; needs $SKILLHOOK_JOB_ID/$SKILLHOOK_JOB_DIR)
  job progress "<msg>" [--state working|blocked] [--percent N] | ask "<question>" [--option A]... [--wait S] | outcome <o> [--summary S] | note "<text>" | context
                                                           Inside a run: report progress, ask a person (waits for the answer), report the outcome
  config show | get <key> | set <key> <value> | unset <key> | reload | path   set/unset tell the running server; most keys apply live, host/port at the next start
  cloud connect --code XXXX-XXXX [--control] | disconnect | status   Pair this machine with Skillhook Cloud (opt-in; docs/cloud.md)
  cloud report "<title>" [--body T|--body-file F|--body -] [--kind K] [--severity S] [--job ID] [--email E] [--no-diagnostics] [--dry-run]
                                                           Report a problem to the Skillhook team from a paired machine, with its diagnostics (scrubbed)
  cloud login [--url U] [--key shc_…|-] | logout          Keep an organisation API key (asked for at a terminal; never the machine token)
  cloud overview | machines | jobs [--waiting] … | job <id>   What needs a person across the organisation; its machines and jobs
  cloud tools [tool] | <tool> [args] [--param value]…      Everything the dashboard shows and does, by name (answer_job, run_skill, get_stats, …)
  cloud secret <machine> <skill|NAME> [--force]            A skill's secret generated on a machine, opened only here

Global options: --dir <path> (default $SKILLHOOK_HOME or ~/.skillhook), --json, --help, --version
skillhook <command> --help (or skillhook help <command>) prints its usage and runs nothing; a mistake prints it too.
Docs: https://github.com/MeterApp/skillhook
`;

export interface Command {
  run: (ctx: Ctx) => Promise<number | void> | number | void;
  /** What `skillhook <command> … --help` prints instead of running it; a function of the subcommand when that changes it. */
  usage: string | ((args: string[]) => string);
}

export const COMMANDS: Record<string, Command> = {
  init: { run: initCommand, usage: INIT_USAGE },
  serve: { run: serveCommand, usage: SERVE_USAGE },
  skills: { run: skillsCommand, usage: SKILLS_USAGE },
  skill: { run: skillsCommand, usage: SKILLS_USAGE },
  secret: { run: secretCommand, usage: SECRET_USAGE },
  secrets: { run: secretCommand, usage: SECRET_USAGE },
  run: { run: runCommand, usage: RUN_USAGE },
  send: { run: sendCommand, usage: SEND_USAGE },
  jobs: { run: jobsCommand, usage: JOBS_USAGE },
  job: { run: jobCommand, usage: jobUsage },
  deliveries: { run: deliveriesCommand, usage: DELIVERIES_USAGE },
  delivery: { run: deliveriesCommand, usage: DELIVERIES_USAGE },
  expose: { run: exposeCommand, usage: EXPOSE_USAGE },
  url: { run: urlCommand, usage: URL_USAGE },
  urls: { run: urlCommand, usage: URL_USAGE },
  service: { run: serviceCommand, usage: SERVICE_USAGE },
  doctor: { run: doctorCommand, usage: DOCTOR_USAGE },
  health: { run: healthCommand, usage: HEALTH_USAGE },
  runners: { run: runnersCommand, usage: RUNNERS_USAGE },
  stats: { run: statsCommand, usage: STATS_USAGE },
  config: { run: configCommand, usage: CONFIG_USAGE },
  cloud: { run: cloudCommand, usage: CLOUD_USAGE },
  mcp: { run: mcpCommand, usage: MCP_USAGE },
  update: { run: updateCommand, usage: UPDATE_USAGE },
  upgrade: { run: updateCommand, usage: UPDATE_USAGE },
  link: { run: linkCommand, usage: PROJECTS_USAGE },
  unlink: { run: unlinkCommand, usage: PROJECTS_USAGE },
  projects: { run: projectsCommand, usage: PROJECTS_USAGE },
  project: { run: projectsCommand, usage: PROJECTS_USAGE },
  schedules: { run: schedulesCommand, usage: SCHEDULES_USAGE },
  schedule: { run: schedulesCommand, usage: SCHEDULES_USAGE },
};

/** The usage `skillhook <name> [args…] --help` prints. */
export function usageOf(command: Command, args: string[]): string {
  return typeof command.usage === "function" ? command.usage(args) : command.usage;
}

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
  const { flags, positionals, positionalIndexes } = parseArgs(argv);
  // `skillhook help jobs` is `skillhook jobs --help`.
  const help = bool(flags, "help", "h") || positionals[0] === "help";
  const offset = positionals[0] === "help" ? 1 : 0;
  const [name, ...rest] = positionals.slice(offset);
  if (flags.version === true || flags.v === true || name === "version") {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (!name || name === "help") {
    io.stdout(HELP);
    return help ? 0 : 1;
  }
  const command = COMMANDS[name];
  if (!command) {
    io.stderr(`Unknown command "${name}".\n\n${HELP}`);
    return 1;
  }
  const ctx = createCtx(flags, rest, io, argv.slice((positionalIndexes[offset] ?? argv.length) + 1));
  if (help) {
    // Checked here, before any command code runs, so no command can forget it: `jobs prune --help` must not prune.
    const usage = usageOf(command, rest);
    ctx.print(usage, { ok: true, command: name, usage });
    return 0;
  }
  try {
    const code = await command.run(ctx);
    noticeUpdate(ctx, name);
    return typeof code === "number" ? code : 0;
  } catch (error) {
    // Messages can carry text from the cloud, machines and senders: a terminal gets it without control characters.
    if (error instanceof UsageError) {
      io.stderr(printable(`${error.message}\n${error.usage ? `\n${error.usage}\n` : ""}`));
      return 2;
    }
    if (error instanceof CommandError) {
      if (ctx.json) io.stdout(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
      else io.stderr(`${printable(error.message)}\n`);
      return error.exitCode;
    }
    if (error instanceof ConfigError || error instanceof SkillError) {
      if (ctx.json) io.stdout(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
      else io.stderr(`${printable(error.message)}\n`);
      return 1;
    }
    io.stderr(`error: ${printable(errorMessage(error))}\n`);
    if (io.env.SKILLHOOK_DEBUG) io.stderr(`${(error as Error).stack ?? ""}\n`);
    return 1;
  }
}
