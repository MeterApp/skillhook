import { readFileSync } from "node:fs";
import { expandTilde } from "../util.js";
import { commandParts, lastLines, shellQuote, uniqueDirs, type Runner, type RunnerOutcome, type StreamState } from "./types.js";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Codex runner: `codex exec --json` with the prompt on stdin (`-`). Codex has no system-prompt
 * flag, so the guardrails are prepended to the prompt. The last agent message is also written
 * by Codex to `-o <file>`, which we read when the stream did not carry it.
 */
export const codexRunner: Runner = {
  name: "codex",
  build(ctx) {
    const runnerConfig = ctx.config.runners.codex;
    const skillConfig = ctx.skill.config.codex ?? {};
    const { command, lead } = commandParts(runnerConfig.command);
    const sandbox = skillConfig.sandbox ?? runnerConfig.sandbox;
    const network = skillConfig.network_access ?? runnerConfig.network_access;
    const args = [...lead, "exec", "--json", "--skip-git-repo-check", "-C", ctx.cwd, "-s", sandbox, "-c", `approval_policy=${tomlString(runnerConfig.approval_policy)}`, "-o", ctx.paths.lastMessagePath];
    if (sandbox === "workspace-write" && network) args.push("-c", "sandbox_workspace_write.network_access=true");
    if (ctx.model) args.push("-m", ctx.model);
    if (ctx.effort) args.push("-c", `model_reasoning_effort=${tomlString(ctx.effort)}`);
    if (skillConfig.profile) args.push("-p", skillConfig.profile);
    for (const dir of uniqueDirs([ctx.skill.dir, ctx.jobDir, ...(skillConfig.add_dirs ?? []).map(expandTilde)])) {
      if (dir !== ctx.cwd) args.push("--add-dir", dir);
    }
    args.push(...runnerConfig.args, ...(skillConfig.args ?? []), "-");
    return { command, args, cwd: ctx.cwd, env: ctx.env, stdin: `${ctx.guardrails}\n\n${ctx.prompt}` };
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
    switch (event.type) {
      case "thread.started":
        if (typeof event.thread_id === "string") state.sessionId = event.thread_id;
        break;
      case "item.completed": {
        const item = event.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string") state.lastMessage = item.text;
        break;
      }
      case "turn.completed":
        state.usage = event.usage;
        break;
      case "turn.failed": {
        const error = event.error as { message?: string } | undefined;
        state.failed = error?.message ?? "turn failed";
        break;
      }
      case "error":
        if (typeof event.message === "string") state.failed = event.message;
        break;
      default:
        break;
    }
  },
  parse(io, ctx): RunnerOutcome {
    let result = io.state.lastMessage;
    if (!result) {
      try {
        result = readFileSync(ctx.paths.lastMessagePath, "utf8").trim() || undefined;
      } catch {
        /* no last message file */
      }
    }
    const ok = (io.exitCode === 0 || io.exitCode === null) && !io.state.failed;
    const outcome: RunnerOutcome = { ok, result, sessionId: io.state.sessionId, usage: io.state.usage };
    if (!ok) outcome.error = io.state.failed ?? lastLines(io.stderr) ?? lastLines(io.stdout) ?? `codex exited with code ${io.exitCode}${io.signal ? ` (${io.signal})` : ""}`;
    if (!ok && !outcome.error) outcome.error = `codex exited with code ${io.exitCode}`;
    return outcome;
  },
  resumeCommand(sessionId, cwd) {
    return `cd ${shellQuote(cwd)} && codex resume ${shellQuote(sessionId)}`;
  },
};
