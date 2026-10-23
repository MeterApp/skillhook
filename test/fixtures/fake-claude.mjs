#!/usr/bin/env node
// Emulates `claude -p --output-format stream-json`: reads the prompt from stdin and prints
// stream-json events. Controlled through env vars the test passes via env_passthrough:
//   FAKE_CLAUDE_FAIL=<message>  -> emit an is_error result and exit 1
//   FAKE_CLAUDE_FAIL_KIND=<auth|usage_limit|session_limit|rate_limit|max_turns|budget> -> the failure the real CLI prints for it (also `auth`
//                                  when CLAUDE_CONFIG_DIR/logged-out exists, like a logged-out install)
//   FAKE_CLAUDE_SLEEP_MS=<ms>   -> delay before answering (timeout/cancel tests)
//   FAKE_CLAUDE_RECORD=<file>   -> write argv, prompt, env and cwd as JSON for assertions
//   FAKE_CLAUDE_OUTCOME=<o>     -> the `outcome` of the structured_output emitted when --json-schema is present
//   FAKE_CLAUDE_WRITE_RESPONSE=<json> -> write it to $SKILLHOOK_JOB_DIR/response.json before answering
//   FAKE_CLAUDE_ASK=<question>  -> report progress, ask a person through the job directory's progress files
//                                  (question.json / progress.jsonl), wait up to FAKE_CLAUDE_ASK_WAIT_MS (default 8000)
//                                  for answer.json, and quote the answer (or "no answer") in the result
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
// Like the real CLI, state lives under CLAUDE_CONFIG_DIR (a pass-through variable): `logged-out` marks a logged-out
// install, `mcp-list.txt` and `plugins.json` replace the canned listings.
const configDir = process.env.CLAUDE_CONFIG_DIR;
const stateFile = (name) => (configDir && existsSync(`${configDir}/${name}`) ? readFileSync(`${configDir}/${name}`, "utf8") : undefined);

// Diagnostic subcommands (what `skillhook health` / `doctor` run) answer before anything is read from stdin.
//   FAKE_CLAUDE_AUTH=out        -> `auth status` says logged out
//   FAKE_CLAUDE_MCP_LIST=<text> -> the text `mcp list` prints (default: a canned list with every state)
//   FAKE_CLAUDE_PLUGINS=<json>  -> what `plugin list --json` prints
if (args[0] === "--version") {
  process.stdout.write("2.1.270 (Claude Code)\n");
  process.exit(0);
}
// Account state under CLAUDE_CONFIG_DIR: `logged-out`, `expired` (a login that ran out), `account` (the email),
// `usage.json` (what `get_usage` answers), `limited` (runs fail with a usage limit and a rejected rate_limit_event).
const loggedIn = () => process.env.FAKE_CLAUDE_AUTH !== "out" && stateFile("logged-out") === undefined && stateFile("expired") === undefined && !(process.env.FAKE_CLAUDE_AUTH_TOKEN_ONLY && !process.env.CLAUDE_CODE_OAUTH_TOKEN);
const accountEmail = () => (stateFile("account") ?? "").trim() || undefined;
if (args[0] === "auth" && args[1] === "status") {
  if (args.includes("--text")) {
    process.stdout.write(stateFile("expired") !== undefined ? "Login: Expired — log in again\nEmail: fake@example.com\n" : loggedIn() ? `Login: Claude Max account\nEmail: ${accountEmail() ?? "fake@example.com"}\n` : "Not logged in. Run claude auth login to authenticate.\n");
    process.exit(0);
  }
  // The real CLI adds the account; a file named `account` in CLAUDE_CONFIG_DIR stands in for one here.
  const email = loggedIn() ? accountEmail() : undefined;
  process.stdout.write(`${JSON.stringify({ loggedIn: loggedIn(), authMethod: loggedIn() ? "claude.ai" : "none", apiProvider: "firstParty", analyticsDisabled: false, ...(email ? { email } : {}) }, null, 2)}\n`);
  process.exit(0); // the real CLI exits 0 either way
}
if (args[0] === "auth" && args[1] === "login") {
  if (!configDir) process.exit(0);
  const { rmSync } = await import("node:fs");
  rmSync(`${configDir}/logged-out`, { force: true });
  rmSync(`${configDir}/expired`, { force: true });
  writeFileSync(`${configDir}/account`, `${process.env.FAKE_CLAUDE_LOGIN_EMAIL ?? "fake@example.com"}\n`);
  process.stdout.write("Login successful.\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "logout") {
  if (configDir) writeFileSync(`${configDir}/logged-out`, "");
  process.stdout.write("Successfully logged out from your Anthropic account.\n");
  process.exit(0);
}
if (args[0] === "setup-token") {
  process.stdout.write(`Your OAuth token (valid for 1 year):\n\nsk-ant-oat01-${"x".repeat(80)}\n\nStore this token securely.\n`);
  process.exit(0);
}
// The control protocol (`-p --input-format stream-json`): what the Agent SDK and skillhook's account probe speak.
// Answers `initialize`, `get_usage` and `get_status` in the captured real shapes; never sends a prompt anywhere.
if (args.includes("--input-format") && args[args.indexOf("--input-format") + 1] === "stream-json") {
  if (process.env.FAKE_CLAUDE_RECORD) writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ args, env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ? "set" : null, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? "set" : null } }, null, 2));
  const { createInterface } = await import("node:readline");
  const reply = (id, response) => process.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response } })}\n`);
  for await (const line of createInterface({ input: process.stdin })) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.type !== "control_request") continue;
    const subtype = message.request?.subtype;
    const expired = stateFile("expired") !== undefined;
    if (subtype === "initialize") reply(message.request_id, { commands: [], models: [], account: loggedIn() ? { email: accountEmail() ?? "fake@example.com", subscriptionType: "max", tokenSource: process.env.CLAUDE_CODE_OAUTH_TOKEN ? "CLAUDE_CODE_OAUTH_TOKEN" : "claude.ai", apiProvider: "firstParty" } : { tokenSource: "none", apiProvider: "firstParty" }, claude_code_version: "2.1.270" });
    else if (subtype === "get_usage") {
      const usage = stateFile("usage.json");
      const reset = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
      reply(message.request_id, usage ? JSON.parse(usage) : loggedIn() ? { session: { total_cost_usd: 0 }, subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: { utilization: 42, resets_at: reset(2) }, seven_day: { utilization: 17, resets_at: reset(90) }, model_scoped: [{ display_name: "Opus", utilization: 5, resets_at: reset(90) }] }, behaviors: null } : { session: { total_cost_usd: 0 }, subscription_type: null, rate_limits_available: false, rate_limits: null, behaviors: null });
    } else if (subtype === "get_status") reply(message.request_id, { sections: [{ title: "Session", rows: [{ label: "Version", value: "2.1.270" }, ...(expired ? [{ label: "Login", value: "Expired — log in again" }] : loggedIn() ? [{ label: "Login", value: "Claude Max account" }] : []), ...(loggedIn() || expired ? [{ label: "Email", value: accountEmail() ?? "fake@example.com" }] : [])] }] });
    else reply(message.request_id, {});
  }
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "list") {
  process.stdout.write(
    process.env.FAKE_CLAUDE_MCP_LIST ??
      stateFile("mcp-list.txt") ??
      [
        "Checking MCP server health…",
        "",
        "stitch: https://stitch.example/mcp (HTTP) - ✔ Connected",
        "sentry: https://mcp.sentry.example/mcp (HTTP) - ! Needs authentication",
        "slack: npx mcp-remote https://slack.example/mcp - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed",
        "skillhook: skillhook mcp - ✔ Connected",
        "",
        "MCP config diagnostics ⚠",
        "",
        "For help configuring MCP servers, see: https://docs.example/mcp",
        "",
        "[Contains warnings] User config (available in all your projects)",
        "Location: /Users/me/.claude.json",
        " └ [Warning] [crowdin] mcpServers.crowdin: Missing environment variables: CROWDIN_API_TOKEN",
        "",
      ].join("\n"),
  );
  process.exit(0);
}
if (args[0] === "plugin" && args[1] === "list") {
  process.stdout.write(
    process.env.FAKE_CLAUDE_PLUGINS ??
      stateFile("plugins.json") ??
      `${JSON.stringify([
        { id: "supabase@claude-plugins-official", version: "0.1.15", scope: "user", enabled: true, installPath: "/Users/me/.claude/plugins/cache/claude-plugins-official/supabase/0.1.15", installedAt: "2026-08-04T21:13:57.407Z", lastUpdated: "2026-09-14T20:22:36.145Z", mcpServers: { supabase: { type: "http", url: "https://mcp.supabase.example/mcp" } } },
        { id: "car-image@meterapp", version: "1.0.0", scope: "user", enabled: false, installPath: "/Users/me/.claude/plugins/cache/meterapp/car-image/1.0.0", installedAt: "2026-09-11T15:57:30.056Z", lastUpdated: "2026-09-11T15:57:30.056Z", mcpServers: {} },
      ])}\n`,
  );
  process.exit(0);
}

const prompt = readFileSync(0, "utf8");
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const model = flag("--model");
const sessionId = `fake-session-${randomBytes(4).toString("hex")}`;
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

out({ type: "system", subtype: "init", session_id: sessionId, model: model ?? "default", cwd: process.cwd(), tools: [] });
if (process.env.FAKE_CLAUDE_RECORD) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("SKILLHOOK_") || k.startsWith("FAKE_") || k.startsWith("ANTHROPIC_") || k === "CLAUDE_CONFIG_DIR" || k === "CLAUDE_CODE_OAUTH_TOKEN" || k === "PATH" || k === "HOME"));
  writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ args, prompt, env, cwd: process.cwd() }, null, 2));
}
const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS ?? 0);
if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));

// A stand-in for the real agent calling the job API: the same files `skillhook job ask` and the job MCP server write.
// A resumed session already has its answer, so it does not ask again.
let humanAnswer;
if (process.env.FAKE_CLAUDE_ASK && process.env.SKILLHOOK_JOB_DIR && !args.includes("--resume")) {
  const dir = process.env.SKILLHOOK_JOB_DIR;
  const { appendFileSync, existsSync } = await import("node:fs");
  const now = () => new Date().toISOString();
  const line = (entry) => appendFileSync(`${dir}/progress.jsonl`, `${JSON.stringify(entry)}\n`);
  line({ at: now(), type: "progress", state: "working", message: "looking at the payload", percent: 10, title: "Fake task" });
  writeFileSync(`${dir}/progress.json`, JSON.stringify({ state: "working", message: "looking at the payload", percent: 10, updated_at: now() }));
  const waitMs = Number(process.env.FAKE_CLAUDE_ASK_WAIT_MS ?? 8000);
  const question = { id: "fakeq", text: process.env.FAKE_CLAUDE_ASK, options: ["A", "B"], recommended: "B", asked_at: now(), wait_until: new Date(Date.now() + waitMs).toISOString() };
  writeFileSync(`${dir}/question.json`, JSON.stringify(question));
  line({ at: now(), type: "question", id: question.id, text: question.text, options: question.options, recommended: question.recommended, wait_until: question.wait_until });
  writeFileSync(`${dir}/progress.json`, JSON.stringify({ state: "waiting_human", message: question.text, updated_at: now() }));
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (existsSync(`${dir}/answer.json`)) {
      try {
        const parsed = JSON.parse(readFileSync(`${dir}/answer.json`, "utf8"));
        if (parsed && parsed.question_id === question.id) {
          humanAnswer = parsed;
          break;
        }
      } catch {
        /* being written */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  line({ at: now(), type: "progress", state: "working", message: humanAnswer ? `got answer: ${humanAnswer.text}` : "no answer, finishing", percent: 90 });
  writeFileSync(`${dir}/progress.json`, JSON.stringify({ state: "working", message: humanAnswer ? "got answer" : "no answer", updated_at: now() }));
}

if (process.env.FAKE_CLAUDE_FAIL) {
  out({ type: "result", subtype: "error", is_error: true, result: process.env.FAKE_CLAUDE_FAIL, session_id: sessionId, total_cost_usd: 0, num_turns: 1, duration_ms: 5 });
  process.exit(1);
}
const failKind = process.env.FAKE_CLAUDE_FAIL_KIND ?? (stateFile("logged-out") !== undefined || stateFile("expired") !== undefined ? "auth" : stateFile("limited") !== undefined ? "limited" : undefined);
if (failKind === "limited") {
  // A limited account, as the real CLI reports it: a rejected window on the rate-limit notice, then the error result.
  const resetsAt = Math.floor(Date.now() / 1000) + 7200;
  out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt, isUsingOverage: false } });
  out({ type: "assistant", is_api_error_message: true, error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit · resets 6pm (UTC)" }] } });
  out({ type: "result", is_error: true, subtype: "success", result: "You've hit your session limit · resets 6pm (UTC)", session_id: sessionId, total_cost_usd: 0, num_turns: 1, duration_ms: 5 });
  process.exit(1);
}
if (failKind) {
  // Captured shapes: the real CLI reports an auth failure as `subtype: success` with `is_error: true`.
  const canned = {
    auth: { subtype: "success", result: "Failed to authenticate: OAuth session expired and could not be refreshed" },
    session_limit: { subtype: "success", result: "You've hit your session limit · resets 6pm (America/New_York)" },
    usage_limit: { subtype: "success", result: "You've hit your usage limit. Your limit will reset at 3pm (UTC)." },
    rate_limit: { subtype: "error_during_execution", result: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}' },
    max_turns: { subtype: "error_max_turns", result: "Reached max turns (1)" },
    budget: { subtype: "error_max_budget_usd", result: "Reached max budget ($0.01)" },
  }[failKind] ?? { subtype: "success", result: `simulated ${failKind} failure` };
  if (failKind === "session_limit") {
    if (prompt.includes("already acting")) out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } });
    out({ type: "assistant", is_api_error_message: true, error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: canned.result }] } });
  }
  out({ type: "result", is_error: true, ...canned, session_id: sessionId, total_cost_usd: 0, num_turns: 1, duration_ms: 5 });
  process.exit(1);
}
if (process.env.FAKE_CLAUDE_WRITE_RESPONSE && process.env.SKILLHOOK_JOB_DIR) writeFileSync(`${process.env.SKILLHOOK_JOB_DIR}/response.json`, process.env.FAKE_CLAUDE_WRITE_RESPONSE);
const summary = `FAKE OK model=${model ?? "default"} prompt_chars=${prompt.length} cwd=${process.cwd()}${process.env.FAKE_CLAUDE_ASK ? ` answer=${humanAnswer ? humanAnswer.text : "none"}` : ""}${args.includes("--resume") ? ` resumed=${args[args.indexOf("--resume") + 1]}` : ""}`;
out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.31, resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: summary }] }, session_id: sessionId });
const result = { type: "result", subtype: "success", is_error: false, result: summary, session_id: sessionId, total_cost_usd: 0.0123, num_turns: 1, duration_ms: 5, usage: { input_tokens: 10, output_tokens: 5 } };
// With --json-schema the real CLI adds the validated answer as `structured_output`.
if (args.includes("--json-schema")) result.structured_output = { outcome: process.env.FAKE_CLAUDE_OUTCOME ?? "completed", summary: `structured ${summary}`, links: ["https://example.com/pr/1"] };
out(result);
