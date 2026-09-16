import { z } from "zod";
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
    /** Extra env var names copied into every agent run (on top of the runner auth vars). */
    env_passthrough: z.array(z.string()).default([]),
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

/** Sets a dotted key (`defaults.model`) in the raw config file, validating the result. */
export function setConfigValue(paths: Paths, dotted: string, value: unknown): Record<string, unknown> {
  const raw = readRawConfig(paths);
  const segments = dotted.split(".");
  let cursor: Record<string, unknown> = raw;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1] as string;
  if (value === undefined) delete cursor[last];
  else cursor[last] = value;
  writeConfig(paths, raw);
  return raw;
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
