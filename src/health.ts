// The health report: every check `skillhook doctor` makes, grouped, plus the deep ones (`skillhook health`): the CLIs'
// versions and logins, every MCP server Claude Code and Codex know, plugins, `codex doctor`, disk space, each skill's
// last run and missing `env:` names. `runDoctor` is `runHealth` without the deep checks. `HealthCache` keeps one report
// per flavour for the server (`GET /health/checks`), coalesces concurrent calls and emits `health.changed`.
import { statfsSync } from "node:fs";
import { findRunningServer, localBaseUrl, probeServer } from "./client.js";
import { CLOUD_TOKEN_ENV, cloudDisabledByEnv, isSecureCloudUrl, resolveCloudUrl } from "./cloud/config.js";
import type { LinkStatusView } from "./cloud/link.js";
import { configExists, loadConfig, type Config } from "./config.js";
import { ADMIN_TOKEN_ENV, loadSecrets, readEnvFile, secretFileMode, type Secrets } from "./env.js";
import type { Events } from "./events.js";
import { JobStore, type JobRecord } from "./jobs.js";
import type { Paths } from "./paths.js";
import { configProjects, SkillRegistry } from "./registry.js";
import { jobOutcome } from "./response.js";
import { resolveRunSettings } from "./run.js";
import { baseRunEnv } from "./runners/env.js";
import { commandParts } from "./runners/types.js";
import { nextRun } from "./schedule.js";
import { serviceStatus } from "./service.js";
import { currentExposures, findTailscale, run, tailscaleStatus, which } from "./tailscale.js";
import { probeClaude, probeCodex, type ClaudeProbe, type CodexProbe } from "./tools.js";
import { checkForUpdate, registryUrl, releaseNotesUrl, updateChecksDisabled, updateStatusFromCache } from "./update.js";
import { displayPath, errorMessage, isDirectory } from "./util.js";
import { VERSION } from "./version.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";
export type HealthGroup = "system" | "skillhook" | "runners" | "tools" | "skills" | "exposure";
export const HEALTH_GROUPS: HealthGroup[] = ["system", "skillhook", "runners", "tools", "skills", "exposure"];

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
  group: HealthGroup;
  /** Structured facts behind the line (versions, server lists, sizes) for dashboards. */
  data?: Record<string, unknown>;
}

export interface HealthSummary {
  ok: number;
  warn: number;
  fail: number;
  skip: number;
}

export interface HealthReport {
  checks: Check[];
  ok: boolean;
  summary: HealthSummary;
  groups: Record<HealthGroup, HealthSummary>;
  public_url?: string;
  server?: { base_url: string; running: boolean; version?: string };
  generated_at: string;
  duration_ms: number;
  /** The deep checks (MCP servers, plugins, `codex doctor`, last runs) were included. */
  deep: boolean;
  /** The npm registry was asked and the public URL probed. */
  network: boolean;
}

export interface HealthOptions {
  /** Environment consulted for the update check (`SKILLHOOK_NO_UPDATE_CHECK`, `CI`, `SKILLHOOK_NPM_REGISTRY`) and for the probes' base environment. */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Probe MCP servers, plugins, the CLIs' own doctor and each skill's last run (one process per listing). Default true. */
  deep?: boolean;
  /** Ask the npm registry for the newest version and probe the public URL. Default true (the server's cache asks for false unless told otherwise). */
  network?: boolean;
  /** Look at Tailscale and the public URL. Default true. */
  exposure?: boolean;
  /** Look at the launchd / systemd service. Default true. */
  service?: boolean;
  /** Facts of the server this runs inside, instead of probing it over HTTP. */
  live?: () => { started_at: string; queue: { running: number; queued: number } };
  /** For the slow probes (`claude mcp list` connects to every server, `codex doctor`). Default 20 s. */
  timeoutMs?: number;
  /** The cloud link of the server this runs inside. */
  cloud?: () => LinkStatusView | undefined;
}

function summarize(checks: Check[]): HealthSummary {
  const summary: HealthSummary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) summary[check.status]++;
  return summary;
}

function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
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

const DISK_WARN_BYTES = 2 * 1024 ** 3;
const DISK_FAIL_BYTES = 512 * 1024 ** 2;

export async function runHealth(paths: Paths, options: HealthOptions = {}): Promise<HealthReport> {
  const started = Date.now();
  const env = options.env ?? process.env;
  const deep = options.deep ?? true;
  const network = options.network ?? true;
  const checks: Check[] = [];
  const check = (group: HealthGroup, name: string, status: CheckStatus, detail: string, hint?: string, data?: Record<string, unknown>) => {
    checks.push({ name, status, detail, ...(hint ? { hint } : {}), group, ...(data ? { data } : {}) });
  };

  // system
  const [major] = process.versions.node.split(".").map(Number);
  check("system", "node", (major ?? 0) >= 22 ? "ok" : "fail", `node ${process.versions.node}`, (major ?? 0) >= 22 ? undefined : "skillhook needs Node 22 or newer", { version: process.versions.node, platform: process.platform, arch: process.arch });
  try {
    const stat = statfsSync(isDirectory(paths.home) ? paths.home : "/");
    const free = Number(stat.bavail) * Number(stat.bsize);
    const total = Number(stat.blocks) * Number(stat.bsize);
    check("system", "disk", free < DISK_FAIL_BYTES ? "fail" : free < DISK_WARN_BYTES ? "warn" : "ok", `${gib(free)} GiB free of ${gib(total)} GiB for ${paths.home}`, free < DISK_WARN_BYTES ? "free some space; jobs write their transcripts and artifacts under the skillhook home" : undefined, { free_bytes: free, total_bytes: total });
  } catch (error) {
    check("system", "disk", "skip", `could not read free space: ${errorMessage(error)}`);
  }

  // skillhook: home, config, version
  let config: Config | undefined;
  if (!isDirectory(paths.home)) {
    check("skillhook", "home", "fail", `${paths.home} does not exist`, "run: skillhook init");
  } else {
    try {
      config = loadConfig(paths);
      check("skillhook", "config", "ok", configExists(paths) ? paths.configFile : `defaults (no ${paths.configFile})`);
    } catch (error) {
      check("skillhook", "config", "fail", errorMessage(error));
    }
  }

  if (updateChecksDisabled(env, config)) check("skillhook", "version", "skip", `skillhook ${VERSION} (update check disabled)`, undefined, { current: VERSION });
  else if (!network) {
    const cached = updateStatusFromCache(paths);
    if (cached.latest === null) check("skillhook", "version", "skip", `skillhook ${VERSION} (no recent update check)`, undefined, { current: VERSION });
    else if (cached.available) check("skillhook", "version", "warn", `skillhook ${VERSION}; ${cached.latest} is available`, `run: skillhook update --install   (notes: ${releaseNotesUrl(cached.latest)})`, { current: VERSION, latest: cached.latest, checked_at: cached.checked_at });
    else check("skillhook", "version", "ok", `skillhook ${VERSION} (latest as of ${cached.checked_at ?? "?"})`, undefined, { current: VERSION, latest: cached.latest, checked_at: cached.checked_at });
  } else {
    const update = await checkForUpdate(paths, { env, config, force: true, timeoutMs: 4_000, fetchImpl: options.fetchImpl });
    if (update.latest === null) check("skillhook", "version", "skip", `skillhook ${VERSION} (could not reach ${registryUrl(env)} to check for updates)`, undefined, { current: VERSION });
    else if (update.available) check("skillhook", "version", "warn", `skillhook ${VERSION}; ${update.latest} is available`, `run: skillhook update --install   (notes: ${releaseNotesUrl(update.latest)})`, { current: VERSION, latest: update.latest, checked_at: update.checked_at });
    else check("skillhook", "version", "ok", `skillhook ${VERSION} (latest)`, undefined, { current: VERSION, latest: update.latest, checked_at: update.checked_at });
  }

  // skillhook: secrets
  const mode = secretFileMode(paths.envFile);
  if (mode === null) check("skillhook", "secrets", "warn", `${paths.envFile} missing`, "run: skillhook init (or skillhook secret generate admin)");
  else check("skillhook", "secrets", mode === 0o600 ? "ok" : "warn", `${paths.envFile} mode ${mode.toString(8)}`, mode === 0o600 ? undefined : `chmod 600 ${paths.envFile}`);
  const secrets: Secrets = loadSecrets(paths, env);
  const fileSecrets = mode === null ? {} : readEnvFile(paths.envFile);
  check("skillhook", "admin token", secrets[ADMIN_TOKEN_ENV] ? "ok" : "warn", secrets[ADMIN_TOKEN_ENV] ? `${ADMIN_TOKEN_ENV} set` : `${ADMIN_TOKEN_ENV} not set (admin API only reachable from localhost)`, secrets[ADMIN_TOKEN_ENV] ? undefined : "run: skillhook secret generate admin");

  // skills
  const loaded = new SkillRegistry(paths.skillsDir, { projects: configProjects(paths), base: paths.home }).list();
  if (loaded.errors.length) check("skills", "skills", "fail", `${loaded.errors.length} invalid skill(s): ${loaded.errors.map((e) => `${e.name} (${e.error.split("\n")[0]})`).join("; ")}`, "run: skillhook skills validate", { errors: loaded.errors.map((e) => e.name) });
  else check("skills", "skills", loaded.skills.length ? "ok" : "warn", loaded.skills.length ? `${loaded.skills.length} skill(s): ${loaded.skills.map((s) => s.name).join(", ")}` : "no skills yet", loaded.skills.length ? undefined : "run: skillhook skills new <name>", { skills: loaded.skills.map((s) => s.name) });
  if (!loaded.projects.length) check("skills", "projects", "skip", "no linked projects", "skillhook link <repo> serves the hooks a repository declares in skillhook.yaml");
  for (const project of loaded.projects) {
    const broken = project.error ? 1 : project.errors.length;
    check("skills", `project ${displayPath(project.dir)}`, broken ? "fail" : "ok", project.error ?? `${project.hooks.length} hook(s): ${project.hooks.map((h) => h.name).join(", ") || "none"}${project.errors.length ? `; ${project.errors.length} invalid: ${project.errors.map((e) => e.name).join(", ")}` : ""}`, broken ? "run: skillhook skills validate" : undefined, { dir: project.dir, file: project.file, hooks: project.hooks.map((h) => h.name) });
  }

  // The newest job per skill, for the deep per-skill lines.
  const lastJobs = new Map<string, JobRecord>();
  if (deep && config && isDirectory(paths.jobsDir)) {
    try {
      const store = new JobStore(paths.jobsDir, { maxJobs: config.jobs.max_jobs, dedupeWindowSeconds: config.jobs.dedupe_window_seconds });
      for (const job of store.list({ limit: 300 })) if (!lastJobs.has(job.skill)) lastJobs.set(job.skill, job);
    } catch {
      /* no jobs to look at */
    }
  }

  const runnersNeeded = new Set<string>();
  if (config) {
    for (const skill of loaded.skills) {
      const settings = resolveRunSettings(skill, config);
      runnersNeeded.add(settings.runner);
      const auth = skill.auth;
      const where = `cwd ${settings.cwd}${skill.source.type === "project" ? `, from ${displayPath(skill.source.file)}` : ""}`;
      const scheduleNote = skill.schedule ? `, schedule ${skill.schedule.cron} (${skill.schedule.timezone})` : "";
      const found: { status: CheckStatus; problem: string; hint: string }[] = [];
      if (!isDirectory(settings.cwd)) found.push({ status: "fail", problem: "cwd does not exist", hint: "cwd does not exist" });
      const missingEnv = (skill.config.env ?? []).filter((name) => secrets[name] === undefined);
      if (missingEnv.length) found.push({ status: "warn", problem: `missing env: ${missingEnv.join(", ")}`, hint: `run: skillhook secret set ${missingEnv[0]}` });
      if (settings.runner === "shell") {
        const spec = skill.config.shell?.command;
        const binary = Array.isArray(spec) ? commandParts(spec).command : undefined;
        if (binary && !binary.includes("/") && !which(binary)) found.push({ status: "fail", problem: `${binary} not found on PATH`, hint: `install ${binary} or give shell.command an absolute path` });
      }
      const status: CheckStatus = found.some((f) => f.status === "fail") ? "fail" : found.length ? "warn" : "ok";
      const problems = found.map((f) => f.problem);
      const hints = found.map((f) => f.hint);
      const last = lastJobs.get(skill.name);
      const lastNote = last ? `, last run ${last.status}${jobOutcome(last) ? ` (${jobOutcome(last)})` : ""} ${last.finished_at ?? last.created_at}` : deep ? ", no runs yet" : "";
      const data = { runner: settings.runner, model: settings.model ?? null, cwd: settings.cwd, auth: auth.type, schedule: skill.schedule?.cron ?? null, source: skill.source.type, ...(last ? { last_job: { id: last.id, status: last.status, outcome: jobOutcome(last) ?? null, finished_at: last.finished_at ?? null } } : {}), ...(missingEnv.length ? { missing_env: missingEnv } : {}) };
      const suffix = problems.length ? `; ${problems.join("; ")}` : "";
      if (!skill.webhook) check("skills", `skill ${skill.name}`, status, `${settings.runner}${settings.model ? ` ${settings.model}` : ""}${scheduleNote}, schedule only, ${where}${lastNote}${suffix}`, hints[0], data);
      else if (auth.type === "none") check("skills", `skill ${skill.name}`, status === "fail" ? "fail" : "warn", `auth: none — anyone with the URL can trigger it${scheduleNote}${lastNote}${suffix}`, hints[0] ?? "set skillhook.auth.type in SKILL.md (or webhook: false for a schedule-only hook)", data);
      else if (!secrets[auth.secret_env]) check("skills", `skill ${skill.name}`, "fail", `secret ${auth.secret_env} not set (webhooks will get 503)${scheduleNote}${lastNote}${suffix}`, `run: skillhook secret generate ${skill.name}  (or: skillhook secret set ${auth.secret_env}${skill.schedule ? ", or webhook: false when only the schedule should run it" : ""})`, data);
      else check("skills", `skill ${skill.name}`, status, `${settings.runner}${settings.model ? ` ${settings.model}` : ""}, auth ${auth.type}${scheduleNote}, ${where}${lastNote}${suffix}`, hints[0], data);
    }
  }

  const scheduled = loaded.skills.filter((skill) => skill.schedule && skill.enabled);
  if (scheduled.length) {
    const now = new Date();
    check("skills", "schedules", "ok", `${scheduled.length} scheduled: ${scheduled.map((s) => `${s.name} (${s.schedule?.cron}, next ${nextRun(s.schedule!.spec, now, s.schedule!.timezone)?.toISOString() ?? "never"})`).join("; ")}`, undefined, { skills: scheduled.map((s) => s.name) });
    if (process.platform === "darwin") {
      const sleep = await macSleepMinutes();
      if (sleep === undefined) check("skills", "sleep", "skip", "could not read pmset; schedules only fire while the machine is awake");
      else if (sleep === 0) check("skills", "sleep", "ok", "system sleep is disabled (pmset sleep 0)", undefined, { sleep_minutes: 0 });
      else check("skills", "sleep", "warn", `this Mac sleeps after ${sleep} min; schedules only fire while it is awake (missed slots follow each hook's catch_up)`, "run: sudo pmset -a sleep 0", { sleep_minutes: sleep });
    }
  }

  // runners and tools: probed with the same environment as a job
  const probeEnv = baseRunEnv({ secrets, fileSecrets, processEnv: env });
  const timeoutMs = options.timeoutMs ?? 20_000;
  let claude: ClaudeProbe | undefined;
  let codex: CodexProbe | undefined;
  if (config) {
    const wantClaude = runnersNeeded.has("claude") || config.defaults.runner === "claude";
    const wantCodex = runnersNeeded.has("codex") || config.defaults.runner === "codex";
    [claude, codex] = await Promise.all([wantClaude ? probeClaude(config.runners.claude.command, { env: probeEnv, deep, timeoutMs }) : undefined, wantCodex ? probeCodex(config.runners.codex.command, { env: probeEnv, deep, timeoutMs }) : undefined]);
  }
  if (claude) {
    const apiKey = Boolean(secrets.ANTHROPIC_API_KEY || secrets.ANTHROPIC_AUTH_TOKEN);
    const version = claude.version ? `${claude.version}, ` : "";
    const data = { found: claude.found, path: claude.path ?? null, version: claude.version ?? null, logged_in: claude.auth.loggedIn, method: claude.auth.method ?? null, api_key: apiKey };
    if (!claude.found) check("runners", "claude", "fail", claude.auth.detail, "install Claude Code: https://claude.com/claude-code, or set runners.claude.command", data);
    else if (claude.auth.loggedIn || apiKey) check("runners", "claude", "ok", `${version}${apiKey && !claude.auth.loggedIn ? "ANTHROPIC_API_KEY set" : claude.auth.detail}`, undefined, data);
    else check("runners", "claude", "fail", `${version}${claude.auth.detail}`, "run `claude login` in a terminal (subscription) or put ANTHROPIC_API_KEY in .env", data);
  }
  if (codex) {
    const apiKey = Boolean(secrets.OPENAI_API_KEY);
    const version = codex.version ? `${codex.version}, ` : "";
    const data = { found: codex.found, path: codex.path ?? null, version: codex.version ?? null, logged_in: codex.auth.loggedIn, method: codex.auth.method ?? null, api_key: apiKey };
    if (!codex.found) check("runners", "codex", "fail", codex.auth.detail, "install Codex: npm i -g @openai/codex, or set runners.codex.command", data);
    else if (codex.auth.loggedIn || apiKey) check("runners", "codex", "ok", `${version}${apiKey && !codex.auth.loggedIn ? "OPENAI_API_KEY set" : codex.auth.detail}`, undefined, data);
    else check("runners", "codex", "fail", `${version}${codex.auth.detail}`, "run `codex login` in a terminal (ChatGPT) or put OPENAI_API_KEY in .env", data);
  }
  if (deep && claude?.mcp) {
    const { servers, warnings, error } = claude.mcp;
    if (error && !servers.length) check("tools", "claude mcp", "skip", error, "run `claude mcp list` in a terminal");
    else if (!servers.length) check("tools", "claude mcp", "skip", "no MCP servers configured for Claude Code");
    for (const server of servers) {
      const target = `${server.target}${server.transport ? ` (${server.transport})` : ""}`;
      const data = { name: server.name, target: server.target, transport: server.transport ?? null, state: server.state };
      if (server.state === "connected") check("tools", `claude mcp ${server.name}`, "ok", `${target}: connected`, undefined, data);
      else if (server.state === "needs_auth") check("tools", `claude mcp ${server.name}`, "warn", `${target}: needs authentication`, "authenticate it in an interactive claude session (/mcp); until then its tools are unavailable to unattended runs", data);
      else if (server.state === "failed") check("tools", `claude mcp ${server.name}`, "fail", `${target}: ${server.detail ?? "failed to connect"}`, `run: claude mcp get ${server.name}   (and check the command or URL)`, data);
      else check("tools", `claude mcp ${server.name}`, "skip", `${target}: ${server.detail ?? "state unknown"}`, undefined, data);
    }
    if (error && servers.length) check("tools", "claude mcp", "warn", `list incomplete: ${error}`, "run `claude mcp list` in a terminal", { servers: servers.length });
    if (warnings.length) check("tools", "claude mcp config", "warn", warnings.join("; "), "run `claude mcp list` in a terminal for the full diagnostics", { warnings });
  }
  if (deep && claude?.plugins) {
    const { plugins, error } = claude.plugins;
    if (error) check("tools", "claude plugins", "warn", error, "run `claude plugin list` in a terminal");
    else if (!plugins.length) check("tools", "claude plugins", "skip", "no plugins installed");
    else {
      const disabled = plugins.filter((p) => !p.enabled);
      check("tools", "claude plugins", "ok", `${plugins.length} plugin(s): ${plugins.map((p) => `${p.id}${p.version ? `@${p.version}` : ""}${p.enabled ? "" : " (disabled)"}`).join(", ")}`, undefined, { plugins, disabled: disabled.map((p) => p.id) });
    }
  }
  if (deep && codex?.mcp) {
    const { servers, error } = codex.mcp;
    if (error && !servers.length) check("tools", "codex mcp", "skip", error, "run `codex mcp list` in a terminal");
    else if (!servers.length) check("tools", "codex mcp", "skip", "no MCP servers configured for Codex");
    for (const server of servers) {
      const target = `${server.target}${server.transport ? ` (${server.transport})` : ""}`;
      const data = { name: server.name, target: server.target, transport: server.transport ?? null, enabled: server.enabled, auth_status: server.auth_status ?? null, state: server.state };
      if (server.state === "disabled") check("tools", `codex mcp ${server.name}`, "skip", `${target}: ${server.detail ?? "disabled"}`, undefined, data);
      else if (server.state === "needs_auth") check("tools", `codex mcp ${server.name}`, "warn", `${target}: ${server.detail ?? "needs authentication"}`, `run: codex mcp login ${server.name}`, data);
      else check("tools", `codex mcp ${server.name}`, "ok", `${target}: configured${server.auth_status ? ` (auth ${server.auth_status})` : ""}`, undefined, data);
    }
  }
  if (deep && codex?.doctor) {
    const { overall, checks: items, error } = codex.doctor;
    if (error) check("tools", "codex doctor", "skip", error, "run `codex doctor` in a terminal");
    else {
      const notOk = items.filter((c) => c.status !== "ok" && c.status !== "skip");
      const worst: CheckStatus = notOk.some((c) => c.status === "fail") ? "fail" : notOk.length ? "warn" : "ok";
      check("tools", "codex doctor", worst, `${overall ?? worst}: ${notOk.length ? notOk.map((c) => `${c.id}: ${c.summary}`).join("; ") : `${items.length} check(s) ok`}`, notOk.find((c) => c.remediation)?.remediation, { overall: overall ?? null, checks: items });
    }
  }

  // exposure
  let publicUrl = config?.public_url;
  if (options.exposure !== false) {
    const tailscale = findTailscale();
    if (!tailscale) check("exposure", "tailscale", "warn", "tailscale CLI not found", "install from https://tailscale.com/download to get a free permanent HTTPS URL");
    else {
      const status = await tailscaleStatus(tailscale);
      if (!status || status.backendState !== "Running") check("exposure", "tailscale", "warn", `backend ${status?.backendState ?? "unavailable"}`, "open Tailscale and sign in");
      else {
        const exposures = await currentExposures(tailscale);
        const port = config?.port ?? 8787;
        const ours = exposures.find((e) => e.target.endsWith(`:${port}`));
        if (ours) {
          publicUrl = publicUrl ?? ours.url;
          check("exposure", "tailscale", "ok", `${ours.mode === "funnel" ? "Funnel (public)" : "Serve (tailnet only)"}: ${ours.url} -> ${ours.target}`, undefined, { mode: ours.mode, url: ours.url, target: ours.target, dns_name: status.dnsName });
        } else check("exposure", "tailscale", "warn", `connected as ${status.dnsName}; port ${port} not exposed`, "run: skillhook expose tailscale", { dns_name: status.dnsName });
      }
    }
    if (publicUrl && network) {
      const health = await probeServer(publicUrl, 8_000);
      check("exposure", "public url", health ? "ok" : "warn", health ? `${publicUrl} answers (v${health.version})` : `${publicUrl} did not answer`, health ? undefined : "if the server is running, the TLS certificate may still be provisioning; retry in a minute or run: skillhook expose status", { url: publicUrl, version: health?.version ?? null });
    } else if (publicUrl) check("exposure", "public url", "skip", `${publicUrl} (not probed)`, undefined, { url: publicUrl });
  }

  // skillhook: server, service, cloud link
  let server: HealthReport["server"];
  let linkStatus: LinkStatusView | null | undefined;
  let serverRunning = false;
  if (config && options.live) {
    const live = options.live();
    const baseUrl = localBaseUrl({ host: config.host, port: config.port });
    server = { base_url: baseUrl, running: true, version: VERSION };
    serverRunning = true;
    linkStatus = options.cloud?.() ?? null;
    check("skillhook", "server", "ok", `this server (v${VERSION}), up ${formatUptime((Date.now() - Date.parse(live.started_at)) / 1000)}, ${live.queue.running} running / ${live.queue.queued} queued`, undefined, { base_url: baseUrl, started_at: live.started_at, queue: live.queue });
  } else if (config) {
    const running = await findRunningServer(paths);
    const baseUrl = running?.baseUrl ?? localBaseUrl({ host: config.host, port: config.port });
    server = { base_url: baseUrl, running: Boolean(running), version: running?.health.version };
    serverRunning = Boolean(running);
    linkStatus = running?.health.cloud;
    check("skillhook", "server", running ? "ok" : "warn", running ? `running at ${baseUrl} (v${running.health.version}${running.health.queue ? `, ${running.health.queue.running} running / ${running.health.queue.queued} queued` : ""})` : `not running at ${baseUrl}`, running ? undefined : "run: skillhook serve   (or: skillhook service install)", { base_url: baseUrl, running: Boolean(running), version: running?.health.version ?? null });
  }
  if (config) {
    const cloud = config.cloud;
    const url = resolveCloudUrl(env, cloud);
    if (cloudDisabledByEnv(env)) check("skillhook", "cloud link", "skip", "SKILLHOOK_NO_CLOUD is set; the link never runs", undefined, { enabled: cloud.enabled, url });
    else if (!cloud.enabled) check("skillhook", "cloud link", "skip", "not connected to Skillhook Cloud", "skillhook cloud connect --code <code from the dashboard>", { enabled: false, url });
    else if (!fileSecrets[CLOUD_TOKEN_ENV]) check("skillhook", "cloud link", "fail", `cloud.enabled but ${CLOUD_TOKEN_ENV} is not in .env`, "run: skillhook cloud connect --force   (or: skillhook cloud disconnect)", { enabled: true, url, token: false });
    else if (!isSecureCloudUrl(url, env)) check("skillhook", "cloud link", "fail", `${url} is not https`, "set cloud.url to an https URL", { enabled: true, url });
    else if (!serverRunning) check("skillhook", "cloud link", "warn", `configured for ${url} (machine ${cloud.machine_id ?? "unpaired"}, mode ${cloud.mode}); no running server keeps the link`, "run: skillhook serve   (or: skillhook service install)", { enabled: true, url, machine_id: cloud.machine_id ?? null, mode: cloud.mode });
    else if (!linkStatus) check("skillhook", "cloud link", "warn", `configured for ${url}; the running server reports no link state (older server?)`, "restart the server", { enabled: true, url });
    else {
      const detail = `${linkStatus.state}${linkStatus.reason ? ` (${linkStatus.reason})` : ""} · ${url} · machine ${linkStatus.machine_id ?? "?"} · mode ${linkStatus.mode}${linkStatus.last_sync_at ? ` · last sync ${linkStatus.last_sync_at}` : ""}${linkStatus.outbox_depth ? ` · ${linkStatus.outbox_depth} event(s) waiting` : ""}${linkStatus.dropped_total ? ` · ${linkStatus.dropped_total} dropped` : ""}`;
      const status: CheckStatus = linkStatus.state === "connected" ? (linkStatus.dropped_total ? "warn" : "ok") : linkStatus.state === "degraded" || linkStatus.state === "connecting" ? "warn" : "fail";
      check("skillhook", "cloud link", status, detail, status === "ok" ? undefined : (linkStatus.last_error ?? "see the server log; skillhook cloud status"), { ...linkStatus });
    }
  }
  if (options.service !== false) {
    const service = await serviceStatus(paths);
    if (service.platform === "unsupported") check("skillhook", "service", "skip", "no launchd/systemd on this platform");
    else check("skillhook", "service", service.running ? "ok" : service.installed ? "warn" : "skip", service.running ? `${service.platform} running (pid ${service.pid})` : service.installed ? `${service.platform} installed but not running` : "not installed", service.running ? undefined : "run: skillhook service install", { platform: service.platform, installed: service.installed, running: service.running, pid: service.pid ?? null });
  }

  const summary = summarize(checks);
  const groups = Object.fromEntries(HEALTH_GROUPS.map((group) => [group, summarize(checks.filter((c) => c.group === group))])) as Record<HealthGroup, HealthSummary>;
  return { checks, ok: summary.fail === 0, summary, groups, public_url: publicUrl, server, generated_at: new Date(started).toISOString(), duration_ms: Date.now() - started, deep, network };
}

const ICON: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "-" };

/** The report grouped, one line per check, hints indented. */
export function formatHealth(report: HealthReport): string {
  const lines: string[] = [];
  for (const group of HEALTH_GROUPS) {
    const checks = report.checks.filter((c) => c.group === group);
    if (!checks.length) continue;
    lines.push(group);
    for (const c of checks) lines.push(`  ${ICON[c.status]} ${c.name.padEnd(26)} ${c.detail}${c.hint ? `\n      → ${c.hint}` : ""}`);
  }
  lines.push("", `${report.summary.ok} ok, ${report.summary.warn} warnings, ${report.summary.fail} failures, ${report.summary.skip} skipped (${report.deep ? "deep" : "quick"}, ${(report.duration_ms / 1000).toFixed(1)}s)`);
  if (report.public_url) lines.push(`public URL: ${report.public_url}`);
  return lines.join("\n");
}

export interface HealthChange {
  name: string;
  from: CheckStatus | null;
  to: CheckStatus;
}

/** Which checks changed status between two reports (new checks come from `null`). */
export function diffHealth(previous: HealthReport | undefined, next: HealthReport): HealthChange[] {
  const before = new Map(previous?.checks.map((c) => [c.name, c.status]) ?? []);
  const changes: HealthChange[] = [];
  for (const c of next.checks) {
    const from = before.get(c.name) ?? null;
    if (from !== c.status) changes.push({ name: c.name, from, to: c.status });
  }
  return changes;
}

export interface HealthCacheDeps {
  /** How long a report stays fresh. */
  ttlMs: () => number;
  /** The options every run starts from (`live`, `timeoutMs`, `env`). */
  options?: () => HealthOptions;
  events?: Events;
}

/**
 * One report per flavour (deep or quick, with or without network), reused within the TTL; concurrent callers share
 * one run. Emits `health.changed` for the first report of a flavour and whenever a check changed status.
 */
export class HealthCache {
  private readonly cached = new Map<string, { report: HealthReport; at: number }>();
  private readonly pending = new Map<string, Promise<HealthReport>>();

  constructor(
    private readonly paths: Paths,
    private readonly deps: HealthCacheDeps,
  ) {}

  async get(input: { deep?: boolean; network?: boolean; refresh?: boolean } = {}): Promise<{ report: HealthReport; cached: boolean }> {
    const deep = input.deep ?? true;
    const network = input.network ?? false;
    const key = `${deep ? "deep" : "quick"}:${network ? "net" : "local"}`;
    const hit = this.cached.get(key);
    if (!input.refresh && hit && Date.now() - hit.at < this.deps.ttlMs()) return { report: hit.report, cached: true };
    const inflight = this.pending.get(key);
    if (inflight) return { report: await inflight, cached: false };
    const promise = runHealth(this.paths, { ...(this.deps.options?.() ?? {}), deep, network }).then(
      (report) => {
        const previous = this.cached.get(key)?.report;
        this.cached.set(key, { report, at: Date.now() });
        this.pending.delete(key);
        const changed = diffHealth(previous, report);
        if (this.deps.events && (!previous || changed.length)) this.deps.events.emit("health.changed", { report, changed });
        return report;
      },
      (error: unknown) => {
        this.pending.delete(key);
        throw error;
      },
    );
    this.pending.set(key, promise);
    return { report: await promise, cached: false };
  }

  /** The newest report of any flavour, without running anything. */
  last(): HealthReport | undefined {
    let newest: { report: HealthReport; at: number } | undefined;
    for (const entry of this.cached.values()) if (!newest || entry.at > newest.at) newest = entry;
    return newest?.report;
  }
}
