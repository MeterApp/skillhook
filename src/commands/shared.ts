import { loadConfig, type Config } from "../config.js";
import { loadSecrets, type Secrets } from "../env.js";
import { JobStore } from "../jobs.js";
import { resolvePaths, type Paths } from "../paths.js";
import { configProjects, SkillRegistry } from "../registry.js";

export type FlagValue = string | boolean | string[];
export type Flags = Record<string, FlagValue>;

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  stdin?: () => Promise<string>;
}

export class UsageError extends Error {
  constructor(
    message: string,
    public readonly usage?: string,
  ) {
    super(message);
    this.name = "UsageError";
  }
}

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

/** Flags that never take a value. Everything else takes the next token unless it starts with `-`. */
const BOOLEAN_FLAGS = new Set(["json", "help", "h", "dry-run", "follow", "f", "yes", "y", "force", "pretty", "stdin", "public", "serve", "funnel", "result", "prompt", "stdout", "stderr", "exec", "all", "print-config", "quiet", "q", "version", "v", "overwrite", "no-secret", "print", "watch", "verbose", "local", "install", "check", "refresh"]);

export function parseArgs(argv: string[]): { flags: Flags; positionals: string[] } {
  const flags: Flags = {};
  const positionals: string[] = [];
  const setFlag = (name: string, value: FlagValue) => {
    const existing = flags[name];
    if (existing === undefined || typeof value === "boolean") flags[name] = value;
    else flags[name] = Array.isArray(existing) ? [...existing, value as string] : [existing as string, value as string];
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq > 0) {
        setFlag(token.slice(2, eq), token.slice(eq + 1));
        continue;
      }
      const name = token.slice(2);
      if (name.startsWith("no-") && !BOOLEAN_FLAGS.has(name)) {
        flags[name.slice(3)] = false;
        continue;
      }
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(name) || next === undefined || (next.startsWith("-") && next !== "-")) setFlag(name, true);
      else {
        setFlag(name, next);
        i++;
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1 && token !== "-") {
      const name = token.slice(1);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(name) || next === undefined || (next.startsWith("-") && next !== "-")) setFlag(name, true);
      else {
        setFlag(name, next);
        i++;
      }
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals };
}

export function str(flags: Flags, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = flags[name];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value[value.length - 1];
  }
  return undefined;
}

export function list(flags: Flags, ...names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const value = flags[name];
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) out.push(...value);
  }
  return out;
}

export function bool(flags: Flags, ...names: string[]): boolean {
  return names.some((name) => flags[name] === true || flags[name] === "true");
}

export function num(flags: Flags, ...names: string[]): number | undefined {
  const value = str(flags, ...names);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`--${names[0]} must be a number, got ${JSON.stringify(value)}`);
  return n;
}

export interface Ctx {
  paths: Paths;
  flags: Flags;
  args: string[];
  json: boolean;
  io: CliIO;
  /** Prints the human text, or the JSON value when --json is set. */
  print(human: string, data?: unknown): void;
  warn(text: string): void;
  config(): Config;
  secrets(): Secrets;
  registry(): SkillRegistry;
  store(): JobStore;
}

export function createCtx(flags: Flags, args: string[], io: CliIO): Ctx {
  const paths = resolvePaths(str(flags, "dir", "home") ?? io.env.SKILLHOOK_HOME);
  const json = bool(flags, "json");
  let config: Config | undefined;
  let registry: SkillRegistry | undefined;
  let store: JobStore | undefined;
  return {
    paths,
    flags,
    args,
    json,
    io,
    print(human, data) {
      if (json) io.stdout(`${JSON.stringify(data ?? { message: human }, null, 2)}\n`);
      else if (human) io.stdout(human.endsWith("\n") ? human : `${human}\n`);
    },
    warn(text) {
      io.stderr(`${text}\n`);
    },
    config() {
      config ??= loadConfig(paths);
      return config;
    },
    secrets() {
      return loadSecrets(paths, io.env);
    },
    registry() {
      registry ??= new SkillRegistry(paths.skillsDir, { projects: configProjects(paths) });
      return registry;
    },
    store() {
      const cfg = this.config();
      store ??= new JobStore(paths.jobsDir, { maxJobs: cfg.jobs.max_jobs, dedupeWindowSeconds: cfg.jobs.dedupe_window_seconds });
      return store;
    },
  };
}

export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  if (all.length === 0) return "";
  const widths: number[] = [];
  for (const row of all) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  const line = (row: string[]) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  ").trimEnd();
  const out = all.map(line);
  if (header) out.splice(1, 0, widths.map((w) => "-".repeat(w)).join("  "));
  return out.join("\n");
}

export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const diff = Math.max(0, now - Date.parse(iso));
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${(s % 60).toString().padStart(2, "0")}s`;
}

/** Reads a `--payload` value: a JSON literal, `@file`/path to a file, or `-` for stdin. */
export async function readPayloadArg(ctx: Ctx, value: string | undefined): Promise<{ payload: unknown; raw: string }> {
  const { readFileSync, existsSync } = await import("node:fs");
  let raw: string;
  if (value === undefined) raw = "{}";
  else if (value === "-") raw = ctx.io.stdin ? await ctx.io.stdin() : readFileSync(0, "utf8");
  else if (value.startsWith("@")) raw = readFileSync(value.slice(1), "utf8");
  else if (!value.trim().startsWith("{") && !value.trim().startsWith("[") && existsSync(value)) raw = readFileSync(value, "utf8");
  else raw = value;
  try {
    return { payload: JSON.parse(raw), raw };
  } catch {
    return { payload: raw, raw };
  }
}

export function parseHeaderFlags(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const idx = value.indexOf(":");
    if (idx <= 0) throw new UsageError(`--header expects "Name: value", got ${JSON.stringify(value)}`);
    out[value.slice(0, idx).trim().toLowerCase()] = value.slice(idx + 1).trim();
  }
  return out;
}
