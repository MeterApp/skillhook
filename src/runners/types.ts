import type { Config, RunnerName } from "../config.js";
import type { Skill } from "../skills.js";

export interface RunPaths {
  payloadPath: string;
  eventPath: string;
  promptPath: string;
  lastMessagePath: string;
  /** Where the agent may write its `{outcome, summary, links, data}` (also `SKILLHOOK_RESPONSE_PATH`). */
  responsePath: string;
  /** The JSON Schema written for `response: { mode: structured }` runs (Codex reads it from disk). */
  responseSchemaPath: string;
}

/** The per-run MCP server the agent talks to (`skillhook mcp --job`), when the skill's `agent_api` is `mcp`. */
export interface AgentApiServer {
  /** Server name as the agent sees it (`skillhook-job`). */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface RunContext {
  skill: Skill;
  config: Config;
  jobId: string;
  jobDir: string;
  prompt: string;
  guardrails: string;
  cwd: string;
  env: Record<string, string>;
  model?: string;
  effort?: string;
  timeoutSeconds: number;
  paths: RunPaths;
  agentApi?: AgentApiServer;
  /** Continue an earlier session (a person answered the agent's question) instead of starting a new one. */
  resume?: { sessionId: string };
}

export interface RunnerInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
}

/** Facts extracted from the runner's live output stream. */
export interface StreamState {
  sessionId?: string;
  lastMessage?: string;
  failed?: string;
  usage?: unknown;
  resultEvent?: Record<string, unknown>;
  structuredOutput?: unknown;
}

export interface RunnerOutcome {
  ok: boolean;
  result?: string;
  sessionId?: string;
  costUsd?: number;
  usage?: unknown;
  numTurns?: number;
  error?: string;
  /** The JSON answer of a `response: { mode: structured }` run, as the runner returned it. */
  structuredOutput?: unknown;
}

export interface RunnerIO {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  state: StreamState;
}

export interface Runner {
  name: RunnerName;
  build(ctx: RunContext): RunnerInvocation;
  /** Called for every complete stdout line while the process runs. */
  onLine?(line: string, state: StreamState): void;
  parse(io: RunnerIO, ctx: RunContext): RunnerOutcome;
  /** Shell command a human can run to continue the agent session. */
  resumeCommand?(sessionId: string, cwd: string): string;
}

/** Splits a config `command` into executable + leading args. */
export function commandParts(command: string | string[]): { command: string; lead: string[] } {
  if (Array.isArray(command)) return { command: command[0] as string, lead: command.slice(1) };
  return { command, lead: [] };
}

export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function formatCommand(invocation: Pick<RunnerInvocation, "command" | "args">): string {
  return [invocation.command, ...invocation.args].map(shellQuote).join(" ");
}

export function lastLines(text: string, count = 20, maxChars = 4000): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-count).join("\n").slice(-maxChars).trim();
}

export function uniqueDirs(dirs: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}
