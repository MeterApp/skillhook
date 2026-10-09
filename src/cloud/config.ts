// Where the cloud is, how a machine identifies itself, and which commands it accepts. The link itself (src/cloud/link.ts)
// is opt-in and only exists once `skillhook cloud connect` wrote `cloud.enabled` and the token; these helpers are pure.
import { COMMAND_CLASS, type CommandType, type MachineMode } from "./protocol.js";

/** The machine token, in `.env`; never forwarded to a run, never printed after pairing. */
export const CLOUD_TOKEN_ENV = "SKILLHOOK_CLOUD_TOKEN";
/** The machine's X25519 private key (base64url), in `.env`; for values the cloud seals to this machine. */
export const CLOUD_PRIVATE_KEY_ENV = "SKILLHOOK_CLOUD_PRIVATE_KEY";
/** A person's organisation API key (`shc_…`) for the fleet (`skillhook cloud login`), in `.env` or the environment; never the machine token. */
export const CLOUD_API_KEY_ENV = "SKILLHOOK_CLOUD_API_KEY";
/** The cloud that key was checked against at login: its requests go there and nowhere else, whatever `cloud.url` says later. */
export const CLOUD_API_URL_ENV = "SKILLHOOK_CLOUD_API_URL";
/** Skillhook Cloud's production deployment (MeterApp/skillhook-cloud); `--url`, `SKILLHOOK_CLOUD_URL` and `cloud.url` name another one. */
export const DEFAULT_CLOUD_URL = "https://skillhook.dev";
/** Every variable of this family stays on the machine: never in a run's environment, even when a skill lists it. */
export const CLOUD_ENV_PREFIX = "SKILLHOOK_CLOUD_";

export interface CloudPolicy {
  mode: MachineMode;
  /** Command types (or `job.*`, `*`) allowed regardless of mode; the only way to allow `allow_list` commands. */
  allow_commands: string[];
  /** Command types (or patterns) refused regardless of anything else. */
  deny_commands: string[];
}

/** Flag > `SKILLHOOK_CLOUD_URL` > `cloud.url` > the default, without a trailing slash. */
export function resolveCloudUrl(env: NodeJS.ProcessEnv, config: { url?: string }, override?: string): string {
  const url = override?.trim() || env.SKILLHOOK_CLOUD_URL?.trim() || config.url?.trim() || DEFAULT_CLOUD_URL;
  return trimTrailingSlashes(url);
}

/** Drops trailing slashes in one pass (a regex like `/\/+$/` backtracks quadratically on long runs of slashes). */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

/** `true` for https, and for plain http to a loopback address (a local cloud in tests) or when `SKILLHOOK_CLOUD_ALLOW_INSECURE=1`. */
export function isSecureCloudUrl(url: string, env: NodeJS.ProcessEnv = {}): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  if (["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)) return true;
  return truthy(env.SKILLHOOK_CLOUD_ALLOW_INSECURE);
}

export class InsecureCloudUrlError extends Error {
  constructor(url: string) {
    super(`the cloud URL must use https (got ${url}); set SKILLHOOK_CLOUD_ALLOW_INSECURE=1 only for a local test server`);
    this.name = "InsecureCloudUrlError";
  }
}

export function assertSecureCloudUrl(url: string, env: NodeJS.ProcessEnv = {}): void {
  if (!isSecureCloudUrl(url, env)) throw new InsecureCloudUrlError(url);
}

/** `SKILLHOOK_NO_CLOUD=1`: the kill switch that beats every config file. */
export function cloudDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.SKILLHOOK_NO_CLOUD);
}

/** Set, and not "", "0" or "false": how the switches in the environment read (`SKILLHOOK_NO_CLOUD`, `CI`). */
export function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/** `job.answer` matches `job.answer`, `job.*` and `*`. */
export function commandMatches(type: string, pattern: string): boolean {
  const p = pattern.trim();
  if (p === "*" || p === type) return true;
  if (p.endsWith(".*")) return type.startsWith(p.slice(0, -1));
  return false;
}

/** Deny list first, then the allow list, then the mode: read commands always, control ones only in `control` mode, allow-list ones only when listed. */
export function commandAllowed(type: string, policy: CloudPolicy): { allowed: boolean; reason?: string } {
  const klass = (COMMAND_CLASS as Record<string, CommandType extends string ? string : never>)[type];
  if (!klass) return { allowed: false, reason: `unknown command ${type}` };
  if (policy.deny_commands.some((pattern) => commandMatches(type, pattern))) return { allowed: false, reason: `${type} is in cloud.deny_commands` };
  if (policy.allow_commands.some((pattern) => commandMatches(type, pattern))) return { allowed: true };
  if (klass === "read") return { allowed: true };
  if (klass === "control") return policy.mode === "control" ? { allowed: true } : { allowed: false, reason: `${type} needs cloud.mode: control (or an entry in cloud.allow_commands)` };
  return { allowed: false, reason: `${type} needs an explicit entry in cloud.allow_commands` };
}
