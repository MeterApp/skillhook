// Skillhook Cloud's operation catalogue (`GET /api/v1/tools`) as this machine's CLI and MCP server use it: every
// operation an organisation API key can call there (what the dashboard shows and does), with its JSON Schema and the
// scope it needs. `skillhook cloud <tool>` and `skillhook mcp --cloud` build their commands and tools from it at run
// time, so an operation the cloud adds needs no new skillhook. A call is `POST /api/v1/tools/<name>` with the key.
import { z } from "zod";
import { CloudApiError, type FleetClient } from "./api.js";

const text = z.string().nullish();

export const CatalogToolSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    title: text,
    description: z.string(),
    /** The key scope it needs: fleet:read, fleet:run or fleet:admin. */
    scope: text,
    /** read, write or destructive. */
    kind: text,
    /** Whether the key that listed it may call it. */
    allowed: z.boolean().nullish(),
    input_schema: z.record(z.string(), z.unknown()),
  })
  .loose();
export type CatalogTool = z.infer<typeof CatalogToolSchema>;

export const CatalogSchema = z
  .object({
    version: z.number().nullish(),
    /** What the cloud tells an agent about using its tools (the hosted MCP server's instructions). */
    instructions: text,
    organisation: z.object({ name: z.string(), slug: text }).loose().nullish(),
    key: z.object({ name: text, scopes: z.array(z.string()).nullish(), role: text }).loose().nullish(),
    tools: z.array(CatalogToolSchema),
  })
  .loose();
export type Catalog = z.infer<typeof CatalogSchema>;

const ResultSchema = z.record(z.string(), z.unknown());

/** The catalogue as this key sees it; a cloud from before the catalogue says so. */
export async function fetchCatalog(client: FleetClient, options: { timeoutMs?: number } = {}): Promise<Catalog> {
  try {
    return (await client.get("/tools", CatalogSchema, options)).data;
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 404) throw new CloudApiError(`${client.url} has no tool catalogue (GET /api/v1/tools): it runs an older Skillhook Cloud. skillhook cloud machines, jobs and job still work.`, 404, error.code);
    throw error;
  }
}

/** How long a call may take: what it waits for a machine (`wait_seconds`) plus the cloud's own wait for a command. */
export function callTimeoutMs(input: Record<string, unknown>): number {
  const wait = typeof input.wait_seconds === "number" && Number.isFinite(input.wait_seconds) ? Math.max(0, Math.min(input.wait_seconds, 300)) : 0;
  return (wait + 90) * 1000;
}

/** Runs one operation; its result is the cloud's answer as it came. */
export async function callTool(client: FleetClient, name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await client.post(`/tools/${encodeURIComponent(name)}`, input, ResultSchema, { timeoutMs: callTimeoutMs(input) })).data;
}

/** `list-jobs` and `List_Jobs` are `list_jobs`. */
export function toolName(given: string): string {
  return given.trim().toLowerCase().replaceAll("-", "_");
}

// ---------------------------------------------------------------------------------------------------------------------
// The CLI: a tool's parameters as flags and arguments, its usage, its result as text.

interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

export interface ToolParameter {
  /** As the tool names it (`wait_seconds`). */
  name: string;
  /** As a flag (`--wait-seconds`; `--wait_seconds` works too). */
  flag: string;
  /** `json`: an object, an array or any value (a payload), given as JSON, `@file` or `-` for stdin. */
  kind: "string" | "integer" | "number" | "boolean" | "json";
  required: boolean;
  description: string | null;
  choices: string[] | null;
}

function kindOf(schema: JsonSchema): ToolParameter["kind"] {
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  if (type === "string" || type === "integer" || type === "number" || type === "boolean") return type;
  if (Array.isArray(schema.enum) && schema.enum.length && schema.enum.every((value) => typeof value === "string")) return "string";
  return "json";
}

export function toolParameters(tool: CatalogTool): ToolParameter[] {
  const schema = tool.input_schema as JsonSchema;
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    flag: name.replaceAll("_", "-"),
    kind: kindOf(property),
    required: required.has(name),
    description: property.description ?? null,
    choices: Array.isArray(property.enum) && property.enum.every((value) => typeof value === "string") ? (property.enum as string[]) : null,
  }));
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

type FlagValue = string | boolean | string[];

export interface InputSources {
  stdin: () => Promise<string>;
  file: (path: string) => string;
}

/** Flags every command has, never a tool's parameter. */
const GLOBAL_FLAGS = new Set(["dir", "home", "json", "help", "h", "input"]);

/**
 * A tool's input from the command line: `--param value` flags (booleans as switches, `--no-param` for false, numbers
 * checked, JSON for objects and payloads as a literal, `@file` or `-`), `--param-file PATH` for a long string, `--input`
 * for the whole object, and the required parameters still missing from the arguments, in order.
 */
export async function toolInput(tool: CatalogTool, args: string[], flags: Record<string, FlagValue>, sources: InputSources): Promise<Record<string, unknown>> {
  const parameters = toolParameters(tool);
  const byFlag = new Map<string, ToolParameter>();
  for (const parameter of parameters) {
    byFlag.set(parameter.flag, parameter);
    byFlag.set(parameter.name, parameter);
  }
  const input: Record<string, unknown> = {};
  const whole = flags.input;
  if (whole !== undefined) {
    if (typeof whole !== "string") throw new ToolInputError("--input needs a JSON object, @file or - (stdin)");
    const value = await jsonValue(whole, sources);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolInputError("--input must be a JSON object");
    Object.assign(input, value);
  }
  const positionals = [...args];
  for (const [flag, raw] of Object.entries(flags)) {
    if (GLOBAL_FLAGS.has(flag)) continue;
    const fileOf = flag.endsWith("-file") || flag.endsWith("_file") ? byFlag.get(flag.slice(0, -5)) : undefined;
    if (fileOf && !byFlag.has(flag)) {
      if (typeof raw !== "string") throw new ToolInputError(`--${flag} needs a path`);
      input[fileOf.name] = fileOf.kind === "string" ? sources.file(raw) : parseJson(sources.file(raw), `--${flag}`);
      continue;
    }
    const parameter = byFlag.get(flag);
    if (!parameter) throw new ToolInputError(`${tool.name} has no --${flag}; its parameters: ${parameters.map((p) => `--${p.flag}`).join(", ") || "none"}`);
    input[parameter.name] = await coerce(parameter, raw, sources, positionals);
  }
  for (const parameter of parameters.filter((p) => p.required && !(p.name in input))) {
    const value = positionals.shift();
    if (value === undefined) break;
    input[parameter.name] = await coerce(parameter, value, sources, []);
  }
  if (positionals.length) throw new ToolInputError(`${tool.name} takes no more arguments (got ${positionals.map((p) => JSON.stringify(p)).join(" ")}); flags name the optional ones`);
  const missing = parameters.filter((p) => p.required && !(p.name in input));
  if (missing.length) throw new ToolInputError(`${tool.name} needs ${missing.map((p) => `<${p.flag}>`).join(" ")}: skillhook cloud tools ${tool.name} describes them`);
  return input;
}

async function coerce(parameter: ToolParameter, raw: FlagValue, sources: InputSources, positionals: string[]): Promise<unknown> {
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  const flag = `--${parameter.flag}`;
  if (parameter.kind === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "false") return value === "true";
    // `--include-body <id>`: the switch took the next argument; it is an argument.
    if (value !== undefined) positionals.unshift(value);
    return true;
  }
  if (typeof value !== "string") throw new ToolInputError(`${flag} needs a value`);
  if (parameter.kind === "integer" || parameter.kind === "number") {
    const number = Number(value);
    if (!value.trim() || !Number.isFinite(number) || (parameter.kind === "integer" && !Number.isInteger(number))) throw new ToolInputError(`${flag} must be ${parameter.kind === "integer" ? "a whole number" : "a number"}, got ${JSON.stringify(value)}`);
    return number;
  }
  if (parameter.kind === "json") return jsonValue(value, sources, flag, true);
  const textValue = value === "-" ? await sources.stdin() : value;
  if (parameter.choices && !parameter.choices.includes(textValue)) throw new ToolInputError(`${flag} must be one of ${parameter.choices.join(", ")}`);
  return textValue;
}

function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ToolInputError(`${what} is not JSON`);
  }
}

/** A JSON literal, `@file`, or `-` for stdin; with `lenient`, text that is not JSON is the string itself (a payload may be text). */
async function jsonValue(raw: string, sources: InputSources, what = "--input", lenient = false): Promise<unknown> {
  const source = raw === "-" ? await sources.stdin() : raw.startsWith("@") ? sources.file(raw.slice(1)) : raw;
  try {
    return JSON.parse(source) as unknown;
  } catch {
    if (lenient) return source;
    throw new ToolInputError(`${what} is not JSON`);
  }
}

/** `skillhook cloud tools <name>`: how to call it from the command line. */
export function toolUsage(tool: CatalogTool): string {
  const parameters = toolParameters(tool);
  const required = parameters.filter((p) => p.required);
  const placeholder = (p: ToolParameter) => (p.kind === "boolean" ? "" : p.choices ? ` ${p.choices.join("|")}` : p.kind === "json" ? " JSON|@file|-" : p.kind === "string" ? " TEXT" : " N");
  const rows = parameters.map((p) => [`  --${p.flag}${placeholder(p)}`, `${p.required ? "(required) " : ""}${p.description ?? ""}`]);
  const width = Math.max(0, ...rows.map(([left]) => (left ?? "").length));
  return [
    `skillhook cloud ${tool.name}${required.map((p) => ` <${p.flag}>`).join("")}${parameters.length > required.length ? " [options]" : ""}`,
    "",
    tool.description,
    "",
    `Scope: ${tool.scope ?? "?"}${tool.allowed === false ? " (this key does not have it)" : ""}${tool.kind ? ` · ${tool.kind}` : ""}`,
    ...(rows.length ? ["", ...rows.map(([left, right]) => `${(left ?? "").padEnd(width)}  ${right ?? ""}`.trimEnd())] : []),
    "",
    "Required parameters may also be given as arguments, in this order; --input JSON|@file|- gives the whole input; --json prints the answer as it came.",
  ].join("\n");
}

/** Control characters (but newlines and tabs) out of text from machines and senders, so a terminal shows it as text. */
function printable(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    out += code === 10 || code === 9 || (code >= 32 && code !== 127) ? char : "";
  }
  return out;
}

/** A tool's answer as indented `key: value` lines: lists as `- ` items, text with newlines as an indented block. */
export function renderResult(value: unknown): string {
  const lines: string[] = [];
  const pad = (depth: number) => "  ".repeat(depth);
  const inline = (v: unknown): string | undefined => {
    if (v === null || v === undefined) return "-";
    if (typeof v === "string") return v.includes("\n") ? undefined : printable(v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      if (v.every((item) => ["string", "number", "boolean"].includes(typeof item) && !String(item).includes("\n"))) {
        const joined = v.map((item) => printable(String(item))).join(", ");
        if (joined.length <= 100) return joined;
      }
      return undefined;
    }
    if (typeof v === "object" && !Object.keys(v).length) return "{}";
    return undefined;
  };
  const block = (head: string, textValue: string, depth: number) => {
    lines.push(`${head}|`);
    for (const line of printable(textValue).replace(/\n$/, "").split("\n")) lines.push(`${pad(depth + 1)}${line}`);
  };
  const walk = (v: unknown, depth: number) => {
    if (Array.isArray(v)) {
      for (const item of v) {
        const short = inline(item);
        if (short !== undefined) lines.push(`${pad(depth)}- ${short}`);
        else if (typeof item === "string") block(`${pad(depth)}- `, item, depth);
        else {
          // An object: its first line after "- ", the rest aligned under it.
          const start = lines.length;
          walk(item, depth + 1);
          if (lines[start] !== undefined) lines[start] = `${pad(depth)}- ${lines[start]!.slice(pad(depth + 1).length)}`;
        }
      }
      return;
    }
    if (v && typeof v === "object") {
      for (const [key, child] of Object.entries(v)) {
        const short = inline(child);
        if (short !== undefined) lines.push(`${pad(depth)}${key}: ${short}`);
        else if (typeof child === "string") block(`${pad(depth)}${key}: `, child, depth);
        else {
          lines.push(`${pad(depth)}${key}:`);
          walk(child, depth + 1);
        }
      }
      return;
    }
    lines.push(`${pad(depth)}${inline(v) ?? printable(String(v))}`);
  };
  walk(value, 0);
  return lines.join("\n");
}
