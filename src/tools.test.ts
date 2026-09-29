import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergedPath } from "./runners/env.js";
import { FAKE_CLAUDE, FAKE_CODEX, tempHome } from "./test-support/helpers.js";
import { parseClaudeAuth, parseClaudeMcpList, parseClaudePlugins, parseCodexDoctor, parseCodexLogin, parseCodexMcpList, parseVersion, probeClaude, probeCodex, resolveCommand } from "./tools.js";

// Captured from Claude Code 2.1.270 (URLs replaced).
const CLAUDE_MCP_LIST = `Checking MCP server health…

plugin:supabase:supabase: https://mcp.supabase.example/mcp (HTTP) - ! Needs authentication
plugin:car-image:car-image: https://carimage.example/api/mcp (HTTP) - ✘ Failed to connect — Server rejected the configured Authorization header (HTTP 401). Check that the token is valid for this MCP endpoint — OAuth fallback is disabled when headers.Authorization is set. Error detail: {"type":"https://carimage.example/docs/errors#401","title":"Invalid credential","status":401}
stitch: https://stitch.example/mcp (HTTP) - ✔ Connected
intercom: npx mcp-remote https://mcp.intercom.example/mcp - ✔ Connected
slack: npx mcp-remote https://slack.example/mcp - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed
skillhook: skillhook mcp - ✔ Connected

MCP config diagnostics ⚠

For help configuring MCP servers, see: https://docs.example/mcp

[Contains warnings] User config (available in all your projects)
Location: /Users/me/.claude.json
 └ [Warning] [crowdin] mcpServers.crowdin: Missing environment variables: CROWDIN_API_TOKEN

[Conflicting scopes]
├ Server "skillhook" is defined in multiple scopes with different endpoints: user (skillhook mcp), project (npx -y @meterapp/skillhook mcp). OAuth tokens are stored per endpoint, so authenticating in one context will not carry over.
└ Keep the correct endpoint and remove the others: \`claude mcp remove skillhook -s user\` or \`claude mcp remove skillhook -s project\`
`;

const CLAUDE_PLUGINS = `[
  { "id": "car-image@meterapp", "version": "1.0.0", "scope": "user", "enabled": true, "installPath": "/Users/me/.claude/plugins/cache/meterapp/car-image/1.0.0", "installedAt": "2026-09-11T15:57:30.056Z", "lastUpdated": "2026-09-11T15:57:30.056Z", "mcpServers": { "car-image": { "type": "http", "url": "https://carimage.example/api/mcp" } } },
  { "id": "supabase@claude-plugins-official", "version": "0.1.15", "scope": "user", "enabled": false, "installPath": "/x", "installedAt": "2026-08-04T21:13:57.407Z", "lastUpdated": "2026-09-14T20:22:36.145Z", "mcpServers": {} },
  { "nope": true }
]`;

// Captured from Codex CLI 0.153.4 (trimmed).
const CODEX_MCP_LIST = `[
  { "name": "analytics-mcp", "enabled": true, "disabled_reason": null, "transport": { "type": "stdio", "command": "/opt/homebrew/bin/pipx", "args": ["run", "analytics-mcp"], "env": {}, "env_vars": [], "cwd": null }, "startup_timeout_sec": null, "tool_timeout_sec": null, "auth_status": "unsupported" },
  { "name": "codex_app", "enabled": false, "disabled_reason": null, "transport": { "type": "stdio", "command": "./launch", "args": ["./server.mjs"], "env": {}, "env_vars": ["HOME"], "cwd": "." }, "startup_timeout_sec": 10.0, "tool_timeout_sec": 3600.0, "auth_status": "unsupported" },
  { "name": "linear", "enabled": true, "disabled_reason": null, "transport": { "type": "streamable_http", "url": "https://mcp.linear.example/mcp", "bearer_token_env_var": null, "http_headers": null }, "startup_timeout_sec": null, "tool_timeout_sec": null, "auth_status": "not_logged_in" }
]`;

const CODEX_DOCTOR = `{
  "schemaVersion": 1,
  "generatedAt": "1790625927s since unix epoch",
  "overallStatus": "warning",
  "codexVersion": "0.153.4",
  "checks": {
    "app_server.status": { "id": "app_server.status", "category": "app-server", "status": "ok", "summary": "background server is not running", "details": { "mode": "ephemeral" }, "remediation": null, "durationMs": 0 },
    "auth.credentials": { "id": "auth.credentials", "category": "auth", "status": "ok", "summary": "auth is configured", "details": {}, "remediation": null, "durationMs": 0 },
    "mcp.servers": { "id": "mcp.servers", "category": "mcp", "status": "warning", "summary": "1 MCP server needs login", "details": {}, "remediation": "run \`codex mcp login linear\`", "durationMs": 12 },
    "disk.space": { "id": "disk.space", "category": "system", "status": "error", "summary": "disk almost full", "details": {}, "remediation": null, "durationMs": 1 }
  }
}`;

describe("CLI output parsers", () => {
  it("reads claude mcp list, including names with colons, plugins and failures with long details", () => {
    const { servers, warnings } = parseClaudeMcpList(CLAUDE_MCP_LIST);
    expect(servers.map((s) => [s.name, s.state])).toEqual([
      ["plugin:supabase:supabase", "needs_auth"],
      ["plugin:car-image:car-image", "failed"],
      ["stitch", "connected"],
      ["intercom", "connected"],
      ["slack", "failed"],
      ["skillhook", "connected"],
    ]);
    expect(servers[0]).toMatchObject({ target: "https://mcp.supabase.example/mcp", transport: "HTTP", detail: "Needs authentication" });
    expect(servers[1]?.detail).toMatch(/^Server rejected the configured Authorization header/);
    expect(servers[3]).toEqual({ name: "intercom", target: "npx mcp-remote https://mcp.intercom.example/mcp", state: "connected" });
    expect(servers[4]?.detail).toBe("CONNECTION_CLOSED: Connection closed");
    expect(servers[5]).toEqual({ name: "skillhook", target: "skillhook mcp", state: "connected" });
    expect(warnings).toEqual(["[crowdin] mcpServers.crowdin: Missing environment variables: CROWDIN_API_TOKEN", expect.stringContaining('Server "skillhook" is defined in multiple scopes')]);
    expect(parseClaudeMcpList("No MCP servers configured. Use `claude mcp add` to add a server.\n")).toEqual({ servers: [], warnings: [] });
  });

  it("reads claude plugin list --json and auth status", () => {
    const plugins = parseClaudePlugins(CLAUDE_PLUGINS);
    expect(plugins).toEqual([
      { id: "car-image@meterapp", version: "1.0.0", scope: "user", enabled: true, mcp_servers: ["car-image"], installed_at: "2026-09-11T15:57:30.056Z", last_updated: "2026-09-11T15:57:30.056Z" },
      { id: "supabase@claude-plugins-official", version: "0.1.15", scope: "user", enabled: false, mcp_servers: [], installed_at: "2026-08-04T21:13:57.407Z", last_updated: "2026-09-14T20:22:36.145Z" },
    ]);
    expect(parseClaudePlugins("not json")).toEqual([]);
    expect(parseClaudeAuth({ code: 0, stdout: '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty"}', stderr: "" })).toEqual({ loggedIn: true, method: "claude.ai", provider: "firstParty", detail: "logged in (claude.ai)" });
    expect(parseClaudeAuth({ code: 0, stdout: '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}', stderr: "" })).toMatchObject({ loggedIn: false, method: "none", detail: "not logged in" });
    expect(parseClaudeAuth({ code: 1, stdout: "", stderr: "Not logged in. Run claude login." })).toEqual({ loggedIn: false, detail: "Not logged in. Run claude login." });
    expect(parseClaudeAuth({ code: 0, stdout: "", stderr: "" }).detail).toContain("printed nothing");
  });

  it("reads codex login status, mcp list --json and doctor --json", () => {
    expect(parseCodexLogin({ code: 0, stdout: "Logged in using ChatGPT\n", stderr: "" })).toEqual({ loggedIn: true, method: "chatgpt", detail: "Logged in using ChatGPT" });
    expect(parseCodexLogin({ code: 0, stdout: "Logged in using an API key\n", stderr: "" })).toMatchObject({ loggedIn: true, method: "api_key" });
    expect(parseCodexLogin({ code: 1, stdout: "", stderr: "Not logged in\n" })).toEqual({ loggedIn: false, method: "none", detail: "Not logged in" });
    const servers = parseCodexMcpList(CODEX_MCP_LIST);
    expect(servers).toEqual([
      { name: "analytics-mcp", enabled: true, transport: "stdio", target: "/opt/homebrew/bin/pipx run analytics-mcp", auth_status: "unsupported", state: "connected" },
      { name: "codex_app", enabled: false, transport: "stdio", target: "./launch ./server.mjs", auth_status: "unsupported", state: "disabled", detail: "disabled" },
      { name: "linear", enabled: true, transport: "streamable_http", target: "https://mcp.linear.example/mcp", auth_status: "not_logged_in", state: "needs_auth", detail: "auth status not_logged_in" },
    ]);
    expect(parseCodexMcpList("[]")).toEqual([]);
    expect(parseCodexMcpList("oops")).toEqual([]);
    const doctor = parseCodexDoctor(CODEX_DOCTOR);
    expect(doctor.version).toBe("0.153.4");
    expect(doctor.overall).toBe("warning");
    expect(doctor.checks.map((c) => [c.id, c.status])).toEqual([
      ["app_server.status", "ok"],
      ["auth.credentials", "ok"],
      ["mcp.servers", "warn"],
      ["disk.space", "fail"],
    ]);
    expect(doctor.checks[2]).toMatchObject({ category: "mcp", summary: "1 MCP server needs login", remediation: "run `codex mcp login linear`" });
    expect(parseCodexDoctor("{}")).toEqual({ checks: [] });
    expect(parseVersion("2.1.270 (Claude Code)\n")).toBe("2.1.270");
    expect(parseVersion("codex-cli 0.153.4")).toBe("0.153.4");
    expect(parseVersion("v1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(parseVersion("no version here")).toBeUndefined();
  });
});

describe("probes", () => {
  const env = { PATH: mergedPath(process.env.PATH), HOME: process.env.HOME ?? "/" };

  it("probes the fake Claude Code: version, login, MCP servers and plugins, also from files under CLAUDE_CONFIG_DIR", async () => {
    const quick = await probeClaude(FAKE_CLAUDE, { env, deep: false });
    expect(quick).toMatchObject({ found: true, path: process.execPath, version: "2.1.270", auth: { loggedIn: true, method: "claude.ai" } });
    expect(quick.mcp).toBeUndefined();
    const deep = await probeClaude(FAKE_CLAUDE, { env, deep: true });
    expect(deep.mcp?.servers.map((s) => [s.name, s.state])).toEqual([
      ["stitch", "connected"],
      ["sentry", "needs_auth"],
      ["slack", "failed"],
      ["skillhook", "connected"],
    ]);
    expect(deep.mcp?.warnings).toEqual(["[crowdin] mcpServers.crowdin: Missing environment variables: CROWDIN_API_TOKEN"]);
    expect(deep.plugins?.plugins.map((p) => `${p.id}:${p.enabled}`)).toEqual(["supabase@claude-plugins-official:true", "car-image@meterapp:false"]);
    const configDir = path.join(tempHome("skillhook-tools-").home, "claude");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "logged-out"), "");
    writeFileSync(path.join(configDir, "mcp-list.txt"), "only: skillhook mcp - ✔ Connected\n");
    writeFileSync(path.join(configDir, "plugins.json"), "[]");
    const out = await probeClaude(FAKE_CLAUDE, { env: { ...env, CLAUDE_CONFIG_DIR: configDir }, deep: true });
    expect(out.auth).toMatchObject({ loggedIn: false, method: "none" });
    expect(out.mcp?.servers).toEqual([{ name: "only", target: "skillhook mcp", state: "connected" }]);
    expect(out.plugins?.plugins).toEqual([]);
  });

  it("probes the fake Codex: version, login, MCP servers and its doctor, also from files under CODEX_HOME", async () => {
    const deep = await probeCodex(FAKE_CODEX, { env, deep: true });
    expect(deep).toMatchObject({ found: true, version: "0.153.4", auth: { loggedIn: true, method: "chatgpt" } });
    expect(deep.mcp?.servers.map((s) => [s.name, s.state])).toEqual([
      ["analytics-mcp", "connected"],
      ["codex_app", "disabled"],
      ["linear", "needs_auth"],
    ]);
    expect(deep.mcp?.servers[1]?.detail).toBe("disabled in config");
    expect(deep.doctor).toMatchObject({ overall: "warning", version: "0.153.4" });
    expect(deep.doctor?.checks.find((c) => c.id === "mcp.servers")).toMatchObject({ status: "warn", remediation: "run `codex mcp login linear`" });
    const codexHome = path.join(tempHome("skillhook-tools-").home, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(path.join(codexHome, "logged-out"), "");
    writeFileSync(path.join(codexHome, "doctor.json"), JSON.stringify({ overallStatus: "ok", codexVersion: "0.153.4", checks: {} }));
    const out = await probeCodex(FAKE_CODEX, { env: { ...env, CODEX_HOME: codexHome }, deep: true });
    expect(out.auth).toEqual({ loggedIn: false, method: "none", detail: "Not logged in" });
    expect(out.doctor).toEqual({ overall: "ok", version: "0.153.4", checks: [] });
  });

  it("reports a command that is not there without running anything", async () => {
    expect(resolveCommand("definitely-not-a-binary-xyz", "/nonexistent")).toEqual({ command: "definitely-not-a-binary-xyz", lead: [], path: undefined });
    expect(resolveCommand("/nonexistent/claude", env.PATH)).toMatchObject({ path: undefined });
    expect(resolveCommand(FAKE_CODEX, env.PATH)).toMatchObject({ command: process.execPath, lead: [FAKE_CODEX[1]], path: process.execPath });
    const missing = await probeClaude("definitely-not-a-binary-xyz", { env: { ...env, PATH: "/nonexistent" }, deep: true });
    expect(missing).toEqual({ found: false, auth: { loggedIn: false, detail: "definitely-not-a-binary-xyz not found on PATH" } });
    expect(await probeCodex("/nonexistent/codex", { env })).toMatchObject({ found: false });
  });
});
