#!/usr/bin/env node
// Emulates `claude -p --output-format stream-json`: reads the prompt from stdin and prints
// stream-json events. Controlled through env vars the test passes via env_passthrough:
//   FAKE_CLAUDE_FAIL=<message>  -> emit an is_error result and exit 1
//   FAKE_CLAUDE_SLEEP_MS=<ms>   -> delay before answering (timeout/cancel tests)
//   FAKE_CLAUDE_RECORD=<file>   -> write argv, prompt, env and cwd as JSON for assertions
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const prompt = readFileSync(0, "utf8");
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const model = flag("--model");
const sessionId = `fake-session-${Math.random().toString(36).slice(2, 10)}`;
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

out({ type: "system", subtype: "init", session_id: sessionId, model: model ?? "default", cwd: process.cwd(), tools: [] });
if (process.env.FAKE_CLAUDE_RECORD) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("SKILLHOOK_") || k.startsWith("FAKE_") || k.startsWith("ANTHROPIC_") || k === "PATH" || k === "HOME"));
  writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ args, prompt, env, cwd: process.cwd() }, null, 2));
}
const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS ?? 0);
if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));

if (process.env.FAKE_CLAUDE_FAIL) {
  out({ type: "result", subtype: "error", is_error: true, result: process.env.FAKE_CLAUDE_FAIL, session_id: sessionId, total_cost_usd: 0, num_turns: 1, duration_ms: 5 });
  process.exit(1);
}
const summary = `FAKE OK model=${model ?? "default"} prompt_chars=${prompt.length} cwd=${process.cwd()}`;
out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: summary }] }, session_id: sessionId });
out({ type: "result", subtype: "success", is_error: false, result: summary, session_id: sessionId, total_cost_usd: 0.0123, num_turns: 1, duration_ms: 5, usage: { input_tokens: 10, output_tokens: 5 } });
