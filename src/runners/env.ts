import { homedir } from "node:os";
import path from "node:path";
import type { Config } from "../config.js";
import type { Secrets } from "../env.js";
import type { Skill } from "../skills.js";

/** Always copied from the server's own environment. */
const BASE_KEYS = ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "TZ", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "SSH_AUTH_SOCK", "COLORTERM"];
/** Runner credentials and settings (API keys, base URLs) pass through automatically. */
const PASSTHROUGH_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_"];
const PASSTHROUGH_EXACT = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"];
/** From the server's own environment only these credential variables pass; never a parent Claude Code session's CLAUDE_CODE_* state. */
const PROCESS_CREDENTIAL_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME", "CLAUDE_CONFIG_DIR", ...PASSTHROUGH_EXACT];
/** Never forwarded unless a skill lists them explicitly. */
const NEVER_IMPLICIT = /^(SKILLHOOK_ADMIN_TOKEN|SKILLHOOK_SECRET_)/;

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

export function buildRunEnv(input: RunEnvInput): Record<string, string> {
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
  const explicit = [...input.config.env_passthrough, ...(input.skill.config.env ?? [])];
  for (const key of explicit) {
    const value = input.secrets[key];
    if (typeof value === "string") env[key] = value;
  }
  Object.assign(env, input.jobVars);
  return env;
}
