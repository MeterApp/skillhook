import { readFileSync } from "node:fs";
import { expandTilde, isPlainObject } from "../util.js";
import { commandParts, lastLines, shellQuote, uniqueDirs, type Runner, type RunnerOutcome, type StreamState } from "./types.js";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(", ")} }`;
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
    // `codex exec resume` continues a session; it takes no -C, -s or --add-dir, so the sandbox goes through -c.
    const args = ctx.resume
      ? [...lead, "exec", "resume", ctx.resume.sessionId, "--json", "--skip-git-repo-check", "-c", `sandbox_mode=${tomlString(sandbox)}`, "-c", `approval_policy=${tomlString(runnerConfig.approval_policy)}`, "-o", ctx.paths.lastMessagePath]
      : [...lead, "exec", "--json", "--skip-git-repo-check", "-C", ctx.cwd, "-s", sandbox, "-c", `approval_policy=${tomlString(runnerConfig.approval_policy)}`, "-o", ctx.paths.lastMessagePath];
    if (sandbox === "workspace-write" && network) args.push("-c", "sandbox_workspace_write.network_access=true");
    if (ctx.model) args.push("-m", ctx.model);
    if (ctx.effort) args.push("-c", `model_reasoning_effort=${tomlString(ctx.effort)}`);
    if (skillConfig.profile) args.push("-p", skillConfig.profile);
    if (!ctx.resume) {
      for (const dir of uniqueDirs([ctx.skill.dir, ctx.jobDir, ...(skillConfig.add_dirs ?? []).map(expandTilde)])) {
        if (dir !== ctx.cwd) args.push("--add-dir", dir);
      }
    }
    // The final message must be JSON matching the schema file prepareRun wrote next to the job.
    if (ctx.skill.config.response?.mode === "structured") args.push("--output-schema", ctx.paths.responseSchemaPath);
    // The job API (progress, asking a person, the outcome) as an MCP server, configured for this run only.
    if (ctx.agentApi) {
      const key = ctx.agentApi.name.replaceAll("-", "_");
      args.push("-c", `mcp_servers.${key}.command=${tomlString(ctx.agentApi.command)}`, "-c", `mcp_servers.${key}.args=${tomlStringArray(ctx.agentApi.args)}`, "-c", `mcp_servers.${key}.env=${tomlInlineTable(ctx.agentApi.env)}`);
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
    if (ctx.skill.config.response?.mode === "structured" && result) {
      try {
        const parsed = JSON.parse(result) as unknown;
        if (isPlainObject(parsed)) {
          outcome.structuredOutput = parsed;
          if (typeof parsed.summary === "string") outcome.result = parsed.summary;
        }
      } catch {
        /* the agent answered in prose; the outcome then comes from response.json or stays unknown */
      }
    }
    if (!ok) outcome.error = io.state.failed || lastLines(io.stderr) || lastLines(io.stdout) || `codex exited with code ${io.exitCode}${io.signal ? ` (${io.signal})` : ""}`;
    return outcome;
  },
  resumeCommand(sessionId, cwd) {
    return `cd ${shellQuote(cwd)} && codex resume ${shellQuote(sessionId)}`;
  },
};
