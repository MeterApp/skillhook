// The MCP servers, connectors and plugins one account's runs get, as its own CLI reports them with the account's
// environment: every account has its own configuration directory, so its servers, its claude.ai / ChatGPT connectors
// and its plugins can differ from the machine's own login, and each needs its own authentication.
//   Claude Code: the control protocol's `mcp_status` (`claude -p --input-format stream-json`, as the account probe
//   speaks it, but with the account's MCP configuration and claude.ai connectors left on), asked again until no server
//   is `pending`; `claude plugin list --json` for the plugins. An older CLI without it falls back to `claude mcp list`.
//   Codex: `codex mcp list --json` (what is configured and enabled) merged with the app server's `mcpServerStatus/list`
//   (what connected, with how many tools, and why not); `codex plugin list` for the plugins.
// No prompt is sent. The CLIs' answers carry each server's headers and environment (tokens): only the URL or command
// line is kept, as `claude mcp list` prints it. The parsers are pure and pinned by captured real answers in the tests.
import { converse } from "./account-probe.js";
import type { ResolvedAccount } from "./accounts.js";
import { execTool, parseClaudeMcpList, parseClaudePlugins, parseCodexMcpList, parseCodexPlugins, resolveCommand, type McpServerState } from "./tools.js";
import { isPlainObject, nowIso } from "./util.js";

export interface AccountMcpServer {
  name: string;
  /** The URL or the command line (never headers or environment). */
  target: string;
  transport?: string;
  state: McpServerState;
  detail?: string;
  /** Where it is configured: `user`, `project`, `local`, `managed`, `plugin`, `connector` (claude.ai / ChatGPT), … */
  source?: string;
  /** The plugin that ships it. */
  plugin?: string;
  /** Tools it offered (when it connected). */
  tools?: number;
}

export interface AccountMcpPlugin {
  id: string;
  version?: string;
  enabled: boolean;
}

export interface AccountMcp {
  servers: AccountMcpServer[];
  plugins?: AccountMcpPlugin[];
  /** `status`: the CLI's own connection report; `list`: the plain listing (an older CLI). */
  via?: "status" | "list";
  /** The listing failed or is incomplete. */
  error?: string;
  checked_at: string;
}

export interface ProbeMcpOptions {
  command: string | string[];
  /** The account's environment (`withAccountEnv`). */
  env: Record<string, string>;
  timeoutMs?: number;
  /** Claude Code: ask at least this long, so the claude.ai connectors (fetched in the background) are listed. Default 3 s. */
  settleMs?: number;
}

/** A CLI's error, one line and short (Codex's carry the whole transport chain). */
export function shortError(text: string): string {
  let line = (text.split("\n")[0] ?? "").trim();
  if (line.startsWith("MCP startup failed: ")) line = line.slice("MCP startup failed: ".length);
  const transport = line.indexOf(" Transport [");
  if (transport > 0) line = line.slice(0, transport).trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** One line: a command can be a whole shell script. */
function oneLine(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** The URL or command line of a server's `config`, nothing else from it. */
function targetOf(config: unknown): { target: string; transport?: string } {
  if (!isPlainObject(config)) return { target: "" };
  const transport = typeof config.type === "string" ? config.type : undefined;
  if (typeof config.url === "string") return { target: config.url, ...(transport ? { transport } : {}) };
  if (typeof config.command === "string") return { target: oneLine([config.command, ...(Array.isArray(config.args) ? config.args.map(String) : [])].join(" ")), transport: transport ?? "stdio" };
  return { target: "", ...(transport ? { transport } : {}) };
}

const CLAUDE_STATES: Record<string, McpServerState> = { connected: "connected", failed: "failed", "needs-auth": "needs_auth", disabled: "disabled", pending: "unknown" };

/** `mcp_status`: `{mcpServers: [{name, status, serverInfo, error, error_code, config, scope, source, tools}]}`. */
export function parseClaudeMcpStatus(response: unknown): AccountMcpServer[] | undefined {
  if (!isPlainObject(response) || !Array.isArray(response.mcpServers)) return undefined;
  const servers: AccountMcpServer[] = [];
  for (const item of response.mcpServers) {
    if (!isPlainObject(item) || typeof item.name !== "string") continue;
    const status = typeof item.status === "string" ? item.status : "";
    const state = CLAUDE_STATES[status] ?? "unknown";
    const scope = typeof item.source === "string" ? item.source : typeof item.scope === "string" ? item.scope : undefined;
    const connector = scope === "claudeai" || item.scope === "claudeai";
    const { target, transport } = targetOf(item.config);
    const error = typeof item.error === "string" && item.error ? shortError(item.error) : undefined;
    const code = typeof item.error_code === "string" ? item.error_code : undefined;
    const detail = state === "connected" ? undefined : status === "pending" ? "still connecting" : error ? `${error}${code ? ` (${code})` : ""}` : state === "needs_auth" ? "needs authentication" : status || "no status";
    // Plugin servers are named `plugin:<plugin>:<server>`.
    const plugin = item.name.startsWith("plugin:") ? item.name.split(":")[1] : undefined;
    servers.push({ name: item.name, target: target || (connector ? "claude.ai" : ""), ...(transport ? { transport } : {}), state, ...(detail ? { detail } : {}), ...(scope ? { source: connector ? "connector" : scope } : {}), ...(plugin ? { plugin } : {}), ...(Array.isArray(item.tools) ? { tools: item.tools.length } : {}) });
  }
  return servers;
}

export async function probeClaudeMcp(options: ProbeMcpOptions): Promise<AccountMcp> {
  const resolved = resolveCommand(options.command, options.env.PATH);
  if (!resolved.path) return { servers: [], error: `${resolved.command} not found on PATH`, checked_at: nowIso() };
  const timeoutMs = options.timeoutMs ?? 20_000;
  const settleMs = Math.min(options.settleMs ?? 3_000, Math.max(0, timeoutMs - 2_000));
  // A run's own MCP configuration, connectors included: no --strict-mcp-config, no ENABLE_CLAUDEAI_MCP_SERVERS=false.
  const env = { ...options.env, CLAUDE_CODE_AUTO_CONNECT_IDE: "0", CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1" };
  const args = [...resolved.lead, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--settings", '{"disableAllHooks":true}'];
  let latest: AccountMcpServer[] | undefined;
  let refused: string | undefined;
  let asked = 0;
  let started = 0;
  let again: NodeJS.Timeout | undefined;
  const plugins = execTool(resolved.path, [...resolved.lead, "plugin", "list", "--json"], { env, timeoutMs: 15_000 });
  const result = await converse(
    resolved.path,
    args,
    env,
    timeoutMs,
    (session) => session.send({ type: "control_request", request_id: "init", request: { subtype: "initialize" } }),
    (message, session) => {
      if (message.type !== "control_response" || !isPlainObject(message.response)) return false;
      const response = message.response;
      const ask = () => session.send({ type: "control_request", request_id: `mcp${++asked}`, request: { subtype: "mcp_status" } });
      if (response.request_id === "init") {
        started = Date.now();
        ask();
        return false;
      }
      if (response.subtype !== "success") {
        refused = typeof response.error === "string" ? response.error : "mcp_status failed";
        session.end();
        return true;
      }
      latest = parseClaudeMcpStatus(response.response);
      if (!latest) {
        refused = "mcp_status gave no server list";
        session.end();
        return true;
      }
      if (!latest.some((s) => s.detail === "still connecting") && Date.now() - started >= settleMs) {
        session.end();
        return true;
      }
      again = setTimeout(ask, 500);
      return false;
    },
  );
  clearTimeout(again);
  const listed = await plugins;
  const pluginList = listed.code === 0 ? parseClaudePlugins(listed.stdout).map((p) => ({ id: p.id, ...(p.version ? { version: p.version } : {}), enabled: p.enabled })) : undefined;
  const checked_at = nowIso();
  if (latest) {
    const pending = latest.filter((s) => s.detail === "still connecting");
    return { servers: latest, ...(pluginList ? { plugins: pluginList } : {}), via: "status", ...(pending.length && !result.done ? { error: `${pending.length} server(s) still connecting after ${Math.round(timeoutMs / 1000)}s` } : {}), checked_at };
  }
  // An older Claude Code (no `mcp_status`): the listing, which connects to the configured servers but not to connectors.
  const list = await execTool(resolved.path, [...resolved.lead, "mcp", "list"], { env, timeoutMs });
  const parsed = parseClaudeMcpList(list.stdout);
  const failed = list.code !== 0 || list.timedOut ? (list.spawnError ?? (list.timedOut ? "claude mcp list timed out" : `claude mcp list exited with code ${list.code ?? "?"}`)) : undefined;
  const why = refused ?? result.error;
  return { servers: parsed.servers.map((s) => ({ ...s })), ...(pluginList ? { plugins: pluginList } : {}), via: "list", ...(failed ? { error: failed } : !parsed.servers.length && why ? { error: why } : {}), checked_at };
}

/** `mcpServerStatus/list`: `{data: [{name, pluginId, httpOrigin, serverInfo, tools, toolsError, authStatus}], nextCursor}`. */
export function parseCodexMcpStatus(result: unknown): { servers: Map<string, { state: McpServerState; detail?: string; tools?: number; plugin?: string; origin?: string; auth?: string }>; next?: string } {
  const servers = new Map<string, { state: McpServerState; detail?: string; tools?: number; plugin?: string; origin?: string; auth?: string }>();
  if (!isPlainObject(result) || !Array.isArray(result.data)) return { servers };
  for (const item of result.data) {
    if (!isPlainObject(item) || typeof item.name !== "string") continue;
    const tools = isPlainObject(item.tools) ? Object.keys(item.tools).length : Array.isArray(item.tools) ? item.tools.length : undefined;
    const error = typeof item.toolsError === "string" && item.toolsError ? shortError(item.toolsError) : undefined;
    const auth = typeof item.authStatus === "string" ? item.authStatus : undefined;
    const lower = (error ?? "").toLowerCase();
    let state: McpServerState;
    let detail: string | undefined;
    if (error && (lower.includes("authorization required") || lower.includes("not logged in") || (auth === "notLoggedIn" && !tools))) {
      state = "needs_auth";
      detail = error;
    } else if (error) {
      state = "failed";
      detail = error;
    } else if (isPlainObject(item.serverInfo) || (tools ?? 0) > 0) state = "connected";
    else {
      state = "unknown";
      detail = "did not start";
    }
    servers.set(item.name, { state, ...(detail ? { detail } : {}), ...(tools !== undefined && state === "connected" ? { tools } : {}), ...(typeof item.pluginId === "string" ? { plugin: item.pluginId } : {}), ...(typeof item.httpOrigin === "string" ? { origin: item.httpOrigin } : {}), ...(auth ? { auth } : {}) });
  }
  return { servers, ...(typeof result.nextCursor === "string" && result.nextCursor ? { next: result.nextCursor } : {}) };
}

/** What is configured (`codex mcp list --json`) and what connected (`mcpServerStatus/list`), one row per server. */
export function mergeCodexMcp(configured: ReturnType<typeof parseCodexMcpList>, status: ReturnType<typeof parseCodexMcpStatus>["servers"] | undefined): AccountMcpServer[] {
  const out: AccountMcpServer[] = [];
  for (const server of configured) {
    const live = status?.get(server.name);
    const base = { name: server.name, target: oneLine(server.target), ...(server.transport ? { transport: server.transport } : {}), source: "user" };
    if (!server.enabled) out.push({ ...base, state: "disabled", detail: server.detail ?? "disabled" });
    else if (!live) out.push({ ...base, state: status ? "unknown" : server.state, ...(status ? { detail: "not in the status report" } : server.detail ? { detail: server.detail } : {}) });
    else out.push({ ...base, state: live.state, ...(live.detail ? { detail: live.detail } : {}), ...(live.tools !== undefined ? { tools: live.tools } : {}) });
  }
  // Servers the configuration does not list: plugins' and the ChatGPT apps (`codex_apps`).
  for (const [name, live] of status ?? []) {
    if (configured.some((s) => s.name === name)) continue;
    out.push({ name, target: live.origin ?? "", state: live.state, ...(live.detail ? { detail: live.detail } : {}), source: live.plugin ? "plugin" : name === "codex_apps" ? "connector" : "user", ...(live.plugin ? { plugin: live.plugin } : {}), ...(live.tools !== undefined ? { tools: live.tools } : {}) });
  }
  return out;
}

export async function probeCodexMcp(options: ProbeMcpOptions): Promise<AccountMcp> {
  const resolved = resolveCommand(options.command, options.env.PATH);
  if (!resolved.path) return { servers: [], error: `${resolved.command} not found on PATH`, checked_at: nowIso() };
  const timeoutMs = options.timeoutMs ?? 20_000;
  const exec = (args: string[], ms: number) => execTool(resolved.path!, [...resolved.lead, ...args], { env: options.env, timeoutMs: ms });
  const pages: ReturnType<typeof parseCodexMcpStatus>["servers"][] = [];
  let id = 1;
  const status = converse(
    resolved.path,
    [...resolved.lead, "app-server"],
    options.env,
    timeoutMs,
    (session) => session.send({ id: 1, method: "initialize", params: { clientInfo: { name: "skillhook", title: "skillhook", version: "1" } } }),
    (message, session) => {
      if (typeof message.id !== "number") return false;
      if (message.id === 1) {
        session.send({ method: "initialized" });
        session.send({ id: ++id, method: "mcpServerStatus/list", params: {} });
        return false;
      }
      if (message.id !== id) return false;
      if (!("result" in message)) {
        session.end();
        return true;
      }
      const page = parseCodexMcpStatus(message.result);
      pages.push(page.servers);
      if (page.next && pages.length < 10) {
        session.send({ id: ++id, method: "mcpServerStatus/list", params: { cursor: page.next } });
        return false;
      }
      session.end();
      return true;
    },
  );
  const [list, live, plugins] = await Promise.all([exec(["mcp", "list", "--json"], 15_000), status, exec(["plugin", "list"], 15_000)]);
  const configured = parseCodexMcpList(list.stdout);
  // An older Codex without `mcpServerStatus/list` answers with an error: the listing alone, as `skillhook health` reads it.
  const merged = pages.length ? new Map(pages.flatMap((p) => [...p])) : undefined;
  const servers = mergeCodexMcp(configured, merged);
  const pluginList = plugins.code === 0 ? parseCodexPlugins(plugins.stdout).filter((p) => p.installed).map((p) => ({ id: p.id, ...(p.version ? { version: p.version } : {}), enabled: p.enabled })) : undefined;
  const error = list.code !== 0 ? (list.spawnError ?? (shortError(`${list.stderr}${list.stdout}`) || `codex mcp list exited with code ${list.code ?? "?"}`)) : !merged ? `no connection status (${live.error ?? "codex app-server gave none"}); listed only` : undefined;
  return { servers, ...(pluginList ? { plugins: pluginList } : {}), via: merged ? "status" : "list", ...(error ? { error } : {}), checked_at: nowIso() };
}

/** The account's MCP servers, connectors and plugins, from its CLI, with the account's environment. */
export function probeAccountMcp(account: Pick<ResolvedAccount, "runner">, options: ProbeMcpOptions): Promise<AccountMcp> {
  return account.runner === "claude" ? probeClaudeMcp(options) : probeCodexMcp(options);
}

/** "7/9": servers that connected of those that are not disabled. */
export function mcpSummary(mcp: AccountMcp | undefined): string {
  if (!mcp) return "";
  const active = mcp.servers.filter((s) => s.state !== "disabled");
  if (!active.length) return mcp.error ? "?" : "none";
  return `${active.filter((s) => s.state === "connected").length}/${active.length}`;
}
