import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { mcpSummary } from "../account-mcp.js";
import { describeAccountDir, collectAccounts, nextResetText, STATUS_TEXT, untilText, usageText, type AccountsReport, type AccountView } from "../account-report.js";
import { AccountStateStore, accountsDir, defaultAccountSecretEnv, defaultLoginDir, getAccount, prepareAccountDir, refNames, resolveAccount, withAccountEnv, type AccountRunner, type ResolvedAccount } from "../accounts.js";
import { adminRequest, findRunningServer } from "../client.js";
import { AccountConfigSchema, AccountNameSchema, ConfigError, loadConfig, readRawConfig, updateConfig, type AccountConfig } from "../config.js";
import { readEnvFile, removeEnvVar, upsertEnvVar } from "../env.js";
import { baseRunEnv } from "../runners/env.js";
import { resolveCommand, probeClaude, probeCodex } from "../tools.js";
import { displayPath, errorMessage, expandTilde, isPlainObject } from "../util.js";
import { notifyDesktop } from "../notify.js";
import { describeReload, notifyServer } from "./config.js";
import { bool, CommandError, promptHidden, relativeTime, str, table, UsageError, type Ctx } from "./shared.js";

export const ACCOUNTS_USAGE = `Usage: skillhook accounts [list] [--usage] [--mcp] [--refresh] [--local]

Several Claude Code and Codex logins on one machine, each a name skills run as (\`account:\` in a skill; docs/accounts.md).
  accounts [list] [--usage] [--mcp] [--refresh] [--local]   every account: state, who it is, plan, usage windows, last use, jobs (24h), what needs attention
                                                    (--mcp: also how many of its MCP servers connect; slow, they all connect)
  accounts show <name> [--usage] [--mcp]            one account in full, with the fix for each problem (--mcp: its MCP servers, connectors and plugins)
  accounts usage [name]                             ask each account's CLI for its usage windows now (5h, weekly, per model, credits) and keep them
  accounts check [--usage] [--mcp] [--notify]               exit 1 when an account needs a person (logged out, expired, limited, high usage, failing runs); --notify also shows a desktop notification
  accounts add <name> --runner claude|codex [--config-dir D] [--share [DIR]|--no-share] [--token|--api-key] [--secret-env NAME] [--label L] [--default] [--login]
                                                    a new account: its own directory under ~/.skillhook/accounts/<name> (or --config-dir; ~/.claude or ~/.codex is this machine's own login)
  accounts login <name> [--device-auth] [--console] [--email E] [--sso] [--token]   log the account in, in this terminal (claude auth login / codex login with its directory; --token: claude setup-token, kept in .env)
  accounts logout <name>                            log it out (claude auth logout / codex logout)
  accounts default <name>... [--runner R] | --clear --runner R   the account (several: a pool) a runner uses when a skill names none
  accounts enable|disable <name>                    take an account out of every pool for a while, or put it back
  accounts reset <name>                             forget a usage limit or a failed run it remembers (once the plan allows runs again)
  accounts discover [--add]                         find logins already on this machine (~/.claude*, ~/.codex*, claude.config_dir of skills) and register them
  accounts sync [name]                              link what the shared directory gained since (share_from)
  accounts exec <name> -- <command> [args…]         run any command as the account (its directory and credential), e.g. claude, codex resume <id>
  accounts remove <name> [--purge]                  forget it (--purge also deletes its directory under ~/.skillhook/accounts and its .env entry)`;

function accountOrThrow(ctx: Ctx, name: string | undefined): ResolvedAccount {
  if (!name) throw new UsageError("Missing account name", ACCOUNTS_USAGE);
  const account = getAccount(ctx.config(), ctx.paths.home, name);
  if (!account) throw new CommandError(`No account "${name}" (skillhook accounts list; skillhook accounts add ${name} --runner claude)`);
  return account;
}

function rawAccounts(ctx: Ctx): Record<string, Record<string, unknown>> {
  const raw = readRawConfig(ctx.paths).accounts;
  return isPlainObject(raw) ? (raw as Record<string, Record<string, unknown>>) : {};
}

async function writeAccounts(ctx: Ctx, set: Record<string, unknown>, unset: string[] = []): Promise<string> {
  try {
    updateConfig(ctx.paths, { set, unset });
  } catch (error) {
    if (error instanceof ConfigError) throw new CommandError(error.message);
    throw error;
  }
  return describeReload(await notifyServer(ctx));
}

/** The report, from the running server when there is one (its readiness cache, which the jobs use), else in this process. */
async function report(ctx: Ctx, options: { usage?: boolean; mcp?: boolean; refresh?: boolean; only?: string; local?: boolean } = {}): Promise<AccountsReport & { via: "server" | "local" }> {
  const running = options.local || bool(ctx.flags, "local") ? undefined : await findRunningServer(ctx.paths);
  if (running) {
    const params = new URLSearchParams({ ...(options.usage ? { usage: "1" } : {}), ...(options.mcp ? { mcp: "1" } : {}), ...(options.refresh ? { refresh: "1" } : {}), ...(options.only ? { account: options.only } : {}) });
    const response = await adminRequest<AccountsReport & { error?: string; message?: string }>(running.baseUrl, ctx.secrets(), `/accounts${params.size ? `?${params.toString()}` : ""}`, { timeoutMs: 120_000 });
    // 404: a server older than accounts; this process answers instead.
    if (response.status !== 404) {
      if (response.status >= 400) throw new CommandError(`Could not read the accounts from ${running.baseUrl}: ${String(response.body.error)}: ${String(response.body.message)}`);
      return { ...response.body, via: "server" };
    }
  }
  // Read again: this command may have just changed the file (`add --login`, `login --token`).
  const config = loadConfig(ctx.paths);
  const secrets = ctx.secrets();
  const baseEnv = baseRunEnv({ secrets, fileSecrets: readEnvFile(ctx.paths.envFile), processEnv: ctx.io.env });
  const result = await collectAccounts({ config, home: ctx.paths.home, secrets, baseEnv, skills: ctx.registry().list().skills, store: ctx.store(), states: new AccountStateStore(ctx.paths.jobsDir), usage: options.usage, mcp: options.mcp, timeoutMs: config.health.probe_timeout_seconds * 1000, refresh: options.refresh, only: options.only });
  return { ...result, via: "local" };
}

function stateCell(view: AccountView): string {
  if (view.status === "limited") return `limited ${untilText(view.limited_until)}`.trim();
  return STATUS_TEXT[view.status];
}

function jobsCell(view: AccountView): string {
  const j = view.jobs_24h;
  if (!j.total) return "";
  return `${j.succeeded}/${j.total} ok${j.usage_limit ? `, ${j.usage_limit} limited` : ""}${j.auth ? `, ${j.auth} auth` : ""}`;
}

/** "mcp 7/9" plus what is wrong ("2 need auth, 1 failed"). */
function mcpCell(view: AccountView): string {
  const mcp = view.mcp;
  if (!mcp) return "";
  if (!mcp.servers.length && mcp.error) return "?";
  const auth = mcp.servers.filter((s) => s.state === "needs_auth").length;
  const failed = mcp.servers.filter((s) => s.state === "failed").length;
  const problems = [auth ? `${auth} need auth` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(", ");
  return `${mcpSummary(mcp)}${problems ? ` (${problems})` : ""}`;
}

const MCP_STATE_TEXT = { connected: "connected", needs_auth: "needs auth", failed: "failed", disabled: "disabled", unknown: "?" } as const;

/** The account's servers as a table, connectors and plugins' servers marked, then its plugins. */
function formatMcp(view: AccountView): string[] {
  const mcp = view.mcp;
  if (!mcp) return [];
  const lines = ["", `MCP servers${mcp.via === "list" ? " (listed; this CLI version reports no connection details)" : ""}: ${mcpSummary(mcp) || "none"}${mcp.servers.length ? " connected" : ""}`];
  if (mcp.servers.length) {
    const order = { needs_auth: 0, failed: 1, unknown: 2, connected: 3, disabled: 4 } as const;
    const sorted = [...mcp.servers].sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
    const clip = (text: string) => (text.length > 100 ? `${text.slice(0, 99)}…` : text);
    lines.push(table(sorted.map((s) => [s.name, MCP_STATE_TEXT[s.state], s.source ?? "", s.tools !== undefined ? String(s.tools) : "", clip(s.state === "connected" || !s.detail ? `${s.target}${s.transport ? ` (${s.transport})` : ""}` : s.detail)]), ["server", "state", "from", "tools", "target / problem"]).split("\n").map((line) => `  ${line}`).join("\n"));
  }
  if (mcp.error) lines.push(`  (${mcp.error})`);
  if (mcp.plugins) {
    const enabled = mcp.plugins.filter((p) => p.enabled);
    const disabled = mcp.plugins.length - enabled.length;
    lines.push(`  plugins    ${enabled.map((p) => `${p.id}${p.version ? `@${p.version}` : ""}`).join(", ") || "none enabled"}${disabled ? ` (+${disabled} disabled)` : ""}`);
  }
  return lines;
}

function formatList(result: AccountsReport): string {
  if (!result.accounts.length) return ["No accounts yet. Every run uses this machine's own claude / codex login.", "", "  skillhook accounts discover          find logins already on this machine", "  skillhook accounts add work --runner claude --login", "", "Then `account: work` (or a pool: `account: [work, personal]`) in a skill, or skillhook accounts default work."].join("\n");
  const withMcp = result.accounts.some((v) => v.mcp);
  const rows = result.accounts.map((v) => [`${v.name}${v.default_for.length ? " *" : ""}`, v.runner, stateCell(v), v.identity?.email ?? (v.kind === "login" ? "" : v.kind), v.identity?.plan ?? "", usageText(v.usage), nextResetText(v.usage), relativeTime(v.last_used_at), jobsCell(v), v.skills.length ? String(v.skills.length) : "", ...(withMcp ? [mcpCell(v)] : [])]);
  const lines = [table(rows, ["account", "runner", "state", "who", "plan", "usage", "next reset", "last used", "jobs 24h", "skills", ...(withMcp ? ["mcp"] : [])])];
  if (result.accounts.some((v) => v.default_for.length)) lines.push("(* a runner's default: defaults.accounts)");
  const attention = result.accounts.flatMap((v) => v.attention.filter((a) => a.level !== "info").map((a) => `  ${a.level === "fail" ? "✗" : "!"} ${v.name}: ${a.message}${a.fix ? `\n      → ${a.fix}` : ""}`));
  for (const problem of result.problems) attention.push(`  ✗ skill ${problem.skill}: ${problem.message}`);
  if (attention.length) lines.push("", "Needs attention:", ...attention);
  if (!result.accounts.some((v) => v.usage)) lines.push("", "skillhook accounts usage asks each account's CLI for its usage windows.");
  return lines.join("\n");
}

function formatShow(view: AccountView): string {
  const lines = [`${view.name}  (${view.runner}, ${view.kind}${view.label ? `, ${view.label}` : ""})`, `  state      ${stateCell(view)}${view.status !== "ready" && view.detail ? ` — ${view.detail}` : ""}`];
  lines.push(`  ${view.kind === "login" ? "directory" : "secret   "}  ${describeAccountDir(view)}`);
  if (view.identity?.email || view.identity?.org) lines.push(`  who        ${[view.identity.email, view.identity.org].filter(Boolean).join(", ")}`);
  if (view.identity?.plan) lines.push(`  plan       ${view.identity.plan}`);
  for (const w of view.usage?.windows ?? []) lines.push(`  ${w.label.padEnd(10)} ${String(Math.round(w.used_percent)).padStart(3)}% used${w.resets_at ? `, resets ${untilText(w.resets_at)} (${w.resets_at})` : ""}`);
  const credits = view.usage?.credits;
  if (credits && (credits.enabled || credits.balance || credits.used)) lines.push(`  credits    ${credits.unlimited ? "unlimited" : [credits.used !== undefined ? `used ${credits.used}` : "", credits.limit !== undefined ? `of ${credits.limit}` : "", credits.balance !== undefined ? `balance ${credits.balance}` : "", credits.currency ?? ""].filter(Boolean).join(" ")}`);
  if (view.usage) lines.push(`  usage read ${relativeTime(view.usage.fetched_at)}${view.usage.error ? ` (last try failed: ${view.usage.error})` : ""}`);
  if (view.last_used_at) lines.push(`  last used  ${relativeTime(view.last_used_at)}${view.last_success_at ? `, last success ${relativeTime(view.last_success_at)}` : ""}`);
  const j = view.jobs_24h;
  lines.push(`  jobs 24h   ${j.total ? `${j.total} (${j.succeeded} succeeded, ${j.failed} failed${j.usage_limit ? `, ${j.usage_limit} usage limit` : ""}${j.auth ? `, ${j.auth} auth` : ""}${j.cost_usd ? `, $${j.cost_usd}` : ""})` : "none"}`);
  lines.push(`  skills     ${view.skills.join(", ") || "none"}${view.default_for.length ? `; default for ${view.default_for.join(", ")}` : ""}`);
  lines.push(...formatMcp(view));
  if (view.attention.length) lines.push("", ...view.attention.map((a) => `  ${a.level === "fail" ? "✗" : a.level === "warn" ? "!" : "·"} ${a.message}${a.fix ? `\n      → ${a.fix}` : ""}`));
  return lines.join("\n");
}

/** Runs a CLI in this terminal with the account's environment; stdout is echoed and kept (for `claude setup-token`). */
function runInteractive(command: string, args: string[], env: Record<string, string>, capture: boolean, write: (text: string) => void): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["inherit", capture ? "pipe" : "inherit", "inherit"] });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = `${stdout}${text}`.slice(-64_000);
      write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

/** The token `claude setup-token` prints at the end (`sk-ant-oat01-…`), if it printed one. */
export function findSetupToken(output: string): string | undefined {
  for (const token of output.split(/\s+/)) {
    const clean = token.replace(/[^A-Za-z0-9_-]/g, "");
    if (clean.startsWith("sk-ant-oat") && clean.length > 40) return clean;
  }
  return undefined;
}

/** The environment a person's own command runs with as this account: their shell's, pointed at the account. */
function personEnv(ctx: Ctx, account: ResolvedAccount): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.io.env)) if (typeof value === "string") env[key] = value;
  return withAccountEnv(env, account, ctx.secrets());
}

async function loginAccount(ctx: Ctx, account: ResolvedAccount): Promise<number> {
  const config = ctx.config();
  const resolved = resolveCommand(config.runners[account.runner].command, ctx.io.env.PATH ?? process.env.PATH);
  if (!resolved.path) throw new CommandError(`${resolved.command} is not installed (or not on PATH)`);
  const token = bool(ctx.flags, "token") || account.kind === "token";
  if (account.kind === "api_key") throw new CommandError(`"${account.name}" is an API-key account: skillhook secret set ${account.secretEnv}`);
  if (token && account.runner !== "claude") throw new CommandError("--token is for Claude Code (claude setup-token); a Codex account logs in with codex login");
  const prepared = prepareAccountDir(account);
  if (prepared.created) ctx.warn(`Created ${displayPath(account.dir)}`);
  if (prepared.linked.length) ctx.warn(`Linked from ${displayPath(account.shareFrom ?? "")}: ${prepared.linked.join(", ")}`);
  const env = personEnv(ctx, account);
  const where = account.defaultDir ? "" : ` (${account.runner === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"}=${displayPath(account.dir)})`;
  let args: string[];
  if (token) args = ["setup-token"];
  else if (account.runner === "claude") args = ["auth", "login", ...(bool(ctx.flags, "console") ? ["--console"] : []), ...(bool(ctx.flags, "sso") ? ["--sso"] : []), ...(str(ctx.flags, "email") ? ["--email", str(ctx.flags, "email")!] : [])];
  else args = ["login", ...(bool(ctx.flags, "device-auth") ? ["--device-auth"] : [])];
  ctx.warn(`Logging in "${account.name}"${where}: ${[path.basename(resolved.command), ...args].join(" ")}`);
  const result = await runInteractive(resolved.path, [...resolved.lead, ...args], env, token, (text) => ctx.io.stderr(text));
  if (result.code !== 0) throw new CommandError(`${[path.basename(resolved.command), ...args].join(" ")} exited with code ${result.code}`, result.code);
  let message = "";
  if (token) {
    const value = findSetupToken(result.stdout) ?? (ctx.io.isTTY ? await promptHidden("Paste the token claude setup-token printed: ") : undefined);
    if (!value) throw new CommandError("No token to keep: run skillhook accounts login again, or skillhook secret set with the token");
    const secretEnv = account.secretEnv ?? defaultAccountSecretEnv(account.name, "token");
    upsertEnvVar(ctx.paths.envFile, secretEnv, value);
    const spec = rawAccounts(ctx)[account.name] ?? {};
    if (spec.kind !== "token") await writeAccounts(ctx, { [`accounts.${account.name}.kind`]: "token" });
    message = `Kept the token in ${secretEnv} (${displayPath(ctx.paths.envFile)}); it lasts about a year and needs no browser on this machine.`;
  }
  // Who is it now? The readiness check, as the next job runs it.
  const after = getAccount(loadConfig(ctx.paths), ctx.paths.home, account.name) ?? account;
  const view = (await report(ctx, { refresh: true, only: after.name, local: true })).accounts[0];
  const who = view?.identity?.email ? ` as ${view.identity.email}${view.identity.plan ? ` (${view.identity.plan})` : ""}` : "";
  const duplicate = view?.attention.find((a) => a.code === "duplicate_login");
  ctx.print([`${view?.ready ? "✓" : "✗"} ${account.name}: ${view?.ready ? `logged in${who}` : view?.detail ?? "not logged in"}`, message, duplicate ? `! ${duplicate.message}` : ""].filter(Boolean).join("\n"), { ok: Boolean(view?.ready), account: view });
  return view?.ready ? 0 : 1;
}

interface Discovered {
  name: string;
  runner: AccountRunner;
  dir: string;
  source: string;
  email?: string;
  logged_in: boolean;
  registered?: string;
}

function suggestName(runner: AccountRunner, dir: string, taken: Set<string>): string {
  const base = path.basename(dir).replace(/^\./, "");
  let suffix = base.startsWith(runner) ? base.slice(runner.length).replace(/^[-_.]+/, "") : base;
  suffix = suffix.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  let name = suffix ? `${runner}-${suffix}`.slice(0, 40) : runner;
  for (let i = 2; taken.has(name); i++) name = `${suffix ? `${runner}-${suffix}` : runner}-${i}`.slice(0, 40);
  taken.add(name);
  return name;
}

async function discover(ctx: Ctx): Promise<Discovered[]> {
  const config = ctx.config();
  const home = ctx.io.env.HOME ?? homedir();
  const candidates = new Map<string, { runner: AccountRunner; source: string }>();
  const add = (runner: AccountRunner, dir: string, source: string) => {
    const abs = path.resolve(expandTilde(dir));
    if (!candidates.has(abs) && existsSync(abs)) candidates.set(abs, { runner, source });
  };
  add("claude", defaultLoginDir("claude", home), "this machine's own login");
  add("codex", defaultLoginDir("codex", home), "this machine's own login");
  try {
    for (const entry of readdirSync(home)) {
      const full = path.join(home, entry);
      if (!statSync(full).isDirectory()) continue;
      if (/^\.claude[-_.]/.test(entry) && existsSync(path.join(full, ".claude.json"))) add("claude", full, "~/.claude-*");
      if (/^\.codex[-_.]/.test(entry) && existsSync(path.join(full, "auth.json"))) add("codex", full, "~/.codex-*");
    }
  } catch {
    /* an unreadable home */
  }
  for (const skill of ctx.registry().list().skills) if (skill.config.claude?.config_dir) add("claude", path.resolve(skill.dir, expandTilde(skill.config.claude.config_dir)), `claude.config_dir of ${skill.name}`);
  const fileEnv = readEnvFile(ctx.paths.envFile);
  if (fileEnv.CLAUDE_CONFIG_DIR) add("claude", fileEnv.CLAUDE_CONFIG_DIR, ".env CLAUDE_CONFIG_DIR");
  if (fileEnv.CODEX_HOME) add("codex", fileEnv.CODEX_HOME, ".env CODEX_HOME");
  const registered = new Map(Object.entries(config.accounts).map(([name, spec]) => [resolveAccount(name, spec, ctx.paths.home, home).dir, name]));
  const taken = new Set(Object.keys(config.accounts));
  const baseEnv = baseRunEnv({ secrets: ctx.secrets(), fileSecrets: fileEnv, processEnv: ctx.io.env });
  const out: Discovered[] = [];
  for (const [dir, { runner, source }] of candidates) {
    const probeAccount = resolveAccount("probe", { runner, kind: "login", dir, disabled: false }, ctx.paths.home, home);
    const env = withAccountEnv(baseEnv, probeAccount, {});
    const probe = runner === "claude" ? await probeClaude(config.runners.claude.command, { env, deep: false }) : await probeCodex(config.runners.codex.command, { env, deep: false });
    const already = registered.get(dir);
    out.push({ name: already ?? suggestName(runner, dir, taken), runner, dir, source, ...(probe.auth.email ? { email: probe.auth.email } : {}), logged_in: probe.auth.loggedIn, ...(already ? { registered: already } : {}) });
  }
  return out;
}

export async function accountsCommand(ctx: Ctx): Promise<number> {
  const [sub = "list", name, ...rest] = ctx.args;
  switch (sub) {
    case "list":
    case "ls":
    case "status": {
      const result = await report(ctx, { usage: bool(ctx.flags, "usage"), mcp: bool(ctx.flags, "mcp"), refresh: bool(ctx.flags, "refresh") });
      ctx.print(formatList(result), result);
      return 0;
    }
    case "show":
    case "get": {
      accountOrThrow(ctx, name);
      const result = await report(ctx, { usage: bool(ctx.flags, "usage"), mcp: bool(ctx.flags, "mcp"), refresh: true, only: name });
      const view = result.accounts[0];
      if (!view) throw new CommandError(`No account "${name}"`);
      ctx.print(formatShow(view), view);
      return 0;
    }
    case "usage":
    case "limits": {
      if (name) accountOrThrow(ctx, name);
      const result = await report(ctx, { usage: true, refresh: true, only: name });
      const rows = result.accounts.map((v) => [v.name, v.runner, stateCell(v), v.identity?.plan ?? "", usageText(v.usage) || (v.kind === "api_key" ? "(API key: pay per use)" : v.ready ? v.usage?.error ?? "" : STATUS_TEXT[v.status]), nextResetText(v.usage)]);
      ctx.print(rows.length ? table(rows, ["account", "runner", "state", "plan", "usage", "next reset"]) : "No accounts (skillhook accounts add …)", result);
      return 0;
    }
    case "check": {
      const result = await report(ctx, { usage: bool(ctx.flags, "usage"), mcp: bool(ctx.flags, "mcp"), refresh: true });
      const items = result.accounts.flatMap((v) => v.attention.filter((a) => a.level !== "info").map((a) => ({ account: v.name, ...a })));
      const problems = result.problems;
      const failing = items.some((i) => i.level === "fail") || problems.length > 0;
      if (bool(ctx.flags, "notify") && (items.length || problems.length)) {
        const first = items[0];
        notifyDesktop("skillhook accounts", first ? `${first.account}: ${first.message}${items.length + problems.length > 1 ? ` (+${items.length + problems.length - 1} more)` : ""}` : `skill ${problems[0]!.skill}: ${problems[0]!.message}`);
      }
      const lines = items.length || problems.length ? [...items.map((i) => `${i.level === "fail" ? "✗" : "!"} ${i.account}: ${i.message}${i.fix ? `\n    → ${i.fix}` : ""}`), ...problems.map((p) => `✗ skill ${p.skill}: ${p.message}`)] : [`✓ ${result.accounts.length} account(s), none needs attention`];
      ctx.print(lines.join("\n"), { ok: !items.length && !problems.length, items, problems, accounts: result.accounts.map((v) => ({ name: v.name, status: v.status })) });
      return failing || items.length ? 1 : 0;
    }
    case "add":
    case "new": {
      if (!name) throw new UsageError("Missing account name", ACCOUNTS_USAGE);
      const parsedName = AccountNameSchema.safeParse(name);
      if (!parsedName.success) throw new UsageError(`Invalid account name "${name}": lowercase letters, digits, - and _`, ACCOUNTS_USAGE);
      if (Object.hasOwn(ctx.config().accounts, name)) throw new CommandError(`Account "${name}" exists (skillhook accounts show ${name})`);
      const runner = str(ctx.flags, "runner");
      if (runner !== "claude" && runner !== "codex") throw new UsageError("--runner claude|codex is required", ACCOUNTS_USAGE);
      const kind = bool(ctx.flags, "token") ? "token" : bool(ctx.flags, "api-key") ? "api_key" : "login";
      const spec: Record<string, unknown> = { runner, ...(kind !== "login" ? { kind } : {}) };
      const dir = str(ctx.flags, "config-dir");
      if (dir) spec.dir = dir;
      // Codex accounts share the machine's Codex settings (everything but auth.json) unless --no-share; Claude only with --share.
      const shareFlag = ctx.flags.share;
      const share = typeof shareFlag === "string" ? shareFlag : shareFlag === true || (shareFlag === undefined && runner === "codex") ? `~/.${runner}` : undefined;
      if (share && kind === "login" && path.resolve(expandTilde(share)) !== path.resolve(expandTilde(dir ?? path.join(accountsDir(ctx.paths.home), name)))) spec.share_from = share;
      const secretEnv = str(ctx.flags, "secret-env");
      if (secretEnv) spec.secret_env = secretEnv;
      const label = str(ctx.flags, "label");
      if (label) spec.label = label;
      const checked = AccountConfigSchema.safeParse(spec);
      if (!checked.success) throw new CommandError(`Invalid account: ${checked.error.issues.map((i) => i.message).join("; ")}`);
      const set: Record<string, unknown> = { [`accounts.${name}`]: spec };
      if (bool(ctx.flags, "default")) {
        const current = refNames(ctx.config().defaults.accounts?.[runner]);
        set[`defaults.accounts.${runner}`] = current.length ? [...current, name] : name;
      }
      const reload = await writeAccounts(ctx, set);
      const account = resolveAccount(name, checked.data as AccountConfig, ctx.paths.home);
      const prepared = prepareAccountDir(account);
      const lines = [`Added ${runner} account "${name}" (${account.kind}${account.kind === "login" ? `, ${describeAccountDir({ kind: account.kind, dir: account.dir, default_dir: account.defaultDir })}` : `, ${account.secretEnv}`})${reload}`];
      if (prepared.linked.length) lines.push(`Linked from ${displayPath(account.shareFrom ?? "")}: ${prepared.linked.join(", ")}`);
      if (bool(ctx.flags, "login")) {
        ctx.print(lines.join("\n"), { ok: true, account: name, dir: account.dir, linked: prepared.linked });
        return loginAccount(ctx, getAccount(loadConfig(ctx.paths), ctx.paths.home, name) ?? account);
      }
      lines.push("", account.kind === "api_key" ? `Next: skillhook secret set ${account.secretEnv}` : `Next: skillhook accounts login ${name}${account.kind === "token" ? " --token" : ""}`, `Then use it: account: ${name} in a skill${bool(ctx.flags, "default") ? "" : `, or skillhook accounts default ${name}`}`);
      ctx.print(lines.join("\n"), { ok: true, account: name, dir: account.dir, linked: prepared.linked, kind: account.kind, ...(account.secretEnv ? { secret_env: account.secretEnv } : {}) });
      return 0;
    }
    case "login": {
      return loginAccount(ctx, accountOrThrow(ctx, name));
    }
    case "logout": {
      const account = accountOrThrow(ctx, name);
      if (account.kind !== "login") throw new CommandError(`"${account.name}" is a ${account.kind} account: remove ${account.secretEnv} with skillhook secret unset ${account.secretEnv}`);
      const config = ctx.config();
      const resolved = resolveCommand(config.runners[account.runner].command, ctx.io.env.PATH ?? process.env.PATH);
      if (!resolved.path) throw new CommandError(`${resolved.command} is not installed (or not on PATH)`);
      const args = account.runner === "claude" ? ["auth", "logout"] : ["logout"];
      const result = await runInteractive(resolved.path, [...resolved.lead, ...args], personEnv(ctx, account), false, (text) => ctx.io.stderr(text));
      ctx.print(result.code === 0 ? `Logged out "${account.name}"` : `${args.join(" ")} exited with code ${result.code}`, { ok: result.code === 0, account: account.name });
      return result.code === 0 ? 0 : 1;
    }
    case "default": {
      const runnerFlag = str(ctx.flags, "runner");
      if (bool(ctx.flags, "clear")) {
        if (runnerFlag !== "claude" && runnerFlag !== "codex") throw new UsageError("--clear needs --runner claude|codex", ACCOUNTS_USAGE);
        const reload = await writeAccounts(ctx, {}, [`defaults.accounts.${runnerFlag}`]);
        ctx.print(`${runnerFlag} runs without a named account (this machine's own login) unless a skill names one${reload}`, { ok: true, runner: runnerFlag, accounts: [] });
        return 0;
      }
      const names = [name, ...rest].filter((n): n is string => Boolean(n));
      if (!names.length) throw new UsageError("Name the account(s): skillhook accounts default work [personal]", ACCOUNTS_USAGE);
      const accounts = names.map((n) => accountOrThrow(ctx, n));
      const runner = accounts[0]!.runner;
      if (runnerFlag && runnerFlag !== runner) throw new CommandError(`"${accounts[0]!.name}" is a ${runner} account, not ${runnerFlag}`);
      const mixed = accounts.find((a) => a.runner !== runner);
      if (mixed) throw new CommandError(`A pool is one runner's accounts: "${mixed.name}" is ${mixed.runner}, "${accounts[0]!.name}" is ${runner}`);
      const reload = await writeAccounts(ctx, { [`defaults.accounts.${runner}`]: names.length === 1 ? names[0] : names });
      ctx.print(`${runner} runs use ${names.length === 1 ? `"${names[0]}"` : `the pool ${names.join(", ")}`} when a skill names no account${reload}`, { ok: true, runner, accounts: names });
      return 0;
    }
    case "enable":
    case "disable": {
      const account = accountOrThrow(ctx, name);
      const reload = await writeAccounts(ctx, sub === "disable" ? { [`accounts.${account.name}.disabled`]: true } : {}, sub === "enable" ? [`accounts.${account.name}.disabled`] : []);
      ctx.print(`${sub === "disable" ? "Disabled" : "Enabled"} "${account.name}"${reload}`, { ok: true, account: account.name, disabled: sub === "disable" });
      return 0;
    }
    case "reset":
    case "clear": {
      const account = accountOrThrow(ctx, name);
      new AccountStateStore(ctx.paths.jobsDir).update(account.name, { limited_until: undefined, limited_reason: undefined, last_failure: undefined });
      ctx.print(`"${account.name}" is no longer treated as limited or failing; the next run checks it again`, { ok: true, account: account.name });
      return 0;
    }
    case "discover":
    case "import": {
      const found = await discover(ctx);
      const fresh = found.filter((d) => !d.registered);
      if (bool(ctx.flags, "add") && fresh.length) {
        const set: Record<string, unknown> = {};
        for (const d of fresh) set[`accounts.${d.name}`] = { runner: d.runner, dir: d.dir };
        const reload = await writeAccounts(ctx, set);
        ctx.print(`Registered ${fresh.map((d) => `"${d.name}" (${displayPath(d.dir)})`).join(", ")}${reload}`, { ok: true, added: fresh, found });
        return 0;
      }
      const rows = found.map((d) => [d.registered ? `${d.registered} (registered)` : d.name, d.runner, displayPath(d.dir), d.logged_in ? `logged in${d.email ? ` as ${d.email}` : ""}` : "not logged in", d.source]);
      ctx.print(found.length ? `${table(rows, ["account", "runner", "directory", "login", "found as"])}${fresh.length ? "\n\nskillhook accounts discover --add registers the new ones under these names." : ""}` : "No Claude Code or Codex logins found in the usual places.", { ok: true, found });
      return 0;
    }
    case "sync": {
      const accounts = name ? [accountOrThrow(ctx, name)] : Object.keys(ctx.config().accounts).map((n) => getAccount(ctx.config(), ctx.paths.home, n)!);
      const results = accounts.filter((a) => a.kind !== "api_key").map((a) => ({ account: a.name, ...prepareAccountDir(a) }));
      ctx.print(results.map((r) => `${r.account}: ${r.linked.length ? `linked ${r.linked.join(", ")}` : "nothing new"}${r.kept.length ? `; kept its own ${r.kept.join(", ")}` : ""}`).join("\n") || "No accounts", { ok: true, results });
      return 0;
    }
    case "exec":
    case "run": {
      const account = accountOrThrow(ctx, name);
      const dash = ctx.rawArgs.indexOf("--");
      const argv = dash >= 0 ? ctx.rawArgs.slice(dash + 1) : rest;
      if (!argv.length) throw new UsageError("Name the command: skillhook accounts exec <name> -- claude", ACCOUNTS_USAGE);
      const [command, ...args] = argv as [string, ...string[]];
      const result = await runInteractive(command, args, personEnv(ctx, account), false, (text) => ctx.io.stdout(text)).catch((error: unknown) => {
        throw new CommandError(`Could not start ${command}: ${errorMessage(error)}`);
      });
      return result.code;
    }
    case "remove":
    case "rm":
    case "delete": {
      const account = accountOrThrow(ctx, name);
      const config = ctx.config();
      const users = ctx
        .registry()
        .list()
        .skills.filter((s) => refNames(s.config.account).includes(account.name))
        .map((s) => s.name);
      const unset = [`accounts.${account.name}`];
      for (const runner of ["claude", "codex"] as const) {
        const pool = refNames(config.defaults.accounts?.[runner]);
        if (!pool.includes(account.name)) continue;
        const left = pool.filter((n) => n !== account.name);
        if (!left.length) unset.push(`defaults.accounts.${runner}`);
      }
      const set: Record<string, unknown> = {};
      for (const runner of ["claude", "codex"] as const) {
        const pool = refNames(config.defaults.accounts?.[runner]);
        const left = pool.filter((n) => n !== account.name);
        if (pool.includes(account.name) && left.length) set[`defaults.accounts.${runner}`] = left.length === 1 ? left[0] : left;
      }
      const reload = await writeAccounts(ctx, set, unset);
      new AccountStateStore(ctx.paths.jobsDir).remove(account.name);
      const notes: string[] = [];
      if (bool(ctx.flags, "purge")) {
        if (account.managed && existsSync(account.dir)) {
          rmSync(account.dir, { recursive: true, force: true });
          notes.push(`deleted ${displayPath(account.dir)}`);
        } else if (account.kind === "login") notes.push(`kept ${displayPath(account.dir)} (not under ${displayPath(accountsDir(ctx.paths.home))})`);
        if (account.secretEnv) {
          if (removeEnvVar(ctx.paths.envFile, account.secretEnv)) notes.push(`removed ${account.secretEnv} from .env`);
        }
      } else if (account.kind === "login" && account.managed) notes.push(`its directory stays at ${displayPath(account.dir)} (--purge deletes it)`);
      if (users.length) notes.push(`skills still naming it fail until changed: ${users.join(", ")}`);
      ctx.print(`Removed "${account.name}"${notes.length ? `; ${notes.join("; ")}` : ""}${reload}`, { ok: true, account: account.name, purged: bool(ctx.flags, "purge"), skills: users });
      return 0;
    }
    default:
      throw new UsageError(`Unknown accounts subcommand "${sub}"`, ACCOUNTS_USAGE);
  }
}
