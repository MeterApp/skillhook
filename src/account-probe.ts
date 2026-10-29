// What an account is, as its own CLI reports it: who is logged in, on which plan, whether the login expired, and how
// much of each usage window is used. Claude Code answers through its control protocol (`claude -p --input-format
// stream-json`: `initialize`, `get_usage`, `get_status`), Codex through `codex app-server` (JSON-RPC `account/read`,
// `account/rateLimits/read`). No prompt is sent and skillhook never touches a token: the CLI asks its provider with the
// account's own login, as it does before every run. The parsers are pure and pinned by captured real answers in the tests.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { AccountIdentity, AccountUsage, ResolvedAccount, UsageWindow } from "./accounts.js";
import { probeEnv } from "./runners/env.js";
import { resolveCommand } from "./tools.js";
import { isPlainObject, nowIso } from "./util.js";

export interface AccountReport {
  /** The CLI answered (false: not installed, timed out, an older version without the protocol). */
  ok: boolean;
  loggedIn: boolean;
  /** A login that existed and ran out. */
  expired?: boolean;
  method?: "subscription" | "api_key" | "other";
  identity?: AccountIdentity;
  usage?: AccountUsage;
  /** A usage window is full: runs fail until it resets. */
  limited?: { until?: string; reason: string };
  error?: string;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/** `initialize`'s `account`: `{email, subscriptionType, tokenSource, apiKeySource, apiProvider, organization}`. */
export function parseClaudeAccount(account: unknown): Pick<AccountReport, "loggedIn" | "method"> & { identity: Omit<AccountIdentity, "checked_at"> } {
  const a = isPlainObject(account) ? account : {};
  const str = (key: string) => (typeof a[key] === "string" && a[key] ? (a[key] as string) : undefined);
  const provider = str("apiProvider");
  const token = str("tokenSource");
  const apiKey = str("apiKeySource");
  const email = str("email");
  const plan = str("subscriptionType");
  const org = str("organization") ?? str("organizationName");
  // As t3code reads it: another provider (Bedrock, Vertex) is its own login; otherwise a token, a key or an account.
  const loggedIn = (provider !== undefined && provider !== "firstParty") || (token !== undefined && token !== "none") || (apiKey !== undefined && apiKey !== "none") || Boolean(email || plan);
  const method = !loggedIn ? undefined : provider && provider !== "firstParty" ? "other" : apiKey && apiKey !== "none" && !plan ? "api_key" : "subscription";
  return { loggedIn, ...(method ? { method } : {}), identity: { ...(email ? { email } : {}), ...(org ? { org } : {}), ...(plan ? { plan: plan.replace(/^claude_/, "").replace(/_subscription$/, "") } : {}) } };
}

function claudeWindow(id: string, label: string, value: unknown, minutes?: number): UsageWindow | undefined {
  if (!isPlainObject(value) || typeof value.utilization !== "number") return undefined;
  const resets = typeof value.resets_at === "string" ? value.resets_at : typeof value.resets_at === "number" ? new Date(value.resets_at * 1000).toISOString() : undefined;
  return { id, label, used_percent: Math.round(value.utilization * 10) / 10, ...(resets ? { resets_at: resets } : {}), ...(minutes ? { window_minutes: minutes } : {}) };
}

/** `get_usage`: `{subscription_type, rate_limits_available, rate_limits: {five_hour, seven_day, model_scoped[], spend}, extra_usage}`. */
export function parseClaudeUsage(response: unknown): { usage?: Omit<AccountUsage, "fetched_at">; plan?: string } {
  if (!isPlainObject(response)) return {};
  const plan = typeof response.subscription_type === "string" && response.subscription_type ? response.subscription_type : undefined;
  if (response.rate_limits_available !== true || !isPlainObject(response.rate_limits)) return plan ? { plan } : {};
  const limits = response.rate_limits;
  const windows: UsageWindow[] = [];
  const five = claudeWindow("five_hour", "5h", limits.five_hour, 300);
  if (five) windows.push(five);
  const week = claudeWindow("seven_day", "weekly", limits.seven_day, 10_080);
  if (week) windows.push(week);
  for (const scoped of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    if (!isPlainObject(scoped)) continue;
    const name = typeof scoped.display_name === "string" ? scoped.display_name : "model";
    const w = claudeWindow(`seven_day_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, `weekly (${name})`, scoped, 10_080);
    if (w) windows.push(w);
  }
  const usage: Omit<AccountUsage, "fetched_at"> = { windows, ...(plan ? { plan } : {}) };
  const spend = isPlainObject(limits.spend) ? limits.spend : undefined;
  const extra = isPlainObject(response.extra_usage) ? response.extra_usage : undefined;
  const money = (value: unknown) => (isPlainObject(value) && typeof value.amount_minor === "number" ? value.amount_minor / 10 ** (typeof value.exponent === "number" ? value.exponent : 2) : undefined);
  if (spend) {
    const currency = isPlainObject(spend.limit) && typeof spend.limit.currency === "string" ? spend.limit.currency : isPlainObject(spend.used) && typeof spend.used.currency === "string" ? spend.used.currency : undefined;
    usage.credits = { ...(typeof spend.enabled === "boolean" ? { enabled: spend.enabled } : {}), ...(money(spend.used) !== undefined ? { used: money(spend.used) } : {}), ...(money(spend.limit) !== undefined ? { limit: money(spend.limit) } : {}), ...(currency ? { currency } : {}) };
  } else if (extra) {
    usage.credits = { ...(typeof extra.is_enabled === "boolean" ? { enabled: extra.is_enabled } : {}), ...(typeof extra.used_credits === "number" ? { used: extra.used_credits } : {}), ...(typeof extra.monthly_limit === "number" ? { limit: extra.monthly_limit } : {}) };
  }
  return { usage, ...(plan ? { plan } : {}) };
}

/** `get_status`: sections of `{label, value}` rows; `Login: Expired — log in again` marks an expired login. */
export function parseClaudeStatus(response: unknown): { expired: boolean; email?: string; org?: string } {
  const rows: { label: string; value: string }[] = [];
  const sections = isPlainObject(response) && Array.isArray(response.sections) ? response.sections : [];
  for (const section of sections) {
    if (!isPlainObject(section) || !Array.isArray(section.rows)) continue;
    for (const row of section.rows) if (isPlainObject(row) && typeof row.label === "string" && typeof row.value === "string") rows.push({ label: row.label, value: row.value });
  }
  const value = (label: string) => rows.find((r) => r.label.toLowerCase() === label)?.value;
  const login = value("login") ?? "";
  const email = value("email");
  const org = value("organization");
  return { expired: login.toLowerCase().includes("expired"), ...(email ? { email } : {}), ...(org ? { org } : {}) };
}

/** A full window (≥ 100 %) means the account is limited until that window resets. */
export function limitFromUsage(usage: Pick<AccountUsage, "windows"> | undefined): AccountReport["limited"] {
  const full = (usage?.windows ?? []).filter((w) => w.used_percent >= 100);
  if (!full.length) return undefined;
  const until = full.map((w) => w.resets_at).filter((v): v is string => Boolean(v)).sort().at(-1);
  return { ...(until ? { until } : {}), reason: `${full.map((w) => w.label).join(", ")} usage limit reached` };
}

export interface ProbeAccountOptions {
  command: string | string[];
  env: Record<string, string>;
  timeoutMs?: number;
}

export interface LineSession {
  send(message: unknown): void;
  end(): void;
}

/**
 * Starts the CLI and feeds it JSON lines: `onMessage` sees every JSON line it prints and returns true once it has
 * what it wants. Resolves with the reason the conversation ended; never throws.
 */
export function converse(command: string, args: string[], env: Record<string, string>, timeoutMs: number, start: (session: LineSession) => void, onMessage: (message: Record<string, unknown>, session: LineSession) => boolean): Promise<{ done: boolean; error?: string; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = "";
    let buffer = "";
    const child = spawn(command, args, { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
    const session: LineSession = {
      send: (message) => {
        if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      end: () => child.stdin.end(),
    };
    const finish = (result: { done: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGTERM");
      resolve({ ...result, stderr });
    };
    const timer = setTimeout(() => finish({ done: false, error: `no answer within ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
    child.stdin.on("error", () => {
      /* the process may exit before reading */
    });
    child.on("error", (error) => finish({ done: false, error: error.message }));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.startsWith("{")) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (isPlainObject(message) && onMessage(message, session)) return finish({ done: true });
      }
    });
    child.on("close", (code) => finish({ done: false, error: `exited with code ${code ?? "?"} before answering` }));
    start(session);
  });
}

/** The flags that keep a probe from doing anything a run does: no hooks, no MCP servers, no saved session. */
const CLAUDE_PROBE_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", '{"disableAllHooks":true}'];

export async function probeClaudeAccount(options: ProbeAccountOptions): Promise<AccountReport> {
  const resolved = resolveCommand(options.command, options.env.PATH);
  if (!resolved.path) return { ok: false, loggedIn: false, error: `${resolved.command} not found on PATH` };
  const env = { ...probeEnv(options.env), ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_AUTO_CONNECT_IDE: "0", CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1" };
  const answers: Record<string, unknown> = {};
  const result = await converse(
    resolved.path,
    [...resolved.lead, ...CLAUDE_PROBE_ARGS],
    env,
    options.timeoutMs ?? 25_000,
    (session) => session.send({ type: "control_request", request_id: "init", request: { subtype: "initialize" } }),
    (message, session) => {
      if (message.type !== "control_response" || !isPlainObject(message.response)) return false;
      const response = message.response;
      const id = typeof response.request_id === "string" ? response.request_id : "";
      answers[id] = response.subtype === "success" ? response.response : { error: typeof response.error === "string" ? response.error : "error" };
      if (id === "init") {
        session.send({ type: "control_request", request_id: "usage", request: { subtype: "get_usage", skip_behaviors: true } });
        session.send({ type: "control_request", request_id: "status", request: { subtype: "get_status" } });
      }
      if ("usage" in answers && "status" in answers) {
        session.end();
        return true;
      }
      return false;
    },
  );
  if (!("init" in answers)) {
    const firstLine = result.stderr.trim().split("\n")[0];
    return { ok: false, loggedIn: false, error: `${result.error ?? "no answer"}${firstLine ? `: ${firstLine}` : ""}` };
  }
  const init = isPlainObject(answers.init) ? answers.init : {};
  const account = parseClaudeAccount(init.account);
  const status = parseClaudeStatus(answers.status);
  const { usage, plan } = parseClaudeUsage(answers.usage);
  const checked_at = nowIso();
  const identity: AccountIdentity = { ...(status.email ? { email: status.email } : {}), ...(status.org ? { org: status.org } : {}), ...account.identity, ...(plan && !account.identity.plan ? { plan } : {}), checked_at };
  const report: AccountReport = { ok: true, loggedIn: account.loggedIn && !status.expired, ...(status.expired ? { expired: true } : {}), ...(account.method ? { method: account.method } : {}), identity };
  if (usage) {
    report.usage = { fetched_at: checked_at, ...usage };
    const limited = limitFromUsage(usage);
    if (limited) report.limited = limited;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function codexWindow(value: unknown, fallbackMinutes: number): UsageWindow | undefined {
  if (!isPlainObject(value) || typeof value.usedPercent !== "number") return undefined;
  const minutes = typeof value.windowDurationMins === "number" ? value.windowDurationMins : fallbackMinutes;
  const label = minutes === 300 ? "5h" : minutes === 10_080 ? "weekly" : minutes >= 40_000 ? "monthly" : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
  const resets = typeof value.resetsAt === "number" ? new Date(value.resetsAt * 1000).toISOString() : undefined;
  return { id: minutes === 300 ? "five_hour" : minutes === 10_080 ? "seven_day" : `window_${minutes}m`, label, used_percent: value.usedPercent, ...(resets ? { resets_at: resets } : {}), window_minutes: minutes };
}

/** `account/read`: `{account: {type: chatgpt|apiKey|amazonBedrock, email, planType} | null, requiresOpenaiAuth}`. */
export function parseCodexAccount(result: unknown): Pick<AccountReport, "loggedIn" | "method"> & { identity: Omit<AccountIdentity, "checked_at"> } {
  const account = isPlainObject(result) && isPlainObject(result.account) ? result.account : undefined;
  if (!account) return { loggedIn: isPlainObject(result) && result.requiresOpenaiAuth === false, identity: {} };
  const type = typeof account.type === "string" ? account.type : "";
  const email = typeof account.email === "string" && account.email ? account.email : undefined;
  const plan = typeof account.planType === "string" && account.planType ? account.planType : undefined;
  return { loggedIn: true, method: type === "chatgpt" ? "subscription" : type === "apiKey" ? "api_key" : "other", identity: { ...(email ? { email } : {}), ...(plan ? { plan } : {}) } };
}

/** `account/rateLimits/read`: `rateLimitsByLimitId.codex` (else `rateLimits`) with `primary` / `secondary` windows, `credits`, `rateLimitReachedType`. */
export function parseCodexRateLimits(result: unknown): { usage?: Omit<AccountUsage, "fetched_at">; reached?: string } {
  if (!isPlainObject(result)) return {};
  const byId = isPlainObject(result.rateLimitsByLimitId) ? result.rateLimitsByLimitId : {};
  const snapshot = isPlainObject(byId.codex) ? byId.codex : isPlainObject(result.rateLimits) ? result.rateLimits : undefined;
  if (!snapshot) return {};
  const plan = typeof snapshot.planType === "string" ? snapshot.planType : undefined;
  const windows = [codexWindow(snapshot.primary, plan === "free" || plan === "go" ? 43_200 : 300), codexWindow(snapshot.secondary, 10_080)].filter((w): w is UsageWindow => Boolean(w));
  const usage: Omit<AccountUsage, "fetched_at"> = { windows, ...(plan ? { plan } : {}) };
  if (isPlainObject(snapshot.credits)) {
    const c = snapshot.credits;
    const balance = typeof c.balance === "string" ? Number(c.balance) : typeof c.balance === "number" ? c.balance : undefined;
    usage.credits = { ...(typeof c.hasCredits === "boolean" ? { enabled: c.hasCredits } : {}), ...(typeof c.unlimited === "boolean" ? { unlimited: c.unlimited } : {}), ...(balance !== undefined && Number.isFinite(balance) ? { balance } : {}) };
  }
  const reached = typeof snapshot.rateLimitReachedType === "string" && snapshot.rateLimitReachedType ? snapshot.rateLimitReachedType : result.ordinaryUsageAllowed === false ? "usage_not_allowed" : undefined;
  return { usage, ...(reached ? { reached } : {}) };
}

export async function probeCodexAccount(options: ProbeAccountOptions): Promise<AccountReport> {
  const resolved = resolveCommand(options.command, options.env.PATH);
  if (!resolved.path) return { ok: false, loggedIn: false, error: `${resolved.command} not found on PATH` };
  const answers: Record<number, unknown> = {};
  const result = await converse(
    resolved.path,
    [...resolved.lead, "app-server"],
    probeEnv(options.env),
    options.timeoutMs ?? 20_000,
    (session) => session.send({ id: 1, method: "initialize", params: { clientInfo: { name: "skillhook", title: "skillhook", version: "1" } } }),
    (message, session) => {
      if (typeof message.id !== "number") return false;
      answers[message.id] = "result" in message ? message.result : { error: message.error };
      if (message.id === 1) {
        session.send({ method: "initialized" });
        session.send({ id: 2, method: "account/read", params: {} });
        session.send({ id: 3, method: "account/rateLimits/read" });
      }
      if (2 in answers && 3 in answers) {
        session.end();
        return true;
      }
      return false;
    },
  );
  if (!(2 in answers)) return { ok: false, loggedIn: false, error: result.error ?? "no answer" };
  const account = parseCodexAccount(answers[2]);
  const checked_at = nowIso();
  const report: AccountReport = { ok: true, loggedIn: account.loggedIn, ...(account.method ? { method: account.method } : {}), identity: { ...account.identity, checked_at } };
  const { usage, reached } = account.loggedIn ? parseCodexRateLimits(answers[3]) : {};
  if (usage) {
    report.usage = { fetched_at: checked_at, ...usage };
    if (usage.plan && !report.identity?.plan) report.identity = { ...report.identity!, plan: usage.plan };
    const limited = limitFromUsage(usage);
    if (limited) report.limited = limited;
    else if (reached) report.limited = { reason: reached.replaceAll("_", " ") };
  }
  return report;
}

/** The account's own report, from its CLI, with the account's environment. */
export function probeAccount(account: Pick<ResolvedAccount, "runner">, options: ProbeAccountOptions): Promise<AccountReport> {
  return account.runner === "claude" ? probeClaudeAccount(options) : probeCodexAccount(options);
}
