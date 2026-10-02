// Skillhook Cloud's operation catalogue (`GET /api/v1/tools`) as this machine's CLI and MCP server use it: every
// operation an organisation API key can call there (what the dashboard shows and does), with its JSON Schema and the
// scope it needs. `skillhook cloud <tool>` and `skillhook mcp --cloud` build their commands and tools from it at run
// time, so an operation the cloud adds needs no new skillhook. A call is `POST /api/v1/tools/<name>` with the key.
import { z } from "zod";
import { printable } from "../util.js";
import { CloudApiError, type FleetClient } from "./api.js";

const text = z.string().nullish();

/** A tool's input as JSON Schema: an object whose parameters are schemas (objects), as MCP requires; read loosely within. */
const InputSchemaSchema = z.object({ type: z.literal("object"), properties: z.record(z.string(), z.record(z.string(), z.unknown())).optional(), required: z.array(z.string()).optional() }).loose();

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
    input_schema: InputSchemaSchema,
  })
  .loose();
export type CatalogTool = z.infer<typeof CatalogToolSchema>;

/** The shape of the catalogue this version reads; a cloud that changes the shape (not the tools) raises it. */
export const CATALOG_VERSION = 1;

const ListingSchema = z
  .object({
    version: z.number().nullish(),
    /** What the cloud tells an agent about using its tools (the hosted MCP server's instructions). */
    instructions: text,
    organisation: z.object({ name: z.string(), slug: text }).loose().nullish(),
    key: z.object({ name: text, scopes: z.array(z.string()).nullish(), role: text }).loose().nullish(),
    tools: z.array(z.unknown()),
  })
  .loose();
type Listing = z.infer<typeof ListingSchema>;
export interface Catalog {
  version?: Listing["version"];
  instructions?: Listing["instructions"];
  organisation?: Listing["organisation"];
  key?: Listing["key"];
  tools: CatalogTool[];
}

const ResultSchema = z.record(z.string(), z.unknown());

/**
 * The catalogue as this key sees it: the tools this version can read (one it cannot, a malformed schema included, is
 * skipped, not fatal; a name listed twice counts once). A cloud from before the catalogue, or with a newer shape of it,
 * says so.
 */
export async function fetchCatalog(client: FleetClient, options: { timeoutMs?: number } = {}): Promise<Catalog> {
  let listing: z.infer<typeof ListingSchema>;
  try {
    listing = (await client.get("/tools", ListingSchema, options)).data;
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 404) throw new CloudApiError(`${client.url} has no tool catalogue (GET /api/v1/tools): it runs an older Skillhook Cloud. skillhook cloud machines, jobs and job still work.`, 404, error.code);
    throw error;
  }
  if (typeof listing.version === "number" && listing.version > CATALOG_VERSION) throw new CloudApiError(`${client.url} lists its tools in version ${listing.version} of the catalogue; this skillhook reads version ${CATALOG_VERSION}: update it (skillhook update --install)`, undefined, "catalog_version");
  const seen = new Set<string>();
  const tools = listing.tools.flatMap((entry) => {
    const parsed = CatalogToolSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.name)) return [];
    seen.add(parsed.data.name);
    return [parsed.data];
  });
  return { version: listing.version, instructions: listing.instructions, organisation: listing.organisation, key: listing.key, tools };
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

export interface InputSources {
  stdin: () => Promise<string>;
  file: (path: string) => string;
}

/** skillhook's own options, read by every command wherever they stand (src/commands/main.ts): never a tool's value. */
const OWN_OPTIONS = new Set(["json", "help", "h", "version", "v", "dir", "home"]);

/** The option a word is as every command reads it (`--json`, `--dir=PATH`, `-h`…), when it is one of skillhook's own. */
function ownOption(word: string): string | undefined {
  if (word === "-" || !word.startsWith("-")) return undefined;
  const eq = word.indexOf("=");
  const name = word.startsWith("--") ? (eq > 0 ? word.slice(2, eq) : word.slice(2)) : word.slice(1);
  return OWN_OPTIONS.has(name) ? name : undefined;
}

/**
 * A tool's input from the words around its name, read with its schema: `--param value` or `--param=value` (a text
 * parameter takes the next word, even one that starts with a dash, unless it is one of skillhook's own options: those,
 * `--json`, `--help`/`-h`, `--version`/`-v`, `--dir`/`--home`, mean the same everywhere, so such a text is given as
 * `--param=--json`), booleans as switches (`--param`, `--no-param`, `--param=false`), numbers checked, JSON parameters
 * (objects, payloads) as a literal, `@file` or `-`, `--param-file PATH` for a long text, `--input JSON|@file|-` for the
 * whole input (flags win over it), and the required parameters not given as flags from the remaining arguments, in
 * order. `--` ends the flags.
 */
export async function toolInput(tool: CatalogTool, tokens: string[], sources: InputSources): Promise<Record<string, unknown>> {
  const parameters = toolParameters(tool);
  const byFlag = new Map<string, ToolParameter>();
  for (const parameter of parameters) {
    byFlag.set(parameter.flag, parameter);
    byFlag.set(parameter.name, parameter);
  }
  const input: Record<string, unknown> = {};
  const positionals: string[] = [];
  let whole: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (token === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    const own = ownOption(token);
    if (own) {
      // Read by main.ts already; --dir and --home take the next word the way it reads them.
      const next = tokens[i + 1];
      if ((own === "dir" || own === "home") && !token.includes("=") && next !== undefined && (next === "-" || !next.startsWith("-"))) i++;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq > 2 ? token.slice(2, eq) : token.slice(2);
    const inline = eq > 2 ? token.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      const next = tokens[i + 1];
      if (next === undefined) throw new ToolInputError(`--${name} needs a value`);
      if (ownOption(next)) throw new ToolInputError(`--${name} needs a value: ${next} is skillhook's own option (as the text itself: --${name}=${next})`);
      i++;
      return next;
    };
    if (name === "input") {
      whole = value();
      continue;
    }
    const parameter = byFlag.get(name);
    if (parameter?.kind === "boolean") {
      input[parameter.name] = inline === undefined ? true : booleanOf(inline, name);
      continue;
    }
    if (parameter) {
      input[parameter.name] = await coerce(parameter, value(), sources);
      continue;
    }
    const negated = name.startsWith("no-") || name.startsWith("no_") ? byFlag.get(name.slice(3)) : undefined;
    if (negated?.kind === "boolean" && inline === undefined) {
      input[negated.name] = false;
      continue;
    }
    const fileOf = name.endsWith("-file") || name.endsWith("_file") ? byFlag.get(name.slice(0, -5)) : undefined;
    if (fileOf) {
      const path = value();
      input[fileOf.name] = fileOf.kind === "json" ? parseJson(sources.file(path), `--${name}`) : sources.file(path);
      continue;
    }
    throw new ToolInputError(`${tool.name} has no --${name}; its parameters: ${parameters.map((p) => `--${p.flag}`).join(", ") || "none"}`);
  }
  if (whole !== undefined) {
    const given = await jsonValue(whole, sources);
    if (!given || typeof given !== "object" || Array.isArray(given)) throw new ToolInputError("--input must be a JSON object");
    for (const [key, item] of Object.entries(given)) if (!(key in input)) input[key] = item;
  }
  for (const parameter of parameters.filter((p) => p.required && !(p.name in input))) {
    const next = positionals.shift();
    if (next === undefined) break;
    input[parameter.name] = await coerce(parameter, next, sources);
  }
  if (positionals.length) throw new ToolInputError(`${tool.name} takes no more arguments (got ${positionals.map((p) => JSON.stringify(p)).join(" ")}); flags name the optional ones`);
  const missing = parameters.filter((p) => p.required && !(p.name in input));
  if (missing.length) throw new ToolInputError(`${tool.name} needs ${missing.map((p) => `<${p.flag}>`).join(" ")}: skillhook cloud tools ${tool.name} describes them`);
  return input;
}

function booleanOf(value: string, name: string): boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new ToolInputError(`--${name} is a switch: --${name}, --no-${name}, or --${name}=true|false`);
}

async function coerce(parameter: ToolParameter, value: string, sources: InputSources): Promise<unknown> {
  const flag = `--${parameter.flag}`;
  if (parameter.kind === "boolean") return booleanOf(value, parameter.flag);
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
    "Required parameters may also be given as arguments, in this order; --input JSON|@file|- gives the whole input; --json prints the answer as it came. A text that is one of skillhook's own options (--json, --help, -h, --version, -v, --dir) goes after an equals sign: --answer=--help.",
  ].join("\n");
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
        const label = printable(key);
        if (short !== undefined) lines.push(`${pad(depth)}${label}: ${short}`);
        else if (typeof child === "string") block(`${pad(depth)}${label}: `, child, depth);
        else {
          lines.push(`${pad(depth)}${label}:`);
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
