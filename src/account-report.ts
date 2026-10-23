// One view of every account for people and dashboards: is it usable, who is it, how much of its plan is left, what
// ran on it, which skills use it, and what needs a person (each item with the command that fixes it). The same
// `collectAccounts` answers `skillhook accounts`, `GET /accounts`, the MCP tool `list_accounts` and the health report.
import { probeAccount } from "./account-probe.js";
import { AccountStateStore, isLimited, listAccounts, peakUsage, poolFor, refNames, type AccountIdentity, type AccountKind, type AccountRunner, type AccountState, type AccountUsage, type ResolvedAccount } from "./accounts.js";
import type { Config, RunnerName } from "./config.js";
import type { Secrets } from "./env.js";
import type { Events } from "./events.js";
import type { JobRecord, JobStore } from "./jobs.js";
import { checkAccountReadiness, type ReadinessCache, type RunnerReadiness } from "./readiness.js";
import { resolveRunSettings } from "./run.js";
import { withAccountEnv } from "./accounts.js";
import type { Skill } from "./skills.js";
import { displayPath, errorMessage, nowIso } from "./util.js";

export type AccountStatus = "ready" | "limited" | "expired" | "needs_login" | "missing_secret" | "not_installed" | "disabled" | "unknown";

export interface AccountAttention {
  level: "fail" | "warn" | "info";
  code: "disabled" | "not_installed" | "login_expired" | "not_logged_in" | "missing_secret" | "dir_missing" | "limited" | "usage_high" | "auth_failed" | "duplicate_login" | "unused" | "probe_failed";
  message: string;
  /** The command that fixes it. */
  fix?: string;
}

export interface AccountJobCounts {
  total: number;
  succeeded: number;
  failed: number;
  usage_limit: number;
  auth: number;
  cost_usd: number;
}

export interface AccountView {
  name: string;
  runner: AccountRunner;
  kind: AccountKind;
  label?: string;
  dir: string;
  default_dir: boolean;
  managed: boolean;
  secret_env?: string;
  disabled: boolean;
  status: AccountStatus;
  ready: boolean;
  detail: string;
  identity?: AccountIdentity;
  usage?: AccountUsage;
  limited_until?: string;
  limited_reason?: string;
  last_used_at?: string;
  last_success_at?: string;
  last_failure?: AccountState["last_failure"];
  /** Jobs that ran on this account in the last 24 hours. */
  jobs_24h: AccountJobCounts;
  /** Skills whose pool names it (directly or through `defaults.accounts`). */
  skills: string[];
  /** Runners whose `defaults.accounts` names it. */
  default_for: RunnerName[];
  attention: AccountAttention[];
  readiness: RunnerReadiness;
}

export interface AccountsReport {
  accounts: AccountView[];
  /** Skills naming accounts that do not exist or do not match their runner. */
  problems: { skill: string; message: string }[];
  /** Accounts whose attention has a `fail` or `warn`. */
  needs_attention: string[];
  generated_at: string;
}

export interface CollectAccountsInput {
  config: Config;
  /** The skillhook directory (`<home>/accounts/<name>` is where managed accounts live). */
  home: string;
  secrets: Secrets;
  /** The environment the probes start from (`baseRunEnv`). */
  baseEnv: Record<string, string>;
  skills: Skill[];
  store?: Pick<JobStore, "list">;
  states: AccountStateStore;
  /** The server's readiness cache, when there is one (shared with the queue's pre-flight). */
  readiness?: ReadinessCache;
  refresh?: boolean;
  /** Also ask each account's CLI for its identity and usage windows (one process per account) and keep the answer. */
  usage?: boolean;
  /** Only this account. */
  only?: string;
  events?: Events;
  timeoutMs?: number;
}

function emptyCounts(): AccountJobCounts {
  return { total: 0, succeeded: 0, failed: 0, usage_limit: 0, auth: 0, cost_usd: 0 };
}

function countJobs(jobs: JobRecord[]): Map<string, AccountJobCounts> {
  const out = new Map<string, AccountJobCounts>();
  for (const job of jobs) {
    const names = new Set([job.account, ...(job.attempts ?? []).map((a) => a.account)].filter((n): n is string => Boolean(n)));
    for (const name of names) {
      const counts = out.get(name) ?? emptyCounts();
      counts.total++;
      if (job.account === name && job.status === "succeeded") counts.succeeded++;
      const failures = [...(job.attempts ?? []).filter((a) => a.account === name).map((a) => a.failure?.kind), ...(job.account === name && job.status !== "succeeded" ? [job.failure?.kind] : [])];
      if (job.account === name && (job.status === "failed" || job.status === "timed_out")) counts.failed++;
      counts.usage_limit += failures.filter((k) => k === "usage_limit").length;
      counts.auth += failures.filter((k) => k === "auth").length;
      if (job.account === name && typeof job.cost_usd === "number") counts.cost_usd = Math.round((counts.cost_usd + job.cost_usd) * 10_000) / 10_000;
      out.set(name, counts);
    }
  }
  return out;
}

/** What needs a person about one account, most serious first. */
export function accountAttention(account: ResolvedAccount, readiness: RunnerReadiness, state: AccountState, config: Config, context: { skills: string[]; defaultFor: RunnerName[]; duplicateOf?: string; now?: number }): AccountAttention[] {
  const now = context.now ?? Date.now();
  const login = `skillhook accounts login ${account.name}`;
  const out: AccountAttention[] = [];
  if (account.disabled) out.push({ level: "info", code: "disabled", message: "disabled: no run uses it", fix: `skillhook accounts enable ${account.name}` });
  else if (!readiness.found) out.push({ level: "fail", code: "not_installed", message: readiness.detail, ...(readiness.hint ? { fix: readiness.hint } : {}) });
  else if (!readiness.ready) {
    if (readiness.expired) out.push({ level: "fail", code: "login_expired", message: `login expired${readiness.identity?.email ? ` (${readiness.identity.email})` : ""}: its runs fail until it logs in again`, fix: login });
    else if (account.kind !== "login") out.push({ level: "fail", code: "missing_secret", message: readiness.detail, ...(readiness.hint ? { fix: readiness.hint } : {}) });
    else if (readiness.detail.endsWith("does not exist")) out.push({ level: "fail", code: "dir_missing", message: readiness.detail, fix: login });
    else out.push({ level: "fail", code: "not_logged_in", message: `not logged in (${readiness.detail})`, fix: login });
  }
  if (!account.disabled && isLimited(state, now)) out.push({ level: "warn", code: "limited", message: `${state.limited_reason ?? "usage limit reached"}; skipped until ${state.limited_until}`, fix: `wait, or skillhook accounts reset ${account.name} once the plan allows runs again` });
  const peak = peakUsage(state);
  if (!account.disabled && !isLimited(state, now) && peak !== undefined && peak >= config.account_policy.usage_warn_percent) {
    const full = (state.usage?.windows ?? []).filter((w) => w.used_percent >= config.account_policy.usage_warn_percent).map((w) => `${w.label} ${Math.round(w.used_percent)}%${w.resets_at ? ` (resets ${w.resets_at})` : ""}`);
    out.push({ level: "warn", code: "usage_high", message: `usage high: ${full.join(", ")}` });
  }
  const failure = state.last_failure;
  if (!account.disabled && readiness.ready && failure?.kind === "auth" && (!state.last_success_at || Date.parse(failure.at) > Date.parse(state.last_success_at)) && now - Date.parse(failure.at) < 86_400_000) {
    out.push({ level: "fail", code: "auth_failed", message: `a run failed to authenticate at ${failure.at}${failure.job ? ` (job ${failure.job})` : ""}${failure.message ? `: ${failure.message}` : ""}`, fix: login });
  }
  if (context.duplicateOf) out.push({ level: "warn", code: "duplicate_login", message: `logged in as the same ${account.runner} account as "${context.duplicateOf}": a pool of both adds no capacity`, fix: `${login}  (as another account)` });
  if (!context.skills.length && !context.defaultFor.length && !account.disabled) out.push({ level: "info", code: "unused", message: "no skill uses it and it is no runner's default", fix: `account: ${account.name} in a skill, or skillhook accounts default ${account.name}` });
  return out;
}

function statusOf(account: ResolvedAccount, readiness: RunnerReadiness, state: AccountState): AccountStatus {
  if (account.disabled) return "disabled";
  if (!readiness.found) return "not_installed";
  if (!readiness.ready) return readiness.expired ? "expired" : account.kind !== "login" ? "missing_secret" : "needs_login";
  if (isLimited(state)) return "limited";
  return "ready";
}

/** Every account (or `only`), probed with its own environment, with what runs taught and what needs a person. */
export async function collectAccounts(input: CollectAccountsInput): Promise<AccountsReport> {
  const { config } = input;
  const accounts = listAccounts(config, input.home).filter((a) => !input.only || a.name === input.only);
  const now = Date.now();
  const since = new Date(now - 86_400_000).toISOString();
  const counts = countJobs(input.store ? input.store.list({ since, limit: 5000 }) : []);
  // Which skills use which account, and skills that name accounts wrongly.
  const usedBy = new Map<string, string[]>();
  const problems: AccountsReport["problems"] = [];
  for (const skill of input.skills) {
    if (!skill.enabled) continue;
    const runner = resolveRunSettings(skill, config).runner;
    const own = refNames(skill.config.account);
    for (const name of poolFor(skill, config, runner)) usedBy.set(name, [...(usedBy.get(name) ?? []), skill.name]);
    for (const name of own) {
      const spec = Object.hasOwn(config.accounts, name) ? config.accounts[name] : undefined;
      if (!spec) problems.push({ skill: skill.name, message: `account "${name}" is not defined` });
      else if (runner !== "shell" && spec.runner !== runner) problems.push({ skill: skill.name, message: `account "${name}" is a ${spec.runner} account; the skill runs ${runner}` });
    }
  }
  const defaultFor = (name: string): RunnerName[] => (["claude", "codex"] as const).filter((runner) => refNames(config.defaults.accounts?.[runner]).includes(name));

  const views = await Promise.all(
    accounts.map(async (account): Promise<{ account: ResolvedAccount; readiness: RunnerReadiness; state: AccountState }> => {
      let readiness: RunnerReadiness;
      try {
        readiness = input.readiness ? await input.readiness.get(account.runner, { account, refresh: input.refresh }) : await checkAccountReadiness(account, config, input.baseEnv, input.secrets);
      } catch (error) {
        readiness = { runner: account.runner, account: account.name, found: false, authenticated: false, detail: errorMessage(error), ready: false, checked_at: nowIso() };
      }
      let state = input.states.get(account.name);
      if (input.usage && readiness.ready && account.kind !== "api_key") {
        const report = await probeAccount(account, { command: config.runners[account.runner].command, env: withAccountEnv(input.baseEnv, account, input.secrets), timeoutMs: input.timeoutMs });
        if (report.ok) {
          const patch: Partial<Record<keyof AccountState, unknown>> = { identity: { ...state.identity, ...report.identity } };
          if (report.usage) patch.usage = report.usage;
          // The provider's own numbers decide: a full window limits the account until it resets, a window with room frees it.
          if (report.limited) {
            patch.limited_until = report.limited.until ?? state.limited_until ?? new Date(now + config.account_policy.limited_cooldown_minutes * 60_000).toISOString();
            patch.limited_reason = report.limited.reason;
          } else if (report.usage && isLimited(state, now)) {
            patch.limited_until = undefined;
            patch.limited_reason = undefined;
          }
          const wasLimited = isLimited(state, now);
          state = input.states.update(account.name, patch);
          input.events?.emit("account.updated", { account: account.name, reason: isLimited(state, now) && !wasLimited ? "limited" : wasLimited && !isLimited(state, now) ? "recovered" : "usage", state });
          if (report.expired && readiness.ready) readiness = { ...readiness, ready: false, authenticated: false, expired: true, detail: "login expired" };
        } else {
          state = { ...state, usage: { fetched_at: nowIso(), windows: state.usage?.windows ?? [], error: report.error ?? "no answer" } };
        }
      }
      return { account, readiness, state };
    }),
  );

  // Two login accounts logged in as the same person are one account twice.
  const byIdentity = new Map<string, string>();
  const duplicates = new Map<string, string>();
  for (const { account, state, readiness } of views) {
    const email = state.identity?.email ?? readiness.identity?.email;
    if (!email || account.kind !== "login" || account.disabled) continue;
    const key = `${account.runner}\0${email.toLowerCase()}\0${state.identity?.org ?? ""}`;
    const first = byIdentity.get(key);
    if (first) duplicates.set(account.name, first);
    else byIdentity.set(key, account.name);
  }

  const out: AccountView[] = views.map(({ account, readiness, state }) => {
    const skills = usedBy.get(account.name) ?? [];
    const dflt = defaultFor(account.name);
    const attention = accountAttention(account, readiness, state, config, { skills, defaultFor: dflt, duplicateOf: duplicates.get(account.name), now });
    const identity = state.identity ?? (readiness.identity ? { ...readiness.identity, checked_at: readiness.checked_at } : undefined);
    const status = statusOf(account, readiness, state);
    return {
      name: account.name,
      runner: account.runner,
      kind: account.kind,
      ...(account.label ? { label: account.label } : {}),
      dir: account.dir,
      default_dir: account.defaultDir,
      managed: account.managed,
      ...(account.secretEnv ? { secret_env: account.secretEnv } : {}),
      disabled: account.disabled,
      status,
      ready: status === "ready",
      detail: status === "limited" ? `limited until ${state.limited_until}` : readiness.detail,
      ...(identity ? { identity } : {}),
      ...(state.usage ? { usage: state.usage } : {}),
      ...(state.limited_until && isLimited(state, now) ? { limited_until: state.limited_until, ...(state.limited_reason ? { limited_reason: state.limited_reason } : {}) } : {}),
      ...(state.last_used_at ? { last_used_at: state.last_used_at } : {}),
      ...(state.last_success_at ? { last_success_at: state.last_success_at } : {}),
      ...(state.last_failure ? { last_failure: state.last_failure } : {}),
      jobs_24h: counts.get(account.name) ?? emptyCounts(),
      skills,
      default_for: dflt,
      attention,
      readiness,
    };
  });
  return { accounts: out, problems, needs_attention: out.filter((v) => v.attention.some((a) => a.level !== "info")).map((v) => v.name), generated_at: nowIso() };
}

function percent(value: number): string {
  return `${Math.round(value)}%`;
}

/** "in 2h 5m", "in 3d" — how far away an instant is. */
export function untilText(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `in ${Math.round(hours / 24)}d`;
}

/** "5h 42% · weekly 80%" for the table. */
export function usageText(usage: AccountUsage | undefined): string {
  if (!usage?.windows.length) return usage?.error ? "?" : "";
  return usage.windows.map((w) => `${w.label} ${percent(w.used_percent)}`).join(" · ");
}

/** The nearest reset among the windows that are fullest. */
export function nextResetText(usage: AccountUsage | undefined, now = Date.now()): string {
  const resets = (usage?.windows ?? []).filter((w) => w.resets_at && Date.parse(w.resets_at) > now).sort((a, b) => b.used_percent - a.used_percent);
  const first = resets[0];
  return first ? `${first.label} ${untilText(first.resets_at, now)}` : "";
}

export const STATUS_TEXT: Record<AccountStatus, string> = { ready: "ready", limited: "limited", expired: "expired", needs_login: "needs login", missing_secret: "no token", not_installed: "not installed", disabled: "disabled", unknown: "?" };

export function describeAccountDir(view: Pick<AccountView, "kind" | "dir" | "default_dir" | "secret_env">): string {
  if (view.kind !== "login") return view.secret_env ?? "";
  return view.default_dir ? `${displayPath(view.dir)} (this machine's own login)` : displayPath(view.dir);
}
