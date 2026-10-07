#!/usr/bin/env node
// Emulates `claude -p --output-format stream-json`: reads the prompt from stdin and prints
// stream-json events. Controlled through env vars the test passes via env_passthrough:
//   FAKE_CLAUDE_FAIL=<message>  -> emit an is_error result and exit 1
//   FAKE_CLAUDE_FAIL_KIND=<auth|usage_limit|rate_limit|max_turns|budget> -> the failure the real CLI prints for it (also `auth`
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
if (args[0] === "auth" && args[1] === "status") {
  const loggedIn = process.env.FAKE_CLAUDE_AUTH !== "out" && stateFile("logged-out") === undefined;
  process.stdout.write(`${JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty", analyticsDisabled: false }, null, 2)}\n`);
  process.exit(0); // the real CLI exits 0 either way
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
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("SKILLHOOK_") || k.startsWith("FAKE_") || k.startsWith("ANTHROPIC_") || k === "PATH" || k === "HOME"));
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
const failKind = process.env.FAKE_CLAUDE_FAIL_KIND ?? (stateFile("logged-out") !== undefined ? "auth" : undefined);
if (failKind) {
  // Captured shapes: the real CLI reports an auth failure as `subtype: success` with `is_error: true`.
  const canned = {
    auth: { subtype: "success", result: "Failed to authenticate: OAuth session expired and could not be refreshed" },
    usage_limit: { subtype: "success", result: "You've hit your usage limit. Your limit will reset at 3pm (UTC)." },
    rate_limit: { subtype: "error_during_execution", result: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}' },
    max_turns: { subtype: "error_max_turns", result: "Reached max turns (1)" },
    budget: { subtype: "error_max_budget_usd", result: "Reached max budget ($0.01)" },
  }[failKind] ?? { subtype: "success", result: `simulated ${failKind} failure` };
  out({ type: "result", is_error: true, ...canned, session_id: sessionId, total_cost_usd: 0, num_turns: 1, duration_ms: 5 });
  process.exit(1);
}
if (process.env.FAKE_CLAUDE_WRITE_RESPONSE && process.env.SKILLHOOK_JOB_DIR) writeFileSync(`${process.env.SKILLHOOK_JOB_DIR}/response.json`, process.env.FAKE_CLAUDE_WRITE_RESPONSE);
const summary = `FAKE OK model=${model ?? "default"} prompt_chars=${prompt.length} cwd=${process.cwd()}${process.env.FAKE_CLAUDE_ASK ? ` answer=${humanAnswer ? humanAnswer.text : "none"}` : ""}${args.includes("--resume") ? ` resumed=${args[args.indexOf("--resume") + 1]}` : ""}`;
out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: summary }] }, session_id: sessionId });
const result = { type: "result", subtype: "success", is_error: false, result: summary, session_id: sessionId, total_cost_usd: 0.0123, num_turns: 1, duration_ms: 5, usage: { input_tokens: 10, output_tokens: 5 } };
// With --json-schema the real CLI adds the validated answer as `structured_output`.
if (args.includes("--json-schema")) result.structured_output = { outcome: process.env.FAKE_CLAUDE_OUTCOME ?? "completed", summary: `structured ${summary}`, links: ["https://example.com/pr/1"] };
out(result);
