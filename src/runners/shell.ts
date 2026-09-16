import { readFileSync } from "node:fs";
import { payloadJson } from "../prompt.js";
import { commandParts, lastLines, type Runner, type RunnerOutcome } from "./types.js";

function readPayload(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Shell runner: runs `skillhook.shell.command` from SKILL.md with the payload JSON on stdin and
 * the job/event/prompt paths in `SKILLHOOK_*` env vars. An escape hatch for scripts and other agents.
 */
export const shellRunner: Runner = {
  name: "shell",
  build(ctx) {
    const spec = ctx.skill.config.shell?.command;
    if (!spec) throw new Error(`Skill "${ctx.skill.name}" uses runner: shell but has no skillhook.shell.command`);
    const parts = Array.isArray(spec) ? commandParts(spec) : { command: "/bin/sh", lead: ["-c", spec] };
    return { command: parts.command, args: parts.lead, cwd: ctx.cwd, env: ctx.env, stdin: payloadJson(readPayload(ctx.paths.payloadPath)) };
  },
  parse(io): RunnerOutcome {
    const ok = io.exitCode === 0;
    const result = io.stdout.trim();
    return ok ? { ok, result } : { ok, result, error: lastLines(io.stderr) || `command exited with code ${io.exitCode}${io.signal ? ` (${io.signal})` : ""}` };
  },
};
