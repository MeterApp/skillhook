import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountStateStore } from "../accounts.js";
import { loadConfig } from "../config.js";
import { readEnvFile } from "../env.js";
import { FAKE_CLAUDE, FAKE_CODEX, tempHome, writeConfigFile, writeSkill } from "../test-support/helpers.js";
import { findSetupToken } from "./accounts.js";
import { main } from "./main.js";
import type { CliIO } from "./shared.js";

function io(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIO = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env, isTTY: false };
  return { cli, out: () => out.join(""), err: () => err.join(""), json: () => JSON.parse(out.join("")) as Record<string, unknown> };
}

function setup() {
  const paths = tempHome("skillhook-accounts-cli-");
  writeConfigFile(paths, { runners: { claude: { command: FAKE_CLAUDE }, codex: { command: FAKE_CODEX } } });
  // No server, no registry, a home of its own: nothing outside the temporary directory is read or written.
  const env = { SKILLHOOK_NO_UPDATE_CHECK: "1", SKILLHOOK_NPM_REGISTRY: "http://127.0.0.1:1", SKILLHOOK_NO_CLOUD: "1", HOME: path.join(paths.home, "user") };
  mkdirSync(env.HOME, { recursive: true });
  const run = async (...args: string[]) => {
    const h = io(env);
    // --dir first: after `--` (accounts exec) it would be the command's own argument.
    const code = await main(["--dir", paths.home, ...args], h.cli);
    return { code, ...h };
  };
  return { paths, env, run };
}

describe("skillhook accounts", () => {
  it("adds, logs in, lists with usage, sets defaults, disables, resets and removes accounts", async () => {
    const { paths, run } = setup();
    const empty = await run("accounts");
    expect(empty.code).toBe(0);
    expect(empty.out()).toContain("No accounts yet");

    const added = await run("accounts", "add", "work", "--runner", "claude", "--label", "Acme Max", "--default", "--json");
    expect(added.code).toBe(0);
    expect(added.json()).toMatchObject({ ok: true, account: "work", kind: "login" });
    const workDir = path.join(paths.home, "accounts", "work");
    expect(existsSync(workDir)).toBe(true);
    expect(loadConfig(paths)).toMatchObject({ accounts: { work: { runner: "claude", label: "Acme Max" } }, defaults: { accounts: { claude: "work" } } });
    expect((await run("accounts", "add", "work", "--runner", "claude")).code).toBe(1);
    expect((await run("accounts", "add", "Bad Name", "--runner", "claude")).code).toBe(2);
    expect((await run("accounts", "add", "x", "--runner", "gemini")).code).toBe(2);

    // A fresh directory is not logged in (the fake CLI needs telling): listed as needing a login, with the fix.
    writeFileSync(path.join(workDir, "logged-out"), "");
    const before = await run("accounts", "--json");
    const view = (before.json().accounts as Record<string, unknown>[])[0]!;
    expect(view).toMatchObject({ name: "work", status: "needs_login", ready: false, default_for: ["claude"], attention: [{ level: "fail", code: "not_logged_in", fix: "skillhook accounts login work" }] });
    expect((await run("accounts", "check")).code).toBe(1);

    const login = await run("accounts", "login", "work");
    expect(login.code).toBe(0);
    expect(login.err()).toContain("CLAUDE_CONFIG_DIR=");
    expect(login.out()).toContain("✓ work: logged in as fake@example.com");
    expect(readFileSync(path.join(workDir, "account"), "utf8")).toContain("fake@example.com");

    const usage = await run("accounts", "usage", "--json");
    expect(usage.code).toBe(0);
    const used = (usage.json().accounts as Record<string, unknown>[])[0]!;
    expect(used).toMatchObject({ status: "ready", identity: { email: "fake@example.com", plan: "max" }, usage: { windows: [{ label: "5h", used_percent: 42 }, { label: "weekly", used_percent: 17 }, { label: "weekly (Opus)", used_percent: 5 }] } });
    // Kept: the list shows it without asking again.
    const table = await run("accounts");
    expect(table.out()).toMatch(/work \*\s+claude\s+ready\s+fake@example\.com\s+max\s+5h 42% · weekly 17% · weekly \(Opus\) 5%/);
    expect((await run("accounts", "check")).code).toBe(0);

    // High usage needs attention (a warning: the check fails, the account still runs).
    writeFileSync(path.join(workDir, "usage.json"), JSON.stringify({ subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: { utilization: 91, resets_at: new Date(Date.now() + 3_600_000).toISOString() } } }));
    const high = await run("accounts", "check", "--usage", "--json");
    expect(high.code).toBe(1);
    expect(high.json()).toMatchObject({ ok: false, items: [{ account: "work", level: "warn", code: "usage_high" }] });
    // A full window makes it limited until the reset.
    writeFileSync(path.join(workDir, "usage.json"), JSON.stringify({ subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: new Date(Date.now() + 3_600_000).toISOString() } } }));
    const limited = await run("accounts", "show", "work", "--usage", "--json");
    expect(limited.json()).toMatchObject({ status: "limited", attention: [{ code: "limited" }] });
    expect(new AccountStateStore(paths.jobsDir).get("work").limited_until).toBeDefined();
    expect((await run("accounts", "reset", "work")).code).toBe(0);
    expect(new AccountStateStore(paths.jobsDir).get("work").limited_until).toBeUndefined();

    // A second account in the pool, then out of it for a while.
    expect((await run("accounts", "add", "personal", "--runner", "claude", "--login")).code).toBe(0);
    const dup = await run("accounts", "--json");
    expect((dup.json().accounts as { name: string; attention: { code: string }[] }[]).find((a) => a.name === "personal")?.attention.map((a) => a.code)).toContain("duplicate_login");
    expect((await run("accounts", "default", "work", "personal")).code).toBe(0);
    expect(loadConfig(paths).defaults.accounts?.claude).toEqual(["work", "personal"]);
    expect((await run("accounts", "disable", "personal")).code).toBe(0);
    expect(loadConfig(paths).accounts.personal?.disabled).toBe(true);
    expect((await run("accounts", "enable", "personal")).code).toBe(0);
    expect(loadConfig(paths).accounts.personal?.disabled).toBe(false);

    // A skill naming an account that does not exist is a problem the check reports.
    writeSkill(paths, "typo", "description: Typo.\nskillhook:\n  account: wrok\n  auth:\n    type: none");
    const typo = await run("accounts", "check", "--json");
    expect(typo.json()).toMatchObject({ problems: [{ skill: "typo", message: 'account "wrok" is not defined' }] });

    const removed = await run("accounts", "remove", "personal", "--purge");
    expect(removed.code).toBe(0);
    expect(existsSync(path.join(paths.home, "accounts", "personal"))).toBe(false);
    expect(loadConfig(paths).defaults.accounts?.claude).toBe("work");
    expect(loadConfig(paths).accounts.personal).toBeUndefined();
  });

  it("keeps a setup-token in .env, shares the Codex settings and runs commands as an account", async () => {
    const { paths, env, run } = setup();
    const token = await run("accounts", "add", "ci", "--runner", "claude", "--token", "--login");
    expect(token.err() + token.out()).toContain("Kept the token in SKILLHOOK_ACCOUNT_CI_TOKEN");
    expect(token.code).toBe(0);
    expect(readEnvFile(paths.envFile).SKILLHOOK_ACCOUNT_CI_TOKEN).toMatch(/^sk-ant-oat01-x+$/);
    expect(loadConfig(paths).accounts.ci).toMatchObject({ kind: "token" });
    const ci = (await run("accounts", "show", "ci", "--json")).json();
    expect(ci).toMatchObject({ status: "ready", kind: "token", secret_env: "SKILLHOOK_ACCOUNT_CI_TOKEN" });

    // Codex accounts link the machine's Codex settings except auth.json.
    const codexHome = path.join(env.HOME, ".codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(path.join(codexHome, "config.toml"), "");
    writeFileSync(path.join(codexHome, "auth.json"), "{}");
    const pro = await run("accounts", "add", "pro", "--runner", "codex", "--share", codexHome, "--json");
    expect(pro.json()).toMatchObject({ ok: true, linked: expect.arrayContaining(["config.toml", "sessions"]) });
    expect(existsSync(path.join(paths.home, "accounts", "pro", "auth.json"))).toBe(false);
    expect((await run("accounts", "login", "pro", "--device-auth")).code).toBe(0);
    expect((await run("accounts", "show", "pro", "--usage", "--json")).json()).toMatchObject({ status: "ready", identity: { email: "codex@example.com", plan: "pro" }, usage: { windows: [{ label: "weekly", used_percent: 48 }] } });

    // `exec` runs any command with the account's environment.
    const seen = path.join(paths.home, "exec.txt");
    const exec = await run("accounts", "exec", "pro", "--", process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], String(process.env.CODEX_HOME))", seen);
    expect(exec.code).toBe(0);
    expect(readFileSync(seen, "utf8")).toBe(path.join(paths.home, "accounts", "pro"));

    expect((await run("accounts", "logout", "pro")).code).toBe(0);
    expect((await run("accounts", "show", "pro", "--json")).json()).toMatchObject({ status: "needs_login" });
    expect(findSetupToken("Your token:\n\n  sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF  \n")).toBe("sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF");
    expect(findSetupToken("no token here")).toBeUndefined();
  });

  it("shows each account's MCP servers, connectors and plugins, and what needs authenticating", async () => {
    const { paths, run } = setup();
    expect((await run("accounts", "add", "work", "--runner", "claude", "--login")).code).toBe(0);
    expect((await run("accounts", "add", "pro", "--runner", "codex", "--no-share", "--login")).code).toBe(0);
    // Without --mcp nothing is asked.
    expect((await run("accounts", "show", "work", "--json")).json().mcp).toBeUndefined();

    const shown = await run("accounts", "show", "work", "--mcp");
    expect(shown.code).toBe(0);
    expect(shown.out()).toContain("MCP servers: 3/5 connected");
    expect(shown.out()).toMatch(/sentry\s+needs auth\s+user/);
    expect(shown.out()).toMatch(/slack\s+failed\s+user\s+Connection closed/);
    expect(shown.out()).toMatch(/claude\.ai Gmail\s+connected\s+connector\s+5/);
    expect(shown.out()).toContain("plugins    supabase@claude-plugins-official@0.1.15 (+1 disabled)");
    expect(shown.out()).toContain("→ skillhook accounts exec work -- claude   then /mcp and authenticate sentry");
    expect(shown.out()).not.toContain("SECRET-");

    const json = (await run("accounts", "show", "pro", "--mcp", "--json")).json();
    expect(json).toMatchObject({ mcp: { via: "status", servers: expect.arrayContaining([expect.objectContaining({ name: "linear", state: "needs_auth" }), expect.objectContaining({ name: "codex_apps", source: "connector" })]) }, attention: expect.arrayContaining([expect.objectContaining({ code: "mcp_needs_auth", fix: "skillhook accounts exec pro -- codex mcp login linear" })]) });

    // An account with fewer servers than the machine's own login is told which (information, not a failure).
    const workDir = path.join(paths.home, "accounts", "work");
    writeFileSync(path.join(workDir, "mcp-status.json"), JSON.stringify({ mcpServers: [{ name: "stitch", status: "connected", config: { type: "http", url: "https://stitch.example/mcp" }, scope: "user", source: "user", tools: [] }] }));
    const listed = await run("accounts", "--mcp");
    expect(listed.out()).toMatch(/work\s+claude\s+ready.*1\/1/);
    expect(listed.out()).toMatch(/pro\s+codex\s+ready.*3\/4 \(1 need auth\)/);
    const work = ((await run("accounts", "--mcp", "--json")).json().accounts as { name: string; attention: { code: string; message: string }[] }[]).find((a) => a.name === "work")!;
    expect(work.attention.filter((a) => a.code.startsWith("mcp_"))).toEqual([expect.objectContaining({ code: "mcp_missing", message: "lacks MCP servers the machine's own claude login has: sentry, slack, plugin:supabase:supabase" })]);
    const check = await run("accounts", "check", "--mcp", "--json");
    expect(check.json()).toMatchObject({ ok: false, items: [{ account: "pro", code: "mcp_needs_auth" }] });
    expect(check.code).toBe(1);
  });

  it("discovers the logins already on the machine and registers them", async () => {
    const { paths, env, run } = setup();
    mkdirSync(path.join(env.HOME, ".claude"), { recursive: true });
    const acme = path.join(env.HOME, ".claude-acme");
    mkdirSync(acme, { recursive: true });
    writeFileSync(path.join(acme, ".claude.json"), "{}");
    writeFileSync(path.join(acme, "account"), "acme@example.com\n");
    const found = await run("accounts", "discover", "--json");
    expect(found.json()).toMatchObject({ found: [{ name: "claude", dir: path.join(env.HOME, ".claude") }, { name: "claude-acme", dir: acme, email: "acme@example.com", logged_in: true }] });
    expect((await run("accounts", "discover", "--add")).code).toBe(0);
    expect(Object.keys(loadConfig(paths).accounts).sort()).toEqual(["claude", "claude-acme"]);
    const again = await run("accounts", "discover", "--json");
    expect((again.json().found as { registered?: string }[]).every((f) => f.registered)).toBe(true);
  });
});
