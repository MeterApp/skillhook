import { expandTilde } from "../util.js";
import { commandParts, lastLines, shellQuote, uniqueDirs, type Runner, type RunnerOutcome, type StreamState } from "./types.js";

function extractText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((block): block is { type: string; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text);
  return parts.length ? parts.join("\n") : undefined;
}

export function findLastResultEvent(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "result") return event;
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

/**
 * Claude Code runner: `claude -p` with stream-json output. Reads the prompt from stdin, so
 * payload size is not bounded by argv limits. Guardrails travel in `--append-system-prompt`.
 */
export const claudeRunner: Runner = {
  name: "claude",
  build(ctx) {
    const runnerConfig = ctx.config.runners.claude;
    const skillConfig = ctx.skill.config.claude ?? {};
    const { command, lead } = commandParts(runnerConfig.command);
    const args = [...lead, "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", skillConfig.permission_mode ?? runnerConfig.permission_mode, "--permission-prompts", "none"];
    if (ctx.model) args.push("--model", ctx.model);
    if (ctx.effort) args.push("--effort", ctx.effort);
    for (const dir of uniqueDirs([ctx.skill.dir, ctx.jobDir, ...(skillConfig.add_dirs ?? []).map(expandTilde)])) {
      if (dir !== ctx.cwd) args.push("--add-dir", dir);
    }
    const allowed = [...ctx.skill.allowedTools, ...(skillConfig.allowed_tools ?? [])];
    if (allowed.length) args.push("--allowedTools", allowed.join(","));
    if (skillConfig.disallowed_tools?.length) args.push("--disallowedTools", skillConfig.disallowed_tools.join(","));
    if (skillConfig.max_budget_usd) args.push("--max-budget-usd", String(skillConfig.max_budget_usd));
    const system = [ctx.guardrails, skillConfig.append_system_prompt].filter(Boolean).join("\n\n");
    args.push("--append-system-prompt", system);
    args.push(...runnerConfig.args, ...(skillConfig.args ?? []));
    return { command, args, cwd: ctx.cwd, env: ctx.env, stdin: ctx.prompt };
  },
  onLine(line, state: StreamState) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof event.session_id === "string" && !state.sessionId) state.sessionId = event.session_id;
    if (event.type === "assistant") {
      const text = extractText(event.message);
      if (text) state.lastMessage = text;
    }
    if (event.type === "result") state.resultEvent = event;
  },
  parse(io): RunnerOutcome {
    const event = io.state.resultEvent ?? findLastResultEvent(io.stdout);
    if (event) {
      const isError = event.is_error === true;
      const ok = !isError && (io.exitCode === 0 || io.exitCode === null);
      const result = typeof event.result === "string" && event.result ? event.result : io.state.lastMessage;
      const outcome: RunnerOutcome = {
        ok,
        result,
        sessionId: (typeof event.session_id === "string" ? event.session_id : undefined) ?? io.state.sessionId,
        costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined,
        usage: event.usage,
        numTurns: typeof event.num_turns === "number" ? event.num_turns : undefined,
      };
      if (!ok) outcome.error = result || (typeof event.subtype === "string" ? event.subtype : undefined) || lastLines(io.stderr) || `claude exited with code ${io.exitCode}`;
      return outcome;
    }
    if (io.exitCode === 0) return { ok: true, result: io.state.lastMessage ?? io.stdout.trim(), sessionId: io.state.sessionId };
    return { ok: false, sessionId: io.state.sessionId, error: lastLines(io.stderr) || lastLines(io.stdout) || `claude exited with code ${io.exitCode}${io.signal ? ` (${io.signal})` : ""}` };
  },
  resumeCommand(sessionId, cwd) {
    return `cd ${shellQuote(cwd)} && claude --resume ${shellQuote(sessionId)}`;
  },
};
