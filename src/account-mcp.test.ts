import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mcpSummary, mergeCodexMcp, parseClaudeMcpStatus, parseCodexMcpStatus, probeClaudeMcp, probeCodexMcp, shortError } from "./account-mcp.js";
import { mcpAttention } from "./account-report.js";
import { mergedPath } from "./runners/env.js";
import { parseCodexMcpList } from "./tools.js";
import { FAKE_CLAUDE, FAKE_CODEX, tempHome } from "./test-support/helpers.js";

// Captured from Claude Code 2.1.305 (`mcp_status` control request) and codex-cli 0.163.0 (`mcpServerStatus/list`),
// header values and tokens replaced. The claude.ai connector row follows the CLI's schema (`scope: "claudeai"`,
// `claudeai-proxy` config); the machine it was captured on had none.
const CLAUDE_MCP_STATUS = {
  mcpServers: [
    { name: "plugin:supabase:supabase", status: "needs-auth", config: { type: "http", url: "https://mcp.supabase.com/mcp", headers: { "X-Source-Name": "claude-code-plugin", "X-Source-Version": "0.1.16" } }, scope: "dynamic", source: "plugin" },
    { name: "stitch", status: "connected", serverInfo: { name: "StatelessServer", version: "scaffolding on HTTPServer2" }, config: { type: "http", url: "https://stitch.googleapis.com/mcp", headers: { "X-Goog-Api-Key": "REDACTED-KEY" } }, scope: "user", source: "user", tools: [{ name: "a" }, { name: "b" }] },
    { name: "intercom", status: "pending", config: { type: "stdio", command: "npx", args: ["mcp-remote", "https://mcp.intercom.com/mcp"] }, scope: "user", source: "user" },
    { name: "homeassistant", status: "failed", error: "Connection to http://homeassistant.local:8123/api/mcp failed\nstack…", error_code: "APPROVAL_REQUIRED", config: { type: "http", url: "http://homeassistant.local:8123/api/mcp", headers: { Authorization: "Bearer REDACTED" } }, scope: "project", source: "project" },
    { name: "claude.ai Gmail", status: "needs-auth", config: { type: "claudeai-proxy", url: "https://mcp-proxy.anthropic.com/v1/mcp/mcpsrv_1", id: "mcpsrv_1" }, scope: "claudeai", source: "claudeai" },
  ],
};
const server = (name: string, extra: Record<string, unknown>) => ({ name, runtimeStatus: null, pluginId: null, httpOrigin: null, serverInfo: null, serverCapabilities: null, tools: {}, toolsError: null, resources: [], resourceTemplates: [], authStatus: "unsupported", ...extra });
const CODEX_MCP_STATUS = {
  data: [
    server("car-image", { pluginId: "car-image@meterapp", httpOrigin: "https://carimage.dev", toolsError: "MCP startup failed: failed to refresh OAuth tokens for server car-image: OAuth authorization required", authStatus: "notLoggedIn" }),
    server("homeassistant", { httpOrigin: "http://homeassistant.local:8123", toolsError: "MCP startup failed: handshaking with MCP server failed: Send message error Transport [codex_rmcp_client::event_notification_transport::EventNotificationTransport<…>] error: Client error: HTTP request failed", authStatus: "bearerToken" }),
    server("stitch", { httpOrigin: "https://stitch.googleapis.com", serverInfo: { name: "StatelessServer", version: "1" }, tools: { a: {}, b: {} }, authStatus: "notLoggedIn" }),
    server("slack", { httpOrigin: "https://mcp.slack.com" }),
    server("codex_apps", { httpOrigin: "https://chatgpt.com", serverInfo: { name: "plugin-runtime", version: "0.1.0" }, tools: { a: {} }, authStatus: "bearerToken" }),
  ],
  nextCursor: null,
};
const CODEX_MCP_LIST = JSON.stringify([
  { name: "homeassistant", enabled: true, disabled_reason: null, transport: { type: "streamable_http", url: "http://homeassistant.local:8123/api/mcp", bearer_token_env_var: "HA_TOKEN", http_headers: null }, auth_status: "bearer_token" },
  { name: "slack", enabled: false, disabled_reason: null, transport: { type: "streamable_http", url: "https://mcp.slack.com/mcp", bearer_token_env_var: null, http_headers: null }, auth_status: "unsupported" },
  { name: "stitch", enabled: true, disabled_reason: null, transport: { type: "streamable_http", url: "https://stitch.googleapis.com/mcp", bearer_token_env_var: null, http_headers: { "X-Goog-Api-Key": "REDACTED-KEY" } }, auth_status: "not_logged_in" },
  { name: "kling", enabled: true, disabled_reason: null, transport: { type: "streamable_http", url: "https://kling.ai/mcp", bearer_token_env_var: null, http_headers: null }, auth_status: "not_logged_in" },
]);

describe("account MCP parsers", () => {
  it("reads Claude Code's mcp_status, keeping only the URL or command of each server", () => {
    const servers = parseClaudeMcpStatus(CLAUDE_MCP_STATUS)!;
    expect(servers).toEqual([
      { name: "plugin:supabase:supabase", target: "https://mcp.supabase.com/mcp", transport: "http", state: "needs_auth", detail: "needs authentication", source: "plugin", plugin: "supabase" },
      { name: "stitch", target: "https://stitch.googleapis.com/mcp", transport: "http", state: "connected", source: "user", tools: 2 },
      { name: "intercom", target: "npx mcp-remote https://mcp.intercom.com/mcp", transport: "stdio", state: "unknown", detail: "still connecting", source: "user" },
      { name: "homeassistant", target: "http://homeassistant.local:8123/api/mcp", transport: "http", state: "failed", detail: "Connection to http://homeassistant.local:8123/api/mcp failed (APPROVAL_REQUIRED)", source: "project" },
      { name: "claude.ai Gmail", target: "https://mcp-proxy.anthropic.com/v1/mcp/mcpsrv_1", transport: "claudeai-proxy", state: "needs_auth", detail: "needs authentication", source: "connector" },
    ]);
    expect(JSON.stringify(servers)).not.toContain("REDACTED");
    expect(parseClaudeMcpStatus({})).toBeUndefined();
    expect(parseClaudeMcpStatus({ mcpServers: [] })).toEqual([]);
  });

  it("merges what Codex has configured with what connected", () => {
    const status = parseCodexMcpStatus(CODEX_MCP_STATUS);
    expect(status.next).toBeUndefined();
    const merged = mergeCodexMcp(parseCodexMcpList(CODEX_MCP_LIST), status.servers);
    expect(merged).toEqual([
      { name: "homeassistant", target: "http://homeassistant.local:8123/api/mcp", transport: "streamable_http", source: "user", state: "failed", detail: "handshaking with MCP server failed: Send message error" },
      { name: "slack", target: "https://mcp.slack.com/mcp", transport: "streamable_http", source: "user", state: "disabled", detail: "disabled" },
      { name: "stitch", target: "https://stitch.googleapis.com/mcp", transport: "streamable_http", source: "user", state: "connected", tools: 2 },
      { name: "kling", target: "https://kling.ai/mcp", transport: "streamable_http", source: "user", state: "unknown", detail: "not in the status report" },
      { name: "car-image", target: "https://carimage.dev", state: "needs_auth", detail: "failed to refresh OAuth tokens for server car-image: OAuth authorization required", source: "plugin", plugin: "car-image@meterapp" },
      { name: "codex_apps", target: "https://chatgpt.com", state: "connected", source: "connector", tools: 1 },
    ]);
    expect(JSON.stringify(merged)).not.toContain("REDACTED");
    // No status report (an older Codex): the listing's own reading.
    expect(mergeCodexMcp(parseCodexMcpList(CODEX_MCP_LIST), undefined).find((s) => s.name === "kling")).toMatchObject({ state: "needs_auth" });
    expect(mcpSummary({ servers: merged, checked_at: "" })).toBe("2/5");
  });

  it("shortens the CLIs' errors to one line", () => {
    expect(shortError("MCP startup failed: boom\nsecond")).toBe("boom");
    expect(shortError("x".repeat(300))).toHaveLength(200);
  });

  it("turns the servers into attention items with the command that fixes each", () => {
    const servers = parseClaudeMcpStatus(CLAUDE_MCP_STATUS)!;
    const items = mcpAttention({ name: "work", runner: "claude" }, { servers, checked_at: "" }, ["stitch", "intercom", "github", "linear"]);
    expect(items).toEqual([
      { level: "warn", code: "mcp_needs_auth", message: "MCP servers need authentication: plugin:supabase:supabase, claude.ai Gmail; their tools are missing from this account's runs", fix: "skillhook accounts exec work -- claude   then /mcp and authenticate plugin:supabase:supabase" },
      { level: "warn", code: "mcp_failed", message: "MCP server fails to connect: homeassistant (Connection to http://homeassistant.local:8123/api/mcp failed (APPROVAL_REQUIRED))", fix: "skillhook accounts exec work -- claude mcp get homeassistant   (and check its command, URL or credentials)" },
      { level: "info", code: "mcp_missing", message: "lacks MCP servers the machine's own claude login has: github, linear", fix: expect.stringContaining("skillhook accounts exec work -- claude mcp add --scope user github") },
    ]);
    const codex = mcpAttention({ name: "pro", runner: "codex" }, { servers: [{ name: "linear", target: "", state: "needs_auth" }], checked_at: "" });
    expect(codex[0]?.fix).toBe("skillhook accounts exec pro -- codex mcp login linear");
    const env = mcpAttention({ name: "pro", runner: "codex" }, { servers: [{ name: "github", target: "", state: "failed", detail: "Environment variable GITHUB_PAT_TOKEN for MCP server 'github' is not set" }], checked_at: "" });
    expect(env[0]?.fix).toBe("skillhook secret set GITHUB_PAT_TOKEN, and list it in env: of the skills that need the server");
    expect(parseClaudeMcpStatus({ mcpServers: [{ name: "sh", status: "connected", config: { type: "stdio", command: "/bin/zsh", args: ["-lc", "set -e\n  exec npx  x"] } }] })?.[0]?.target).toBe("/bin/zsh -lc set -e exec npx x");
    // An incomplete listing is not evidence that a server is missing.
    expect(mcpAttention({ name: "w", runner: "claude" }, { servers: [], error: "timed out", checked_at: "" }, ["github"])).toEqual([]);
  });
});

describe("account MCP probes against the CLIs", () => {
  const ENV = { PATH: mergedPath(process.env.PATH), HOME: process.env.HOME ?? "/" };

  it("asks Claude Code's control protocol until no server is pending, with connectors left on", async () => {
    const paths = tempHome("skillhook-mcp-probe-");
    const dir = path.join(paths.home, "claude-a");
    mkdirSync(dir);
    const record = path.join(paths.home, "record.json");
    const mcp = await probeClaudeMcp({ command: FAKE_CLAUDE, env: { ...ENV, CLAUDE_CONFIG_DIR: dir, FAKE_CLAUDE_RECORD: record, ENABLE_CLAUDEAI_MCP_SERVERS: "1" }, settleMs: 0 });
    expect(mcp).toMatchObject({ via: "status", plugins: [{ id: "supabase@claude-plugins-official", version: "0.1.15", enabled: true }, { id: "car-image@meterapp", enabled: false }] });
    expect(mcp.error).toBeUndefined();
    expect(mcp.servers.map((s) => [s.name, s.state, s.source])).toEqual([
      ["stitch", "connected", "user"],
      ["sentry", "needs_auth", "user"],
      ["slack", "failed", "user"],
      ["plugin:supabase:supabase", "connected", "plugin"],
      ["claude.ai Gmail", "connected", "connector"],
    ]);
    expect(JSON.stringify(mcp)).not.toMatch(/SECRET-(HEADER|ENV)-VALUE/);
    const args = (JSON.parse(readFileSync(record, "utf8")) as { args: string[] }).args;
    expect(args).toEqual(expect.arrayContaining(["--no-session-persistence", "--settings", '{"disableAllHooks":true}']));
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("falls back to claude mcp list on a Claude Code without mcp_status", async () => {
    const paths = tempHome("skillhook-mcp-probe-");
    const dir = path.join(paths.home, "claude-old");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "no-mcp-status"), "");
    const mcp = await probeClaudeMcp({ command: FAKE_CLAUDE, env: { ...ENV, CLAUDE_CONFIG_DIR: dir }, settleMs: 0 });
    expect(mcp.via).toBe("list");
    expect(mcp.servers.map((s) => [s.name, s.state])).toEqual([
      ["stitch", "connected"],
      ["sentry", "needs_auth"],
      ["slack", "failed"],
      ["skillhook", "connected"],
    ]);
    expect(await probeClaudeMcp({ command: "definitely-not-claude-xyz", env: ENV })).toMatchObject({ servers: [], error: "definitely-not-claude-xyz not found on PATH" });
  });

  it("merges codex mcp list with the app server's status, and lists installed plugins", async () => {
    const paths = tempHome("skillhook-mcp-probe-");
    const home = path.join(paths.home, "codex-a");
    mkdirSync(home);
    const mcp = await probeCodexMcp({ command: FAKE_CODEX, env: { ...ENV, CODEX_HOME: home } });
    expect(mcp).toMatchObject({ via: "status", plugins: [{ id: "car-image@meterapp", version: "1.0.0", enabled: true }, { id: "browser@openai-bundled", version: "2.0.0", enabled: false }] });
    expect(mcp.servers.map((s) => [s.name, s.state, s.source])).toEqual([
      ["analytics-mcp", "connected", "user"],
      ["codex_app", "disabled", "user"],
      ["linear", "needs_auth", "user"],
      ["car-image-catalog", "connected", "plugin"],
      ["codex_apps", "connected", "connector"],
    ]);
    writeFileSync(path.join(home, "no-mcp-status"), "");
    const old = await probeCodexMcp({ command: FAKE_CODEX, env: { ...ENV, CODEX_HOME: home } });
    expect(old).toMatchObject({ via: "list", error: expect.stringContaining("listed only") });
    expect(old.servers.map((s) => s.state)).toEqual(["connected", "disabled", "needs_auth"]);
  });
});
