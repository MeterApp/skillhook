import { statSync } from "node:fs";
import { z } from "zod";
import type { Events } from "./events.js";
import { FallbackSchema } from "./runners/failure.js";
import { readFileSync } from "node:fs";
import { exists, writeJsonFile } from "./util.js";
import type { Paths } from "./paths.js";

export const RunnerNameSchema = z.enum(["claude", "codex", "shell"]);
export type RunnerName = z.infer<typeof RunnerNameSchema>;

/** A command is an executable name/path, or an array whose head is the executable and tail are leading args. */
export const CommandSpecSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
export type CommandSpec = z.infer<typeof CommandSpecSchema>;

export const ClaudePermissionModeSchema = z.enum(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
export const CodexSandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);

export const ClaudeRunnerConfigSchema = z
  .object({
    /** Executable (default `claude`). Use an absolute path when the server runs as a service. */
    command: CommandSpecSchema.default("claude"),
    /** Unattended runs need a mode that never prompts. `bypassPermissions` is the default; combine `acceptEdits` with `allowed_tools` for tighter control. */
    permission_mode: ClaudePermissionModeSchema.default("bypassPermissions"),
    /** Extra CLI args appended to every claude invocation. */
    args: z.array(z.string()).default([]),
  })
  .strict();

export const CodexRunnerConfigSchema = z
  .object({
    command: CommandSpecSchema.default("codex"),
    sandbox: CodexSandboxSchema.default("workspace-write"),
    /** Codex's workspace-write sandbox blocks network by default; webhook automations usually need it. */
    network_access: z.boolean().default(true),
    approval_policy: z.string().default("never"),
    args: z.array(z.string()).default([]),
  })
  .strict();

export const ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    port: z.number().int().min(1).max(65535).default(8787),
    /** Bind address. Keep it on loopback and let Tailscale (or another TLS proxy) expose it. */
    host: z.string().default("127.0.0.1"),
    /** Public base URL (set by `skillhook expose`); informational, used to print webhook URLs. */
    public_url: z.url().optional(),
    /** Trust X-Forwarded-For from loopback proxies (Tailscale Serve/Funnel, cloudflared, ngrok). */
    trust_proxy: z.boolean().default(true),
    defaults: z
      .object({
        runner: RunnerNameSchema.default("claude"),
        model: z.string().optional(),
        effort: z.string().optional(),
        timeout_seconds: z.number().int().positive().default(900),
        cwd: z.string().optional(),
        /** Fallback runners for every skill that does not set its own `fallback:` (`{ runners: [codex], on: [not_ready] }`). */
        fallback: FallbackSchema.optional(),
      })
      .strict()
      .prefault({}),
    /** Max jobs running at once across all skills (each skill additionally defaults to 1 at a time). */
    concurrency: z.number().int().min(1).default(2),
    max_body_bytes: z.number().int().positive().default(1_048_576),
    /** Upper bound for `?wait=` (synchronous responses). */
    max_wait_seconds: z.number().int().min(0).default(120),
    rate_limit: z
      .object({
        requests_per_minute: z.number().int().positive().default(120),
        auth_failures_per_minute: z.number().int().positive().default(10),
      })
      .strict()
      .prefault({}),
    runners: z
      .object({
        claude: ClaudeRunnerConfigSchema.prefault({}),
        codex: CodexRunnerConfigSchema.prefault({}),
      })
      .strict()
      .prefault({}),
    jobs: z
      .object({
        max_jobs: z.number().int().positive().default(1000),
        dedupe_window_seconds: z.number().int().positive().default(86_400),
        /** Do not queue a webhook whose payload and query string are identical to a job of the same skill that is still queued or running; the response points at that job. `dedupe.in_flight` in a skill overrides it. */
        dedupe_in_flight: z.boolean().default(true),
        /** Payloads larger than this are truncated in the prompt (the full file is always on disk). */
        inline_payload_max_bytes: z.number().int().positive().default(200_000),
      })
      .strict()
      .prefault({}),
    deliveries: z
      .object({
        /** Records kept in `jobs/.delivery-log` (one per request to `/hooks/<skill>`, whatever its outcome). */
        max: z.number().int().positive().default(2000),
        /** Keep the body of a delivery that did not become a job (rejected, filtered), for inspection and replay. Accepted deliveries keep theirs in the job directory. */
        store_bodies: z.boolean().default(true),
        /** How much of such a body is kept, in bytes. */
        body_max_bytes: z.number().int().positive().default(65_536),
      })
      .strict()
      .prefault({}),
    health: z
      .object({
        /** How long `GET /health/checks` (and `skillhook health` through the server) reuse a report before probing again. */
        cache_seconds: z.number().int().min(0).default(60),
        /** How long one slow probe (`claude mcp list`, which connects to every server; `codex doctor`) may take. */
        probe_timeout_seconds: z.number().int().positive().default(20),
        /** How long a runner's readiness (installed, logged in) is trusted before a job re-checks it. */
        readiness_cache_seconds: z.number().int().min(0).default(60),
      })
      .strict()
      .prefault({}),
    /** Extra env var names copied into every agent run (on top of the runner auth vars). */
    env_passthrough: z.array(z.string()).default([]),
    /** Linked projects: directories whose `skillhook.yaml` (or the file itself) contributes hooks. Managed by `skillhook link` / `unlink`; re-read without a restart. */
    projects: z.array(z.string().min(1)).default([]),
    log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    /** Ask the npm registry once a day whether a newer skillhook exists and say so in CLI output, `doctor` and the server log. `SKILLHOOK_NO_UPDATE_CHECK=1` and `CI` disable it too. */
    update_check: z.boolean().default(true),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly file: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export function configExists(paths: Paths): boolean {
  return exists(paths.configFile);
}

export function loadConfig(paths: Paths): Config {
  if (!exists(paths.configFile)) return defaultConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.configFile, "utf8"));
  } catch (error) {
    throw new ConfigError(`Cannot parse ${paths.configFile}: ${(error as Error).message}`, paths.configFile);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid ${paths.configFile}:\n${z.prettifyError(result.error)}`, paths.configFile);
  }
  return result.data;
}

/** Reads the raw (unvalidated, un-defaulted) config object so edits do not bake defaults into the file. */
export function readRawConfig(paths: Paths): Record<string, unknown> {
  if (!exists(paths.configFile)) return {};
  return JSON.parse(readFileSync(paths.configFile, "utf8")) as Record<string, unknown>;
}

export function writeConfig(paths: Paths, config: ConfigInput | Record<string, unknown>): void {
  const validated = ConfigSchema.safeParse(config);
  if (!validated.success) throw new ConfigError(`Refusing to write invalid config:\n${z.prettifyError(validated.error)}`, paths.configFile);
  writeJsonFile(paths.configFile, config);
}

/** Sets (or, with `undefined`, removes) a dotted key in a raw config object; prototype keys are refused. */
function assignDotted(raw: Record<string, unknown>, dotted: string, value: unknown, file: string): void {
  const segments = dotted.split(".");
  let cursor: Record<string, unknown> = raw;
  for (const segment of segments.slice(0, -1)) {
    // `__proto__`, `constructor` and `prototype` would walk into Object.prototype instead of the config file.
    if (segment === "" || segment === "__proto__" || segment === "constructor" || segment === "prototype") throw new ConfigError(`Invalid config key "${dotted}"`, file);
    const next = cursor[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1] as string;
  if (last === "" || last === "__proto__" || last === "constructor" || last === "prototype") throw new ConfigError(`Invalid config key "${dotted}"`, file);
  if (value === undefined) delete cursor[last];
  else cursor[last] = value;
}

/** Sets a dotted key (`defaults.model`) in the raw config file, validating the result. */
export function setConfigValue(paths: Paths, dotted: string, value: unknown): Record<string, unknown> {
  const raw = readRawConfig(paths);
  assignDotted(raw, dotted, value, paths.configFile);
  writeConfig(paths, raw);
  return raw;
}

export interface ConfigPatch {
  /** Dotted keys to set (`{"defaults.model": "sonnet", "concurrency": 3}`). */
  set?: Record<string, unknown>;
  /** Dotted keys to remove. */
  unset?: string[];
}

/** Applies several changes to the raw config file in one validated write. `$schema` is not a setting. */
export function updateConfig(paths: Paths, patch: ConfigPatch): { raw: Record<string, unknown>; config: Config } {
  const raw = readRawConfig(paths);
  const keys = [...Object.keys(patch.set ?? {}), ...(patch.unset ?? [])];
  for (const key of keys) if (key === "$schema" || key.startsWith("$schema.")) throw new ConfigError(`"$schema" is not a setting`, paths.configFile);
  for (const [key, value] of Object.entries(patch.set ?? {})) assignDotted(raw, key, value, paths.configFile);
  for (const key of patch.unset ?? []) assignDotted(raw, key, undefined, paths.configFile);
  writeConfig(paths, raw);
  return { raw, config: ConfigSchema.parse(raw) };
}

/** Keys that only a restart applies: the bind address. Everything else the running server takes over on reload. */
export const RESTART_CONFIG_KEYS: (keyof Config)[] = ["host", "port"];
export const HOT_CONFIG_KEYS: (keyof Config)[] = (Object.keys(ConfigSchema.shape) as (keyof Config)[]).filter((key) => key !== "$schema" && !RESTART_CONFIG_KEYS.includes(key));

/** Top-level keys whose values differ. */
export function diffConfig(before: Config, after: Config): (keyof Config)[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)] as (keyof Config)[]);
  return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

export interface ConfigReload {
  changed: (keyof Config)[];
  /** Applied to the live config now. */
  applied: (keyof Config)[];
  /** Changed in the file, effective at the next start. */
  restart_required: (keyof Config)[];
  pending_restart: (keyof Config)[];
}

/**
 * The running server's config: one object, shared by the server, the queue, the scheduler and every run, patched in
 * place on `reload()` so nothing needs a new reference. Restart-only keys are remembered as `pendingRestart()`.
 */
export class ConfigRef {
  readonly current: Config;
  private readonly pending = new Set<keyof Config>();
  /** The restart-only values this process started with; a file that returns to them clears the pending restart. */
  private readonly startedWith: Record<string, string>;
  private stamp = -1;

  constructor(
    private readonly paths: Paths,
    initial: Config,
    private readonly deps: { events?: Events; onChange?: (applied: (keyof Config)[], config: Config) => void } = {},
  ) {
    this.current = initial;
    this.startedWith = Object.fromEntries(RESTART_CONFIG_KEYS.map((key) => [key, JSON.stringify(initial[key])]));
    this.stamp = this.mtime();
  }

  get(): Config {
    return this.current;
  }

  pendingRestart(): (keyof Config)[] {
    return [...this.pending];
  }

  private mtime(): number {
    try {
      return statSync(this.paths.configFile).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Re-reads the file (throws `ConfigError` when it is invalid; the live config is then untouched). */
  reload(): ConfigReload {
    this.stamp = this.mtime(); // this version of the file has been looked at, valid or not
    const next = loadConfig(this.paths);
    const changed = diffConfig(this.current, next);
    const applied: (keyof Config)[] = [];
    const restart: (keyof Config)[] = [];
    for (const key of changed) {
      if (RESTART_CONFIG_KEYS.includes(key)) restart.push(key);
      else {
        (this.current as Record<string, unknown>)[key] = next[key];
        applied.push(key);
      }
    }
    for (const key of RESTART_CONFIG_KEYS) {
      if (JSON.stringify(next[key]) !== this.startedWith[key]) this.pending.add(key);
      else this.pending.delete(key);
    }
    const result: ConfigReload = { changed, applied, restart_required: restart, pending_restart: this.pendingRestart() };
    if (changed.length) {
      this.deps.onChange?.(applied, this.current);
      this.deps.events?.emit("config.changed", { ...result, config: this.current });
    }
    return result;
  }

  /** Reloads when the file's mtime changed (what `serve` polls every few seconds); errors go to `onError`. */
  poll(onError?: (error: unknown) => void): ConfigReload | undefined {
    if (this.mtime() === this.stamp) return undefined;
    try {
      return this.reload();
    } catch (error) {
      onError?.(error);
      return undefined;
    }
  }
}

/** Parses a CLI value: JSON when it looks like JSON, otherwise a string. */
export function coerceConfigValue(text: string): unknown {
  const trimmed = text.trim();
  if (/^(true|false|null|-?\d+(\.\d+)?|\[.*\]|\{.*\})$/s.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }
  return text;
}
