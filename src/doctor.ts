import { existsSync } from "node:fs";
import { findRunningServer, localBaseUrl, probeServer } from "./client.js";
import { configExists, loadConfig, type Config } from "./config.js";
import { ADMIN_TOKEN_ENV, loadSecrets, secretFileMode, type Secrets } from "./env.js";
import type { Paths } from "./paths.js";
import { resolveRunSettings } from "./run.js";
import { commandParts } from "./runners/types.js";
import { nextRun } from "./schedule.js";
import { serviceStatus } from "./service.js";
import { configProjects, SkillRegistry } from "./registry.js";
import type { Skill } from "./skills.js";
import { currentExposures, findTailscale, run, tailscaleStatus, which } from "./tailscale.js";
import { checkForUpdate, registryUrl, releaseNotesUrl, updateChecksDisabled } from "./update.js";
import { displayPath, errorMessage, isDirectory } from "./util.js";
import { VERSION } from "./version.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  checks: Check[];
  ok: boolean;
  summary: { ok: number; warn: number; fail: number; skip: number };
  public_url?: string;
  server?: { base_url: string; running: boolean; version?: string };
}

function check(name: string, status: CheckStatus, detail: string, hint?: string): Check {
  return hint ? { name, status, detail, hint } : { name, status, detail };
}

export async function claudeAuth(command: string | string[]): Promise<{ found: boolean; loggedIn: boolean; method?: string; detail: string }> {
  const parts = commandParts(command);
  const resolved = parts.command.includes("/") ? (existsSync(parts.command) ? parts.command : undefined) : which(parts.command);
  if (!resolved) return { found: false, loggedIn: false, detail: `${parts.command} not found on PATH` };
  const result = await run(resolved, [...parts.lead, "auth", "status"], { timeoutMs: 15_000 });
  try {
    const json = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string };
    return { found: true, loggedIn: Boolean(json.loggedIn), method: json.authMethod, detail: json.loggedIn ? `logged in (${json.authMethod})` : "not logged in" };
  } catch {
    const firstLine = `${result.stdout}${result.stderr}`.trim().split("\n")[0] ?? "";
    return { found: true, loggedIn: result.code === 0, detail: firstLine || `claude auth status exited with code ${result.code} and printed nothing` };
  }
}

export async function codexAuth(command: string | string[]): Promise<{ found: boolean; loggedIn: boolean; detail: string }> {
  const parts = commandParts(command);
  const resolved = parts.command.includes("/") ? (existsSync(parts.command) ? parts.command : undefined) : which(parts.command);
  if (!resolved) return { found: false, loggedIn: false, detail: `${parts.command} not found on PATH` };
  const result = await run(resolved, [...parts.lead, "login", "status"], { timeoutMs: 15_000 });
  const text = `${result.stdout}${result.stderr}`.trim().split("\n")[0] ?? "";
  return { found: true, loggedIn: result.code === 0 && !/not logged in/i.test(text), detail: text || (result.code === 0 ? "logged in" : "not logged in") };
}

export interface DoctorOptions {
  /** Environment consulted for the update check (`SKILLHOOK_NO_UPDATE_CHECK`, `CI`, `SKILLHOOK_NPM_REGISTRY`). */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export async function runDoctor(paths: Paths, options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const checks: Check[] = [];
  const [major] = process.versions.node.split(".").map(Number);
  checks.push(check("node", (major ?? 0) >= 22 ? "ok" : "fail", `node ${process.versions.node}`, (major ?? 0) >= 22 ? undefined : "skillhook needs Node 22 or newer"));

  let config: Config | undefined;
  if (!isDirectory(paths.home)) {
    checks.push(check("home", "fail", `${paths.home} does not exist`, "run: skillhook init"));
  } else {
    try {
      config = loadConfig(paths);
      checks.push(check("config", "ok", configExists(paths) ? paths.configFile : `defaults (no ${paths.configFile})`));
    } catch (error) {
      checks.push(check("config", "fail", errorMessage(error)));
    }
  }

  if (updateChecksDisabled(env, config)) checks.push(check("version", "skip", `skillhook ${VERSION} (update check disabled)`));
  else {
    const update = await checkForUpdate(paths, { env, config, force: true, timeoutMs: 4_000, fetchImpl: options.fetchImpl });
    if (update.latest === null) checks.push(check("version", "skip", `skillhook ${VERSION} (could not reach ${registryUrl(env)} to check for updates)`));
    else if (update.available) checks.push(check("version", "warn", `skillhook ${VERSION}; ${update.latest} is available`, `run: skillhook update --install   (notes: ${releaseNotesUrl(update.latest)})`));
    else checks.push(check("version", "ok", `skillhook ${VERSION} (latest)`));
  }

  const mode = secretFileMode(paths.envFile);
  if (mode === null) checks.push(check("secrets", "warn", `${paths.envFile} missing`, "run: skillhook init (or skillhook secret generate admin)"));
  else checks.push(check("secrets", mode === 0o600 ? "ok" : "warn", `${paths.envFile} mode ${mode.toString(8)}`, mode === 0o600 ? undefined : `chmod 600 ${paths.envFile}`));

  const secrets: Secrets = loadSecrets(paths);
  checks.push(check("admin token", secrets[ADMIN_TOKEN_ENV] ? "ok" : "warn", secrets[ADMIN_TOKEN_ENV] ? `${ADMIN_TOKEN_ENV} set` : `${ADMIN_TOKEN_ENV} not set (admin API only reachable from localhost)`, secrets[ADMIN_TOKEN_ENV] ? undefined : "run: skillhook secret generate admin"));

  const loaded = new SkillRegistry(paths.skillsDir, { projects: configProjects(paths), base: paths.home }).list();
  if (loaded.errors.length) checks.push(check("skills", "fail", `${loaded.errors.length} invalid skill(s): ${loaded.errors.map((e) => `${e.name} (${e.error.split("\n")[0]})`).join("; ")}`, "run: skillhook skills validate"));
  else checks.push(check("skills", loaded.skills.length ? "ok" : "warn", loaded.skills.length ? `${loaded.skills.length} skill(s): ${loaded.skills.map((s) => s.name).join(", ")}` : "no skills yet", loaded.skills.length ? undefined : "run: skillhook skills new <name>"));
  if (!loaded.projects.length) checks.push(check("projects", "skip", "no linked projects", "skillhook link <repo> serves the hooks a repository declares in skillhook.yaml"));
  for (const project of loaded.projects) {
    const broken = project.error ? 1 : project.errors.length;
    checks.push(check(`project ${displayPath(project.dir)}`, broken ? "fail" : "ok", project.error ?? `${project.hooks.length} hook(s): ${project.hooks.map((h) => h.name).join(", ") || "none"}${project.errors.length ? `; ${project.errors.length} invalid: ${project.errors.map((e) => e.name).join(", ")}` : ""}`, broken ? "run: skillhook skills validate" : undefined));
  }

  const runnersNeeded = new Set<string>();
  if (config) {
    for (const skill of loaded.skills) {
      const settings = resolveRunSettings(skill, config);
      runnersNeeded.add(settings.runner);
      const auth = skill.auth;
      const where = `cwd ${settings.cwd}${skill.source.type === "project" ? `, from ${displayPath(skill.source.file)}` : ""}`;
      const scheduleNote = skill.schedule ? `, schedule ${skill.schedule.cron} (${skill.schedule.timezone})` : "";
      if (!skill.webhook) checks.push(check(`skill ${skill.name}`, isDirectory(settings.cwd) ? "ok" : "fail", `${settings.runner}${settings.model ? ` ${settings.model}` : ""}${scheduleNote}, schedule only, ${where}`, isDirectory(settings.cwd) ? undefined : "cwd does not exist"));
      else if (auth.type === "none") checks.push(check(`skill ${skill.name}`, "warn", `auth: none — anyone with the URL can trigger it${scheduleNote}`, "set skillhook.auth.type in SKILL.md (or webhook: false for a schedule-only hook)"));
      else if (!secrets[auth.secret_env]) checks.push(check(`skill ${skill.name}`, "fail", `secret ${auth.secret_env} not set (webhooks will get 503)${scheduleNote}`, `run: skillhook secret generate ${skill.name}  (or: skillhook secret set ${auth.secret_env}${skill.schedule ? ", or webhook: false when only the schedule should run it" : ""})`));
      else checks.push(check(`skill ${skill.name}`, isDirectory(settings.cwd) ? "ok" : "fail", `${settings.runner}${settings.model ? ` ${settings.model}` : ""}, auth ${auth.type}${scheduleNote}, ${where}`, isDirectory(settings.cwd) ? undefined : "cwd does not exist"));
    }
  }

  const scheduled = loaded.skills.filter((skill) => skill.schedule && skill.enabled);
  if (scheduled.length) {
    const now = new Date();
    checks.push(check("schedules", "ok", `${scheduled.length} scheduled: ${scheduled.map((s) => `${s.name} (${s.schedule?.cron}, next ${nextRun(s.schedule!.spec, now, s.schedule!.timezone)?.toISOString() ?? "never"})`).join("; ")}`));
    if (process.platform === "darwin") {
      const sleep = await macSleepMinutes();
      if (sleep === undefined) checks.push(check("sleep", "skip", "could not read pmset; schedules only fire while the machine is awake"));
      else if (sleep === 0) checks.push(check("sleep", "ok", "system sleep is disabled (pmset sleep 0)"));
      else checks.push(check("sleep", "warn", `this Mac sleeps after ${sleep} min; schedules only fire while it is awake (missed slots follow each hook's catch_up)`, "run: sudo pmset -a sleep 0"));
    }
  }

  if (config && (runnersNeeded.has("claude") || config.defaults.runner === "claude")) {
    const claude = await claudeAuth(config.runners.claude.command);
    const apiKey = Boolean(secrets.ANTHROPIC_API_KEY);
    if (!claude.found) checks.push(check("claude", "fail", claude.detail, "install Claude Code: https://claude.com/claude-code, or set runners.claude.command"));
    else if (claude.loggedIn || apiKey) checks.push(check("claude", "ok", apiKey && !claude.loggedIn ? "ANTHROPIC_API_KEY set" : claude.detail));
    else checks.push(check("claude", "fail", claude.detail, "run `claude login` in a terminal (subscription) or put ANTHROPIC_API_KEY in .env"));
  }
  if (config && (runnersNeeded.has("codex") || config.defaults.runner === "codex")) {
    const codex = await codexAuth(config.runners.codex.command);
    const apiKey = Boolean(secrets.OPENAI_API_KEY);
    if (!codex.found) checks.push(check("codex", "fail", codex.detail, "install Codex: npm i -g @openai/codex, or set runners.codex.command"));
    else if (codex.loggedIn || apiKey) checks.push(check("codex", "ok", apiKey && !codex.loggedIn ? "OPENAI_API_KEY set" : codex.detail));
    else checks.push(check("codex", "fail", codex.detail, "run `codex login` in a terminal (ChatGPT) or put OPENAI_API_KEY in .env"));
  }

  let publicUrl = config?.public_url;
  const tailscale = findTailscale();
  if (!tailscale) checks.push(check("tailscale", "warn", "tailscale CLI not found", "install from https://tailscale.com/download to get a free permanent HTTPS URL"));
  else {
    const status = await tailscaleStatus(tailscale);
    if (!status || status.backendState !== "Running") checks.push(check("tailscale", "warn", `backend ${status?.backendState ?? "unavailable"}`, "open Tailscale and sign in"));
    else {
      const exposures = await currentExposures(tailscale);
      const port = config?.port ?? 8787;
      const ours = exposures.find((e) => e.target.endsWith(`:${port}`));
      if (ours) {
        publicUrl = publicUrl ?? ours.url;
        checks.push(check("tailscale", "ok", `${ours.mode === "funnel" ? "Funnel (public)" : "Serve (tailnet only)"}: ${ours.url} -> ${ours.target}`));
      } else checks.push(check("tailscale", "warn", `connected as ${status.dnsName}; port ${port} not exposed`, "run: skillhook expose tailscale"));
    }
  }

  if (publicUrl) {
    const health = await probeServer(publicUrl, 8_000);
    checks.push(check("public url", health ? "ok" : "warn", health ? `${publicUrl} answers (v${health.version})` : `${publicUrl} did not answer`, health ? undefined : "if the server is running, the TLS certificate may still be provisioning; retry in a minute or run: skillhook expose status"));
  }

  let server: DoctorReport["server"];
  if (config) {
    const running = await findRunningServer(paths);
    const baseUrl = running?.baseUrl ?? localBaseUrl({ host: config.host, port: config.port });
    server = { base_url: baseUrl, running: Boolean(running), version: running?.health.version };
    checks.push(check("server", running ? "ok" : "warn", running ? `running at ${baseUrl} (v${running.health.version}${running.health.queue ? `, ${running.health.queue.running} running / ${running.health.queue.queued} queued` : ""})` : `not running at ${baseUrl}`, running ? undefined : "run: skillhook serve   (or: skillhook service install)"));
  }

  const service = await serviceStatus(paths);
  if (service.platform === "unsupported") checks.push(check("service", "skip", "no launchd/systemd on this platform"));
  else checks.push(check("service", service.running ? "ok" : service.installed ? "warn" : "skip", service.running ? `${service.platform} running (pid ${service.pid})` : service.installed ? `${service.platform} installed but not running` : "not installed", service.running ? undefined : "run: skillhook service install"));

  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;
  return { checks, ok: summary.fail === 0, summary, public_url: publicUrl, server };
}

/** The `sleep` value of `pmset -g custom` on macOS (AC power when listed), in minutes; undefined when pmset is unavailable or unreadable. */
export async function macSleepMinutes(): Promise<number | undefined> {
  const pmset = which("pmset");
  if (!pmset) return undefined;
  const result = await run(pmset, ["-g", "custom"], { timeoutMs: 5_000 });
  if (result.code !== 0) return undefined;
  let section = "";
  let value: number | undefined;
  let acValue: number | undefined;
  for (const raw of result.stdout.split("\n")) {
    const line = raw.trim();
    if (line.endsWith(":")) {
      section = line.slice(0, -1);
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts[0] === "sleep" && parts[1] !== undefined && /^\d+$/.test(parts[1])) {
      const minutes = Number(parts[1]);
      if (section === "AC Power") acValue = minutes;
      value ??= minutes;
    }
  }
  return acValue ?? value;
}

export function formatDoctor(report: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "-" };
  const lines = report.checks.map((c) => `${icon[c.status]} ${c.name.padEnd(22)} ${c.detail}${c.hint ? `\n    → ${c.hint}` : ""}`);
  lines.push("", `${report.summary.ok} ok, ${report.summary.warn} warnings, ${report.summary.fail} failures`);
  if (report.public_url) lines.push(`public URL: ${report.public_url}`);
  return lines.join("\n");
}

export function skillsNeedingSecrets(skills: Skill[], secrets: Secrets): Skill[] {
  return skills.filter((s) => s.auth.type !== "none" && !secrets[s.auth.secret_env]);
}
