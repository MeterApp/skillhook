#!/usr/bin/env node
// Emulates `codex exec --json ... -o <file> -`: reads the prompt from stdin, prints JSONL events
// and writes the last message to the -o file.
//   FAKE_CODEX_FAIL=<message> -> emit error + turn.failed and exit 1
//   FAKE_CODEX_FAIL_KIND=<auth|usage_limit|rate_limit> -> the failure the real CLI prints for it (also `auth` when
//                               CODEX_HOME/logged-out exists)
//   FAKE_CODEX_RECORD=<file>  -> write argv/prompt/cwd as JSON
//   FAKE_CODEX_OUTCOME=<o>    -> the `outcome` of the JSON answer emitted when --output-schema is present
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
// Like the real CLI, state lives under CODEX_HOME (a pass-through variable): `logged-out`, `mcp-list.json`, `doctor.json`.
const codexHome = process.env.CODEX_HOME;
const stateFile = (name) => (codexHome && existsSync(`${codexHome}/${name}`) ? readFileSync(`${codexHome}/${name}`, "utf8") : undefined);

// Diagnostic subcommands (what `skillhook health` / `doctor` run) answer before anything is read from stdin.
//   FAKE_CODEX_AUTH=out        -> `login status` says not logged in (exit 1)
//   FAKE_CODEX_MCP_LIST=<json> -> what `mcp list --json` prints
//   FAKE_CODEX_DOCTOR=<json>   -> what `doctor --json` prints
if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.153.4\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (process.env.FAKE_CODEX_AUTH === "out" || stateFile("logged-out") !== undefined) {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  process.stdout.write("Logged in using ChatGPT\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] !== "status") {
  if (codexHome) {
    const { rmSync } = await import("node:fs");
    rmSync(`${codexHome}/logged-out`, { force: true });
    writeFileSync(`${codexHome}/auth.json`, JSON.stringify({ auth_mode: "chatgpt", email: process.env.FAKE_CODEX_LOGIN_EMAIL ?? "codex@example.com" }));
  }
  process.stdout.write("Successfully logged in\n");
  process.exit(0);
}
if (args[0] === "logout") {
  if (codexHome) writeFileSync(`${codexHome}/logged-out`, "");
  process.stdout.write("Successfully logged out\n");
  process.exit(0);
}
// `codex app-server`: JSON-RPC lines, answering initialize, account/read, account/rateLimits/read and
// mcpServerStatus/list in the captured real shapes. State under CODEX_HOME: `logged-out`, `auth.json` (its `email`),
// `rate-limits.json` and `mcp-status.json` (the answers), `no-mcp-status` (an older Codex without the method).
if (args[0] === "app-server") {
  const { createInterface } = await import("node:readline");
  const loggedOut = process.env.FAKE_CODEX_AUTH === "out" || stateFile("logged-out") !== undefined;
  let email = "codex@example.com";
  try {
    email = JSON.parse(stateFile("auth.json") ?? "{}").email ?? email;
  } catch {
    /* not JSON */
  }
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  for await (const line of createInterface({ input: process.stdin })) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.method === "initialize") send({ id: message.id, result: { userAgent: "skillhook/0.153.4", codexHome: codexHome ?? "~/.codex", platformFamily: "unix", platformOs: "macos" } });
    else if (message.method === "account/read") send({ id: message.id, result: loggedOut ? { account: null, requiresOpenaiAuth: true } : { account: { type: "chatgpt", email, planType: "pro" }, requiresOpenaiAuth: true } });
    else if (message.method === "account/rateLimits/read") {
      const canned = stateFile("rate-limits.json");
      const snapshot = { limitId: "codex", limitName: null, primary: { usedPercent: 48, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 * 3 }, secondary: null, credits: { hasCredits: false, unlimited: false, balance: "0" }, individualLimit: null, spendControlReached: false, planType: "pro", rateLimitReachedType: null };
      send({ id: message.id, result: canned ? JSON.parse(canned) : { ordinaryUsageAllowed: true, rateLimits: snapshot, rateLimitsByLimitId: { codex: snapshot }, rateLimitResetCredits: { availableCount: 0, credits: [] }, accountId: "acct", rateLimitUpsell: null } });
    } else if (message.method === "mcpServerStatus/list" && stateFile("no-mcp-status") === undefined) {
      const canned = stateFile("mcp-status.json");
      const server = (name, extra) => ({ name, runtimeStatus: null, pluginId: null, httpOrigin: null, serverInfo: null, serverCapabilities: null, tools: {}, toolsError: null, resources: [], resourceTemplates: [], authStatus: "unsupported", ...extra });
      const tools = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`tool${i}`, { name: `tool${i}` }]));
      send({
        id: message.id,
        result: canned
          ? JSON.parse(canned)
          : {
              data: [
                server("analytics-mcp", { serverInfo: { name: "Google Analytics MCP Server", version: "1.0.0" }, tools: tools(9) }),
                server("codex_app", { pluginId: "codex-app-tools@openai-bundled" }),
                server("linear", { httpOrigin: "https://mcp.linear.example", toolsError: "MCP startup failed: failed to refresh OAuth tokens for server linear: OAuth authorization required", authStatus: "notLoggedIn" }),
                server("car-image-catalog", { pluginId: "car-image@meterapp", httpOrigin: "https://carimage.example", serverInfo: { name: "car-image-catalog", version: "1.33.0" }, tools: tools(7), authStatus: "notLoggedIn" }),
                server("codex_apps", { httpOrigin: "https://chatgpt.com", serverInfo: { name: "plugin-runtime", version: "0.1.0" }, tools: tools(12), authStatus: "bearerToken" }),
              ],
              nextCursor: null,
            },
      });
    } else if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "method not found" } });
  }
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "list") {
  process.stdout.write(
    process.env.FAKE_CODEX_MCP_LIST ??
      stateFile("mcp-list.json") ??
      `${JSON.stringify([
        { name: "analytics-mcp", enabled: true, disabled_reason: null, transport: { type: "stdio", command: "/opt/homebrew/bin/pipx", args: ["run", "analytics-mcp"], env: {}, env_vars: [], cwd: null }, startup_timeout_sec: null, tool_timeout_sec: null, auth_status: "unsupported" },
        { name: "codex_app", enabled: false, disabled_reason: "disabled in config", transport: { type: "stdio", command: "./launch", args: [], env: {}, env_vars: [], cwd: "." }, startup_timeout_sec: 10, tool_timeout_sec: 3600, auth_status: "unsupported" },
        { name: "linear", enabled: true, disabled_reason: null, transport: { type: "streamable_http", url: "https://mcp.linear.example/mcp", bearer_token_env_var: null, http_headers: null }, startup_timeout_sec: null, tool_timeout_sec: null, auth_status: "not_logged_in" },
      ])}\n`,
  );
  process.exit(0);
}
if (args[0] === "plugin" && args[1] === "list") {
  process.stdout.write(
    stateFile("plugin-list.txt") ??
      ["Marketplace `openai-bundled`", "/tmp/marketplace.json", "", "PLUGIN                       STATUS               VERSION  SOURCE", "car-image@meterapp           installed, enabled   1.0.0    /tmp/car-image", "browser@openai-bundled       installed, disabled  2.0.0    /tmp/browser", "expo@openai-bundled          not installed                 /tmp/expo", ""].join("\n"),
  );
  process.exit(0);
}
if (args[0] === "doctor") {
  process.stdout.write(
    process.env.FAKE_CODEX_DOCTOR ??
      stateFile("doctor.json") ??
      `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: "1790625927s since unix epoch",
        overallStatus: "warning",
        codexVersion: "0.153.4",
        checks: {
          "auth.credentials": { id: "auth.credentials", category: "auth", status: "ok", summary: "auth is configured", details: { "stored auth mode": "chatgpt" }, remediation: null, durationMs: 0 },
          "config.load": { id: "config.load", category: "config", status: "ok", summary: "config loaded", details: { "mcp servers": "3" }, remediation: null, durationMs: 0 },
          "mcp.servers": { id: "mcp.servers", category: "mcp", status: "warning", summary: "1 MCP server needs login", details: {}, remediation: "run `codex mcp login linear`", durationMs: 12 },
        },
      })}\n`,
  );
  process.exit(0);
}

const prompt = readFileSync(0, "utf8");
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const model = flag("-m");
const outFile = flag("-o");
const threadId = `fake-thread-${randomBytes(4).toString("hex")}`;
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

out({ type: "thread.started", thread_id: threadId });
out({ type: "turn.started" });
if (process.env.FAKE_CODEX_RECORD) writeFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ args, prompt, cwd: process.cwd() }, null, 2));
const failKind = process.env.FAKE_CODEX_FAIL_KIND ?? (stateFile("logged-out") !== undefined ? "auth" : stateFile("limited") !== undefined ? "usage_limit" : undefined);
const failMessage =
  process.env.FAKE_CODEX_FAIL ??
  (failKind
    ? ({
        auth: "Not logged in. Run `codex login` to authenticate.",
        usage_limit: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage or try again at Sep 19th.",
        rate_limit: "Rate limit reached for gpt-5-codex (429). Try again in 20s.",
      }[failKind] ?? `simulated ${failKind} failure`)
    : undefined);
if (failMessage) {
  out({ type: "error", message: failMessage });
  out({ type: "turn.failed", error: { message: failMessage } });
  process.exit(1);
}
// With --output-schema the real CLI's final message is the JSON object the schema asks for.
const resumed = args[0] === "exec" && args[1] === "resume" ? args[2] : undefined;
const text = args.includes("--output-schema") ? JSON.stringify({ outcome: process.env.FAKE_CODEX_OUTCOME ?? "completed", summary: `structured codex model=${model ?? "default"}` }) : `FAKE CODEX OK model=${model ?? "default"} prompt_chars=${prompt.length}${resumed ? ` resumed=${resumed}` : ""}`;
out({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });
out({ type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 6 } });
if (outFile) writeFileSync(outFile, text);
