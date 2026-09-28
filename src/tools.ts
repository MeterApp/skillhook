// Probes of the external CLIs skillhook depends on: what `claude` and `codex` say about their version, login, MCP
// servers, plugins and their own doctor. They run with the same environment as a job (`baseRunEnv`), so a
// `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or API key in `.env` applies to the diagnosis exactly as to the runs. The parsers
// are pure and exported so the captured real outputs in the tests pin them down; unknown lines never throw.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { commandParts } from "./runners/types.js";
import { which } from "./tailscale.js";
import { isPlainObject } from "./util.js";

export interface ToolExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The command could not be started at all (ENOENT, EACCES). */
  spawnError?: string;
}

/** Runs one tool with the given environment (its PATH decides what is found); never throws. */
export function execTool(command: string, args: string[], options: { env: Record<string, string>; timeoutMs?: number; cwd?: string }): Promise<ToolExecResult> {
  return new Promise((resolve) => {
    execFile(command, args, { env: options.env, cwd: options.cwd, timeout: options.timeoutMs ?? 20_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr, timedOut: false });
      const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stdout?: string; stderr?: string };
      const started = typeof e.code !== "string"; // execFile reports a numeric exit code once the process ran; ENOENT & co. are strings
      resolve({ code: typeof e.code === "number" ? e.code : null, stdout: typeof stdout === "string" ? stdout : "", stderr: typeof stderr === "string" ? stderr : "", timedOut: e.killed === true && e.signal === "SIGTERM", ...(started ? {} : { spawnError: e.message }) });
    });
  });
}

/** Where a configured command (`claude`, `/usr/local/bin/claude`, `["node", "/path/cli.js"]`) actually is, on the given PATH. */
export function resolveCommand(command: string | string[], pathVar: string | undefined): { command: string; lead: string[]; path?: string } {
  const parts = commandParts(command);
  const path = parts.command.includes("/") ? (existsSync(parts.command) ? parts.command : undefined) : which(parts.command, pathVar);
  return { command: parts.command, lead: parts.lead, path };
}

export function parseVersion(text: string): string | undefined {
  for (const token of text.trim().split(/\s+/)) {
    const clean = token.replace(/^v/, "");
    if (/^\d+\.\d+\.\d+/.test(clean)) return clean;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

export interface ToolAuth {
  loggedIn: boolean;
  /** `claude.ai`, `console`, `apiKey`, `none`, … as the CLI reports it; `chatgpt` / `api_key` for Codex. */
  method?: string;
  provider?: string;
  detail: string;
}

export type McpServerState = "connected" | "needs_auth" | "failed" | "disabled" | "unknown";

export interface ClaudeMcpServer {
  name: string;
  /** The URL or the command line, as printed. */
  target: string;
  transport?: string;
  state: McpServerState;
  detail?: string;
}

export interface ClaudePlugin {
  id: string;
  version?: string;
  scope?: string;
  enabled: boolean;
  mcp_servers: string[];
  installed_at?: string;
  last_updated?: string;
}

export interface ClaudeProbe {
  found: boolean;
  path?: string;
  version?: string;
  auth: ToolAuth;
  /** Only with `deep`. */
  mcp?: { servers: ClaudeMcpServer[]; warnings: string[]; error?: string };
  plugins?: { plugins: ClaudePlugin[]; error?: string };
}

/** `claude auth status` prints JSON and exits 0 whether or not anyone is logged in. */
export function parseClaudeAuth(result: Pick<ToolExecResult, "code" | "stdout" | "stderr">): ToolAuth {
  try {
    const json = JSON.parse(result.stdout) as unknown;
    if (isPlainObject(json) && typeof json.loggedIn === "boolean") {
      const method = typeof json.authMethod === "string" ? json.authMethod : undefined;
      const provider = typeof json.apiProvider === "string" ? json.apiProvider : undefined;
      return { loggedIn: json.loggedIn, method, provider, detail: json.loggedIn ? `logged in (${method ?? "unknown method"})` : "not logged in" };
    }
  } catch {
    /* not JSON: an older CLI */
  }
  const firstLine = `${result.stdout}${result.stderr}`.trim().split("\n")[0] ?? "";
  return { loggedIn: result.code === 0, detail: firstLine || `claude auth status exited with code ${result.code ?? "?"} and printed nothing` };
}

const MCP_MARKS: { mark: string; state: McpServerState }[] = [
  { mark: " - ✔", state: "connected" },
  { mark: " - ✘", state: "failed" },
  { mark: " - !", state: "needs_auth" },
];

/**
 * `claude mcp list` is text: one `name: target [(transport)] - <mark> <state>` line per server, then an optional
 * "MCP config diagnostics" block whose warnings are kept as plain strings.
 */
export function parseClaudeMcpList(text: string): { servers: ClaudeMcpServer[]; warnings: string[] } {
  const servers: ClaudeMcpServer[] = [];
  const warnings: string[] = [];
  let diagnostics = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith("MCP config diagnostics")) {
      diagnostics = true;
      continue;
    }
    if (diagnostics) {
      let item = line.trim();
      while (item.startsWith("├") || item.startsWith("└") || item.startsWith("│")) item = item.slice(1).trim();
      if (item.startsWith("[Warning]")) warnings.push(item.slice("[Warning]".length).trim());
      else if (item.startsWith("[Error]")) warnings.push(item.slice("[Error]".length).trim());
      else if (item.startsWith("Server ")) warnings.push(item);
      continue;
    }
    let cut = -1;
    let state: McpServerState = "unknown";
    for (const candidate of MCP_MARKS) {
      const index = line.indexOf(candidate.mark);
      if (index >= 0 && (cut < 0 || index < cut)) {
        cut = index;
        state = candidate.state;
      }
    }
    if (cut < 0) continue;
    const head = line.slice(0, cut);
    const colon = head.indexOf(": ");
    if (colon <= 0) continue;
    const name = head.slice(0, colon).trim();
    let target = head.slice(colon + 2).trim();
    let transport: string | undefined;
    if (target.endsWith(")")) {
      const open = target.lastIndexOf(" (");
      if (open > 0) {
        transport = target.slice(open + 2, -1);
        target = target.slice(0, open).trim();
      }
    }
    const tail = line.slice(cut + 4).trim(); // after the mark: "Connected", "Failed to connect — …", "Needs authentication"
    const dash = tail.indexOf(" — ");
    const detail = dash >= 0 ? tail.slice(dash + 3).trim() : tail;
    servers.push({ name, target, ...(transport ? { transport } : {}), state, ...(state === "connected" ? {} : { detail }) });
  }
  return { servers, warnings };
}

/** `claude plugin list --json`: an array of `{id, version, scope, enabled, installPath, installedAt, lastUpdated, mcpServers}`. */
export function parseClaudePlugins(text: string): ClaudePlugin[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const plugins: ClaudePlugin[] = [];
  for (const item of parsed) {
    if (!isPlainObject(item) || typeof item.id !== "string") continue;
    plugins.push({
      id: item.id,
      ...(typeof item.version === "string" ? { version: item.version } : {}),
      ...(typeof item.scope === "string" ? { scope: item.scope } : {}),
      enabled: item.enabled !== false,
      mcp_servers: isPlainObject(item.mcpServers) ? Object.keys(item.mcpServers) : [],
      ...(typeof item.installedAt === "string" ? { installed_at: item.installedAt } : {}),
      ...(typeof item.lastUpdated === "string" ? { last_updated: item.lastUpdated } : {}),
    });
  }
  return plugins;
}

function describeFailure(result: ToolExecResult, what: string): string {
  if (result.spawnError) return result.spawnError;
  if (result.timedOut) return `${what} timed out`;
  const line = `${result.stderr}${result.stdout}`.trim().split("\n")[0] ?? "";
  return line || `${what} exited with code ${result.code ?? "?"}`;
}

export interface ProbeOptions {
  /** The environment to run the CLI with (`baseRunEnv`); its PATH decides what is found. */
  env: Record<string, string>;
  /** Also list MCP servers and plugins (Claude) / MCP servers and `codex doctor` (Codex): slower, one process each. */
  deep?: boolean;
  /** For the slow listings (`claude mcp list` connects to every server); the quick calls get 15 s. */
  timeoutMs?: number;
}

export async function probeClaude(command: string | string[], options: ProbeOptions): Promise<ClaudeProbe> {
  const resolved = resolveCommand(command, options.env.PATH);
  if (!resolved.path) return { found: false, auth: { loggedIn: false, detail: `${resolved.command} not found on PATH` } };
  const exec = (args: string[], timeoutMs: number) => execTool(resolved.path!, [...resolved.lead, ...args], { env: options.env, timeoutMs });
  const [version, auth] = await Promise.all([exec(["--version"], 15_000), exec(["auth", "status"], 15_000)]);
  const probe: ClaudeProbe = { found: true, path: resolved.path, version: parseVersion(version.stdout), auth: parseClaudeAuth(auth) };
  if (options.deep) {
    const [mcp, plugins] = await Promise.all([exec(["mcp", "list"], options.timeoutMs ?? 20_000), exec(["plugin", "list", "--json"], 15_000)]);
    const listed = parseClaudeMcpList(mcp.stdout);
    probe.mcp = { ...listed, ...(mcp.code !== 0 || mcp.timedOut ? { error: describeFailure(mcp, "claude mcp list") } : {}) };
    probe.plugins = { plugins: parseClaudePlugins(plugins.stdout), ...(plugins.code !== 0 ? { error: describeFailure(plugins, "claude plugin list") } : {}) };
  }
  return probe;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export interface CodexMcpServer {
  name: string;
  enabled: boolean;
  transport?: string;
  target: string;
  auth_status?: string;
  state: McpServerState;
  detail?: string;
}

export interface CodexDoctorCheck {
  id: string;
  category?: string;
  status: "ok" | "warn" | "fail" | "skip";
  summary: string;
  remediation?: string;
}

export interface CodexProbe {
  found: boolean;
  path?: string;
  version?: string;
  auth: ToolAuth;
  mcp?: { servers: CodexMcpServer[]; error?: string };
  doctor?: { overall?: string; checks: CodexDoctorCheck[]; error?: string };
}

/** `codex login status` prints one line (`Logged in using ChatGPT`, `Logged in using an API key`, `Not logged in`) and exits non-zero when logged out. */
export function parseCodexLogin(result: Pick<ToolExecResult, "code" | "stdout" | "stderr">): ToolAuth {
  const text = `${result.stdout}${result.stderr}`.trim().split("\n")[0] ?? "";
  const lower = text.toLowerCase();
  const loggedIn = result.code === 0 && !lower.includes("not logged in");
  const method = !loggedIn ? "none" : lower.includes("api key") ? "api_key" : lower.includes("chatgpt") ? "chatgpt" : undefined;
  return { loggedIn, ...(method ? { method } : {}), detail: text || (loggedIn ? "logged in" : "not logged in") };
}

function codexMcpState(item: Record<string, unknown>): { state: McpServerState; detail?: string } {
  if (item.enabled === false) return { state: "disabled", detail: typeof item.disabled_reason === "string" && item.disabled_reason ? item.disabled_reason : "disabled" };
  const auth = typeof item.auth_status === "string" ? item.auth_status.toLowerCase() : "";
  if (auth.includes("not_logged") || auth.includes("needs") || auth === "unauthenticated") return { state: "needs_auth", detail: `auth status ${item.auth_status as string}` };
  return { state: "connected" }; // listed and enabled: Codex does not connect at list time
}

/** `codex mcp list --json`: `{name, enabled, disabled_reason, transport: {type, command, args | url}, auth_status}` per server. */
export function parseCodexMcpList(text: string): CodexMcpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const servers: CodexMcpServer[] = [];
  for (const item of parsed) {
    if (!isPlainObject(item) || typeof item.name !== "string") continue;
    const transport = isPlainObject(item.transport) ? item.transport : {};
    const type = typeof transport.type === "string" ? transport.type : undefined;
    const target = typeof transport.url === "string" ? transport.url : typeof transport.command === "string" ? [transport.command, ...(Array.isArray(transport.args) ? transport.args.map(String) : [])].join(" ") : "";
    const { state, detail } = codexMcpState(item);
    servers.push({ name: item.name, enabled: item.enabled !== false, ...(type ? { transport: type } : {}), target, ...(typeof item.auth_status === "string" ? { auth_status: item.auth_status } : {}), state, ...(detail ? { detail } : {}) });
  }
  return servers;
}

function codexStatus(value: unknown): CodexDoctorCheck["status"] {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text === "ok" || text === "pass" || text === "passed") return "ok";
  if (text.startsWith("warn")) return "warn";
  if (text === "error" || text === "fail" || text === "failed" || text === "critical") return "fail";
  return "skip";
}

/** `codex doctor --json`: `{overallStatus, codexVersion, checks: {<id>: {id, category, status, summary, remediation}}}`. */
export function parseCodexDoctor(text: string): { version?: string; overall?: string; checks: CodexDoctorCheck[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { checks: [] };
  }
  if (!isPlainObject(parsed)) return { checks: [] };
  const checks: CodexDoctorCheck[] = [];
  const raw = isPlainObject(parsed.checks) ? Object.values(parsed.checks) : Array.isArray(parsed.checks) ? parsed.checks : [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const id = typeof item.id === "string" ? item.id : undefined;
    if (!id) continue;
    checks.push({ id, ...(typeof item.category === "string" ? { category: item.category } : {}), status: codexStatus(item.status), summary: typeof item.summary === "string" ? item.summary : "", ...(typeof item.remediation === "string" && item.remediation ? { remediation: item.remediation } : {}) });
  }
  return { ...(typeof parsed.codexVersion === "string" ? { version: parsed.codexVersion } : {}), ...(typeof parsed.overallStatus === "string" ? { overall: parsed.overallStatus } : {}), checks };
}

export async function probeCodex(command: string | string[], options: ProbeOptions): Promise<CodexProbe> {
  const resolved = resolveCommand(command, options.env.PATH);
  if (!resolved.path) return { found: false, auth: { loggedIn: false, detail: `${resolved.command} not found on PATH` } };
  const exec = (args: string[], timeoutMs: number) => execTool(resolved.path!, [...resolved.lead, ...args], { env: options.env, timeoutMs });
  const [version, login] = await Promise.all([exec(["--version"], 15_000), exec(["login", "status"], 15_000)]);
  const probe: CodexProbe = { found: true, path: resolved.path, version: parseVersion(version.stdout), auth: parseCodexLogin(login) };
  if (options.deep) {
    const [mcp, doctor] = await Promise.all([exec(["mcp", "list", "--json"], 15_000), exec(["doctor", "--json"], options.timeoutMs ?? 20_000)]);
    probe.mcp = { servers: parseCodexMcpList(mcp.stdout), ...(mcp.code !== 0 ? { error: describeFailure(mcp, "codex mcp list") } : {}) };
    const parsed = parseCodexDoctor(doctor.stdout);
    probe.doctor = { ...parsed, ...(doctor.code !== 0 && !parsed.checks.length ? { error: describeFailure(doctor, "codex doctor") } : {}) };
    if (!probe.version && parsed.version) probe.version = parsed.version;
  }
  return probe;
}
