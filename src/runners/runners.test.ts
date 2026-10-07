import { describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import { parseSkillDocument } from "../skills.js";
import { claudeRunner } from "./claude.js";
import { codexRunner } from "./codex.js";
import { buildRunEnv, mergedPath } from "./env.js";
import { shellRunner } from "./shell.js";
import type { RunContext, StreamState } from "./types.js";

function ctx(frontmatter = "", overrides: Partial<RunContext> = {}): RunContext {
  const skill = parseSkillDocument(`---\nname: demo\ndescription: d\n${frontmatter}\n---\nbody`, "/skills/demo");
  return {
    skill,
    config: defaultConfig(),
    jobId: "j1",
    jobDir: "/jobs/j1",
    prompt: "PROMPT",
    guardrails: "GUARD",
    cwd: "/work",
    env: { PATH: "/bin" },
    timeoutSeconds: 10,
    paths: { payloadPath: "/jobs/j1/payload.json", eventPath: "/jobs/j1/event.json", promptPath: "/jobs/j1/prompt.md", lastMessagePath: "/jobs/j1/last-message.md", responsePath: "/jobs/j1/response.json", responseSchemaPath: "/jobs/j1/response.schema.json" },
    ...overrides,
  };
}

describe("claude runner", () => {
  it("builds the headless command line", () => {
    const c = ctx(`allowed-tools: Read Bash(git:*)\nskillhook:\n  claude:\n    permission_mode: acceptEdits\n    allowed_tools: [Edit]\n    max_budget_usd: 2.5\n    add_dirs: [/extra]`, { model: "opus", effort: "high" });
    const inv = claudeRunner.build(c);
    expect(inv.command).toBe("claude");
    expect(inv.args.slice(0, 5)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--permission-mode"]);
    expect(inv.args).toContain("acceptEdits");
    expect(inv.args.join(" ")).toContain("--permission-prompts none");
    expect(inv.args.join(" ")).toContain("--model opus");
    expect(inv.args.join(" ")).toContain("--effort high");
    expect(inv.args.join(" ")).toContain("--add-dir /skills/demo --add-dir /jobs/j1 --add-dir /extra");
    expect(inv.args.join(" ")).toContain("--allowedTools Read,Bash(git:*),Edit");
    expect(inv.args.join(" ")).toContain("--max-budget-usd 2.5");
    expect(inv.args[inv.args.indexOf("--append-system-prompt") + 1]).toBe("GUARD");
    expect(inv.stdin).toBe("PROMPT");
    expect(inv.cwd).toBe("/work");
  });

  it("injects the job API as an MCP server and resumes a session when asked", () => {
    const agentApi = { name: "skillhook-job", command: "/usr/bin/node", args: ["/opt/skillhook/dist/cli.js", "mcp", "--job", "--dir", "/home/me/.skillhook"], env: { SKILLHOOK_JOB_ID: "j1", SKILLHOOK_JOB_DIR: "/jobs/j1" } };
    const inv = claudeRunner.build(ctx("allowed-tools: Read", { agentApi }));
    const config = JSON.parse(inv.args[inv.args.indexOf("--mcp-config") + 1] as string) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    expect(config.mcpServers["skillhook-job"]).toEqual({ command: "/usr/bin/node", args: ["/opt/skillhook/dist/cli.js", "mcp", "--job", "--dir", "/home/me/.skillhook"], env: { SKILLHOOK_JOB_ID: "j1", SKILLHOOK_JOB_DIR: "/jobs/j1" } });
    expect(inv.args[inv.args.indexOf("--allowedTools") + 1]).toBe("Read,mcp__skillhook-job");
    expect(inv.args).not.toContain("--resume");
    const resumed = claudeRunner.build(ctx("", { resume: { sessionId: "sess-123" } }));
    expect(resumed.args[resumed.args.indexOf("--resume") + 1]).toBe("sess-123");
    expect(resumed.args).not.toContain("--mcp-config");
    expect(resumed.args).not.toContain("--allowedTools");
  });

  it("supports array commands and skips --add-dir for the cwd", () => {
    const c = ctx();
    c.config.runners.claude.command = ["/usr/bin/env", "claude"];
    c.cwd = "/skills/demo";
    const inv = claudeRunner.build(c);
    expect(inv.command).toBe("/usr/bin/env");
    expect(inv.args[0]).toBe("claude");
    expect(inv.args.join(" ")).not.toContain("--add-dir /skills/demo");
  });

  it("parses a successful stream-json run", () => {
    const state: StreamState = {};
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done: scheduled 3 invites", session_id: "sess-1", total_cost_usd: 0.42, num_turns: 7, usage: { input_tokens: 1 } }),
    ];
    for (const line of lines) claudeRunner.onLine?.(line, state);
    expect(state.sessionId).toBe("sess-1");
    const outcome = claudeRunner.parse({ stdout: lines.join("\n"), stderr: "", exitCode: 0, signal: null, state }, ctx());
    expect(outcome).toMatchObject({ ok: true, result: "Done: scheduled 3 invites", sessionId: "sess-1", costUsd: 0.42, numTurns: 7 });
    expect(claudeRunner.resumeCommand?.("sess-1", "/work dir")).toBe("cd '/work dir' && claude --resume sess-1");
  });

  it("parses the auth failure Claude Code prints as an is_error result", () => {
    const line = '{"duration_api_ms":0,"stop_reason":"stop_sequence","session_id":"4e58fcad","total_cost_usd":0,"is_error":true,"num_turns":1,"subtype":"success","result":"Failed to authenticate: OAuth session expired and could not be refreshed","type":"result"}';
    const state: StreamState = {};
    claudeRunner.onLine?.(line, state);
    const outcome = claudeRunner.parse({ stdout: line, stderr: "", exitCode: 1, signal: null, state }, ctx());
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("Failed to authenticate");
    expect(outcome.sessionId).toBe("4e58fcad");
  });

  it("falls back to stderr when there is no result event", () => {
    const outcome = claudeRunner.parse({ stdout: "", stderr: "boom\nreal error here", exitCode: 2, signal: null, state: {} }, ctx());
    expect(outcome).toMatchObject({ ok: false, error: "boom\nreal error here" });
  });

  it("asks for structured output only when the skill wants it, and reads it back", () => {
    expect(claudeRunner.build(ctx()).args).not.toContain("--json-schema");
    const c = ctx("skillhook:\n  response:\n    mode: structured");
    const inv = claudeRunner.build(c);
    const schema = JSON.parse(inv.args[inv.args.indexOf("--json-schema") + 1] as string) as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(["outcome", "summary"]);
    expect(Object.keys(schema.properties)).toEqual(["outcome", "title", "headline", "summary", "links", "options", "recommended", "multiple", "data"]);
    const state: StreamState = {};
    const line = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", session_id: "s", structured_output: { outcome: "needs_human", summary: "Ask Bob", links: ["https://x"] } });
    claudeRunner.onLine?.(line, state);
    expect(state.structuredOutput).toMatchObject({ outcome: "needs_human" });
    const outcome = claudeRunner.parse({ stdout: line, stderr: "", exitCode: 0, signal: null, state }, c);
    expect(outcome.ok).toBe(true);
    expect(outcome.structuredOutput).toEqual({ outcome: "needs_human", summary: "Ask Bob", links: ["https://x"] });
    expect(outcome.result).toBe("Ask Bob");
    const custom = ctx("skillhook:\n  response:\n    mode: structured\n    schema:\n      type: object\n      properties:\n        ticket: { type: string }");
    const customInv = claudeRunner.build(custom);
    expect(JSON.parse(customInv.args[customInv.args.indexOf("--json-schema") + 1] as string)).toEqual({ type: "object", properties: { ticket: { type: "string" } } });
  });
});

describe("codex runner", () => {
  it("builds codex exec with sandbox, approvals, model and reasoning effort", () => {
    const c = ctx(`skillhook:\n  codex:\n    sandbox: workspace-write\n    add_dirs: [/extra]`, { model: "gpt-5-codex", effort: "high" });
    const inv = codexRunner.build(c);
    expect(inv.command).toBe("codex");
    expect(inv.args.slice(0, 3)).toEqual(["exec", "--json", "--skip-git-repo-check"]);
    const joined = inv.args.join(" ");
    expect(joined).toContain("-C /work");
    expect(joined).toContain("-s workspace-write");
    expect(joined).toContain('-c approval_policy="never"');
    expect(joined).toContain("-c sandbox_workspace_write.network_access=true");
    expect(joined).toContain("-m gpt-5-codex");
    expect(joined).toContain('-c model_reasoning_effort="high"');
    expect(joined).toContain("-o /jobs/j1/last-message.md");
    expect(joined).toContain("--add-dir /skills/demo --add-dir /jobs/j1 --add-dir /extra");
    expect(inv.args[inv.args.length - 1]).toBe("-");
    expect(inv.stdin).toBe("GUARD\n\nPROMPT");
  });

  it("configures the job API through -c and continues a thread with exec resume", () => {
    const agentApi = { name: "skillhook-job", command: "/usr/bin/node", args: ["/opt/cli.js", "mcp", "--job"], env: { SKILLHOOK_JOB_ID: "j1", SKILLHOOK_JOB_DIR: "/jobs/j1" } };
    const inv = codexRunner.build(ctx("", { agentApi }));
    const joined = inv.args.join(" ");
    expect(joined).toContain('-c mcp_servers.skillhook_job.command="/usr/bin/node"');
    expect(joined).toContain('-c mcp_servers.skillhook_job.args=["/opt/cli.js", "mcp", "--job"]');
    expect(joined).toContain('-c mcp_servers.skillhook_job.env={ SKILLHOOK_JOB_ID = "j1", SKILLHOOK_JOB_DIR = "/jobs/j1" }');
    // `codex exec resume` takes neither -C, -s nor --add-dir: the sandbox travels as -c sandbox_mode, cwd is the spawn cwd.
    const resumed = codexRunner.build(ctx("skillhook:\n  codex:\n    sandbox: workspace-write\n    add_dirs: [/extra]", { resume: { sessionId: "thread-9" } }));
    expect(resumed.args.slice(0, 5)).toEqual(["exec", "resume", "thread-9", "--json", "--skip-git-repo-check"]);
    const joinedResume = resumed.args.join(" ");
    expect(joinedResume).toContain('-c sandbox_mode="workspace-write"');
    expect(joinedResume).toContain("-c sandbox_workspace_write.network_access=true");
    expect(joinedResume).not.toContain("-C ");
    expect(joinedResume).not.toContain("-s ");
    expect(joinedResume).not.toContain("--add-dir");
    expect(resumed.args[resumed.args.length - 1]).toBe("-");
    expect(resumed.cwd).toBe("/work");
  });

  it("omits network override outside workspace-write", () => {
    const c = ctx(`skillhook:\n  codex:\n    sandbox: danger-full-access`);
    expect(codexRunner.build(c).args.join(" ")).not.toContain("network_access");
  });

  it("parses the usage-limit failure Codex prints", () => {
    const lines = [
      '{"type":"thread.started","thread_id":"01a0a7fb"}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage or try again at Sep 19th."}',
      '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage or try again at Sep 19th."}}',
    ];
    const state: StreamState = {};
    for (const line of lines) codexRunner.onLine?.(line, state);
    const outcome = codexRunner.parse({ stdout: lines.join("\n"), stderr: "", exitCode: 1, signal: null, state }, ctx());
    expect(outcome.ok).toBe(false);
    expect(outcome.sessionId).toBe("01a0a7fb");
    expect(outcome.error).toContain("usage limit");
  });

  it("parses a successful run", () => {
    const lines = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}',
      '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}',
    ];
    const state: StreamState = {};
    for (const line of lines) codexRunner.onLine?.(line, state);
    const outcome = codexRunner.parse({ stdout: lines.join("\n"), stderr: "", exitCode: 0, signal: null, state }, ctx());
    expect(outcome).toMatchObject({ ok: true, result: "pong", sessionId: "t1", usage: { input_tokens: 5, output_tokens: 1 } });
  });

  it("passes a schema file when the skill wants structured output and parses the JSON answer", () => {
    expect(codexRunner.build(ctx()).args).not.toContain("--output-schema");
    const c = ctx("skillhook:\n  runner: codex\n  response:\n    mode: structured");
    const inv = codexRunner.build(c);
    expect(inv.args.join(" ")).toContain("--output-schema /jobs/j1/response.schema.json");
    expect(inv.args[inv.args.length - 1]).toBe("-");
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t2" }),
      JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: JSON.stringify({ outcome: "nothing_to_do", summary: "Nothing changed" }) } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
    ];
    const state: StreamState = {};
    for (const line of lines) codexRunner.onLine?.(line, state);
    const outcome = codexRunner.parse({ stdout: lines.join("\n"), stderr: "", exitCode: 0, signal: null, state }, c);
    expect(outcome).toMatchObject({ ok: true, result: "Nothing changed", structuredOutput: { outcome: "nothing_to_do", summary: "Nothing changed" } });
    const prose = codexRunner.parse({ stdout: "", stderr: "", exitCode: 0, signal: null, state: { lastMessage: "just prose" } }, c);
    expect(prose).toMatchObject({ ok: true, result: "just prose" });
    expect(prose.structuredOutput).toBeUndefined();
  });
});

describe("shell runner", () => {
  it("wraps string commands in sh -c and passes arrays through", () => {
    const str = shellRunner.build(ctx(`skillhook:\n  runner: shell\n  shell:\n    command: ./run.sh --flag`));
    expect(str.command).toBe("/bin/sh");
    expect(str.args).toEqual(["-c", "./run.sh --flag"]);
    const arr = shellRunner.build(ctx(`skillhook:\n  runner: shell\n  shell:\n    command: [python3, handler.py]`));
    expect(arr.command).toBe("python3");
    expect(arr.args).toEqual(["handler.py"]);
    expect(() => shellRunner.build(ctx(`skillhook:\n  runner: shell`))).toThrow(/shell.command/);
  });
});

describe("buildRunEnv", () => {
  it("forwards credentials from .env, only well-known credential names from the process env, and never a parent Claude Code session", () => {
    const skill = parseSkillDocument(`---\nname: demo\ndescription: d\n---\nb`, "/skills/demo");
    const fileSecrets = { ANTHROPIC_API_KEY: "file", CLAUDE_CONFIG_DIR: "/cfg", OPENAI_BASE_URL: "https://proxy" };
    const processEnv = { HOME: "/h", PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "parent", CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_API_KEY: "proc", OPENAI_API_KEY: "proc-openai" };
    const env = buildRunEnv({ secrets: { ...fileSecrets, ...processEnv }, fileSecrets, skill, config: defaultConfig(), jobVars: {}, processEnv });
    expect(env.ANTHROPIC_API_KEY).toBe("file");
    expect(env.OPENAI_API_KEY).toBe("proc-openai");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/cfg");
    expect(env.OPENAI_BASE_URL).toBe("https://proxy");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  it("passes runner credentials and explicit names only", () => {
    const skill = parseSkillDocument(`---\nname: demo\ndescription: d\nskillhook:\n  env: [GITHUB_TOKEN]\n---\nb`, "/skills/demo");
    const config = defaultConfig();
    config.env_passthrough = ["SHARED_KEY"];
    const env = buildRunEnv({
      secrets: { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", GITHUB_TOKEN: "g", SHARED_KEY: "s", SKILLHOOK_SECRET_DEMO: "no", SKILLHOOK_ADMIN_TOKEN: "no", RANDOM_SECRET: "no" },
      skill,
      config,
      jobVars: { SKILLHOOK_JOB_ID: "j1" },
      processEnv: { HOME: "/Users/x", PATH: "/custom/bin", RANDOM_SECRET: "leak" },
    });
    expect(env).toMatchObject({ HOME: "/Users/x", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", GITHUB_TOKEN: "g", SHARED_KEY: "s", SKILLHOOK_JOB_ID: "j1" });
    expect(env.SKILLHOOK_SECRET_DEMO).toBeUndefined();
    expect(env.SKILLHOOK_ADMIN_TOKEN).toBeUndefined();
    expect(env.RANDOM_SECRET).toBeUndefined();
    expect(env.PATH?.startsWith("/custom/bin:")).toBe(true);
    expect(env.PATH).toContain("/opt/homebrew/bin");
    expect(mergedPath(undefined, "/h")).toContain("/h/.local/bin");
  });
});
