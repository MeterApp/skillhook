// Is a runner usable right now? Installed, and logged in or given an API key. Checked before a job spawns (so a
// logged-out CLI fails fast, or a `fallback:` runner takes over) and shown by `skillhook runners`, `GET /runners` and
// the MCP tool get_runners. Probes run with the job environment (baseRunEnv), cached per runner for a minute.
import type { Config, RunnerName } from "./config.js";
import type { Events } from "./events.js";
import { withClaudeConfigDir } from "./runners/env.js";
import { probeClaude, probeCodex } from "./tools.js";
import { nowIso } from "./util.js";

export const RUNNER_NAMES: RunnerName[] = ["claude", "codex", "shell"];

export interface RunnerReadiness {
  runner: RunnerName;
  found: boolean;
  path?: string;
  version?: string;
  /** null for the shell runner (nothing to log in to). */
  authenticated: boolean | null;
  method?: "subscription" | "api_key" | "unknown";
  detail: string;
  hint?: string;
  ready: boolean;
  /** The Claude Code configuration directory this answer is about, when a skill names its own (`claude.config_dir`). */
  config_dir?: string;
  checked_at: string;
}

export interface ReadinessOptions {
  refresh?: boolean;
  /** Probe Claude Code as a skill with this `claude.config_dir` runs it (ignored for the other runners). */
  claudeConfigDir?: string;
}

function claudeMethod(method: string | undefined): RunnerReadiness["method"] {
  const m = (method ?? "").toLowerCase();
  if (!m || m === "none") return "unknown";
  if (m.includes("key") || m.includes("console")) return "api_key";
  return "subscription"; // claude.ai, oauth, …
}

export async function checkReadiness(runner: RunnerName, config: Config, baseEnv: Record<string, string>, claudeConfigDir?: string): Promise<RunnerReadiness> {
  const checked_at = nowIso();
  if (runner === "shell") return { runner, found: true, authenticated: null, detail: "runs the skill's own command", ready: true, checked_at };
  if (runner === "claude") {
    const env = withClaudeConfigDir(baseEnv, claudeConfigDir);
    const where = claudeConfigDir ? { config_dir: claudeConfigDir } : {};
    const hintDir = claudeConfigDir ? `CLAUDE_CONFIG_DIR=${claudeConfigDir} ` : "";
    const probe = await probeClaude(config.runners.claude.command, { env, deep: false });
    const apiKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
    if (!probe.found) return { runner, found: false, authenticated: false, detail: probe.auth.detail, hint: "install Claude Code: https://claude.com/claude-code, or set runners.claude.command", ready: false, ...where, checked_at };
    const authenticated = probe.auth.loggedIn || apiKey;
    return {
      runner,
      found: true,
      path: probe.path,
      version: probe.version,
      authenticated,
      method: probe.auth.loggedIn ? claudeMethod(probe.auth.method) : apiKey ? "api_key" : undefined,
      detail: probe.auth.loggedIn ? probe.auth.detail : apiKey ? "ANTHROPIC_API_KEY set" : probe.auth.detail,
      ...(authenticated ? {} : { hint: claudeConfigDir ? `run \`${hintDir}claude login\` in a terminal as this user` : "run `claude login` in a terminal as this user, or put ANTHROPIC_API_KEY in .env" }),
      ready: authenticated,
      ...where,
      checked_at,
    };
  }
  const env = baseEnv;
  const probe = await probeCodex(config.runners.codex.command, { env, deep: false });
  const apiKey = Boolean(env.OPENAI_API_KEY);
  if (!probe.found) return { runner, found: false, authenticated: false, detail: probe.auth.detail, hint: "install Codex: npm i -g @openai/codex, or set runners.codex.command", ready: false, checked_at };
  const authenticated = probe.auth.loggedIn || apiKey;
  return {
    runner,
    found: true,
    path: probe.path,
    version: probe.version,
    authenticated,
    method: probe.auth.loggedIn ? (probe.auth.method === "api_key" ? "api_key" : probe.auth.method === "chatgpt" ? "subscription" : "unknown") : apiKey ? "api_key" : undefined,
    detail: probe.auth.loggedIn ? probe.auth.detail : apiKey ? "OPENAI_API_KEY set" : probe.auth.detail,
    ...(authenticated ? {} : { hint: "run `codex login` in a terminal as this user, or put OPENAI_API_KEY in .env" }),
    ready: authenticated,
    checked_at,
  };
}

export interface ReadinessCacheDeps {
  config: () => Config;
  /** The environment the probes run with (`baseRunEnv`), re-read on every probe so a new `.env` value counts. */
  env: () => Record<string, string>;
  /** How long an answer is trusted (default 60 s). */
  ttlMs?: () => number;
  events?: Events;
}

function cacheKey(runner: RunnerName, claudeConfigDir: string | undefined): string {
  return claudeConfigDir ? `${runner}\0${claudeConfigDir}` : runner;
}

export class ReadinessCache {
  /** Keyed by runner, and for Claude Code by configuration directory too (`claude\0<dir>`). */
  private readonly cached = new Map<string, { readiness: RunnerReadiness; at: number }>();
  private readonly pending = new Map<string, Promise<RunnerReadiness>>();

  constructor(private readonly deps: ReadinessCacheDeps) {}

  async get(runner: RunnerName, options: ReadinessOptions = {}): Promise<RunnerReadiness> {
    const claudeConfigDir = runner === "claude" ? options.claudeConfigDir : undefined;
    const key = cacheKey(runner, claudeConfigDir);
    const hit = this.cached.get(key);
    if (!options.refresh && hit && Date.now() - hit.at < (this.deps.ttlMs?.() ?? 60_000)) return hit.readiness;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const promise = checkReadiness(runner, this.deps.config(), this.deps.env(), claudeConfigDir).then(
      (readiness) => {
        const previous = this.cached.get(key)?.readiness;
        this.cached.set(key, { readiness, at: Date.now() });
        this.pending.delete(key);
        if (this.deps.events && (!previous || previous.ready !== readiness.ready || previous.authenticated !== readiness.authenticated || previous.found !== readiness.found)) this.deps.events.emit("runners.changed", { runner, readiness, previous });
        return readiness;
      },
      (error: unknown) => {
        this.pending.delete(key);
        throw error;
      },
    );
    this.pending.set(key, promise);
    return promise;
  }

  async all(options: { refresh?: boolean } = {}): Promise<RunnerReadiness[]> {
    return Promise.all(RUNNER_NAMES.map((runner) => this.get(runner, options)));
  }

  /** Stop trusting what is known about a runner (after a run failed to authenticate): the next `get` probes again. */
  invalidate(runner: RunnerName, options: Pick<ReadinessOptions, "claudeConfigDir"> = {}): void {
    const key = cacheKey(runner, runner === "claude" ? options.claudeConfigDir : undefined);
    const hit = this.cached.get(key);
    if (hit) this.cached.set(key, { readiness: hit.readiness, at: 0 });
  }

  last(runner: RunnerName, options: Pick<ReadinessOptions, "claudeConfigDir"> = {}): RunnerReadiness | undefined {
    return this.cached.get(cacheKey(runner, runner === "claude" ? options.claudeConfigDir : undefined))?.readiness;
  }
}
