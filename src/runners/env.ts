import { homedir } from "node:os";
import path from "node:path";
import type { Config } from "../config.js";
import type { Secrets } from "../env.js";
import type { Skill } from "../skills.js";
import { expandTilde } from "../util.js";

/** Always copied from the server's own environment. */
const BASE_KEYS = ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "TZ", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "SSH_AUTH_SOCK", "COLORTERM"];
/** Runner credentials and settings (API keys, base URLs) pass through automatically. */
const PASSTHROUGH_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_"];
const PASSTHROUGH_EXACT = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"];
/** From the server's own environment only these credential variables pass; never a parent Claude Code session's CLAUDE_CODE_* state. */
const PROCESS_CREDENTIAL_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME", "CLAUDE_CONFIG_DIR", ...PASSTHROUGH_EXACT];
/** Never forwarded unless a skill lists them explicitly. */
const NEVER_IMPLICIT = /^(SKILLHOOK_ADMIN_TOKEN|SKILLHOOK_SECRET_|SKILLHOOK_CLOUD_|SKILLHOOK_SENTRY_|SKILLHOOK_NO_SENTRY$|SKILLHOOK_ACCOUNT_)/;
/** Never forwarded at all: the cloud link's token, key and URL stay in the server process (docs/cloud.md); an account's token or key reaches only that account's runs, as the CLI's own variable (docs/accounts.md). */
const NEVER_EXPLICIT = /^(SKILLHOOK_CLOUD_|SKILLHOOK_SENTRY_|SKILLHOOK_NO_SENTRY$|SKILLHOOK_ACCOUNT_)/;

export function defaultPathEntries(home = homedir()): string[] {
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
}

/** The server's PATH plus the usual tool locations, so launchd's minimal PATH still finds `claude` and `codex`. */
export function mergedPath(current: string | undefined, home = homedir()): string {
  const entries = (current ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of defaultPathEntries(home)) if (!entries.includes(entry)) entries.push(entry);
  return entries.join(path.delimiter);
}

export interface RunEnvInput {
  /** Merged secrets (.env file with the process environment layered on top); used for explicit `env:` names. */
  secrets: Secrets;
  /** Secrets from the .env file only. Runner credentials (ANTHROPIC_*, CLAUDE_*, OPENAI_*, CODEX_*) pass through from here. Defaults to `secrets`. */
  fileSecrets?: Secrets;
  skill: Skill;
  config: Config;
  jobVars: Record<string, string>;
  processEnv?: NodeJS.ProcessEnv;
}

/**
 * The environment every run starts from, before a skill's own `env:` names and the job variables: session basics, the
 * merged PATH and the runner credentials. Also what the health probes run `claude`/`codex` with, so `CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME` or an API key in `.env` apply to the diagnosis exactly as to the jobs.
 */
export function baseRunEnv(input: Pick<RunEnvInput, "secrets" | "fileSecrets" | "processEnv">): Record<string, string> {
  const processEnv = input.processEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const key of BASE_KEYS) {
    const value = processEnv[key];
    if (typeof value === "string") env[key] = value;
  }
  env.PATH = mergedPath(processEnv.PATH, env.HOME);
  for (const [key, value] of Object.entries(input.fileSecrets ?? input.secrets)) {
    if (NEVER_IMPLICIT.test(key)) continue;
    if (PASSTHROUGH_EXACT.includes(key) || PASSTHROUGH_PREFIXES.some((p) => key.startsWith(p))) env[key] = value;
  }
  for (const key of PROCESS_CREDENTIAL_KEYS) {
    const value = processEnv[key];
    if (typeof value === "string" && env[key] === undefined) env[key] = value;
  }
  return env;
}

/**
 * What a probe of `claude` / `codex` (a version or login check, a listing, the control protocol) runs with: `env` cut
 * down to PATH, the session basics (`BASE_KEYS`) and the runner's own credentials and settings (`ANTHROPIC_*`,
 * `CLAUDE_*`, `OPENAI_*`, `CODEX_*`, proxies and certificates). A probe does no work for a skill, so nothing a skill
 * was given (`env_passthrough`, `env:`, the job variables) and nothing else `.env` holds reaches its environment, where
 * `ps` would show it.
 */
export function probeEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "PATH" || BASE_KEYS.includes(key) || PASSTHROUGH_EXACT.includes(key) || PASSTHROUGH_PREFIXES.some((p) => key.startsWith(p))) out[key] = value;
  }
  return out;
}

/** Credentials Claude Code prefers to the login in its configuration directory: dropped when a skill names one. */
const CLAUDE_LOGIN_OVERRIDES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

/** The skill's `claude.config_dir` as an absolute path (`~` expanded, relative to the skill's directory), if it names one. */
export function claudeConfigDir(skill: Pick<Skill, "dir" | "config">): string | undefined {
  const dir = skill.config.claude?.config_dir;
  return dir ? path.resolve(skill.dir, expandTilde(dir)) : undefined;
}

/**
 * `env` with Claude Code pointed at `configDir`: `CLAUDE_CONFIG_DIR` set and the variables that would authenticate as
 * someone else instead (an API key, an OAuth token) removed, unless `keep` names them.
 */
export function withClaudeConfigDir(env: Record<string, string>, configDir: string | undefined, keep: readonly string[] = []): Record<string, string> {
  if (!configDir) return env;
  const out: Record<string, string> = { ...env, CLAUDE_CONFIG_DIR: configDir };
  for (const key of CLAUDE_LOGIN_OVERRIDES) if (!keep.includes(key)) delete out[key];
  return out;
}

export function buildRunEnv(input: RunEnvInput): Record<string, string> {
  const explicit = [...input.config.env_passthrough, ...(input.skill.config.env ?? [])];
  const env = withClaudeConfigDir(baseRunEnv(input), claudeConfigDir(input.skill), explicit);
  for (const key of explicit) {
    if (NEVER_EXPLICIT.test(key)) continue;
    const value = input.secrets[key];
    if (typeof value === "string") env[key] = value;
  }
  Object.assign(env, input.jobVars);
  return env;
}
