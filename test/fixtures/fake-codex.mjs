#!/usr/bin/env node
// Emulates `codex exec --json ... -o <file> -`: reads the prompt from stdin, prints JSONL events
// and writes the last message to the -o file.
//   FAKE_CODEX_FAIL=<message> -> emit error + turn.failed and exit 1
//   FAKE_CODEX_RECORD=<file>  -> write argv/prompt/cwd as JSON
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const prompt = readFileSync(0, "utf8");
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const model = flag("-m");
const outFile = flag("-o");
const threadId = `fake-thread-${Math.random().toString(36).slice(2, 10)}`;
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

out({ type: "thread.started", thread_id: threadId });
out({ type: "turn.started" });
if (process.env.FAKE_CODEX_RECORD) writeFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ args, prompt, cwd: process.cwd() }, null, 2));
if (process.env.FAKE_CODEX_FAIL) {
  out({ type: "error", message: process.env.FAKE_CODEX_FAIL });
  out({ type: "turn.failed", error: { message: process.env.FAKE_CODEX_FAIL } });
  process.exit(1);
}
const text = `FAKE CODEX OK model=${model ?? "default"} prompt_chars=${prompt.length}`;
out({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });
out({ type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 6 } });
if (outFile) writeFileSync(outFile, text);
