// Named logins of Claude Code and Codex (`accounts` in skillhook.json, `skillhook accounts`, docs/accounts.md). An
// account is a configuration directory of its own (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, so its login, sessions and
// settings), or a long-lived token / API key kept in `.env`. A skill picks one or a pool with `account:`; the queue
// picks a usable account of the pool for every run (accountCandidates), the run's environment is pointed at it
// (withAccountEnv) and what the runs learn (a usage limit, a failed login, the last use) is kept per account in
// `jobs/.accounts.json` (AccountStateStore), which the readiness check, `skillhook accounts` and the health report read.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AccountConfig, AccountRef, Config, RunnerName } from "./config.js";
import type { Secrets } from "./env.js";
import type { FailureKind } from "./runners/failure.js";
import { isValidTimeZone, nextRun, parseCron } from "./schedule.js";
import type { Skill } from "./skills.js";
import { expandTilde, isPlainObject, nowIso, readJsonFileOr, writeJsonFile } from "./util.js";

export type AccountRunner = AccountConfig["runner"];
export type AccountKind = AccountConfig["kind"];

/** Where each CLI keeps its login when nothing says otherwise. */
export function defaultLoginDir(runner: AccountRunner, home = homedir()): string {
  return path.join(home, runner === "claude" ? ".claude" : ".codex");
}

export interface ResolvedAccount {
  name: string;
  runner: AccountRunner;
  kind: AccountKind;
  label?: string;
  disabled: boolean;
  /** The configuration directory runs use (absolute). */
  dir: string;
  /** `dir` is the CLI's own default (`~/.claude`, `~/.codex`): the machine's own login, so no variable is set for it. */
  defaultDir: boolean;
  /** `dir` is under `<home>/accounts/` (skillhook made it; `accounts remove --purge` may delete it). */
  managed: boolean;
  /** The `.env` name of a `token` / `api_key` account's credential. */
  secretEnv?: string;
  /** The directory whose settings are linked into `dir` (`share_from`). */
  shareFrom?: string;
}

/** `SKILLHOOK_ACCOUNT_<NAME>_TOKEN` / `_API_KEY`: never forwarded to a run except through the account itself. */
export function defaultAccountSecretEnv(name: string, kind: AccountKind): string {
  return `SKILLHOOK_ACCOUNT_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${kind === "token" ? "TOKEN" : "API_KEY"}`;
}

export function accountsDir(skillhookHome: string): string {
  return path.join(skillhookHome, "accounts");
}

export function resolveAccount(name: string, spec: AccountConfig, skillhookHome: string, home = homedir()): ResolvedAccount {
  const managedDir = path.join(accountsDir(skillhookHome), name);
  const dir = spec.dir ? path.resolve(expandTilde(spec.dir)) : managedDir;
  return {
    name,
    runner: spec.runner,
    kind: spec.kind,
    ...(spec.label ? { label: spec.label } : {}),
    disabled: spec.disabled,
    dir,
    defaultDir: dir === defaultLoginDir(spec.runner, home),
    managed: dir.startsWith(`${accountsDir(skillhookHome)}${path.sep}`),
    ...(spec.kind !== "login" ? { secretEnv: spec.secret_env ?? defaultAccountSecretEnv(name, spec.kind) } : {}),
    ...(spec.share_from ? { shareFrom: path.resolve(expandTilde(spec.share_from)) } : {}),
  };
}

// ---------------------------------------------------------------------------
// The account's directory: made by skillhook, settings linked from the machine's own
// ---------------------------------------------------------------------------

/** Never linked: each account's own login and the caches tied to it (t3code's Codex "shadow home" keeps the same two private). */
const CODEX_PRIVATE = new Set(["auth.json", "models_cache.json", "log", "logs", "memories", "tmp", ".DS_Store", ".credentials.json"]);
/** Linked from the shared home before Codex first writes them, so sessions can be resumed whichever account ran them. */
const CODEX_SHARED_DIRS = ["sessions", "archived_sessions"];
/** What Claude Code reads as settings; its login (`.credentials.json`, the keychain), `.claude.json` and sessions stay the account's own. */
const CLAUDE_SHARED = ["settings.json", "CLAUDE.md", "agents", "commands", "skills", "output-styles"];

export interface PreparedDir {
  dir: string;
  created: boolean;
  linked: string[];
  /** Entries the account already has as its own file or directory, so they are not linked. */
  kept: string[];
}

/**
 * Makes the account's directory (mode 700) and, with `share_from`, links the shared settings into it: for Codex every
 * top-level entry of the shared home except the private ones, for Claude Code the settings files. Idempotent: run again
 * (`skillhook accounts login`, `accounts sync`) it links what the shared directory gained meanwhile and never replaces
 * a file the account has of its own. Written only by commands a person runs, never by the server.
 */
export function prepareAccountDir(account: ResolvedAccount): PreparedDir {
  const result: PreparedDir = { dir: account.dir, created: false, linked: [], kept: [] };
  if (account.defaultDir) return result;
  if (!existsSync(account.dir)) {
    mkdirSync(account.dir, { recursive: true, mode: 0o700 });
    result.created = true;
  }
  if (account.managed) chmodSync(account.dir, 0o700);
  const from = account.shareFrom;
  if (!from || from === account.dir || !existsSync(from)) return result;
  let names: string[];
  if (account.runner === "codex") {
    for (const dir of CODEX_SHARED_DIRS) if (!existsSync(path.join(from, dir))) mkdirSync(path.join(from, dir), { recursive: true });
    names = readdirSync(from).filter((name) => !CODEX_PRIVATE.has(name) && !name.endsWith(".lock") && !name.startsWith(".tmp"));
  } else names = CLAUDE_SHARED.filter((name) => existsSync(path.join(from, name)));
  for (const name of names) {
    const target = path.join(from, name);
    const link = path.join(account.dir, name);
    let existing: ReturnType<typeof lstatSync> | undefined;
    try {
      existing = lstatSync(link);
    } catch {
      existing = undefined;
    }
    if (existing?.isSymbolicLink() && readlinkSync(link) === target) continue;
    if (existing) {
      result.kept.push(name);
      continue;
    }
    symlinkSync(target, link);
    result.linked.push(name);
  }
  return result;
}

export function listAccounts(config: Config, skillhookHome: string): ResolvedAccount[] {
  return Object.entries(config.accounts).map(([name, spec]) => resolveAccount(name, spec, skillhookHome));
}

export function getAccount(config: Config, skillhookHome: string, name: string): ResolvedAccount | undefined {
  const spec = Object.hasOwn(config.accounts, name) ? config.accounts[name] : undefined;
  return spec ? resolveAccount(name, spec, skillhookHome) : undefined;
}

export function refNames(ref: AccountRef | undefined): string[] {
  return ref === undefined ? [] : Array.isArray(ref) ? ref : [ref];
}

/**
 * The pool for a run on `runner`: the explicit account, else the skill's `account:` when it is for that runner (a
 * fallback runner does not inherit the other runner's accounts), else `defaults.accounts.<runner>`.
 */
export function poolFor(skill: Pick<Skill, "config">, config: Config, runner: RunnerName, explicit?: string): string[] {
  if (explicit) return [explicit];
  const own = refNames(skill.config.account);
  // A shell command that starts `claude` or `codex` runs as the skill's own account; defaults are for the agent runners.
  if (runner !== "claude" && runner !== "codex") return own;
  if (own.length && (skill.config.runner === runner || runnerOfAccounts(config, own) === runner || !runnerOfAccounts(config, own))) return own;
  return refNames(config.defaults.accounts?.[runner]);
}

/** The runner the skill's own `account:` implies, when it does not set `runner:` (all accounts of a pool share one). */
export function runnerOfAccounts(config: Config, names: string[]): AccountRunner | undefined {
  for (const name of names) {
    const spec = Object.hasOwn(config.accounts, name) ? config.accounts[name] : undefined;
    if (spec) return spec.runner;
  }
  return undefined;
}

/** What is wrong with an account reference, for validation and the health report; empty when it is usable. */
export function accountRefProblems(config: Config, names: string[], runner: RunnerName): string[] {
  const problems: string[] = [];
  for (const name of names) {
    const spec = Object.hasOwn(config.accounts, name) ? config.accounts[name] : undefined;
    if (!spec) problems.push(`account "${name}" is not defined (skillhook accounts add ${name} --runner ${runner === "codex" ? "codex" : "claude"})`);
    else if (runner !== "shell" && spec.runner !== runner) problems.push(`account "${name}" is a ${spec.runner} account, the run uses ${runner}`);
  }
  return problems;
}

/** Variables that would make Claude Code authenticate as someone else than the account's login. */
const CLAUDE_AUTH_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];
/** Likewise for Codex (`codex exec` reads CODEX_API_KEY). */
const CODEX_AUTH_VARS = ["OPENAI_API_KEY", "CODEX_API_KEY"];

/**
 * `env` pointed at the account: its configuration directory (unless it is the CLI's default, which needs no variable,
 * and on macOS must not get one: Claude Code names its keychain entry after a non-default directory), and only its
 * credential. Every other way of authenticating that `env` carried is removed, so the run is billed to this account.
 */
export function withAccountEnv(env: Record<string, string>, account: ResolvedAccount, secrets: Secrets): Record<string, string> {
  const out: Record<string, string> = { ...env };
  const dirVar = account.runner === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  for (const key of account.runner === "claude" ? CLAUDE_AUTH_VARS : CODEX_AUTH_VARS) delete out[key];
  if (account.defaultDir) delete out[dirVar];
  else out[dirVar] = account.dir;
  const secret = account.secretEnv ? secrets[account.secretEnv] : undefined;
  if (secret) {
    if (account.runner === "claude") out[account.kind === "token" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"] = secret;
    else {
      out.OPENAI_API_KEY = secret;
      out.CODEX_API_KEY = secret;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// What runs and probes learned about each account: jobs/.accounts.json
// ---------------------------------------------------------------------------

export interface UsageWindow {
  /** `five_hour`, `seven_day`, `seven_day_opus`, `primary`, `secondary`, … as the provider names it. */
  id: string;
  /** For people: "5h", "weekly", "weekly (Opus)". */
  label: string;
  /** 0–100. */
  used_percent: number;
  resets_at?: string;
  /** The window's length, when the provider says. */
  window_minutes?: number;
}

export interface AccountUsage {
  fetched_at: string;
  windows: UsageWindow[];
  /** Extra usage / credits beyond the plan, when the provider reports them. */
  credits?: { enabled?: boolean; used?: number; limit?: number; balance?: number; currency?: string; unlimited?: boolean };
  plan?: string;
  error?: string;
}

export interface AccountIdentity {
  email?: string;
  org?: string;
  /** `max`, `pro`, `team`, `plus`, `business`, … */
  plan?: string;
  /** A ChatGPT subscription's paid-until date. */
  subscription_until?: string;
  checked_at: string;
}

export interface AccountState {
  /** When the pool last gave the account a job (before it ran): the round robin's clock. */
  last_picked_at?: string;
  last_used_at?: string;
  last_job?: string;
  last_success_at?: string;
  last_failure?: { kind: FailureKind; at: string; job?: string; message?: string };
  /** Skipped by pools until then: a usage limit was hit (reset time from the CLI's message, the usage API or the cooldown). */
  limited_until?: string;
  limited_reason?: string;
  identity?: AccountIdentity;
  usage?: AccountUsage;
}

export type AccountStates = Record<string, AccountState>;

/** `jobs/.accounts.json`, read and written whole (small; one entry per account). */
export class AccountStateStore {
  readonly file: string;

  constructor(jobsDir: string) {
    this.file = path.join(jobsDir, ".accounts.json");
  }

  all(): AccountStates {
    const raw = readJsonFileOr<unknown>(this.file, {});
    if (!isPlainObject(raw)) return {};
    const out: AccountStates = {};
    for (const [name, value] of Object.entries(raw)) if (name !== "__proto__" && isPlainObject(value)) out[name] = value as AccountState;
    return out;
  }

  get(name: string): AccountState {
    return this.all()[name] ?? {};
  }

  /** Merges `patch` into the account's entry (`undefined` removes a field) and returns the new entry. */
  update(name: string, patch: Partial<Record<keyof AccountState, unknown>>): AccountState {
    if (name === "__proto__") throw new Error("invalid account name");
    const states = this.all();
    const next: Record<string, unknown> = { ...(states[name] ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    states[name] = next as AccountState;
    writeJsonFile(this.file, states);
    return states[name];
  }

  remove(name: string): void {
    const states = this.all();
    if (!Object.hasOwn(states, name)) return;
    delete states[name];
    writeJsonFile(this.file, states);
  }
}

/** Is the account skipped for now because it hit a limit? */
export function isLimited(state: AccountState | undefined, now = Date.now()): boolean {
  const until = state?.limited_until ? Date.parse(state.limited_until) : Number.NaN;
  return Number.isFinite(until) && until > now;
}

/**
 * How much of the window is used now: a window whose reset has passed (or, with no reset time, whose whole length
 * has gone by since it was read) is empty again, whatever the last reading said.
 */
export function windowUsed(window: UsageWindow, fetchedAt: string | undefined, now = Date.now()): number {
  const resets = window.resets_at ? Date.parse(window.resets_at) : Number.NaN;
  if (Number.isFinite(resets)) return resets <= now ? 0 : window.used_percent;
  const fetched = fetchedAt ? Date.parse(fetchedAt) : Number.NaN;
  if (window.window_minutes && Number.isFinite(fetched) && fetched + window.window_minutes * 60_000 <= now) return 0;
  return window.used_percent;
}

/** The fullest usage window as of `now`, 0–100 (undefined when no usage is known). */
export function peakUsage(state: AccountState | undefined, now = Date.now()): number | undefined {
  const windows = state?.usage?.windows ?? [];
  return windows.length ? Math.max(...windows.map((w) => windowUsed(w, state?.usage?.fetched_at, now))) : undefined;
}

/** When the pool last handed the account a job (`last_picked_at`, set when the job is given to it), else when a run of it ended. */
function lastPicked(state: AccountState | undefined): number {
  const at = Date.parse(state?.last_picked_at ?? state?.last_used_at ?? "");
  return Number.isFinite(at) ? at : 0;
}

/** Accounts whose usage differs by less than one band count as equally used, so the least recently used decides. */
const USAGE_BAND_PERCENT = 25;

export interface PoolOrderOptions {
  now?: number;
  /** Jobs running on each account right now. */
  inFlight?: Record<string, number>;
  /** `account_policy.usage_avoid_percent`: a window at or above it puts the account behind those with more left. */
  avoidPercent?: number;
}

/**
 * The order in which a pool's accounts are tried, in tiers: accounts with usage left first, then those with a window
 * at or above `avoidPercent` (about to hit a limit, so a long run would likely be cut off mid-session; the one with
 * the most left first), then limited ones (used only when nothing else is left, and then only once their limit may be
 * over). Within the first tier, `ordered` keeps the order listed; `balanced` takes the account running the fewest jobs,
 * then the least used (in bands of 25 points), then the one picked least recently: with no usage known that is a
 * round robin, and an account a person also uses by hand gets fewer jobs as its windows fill.
 */
export function orderPool(names: string[], states: AccountStates, strategy: Config["account_policy"]["strategy"], options: PoolOrderOptions = {}): string[] {
  const now = options.now ?? Date.now();
  const avoid = options.avoidPercent ?? 100;
  const indexed = names.map((name, index) => {
    const state = states[name];
    const used = peakUsage(state, now) ?? 0;
    return { name, index, state, used, tier: isLimited(state, now) ? 2 : used >= avoid ? 1 : 0, running: options.inFlight?.[name] ?? 0 };
  });
  indexed.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier === 1 && a.used !== b.used) return a.used - b.used;
    if (strategy === "balanced" && a.tier === 0) {
      if (a.running !== b.running) return a.running - b.running;
      const band = Math.floor(a.used / USAGE_BAND_PERCENT) - Math.floor(b.used / USAGE_BAND_PERCENT);
      if (band) return band;
      const picked = lastPicked(a.state) - lastPicked(b.state);
      if (picked) return picked;
    }
    return a.index - b.index;
  });
  return indexed.map((entry) => entry.name);
}

/**
 * When a usage limit the CLI reported ends, from its message: Claude Code's `Claude AI usage limit reached|<epoch>`,
 * "resets at 3pm" / "resets 7:30am (Europe/Paris)" style times (today or tomorrow, in the machine's zone when none
 * is named), Codex's "try again in 2 days 3 hours" / "in 45 minutes". Undefined when it does not say.
 */
export function parseLimitReset(message: string | undefined, now = new Date()): string | undefined {
  if (!message) return undefined;
  const epoch = /limit reached\|(\d{10,13})/i.exec(message);
  if (epoch) {
    const value = Number(epoch[1]);
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  const lower = message.toLowerCase();
  // Plain string search first: the CLI's text is not trusted to keep a regex linear.
  const inAt = ["try again in ", "resets in ", "reset in "].map((needle) => lower.indexOf(needle)).find((index) => index >= 0);
  if (inAt !== undefined) {
    let ms = 0;
    const span = lower.slice(inAt, inAt + 80).replace(/^\D+/, "");
    for (const part of span.matchAll(/(\d+) ?(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g)) {
      const n = Number(part[1]);
      const unit = part[2] ?? "";
      ms += unit.startsWith("d") ? n * 86_400_000 : unit.startsWith("h") ? n * 3_600_000 : unit.startsWith("m") ? n * 60_000 : n * 1000;
    }
    if (ms > 0) return new Date(now.getTime() + ms).toISOString();
  }
  const at = /(?:resets?|try again)(?: at)? (\d{1,2})(?::(\d{2}))? ?(am|pm)/.exec(lower);
  if (at) {
    let hour = Number(at[1]) % 12;
    if (at[3] === "pm") hour += 12;
    // "resets 6pm (America/New_York)": the next 6pm in that zone (the original casing; zones are case-sensitive).
    const open = message.indexOf("(", (at.index ?? 0) + at[0].length);
    const close = open >= 0 ? message.indexOf(")", open) : -1;
    const named = open >= 0 && close > open && open - ((at.index ?? 0) + at[0].length) <= 2 ? message.slice(open + 1, close).trim() : "";
    const zone = named && isValidTimeZone(named) ? named : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const next = nextRun(parseCron(`${Number(at[2] ?? 0)} ${hour} * * *`), now, zone);
    return next?.toISOString();
  }
  return undefined;
}

/** Claude Code's `rate_limit_event` notices of one run, by window type (`five_hour`, `seven_day`, `seven_day_opus`, …). */
export type RunRateLimits = Record<string, { utilization?: number; resets_at?: string; status?: string }>;

const RUN_WINDOW_LABELS: Record<string, string> = { five_hour: "5h", seven_day: "weekly", seven_day_opus: "weekly (Opus)", seven_day_sonnet: "weekly (Sonnet)" };

/** The windows a run reported, merged over what was known (a run only mentions the windows it touched). */
export function usageFromRun(before: AccountState, rateLimits: RunRateLimits | undefined, at = nowIso()): Partial<Record<keyof AccountState, unknown>> {
  const reported = Object.entries(rateLimits ?? {}).filter(([, info]) => typeof info.utilization === "number");
  if (!reported.length) return {};
  const windows = [...(before.usage?.windows ?? [])];
  for (const [id, info] of reported) {
    // The event says 0–1; the usage report says 0–100.
    const used_percent = Math.round((info.utilization as number) * 1000) / 10;
    const window: UsageWindow = { id, label: RUN_WINDOW_LABELS[id] ?? id.replaceAll("_", " "), used_percent, ...(info.resets_at ? { resets_at: info.resets_at } : {}) };
    const index = windows.findIndex((w) => w.id === id);
    if (index >= 0) windows[index] = { ...windows[index], ...window };
    else windows.push(window);
  }
  return { usage: { ...(before.usage ?? {}), fetched_at: at, windows } };
}

/** What `jobs/.accounts.json` should say after a run of this account ended. */
export function stateAfterRun(input: { jobId: string; ok: boolean; failure?: { kind: FailureKind; message?: string }; at?: string; cooldownMinutes: number; rateLimits?: RunRateLimits }): Partial<Record<keyof AccountState, unknown>> {
  const at = input.at ?? nowIso();
  if (input.ok) return { last_used_at: at, last_job: input.jobId, last_success_at: at, limited_until: undefined, limited_reason: undefined };
  const patch: Partial<Record<keyof AccountState, unknown>> = { last_used_at: at, last_job: input.jobId };
  if (input.failure && (input.failure.kind === "auth" || input.failure.kind === "usage_limit")) {
    patch.last_failure = { kind: input.failure.kind, at, job: input.jobId, ...(input.failure.message ? { message: input.failure.message } : {}) };
  }
  if (input.failure?.kind === "usage_limit") {
    // The CLI's own notice of the rejected window is the most exact reset time, then its message, then the cooldown.
    const rejected = Object.values(input.rateLimits ?? {}).filter((info) => info.status === "rejected" && info.resets_at).map((info) => info.resets_at as string).sort().at(-1);
    patch.limited_until = rejected ?? parseLimitReset(input.failure.message, new Date(at)) ?? new Date(Date.parse(at) + input.cooldownMinutes * 60_000).toISOString();
    patch.limited_reason = input.failure.message ?? "usage limit reached";
  }
  return patch;
}
