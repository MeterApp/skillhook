import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountStateStore, defaultAccountSecretEnv, getAccount, isLimited, orderPool, parseLimitReset, poolFor, prepareAccountDir, resolveAccount, runnerOfAccounts, stateAfterRun, usageFromRun, withAccountEnv } from "./accounts.js";
import { AccountWatch } from "./account-watch.js";
import { ConfigSchema, loadConfig as load } from "./config.js";
import { Events } from "./events.js";
import { JobStore } from "./jobs.js";
import { silentLogger } from "./logger.js";
import { createManualJob } from "./manual.js";
import { JobQueue } from "./queue.js";
import { ReadinessCache } from "./readiness.js";
import { SkillRegistry } from "./registry.js";
import { resolveRunSettings, prepareRun } from "./run.js";
import { baseRunEnv, buildRunEnv, mergedPath } from "./runners/env.js";
import { loadSkills } from "./skills.js";
import { FAKE_CLAUDE, FAKE_CODEX, tempHome, writeConfigFile, writeEnv, writeSkill } from "./test-support/helpers.js";

const SKILL = { config: {} } as never;

describe("accounts: configuration and environment", () => {
  it("resolves names to directories, secrets and the machine's own login", () => {
    const home = "/tmp/sh-home";
    expect(resolveAccount("work", { runner: "claude", kind: "login", disabled: false }, home)).toMatchObject({ name: "work", runner: "claude", kind: "login", dir: "/tmp/sh-home/accounts/work", defaultDir: false, managed: true });
    expect(resolveAccount("own", { runner: "claude", kind: "login", dir: "~/.claude", disabled: false }, home)).toMatchObject({ dir: path.join(homedir(), ".claude"), defaultDir: true, managed: false });
    expect(resolveAccount("ci", { runner: "claude", kind: "token", disabled: false }, home)).toMatchObject({ kind: "token", secretEnv: "SKILLHOOK_ACCOUNT_CI_TOKEN" });
    expect(defaultAccountSecretEnv("open-ai", "api_key")).toBe("SKILLHOOK_ACCOUNT_OPEN_AI_API_KEY");
    expect(ConfigSchema.safeParse({ accounts: { x: { runner: "codex", kind: "token" } } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ accounts: { "Bad Name": { runner: "claude" } } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ accounts: { a: { runner: "claude" } }, defaults: { accounts: { claude: ["a", "b"] } } }).success).toBe(true);
  });

  it("points a run at the account and removes every other way to authenticate", () => {
    const env = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o", CLAUDE_CONFIG_DIR: "/elsewhere", OPENAI_API_KEY: "sk-oai", CODEX_API_KEY: "c", CODEX_HOME: "/codex-elsewhere" };
    const home = "/tmp/sh-home";
    const login = withAccountEnv(env, resolveAccount("work", { runner: "claude", kind: "login", disabled: false }, home), {});
    expect(login).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/tmp/sh-home/accounts/work", OPENAI_API_KEY: "sk-oai", CODEX_API_KEY: "c", CODEX_HOME: "/codex-elsewhere" });
    // ~/.claude is the default: no variable at all (a non-default CLAUDE_CONFIG_DIR changes Claude Code's keychain entry on macOS).
    const own = withAccountEnv(env, resolveAccount("own", { runner: "claude", kind: "login", dir: "~/.claude", disabled: false }, home), {});
    expect(own.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(own.ANTHROPIC_API_KEY).toBeUndefined();
    const token = withAccountEnv(env, resolveAccount("ci", { runner: "claude", kind: "token", disabled: false }, home), { SKILLHOOK_ACCOUNT_CI_TOKEN: "sk-ant-oat01-abc" });
    expect(token).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc", CLAUDE_CONFIG_DIR: "/tmp/sh-home/accounts/ci" });
    expect(token.ANTHROPIC_API_KEY).toBeUndefined();
    const key = withAccountEnv(env, resolveAccount("api", { runner: "claude", kind: "api_key", secret_env: "ACME_KEY", disabled: false }, home), { ACME_KEY: "sk-acme" });
    expect(key).toMatchObject({ ANTHROPIC_API_KEY: "sk-acme" });
    expect(key.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const codex = withAccountEnv(env, resolveAccount("pro", { runner: "codex", kind: "login", disabled: false }, home), {});
    expect(codex).toMatchObject({ CODEX_HOME: "/tmp/sh-home/accounts/pro", ANTHROPIC_API_KEY: "sk-ant" });
    expect(codex.OPENAI_API_KEY).toBeUndefined();
    expect(codex.CODEX_API_KEY).toBeUndefined();
  });

  it("never forwards an account's token to a run except through the account, even when a skill lists it", () => {
    const skill = { name: "s", dir: "/tmp", config: { env: ["SKILLHOOK_ACCOUNT_CI_TOKEN"] } } as never;
    const secrets = { SKILLHOOK_ACCOUNT_CI_TOKEN: "sk-ant-oat01-secret" };
    const env = buildRunEnv({ secrets, fileSecrets: secrets, skill, config: ConfigSchema.parse({ env_passthrough: ["SKILLHOOK_ACCOUNT_CI_TOKEN"] }), jobVars: {}, processEnv: { PATH: "/bin" } });
    expect(env.SKILLHOOK_ACCOUNT_CI_TOKEN).toBeUndefined();
  });

  it("finds the pool of a run: explicit, the skill's own (for its runner), else the runner's default", () => {
    const config = ConfigSchema.parse({ accounts: { a: { runner: "claude" }, b: { runner: "claude" }, x: { runner: "codex" } }, defaults: { accounts: { claude: ["b"], codex: "x" } } });
    const own = { config: { account: ["a", "b"] } } as never;
    expect(poolFor(own, config, "claude")).toEqual(["a", "b"]);
    expect(poolFor(own, config, "claude", "b")).toEqual(["b"]);
    // A fallback to codex does not inherit the claude accounts.
    expect(poolFor(own, config, "codex")).toEqual(["x"]);
    expect(poolFor(SKILL, config, "claude")).toEqual(["b"]);
    expect(poolFor({ config: { account: "a" } } as never, config, "shell")).toEqual(["a"]);
    expect(poolFor(SKILL, config, "shell")).toEqual([]);
    expect(runnerOfAccounts(config, ["x"])).toBe("codex");
    const skill = { name: "s", dir: "/tmp", config: { account: "x" } } as never;
    expect(resolveRunSettings(skill, config).runner).toBe("codex");
    expect(resolveRunSettings({ name: "s", dir: "/tmp", config: {} } as never, config, { account: "x" }).runner).toBe("codex");
  });

  it("orders a pool: limited accounts last; balanced prefers the most usage left, then the least recently used", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    const states = {
      a: { usage: { fetched_at: "", windows: [{ id: "five_hour", label: "5h", used_percent: 80 }] }, last_used_at: "2026-10-23T11:00:00Z" },
      b: { usage: { fetched_at: "", windows: [{ id: "five_hour", label: "5h", used_percent: 10 }] }, last_used_at: "2026-10-23T11:59:00Z" },
      c: { limited_until: "2026-10-23T14:00:00Z" },
      d: { last_used_at: "2026-10-23T09:00:00Z" },
    };
    expect(orderPool(["c", "a", "b", "d"], states, "ordered", now)).toEqual(["a", "b", "d", "c"]);
    expect(orderPool(["c", "a", "b", "d"], states, "balanced", now)).toEqual(["d", "b", "a", "c"]);
    expect(isLimited(states.c, now)).toBe(true);
    expect(isLimited(states.c, Date.parse("2026-10-23T15:00:00Z"))).toBe(false);
  });

  it("reads when a usage limit ends from what the CLIs print", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    expect(parseLimitReset("Claude AI usage limit reached|1792771200", now)).toBe("2026-10-23T16:00:00.000Z");
    expect(parseLimitReset("You've hit your session limit · resets 6pm (UTC)", now)).toBe("2026-10-23T18:00:00.000Z");
    expect(parseLimitReset("You've hit your session limit · resets 6pm (America/New_York)", now)).toBe("2026-10-23T22:00:00.000Z");
    expect(parseLimitReset("You've hit your usage limit. Your limit will reset at 3pm (UTC).", now)).toBe("2026-10-23T15:00:00.000Z");
    expect(parseLimitReset("Your limit will reset at 9am (UTC).", now)).toBe("2026-10-24T09:00:00.000Z");
    expect(parseLimitReset("You've hit your usage limit. Try again in 2 days 3 hours.", now)).toBe("2026-10-25T15:00:00.000Z");
    expect(parseLimitReset("Rate limit reached. Try again in 20s.", now)).toBe("2026-10-23T12:00:20.000Z");
    expect(parseLimitReset("something else", now)).toBeUndefined();
    expect(parseLimitReset(`${"try again in ".repeat(500)}x`, now)).toBeUndefined();
  });

  it("turns a run's end into the account's state", () => {
    const at = "2026-10-23T12:00:00.000Z";
    expect(stateAfterRun({ jobId: "j1", ok: true, at, cooldownMinutes: 60 })).toEqual({ last_used_at: at, last_job: "j1", last_success_at: at, limited_until: undefined, limited_reason: undefined });
    expect(stateAfterRun({ jobId: "j2", ok: false, failure: { kind: "usage_limit", message: "You've hit your usage limit" }, at, cooldownMinutes: 60 })).toMatchObject({ limited_until: "2026-10-23T13:00:00.000Z", last_failure: { kind: "usage_limit", job: "j2" } });
    // The rejected window's own reset wins over the message and the cooldown.
    expect(stateAfterRun({ jobId: "j3", ok: false, failure: { kind: "usage_limit", message: "resets 6pm (UTC)" }, at, cooldownMinutes: 60, rateLimits: { five_hour: { status: "rejected", resets_at: "2026-10-23T14:30:00.000Z", utilization: 1 } } })).toMatchObject({ limited_until: "2026-10-23T14:30:00.000Z" });
    expect(stateAfterRun({ jobId: "j4", ok: false, failure: { kind: "auth", message: "Failed to authenticate" }, at, cooldownMinutes: 60 })).toMatchObject({ last_failure: { kind: "auth" } });
    expect(stateAfterRun({ jobId: "j5", ok: false, failure: { kind: "crash" }, at, cooldownMinutes: 60 })).toEqual({ last_used_at: at, last_job: "j5" });
    expect(usageFromRun({ usage: { fetched_at: "x", windows: [{ id: "seven_day", label: "weekly", used_percent: 20 }] } }, { five_hour: { utilization: 0.314, resets_at: "2026-10-23T14:00:00Z" } }, at)).toEqual({ usage: { fetched_at: at, windows: [{ id: "seven_day", label: "weekly", used_percent: 20 }, { id: "five_hour", label: "5h", used_percent: 31.4, resets_at: "2026-10-23T14:00:00Z" }] } });
    expect(usageFromRun({}, undefined)).toEqual({});
  });

  it("keeps the state per account in jobs/.accounts.json", () => {
    const paths = tempHome("skillhook-accounts-");
    const store = new AccountStateStore(paths.jobsDir);
    expect(store.get("a")).toEqual({});
    store.update("a", { last_used_at: "t", limited_until: "u" });
    store.update("a", { limited_until: undefined });
    store.update("b", { last_job: "j" });
    expect(store.all()).toEqual({ a: { last_used_at: "t" }, b: { last_job: "j" } });
    store.remove("b");
    expect(Object.keys(store.all())).toEqual(["a"]);
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(() => store.update("__proto__", {})).toThrow();
  });

  it("makes the account's directory and links the shared settings, never the login", () => {
    const paths = tempHome("skillhook-accounts-");
    const shared = path.join(paths.home, "codex-home");
    mkdirSync(path.join(shared, "skills"), { recursive: true });
    writeFileSync(path.join(shared, "config.toml"), 'model = "gpt-5"\n');
    writeFileSync(path.join(shared, "auth.json"), "{}");
    writeFileSync(path.join(shared, "models_cache.json"), "{}");
    const account = resolveAccount("pro", { runner: "codex", kind: "login", share_from: shared, disabled: false }, paths.home);
    const first = prepareAccountDir(account);
    expect(first.created).toBe(true);
    expect(statSync(account.dir).mode & 0o777).toBe(0o700);
    expect(first.linked.sort()).toEqual(["archived_sessions", "config.toml", "sessions", "skills"]);
    expect(readlinkSync(path.join(account.dir, "config.toml"))).toBe(path.join(shared, "config.toml"));
    expect(existsSync(path.join(account.dir, "auth.json"))).toBe(false);
    expect(existsSync(path.join(account.dir, "models_cache.json"))).toBe(false);
    // Idempotent; a file of the account's own is kept; what the shared home gains is linked next time.
    writeFileSync(path.join(shared, "AGENTS.md"), "hi");
    writeFileSync(path.join(shared, "hooks.json"), "{}");
    writeFileSync(path.join(account.dir, "hooks.json"), "{}");
    const second = prepareAccountDir(account);
    expect(second).toMatchObject({ created: false, linked: ["AGENTS.md"], kept: ["hooks.json"] });
    expect(lstatSync(path.join(account.dir, "hooks.json")).isSymbolicLink()).toBe(false);

    const claudeShared = path.join(paths.home, "claude-home");
    mkdirSync(path.join(claudeShared, "agents"), { recursive: true });
    writeFileSync(path.join(claudeShared, "settings.json"), "{}");
    writeFileSync(path.join(claudeShared, ".credentials.json"), "{}");
    writeFileSync(path.join(claudeShared, ".claude.json"), "{}");
    const claude = resolveAccount("work", { runner: "claude", kind: "login", share_from: claudeShared, disabled: false }, paths.home);
    expect(prepareAccountDir(claude).linked.sort()).toEqual(["agents", "settings.json"]);
    expect(existsSync(path.join(claude.dir, ".credentials.json"))).toBe(false);
    // The machine's own login directory is never made or changed.
    expect(prepareAccountDir(resolveAccount("own", { runner: "claude", kind: "login", dir: "~/.claude", disabled: false }, paths.home))).toMatchObject({ created: false, linked: [] });
  });
});

const ENV = { PATH: mergedPath(process.env.PATH), HOME: process.env.HOME ?? "/" };

function setup(accounts: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const paths = tempHome("skillhook-accounts-queue-");
  writeConfigFile(paths, { runners: { claude: { command: FAKE_CLAUDE }, codex: { command: FAKE_CODEX } }, accounts, ...extra });
  const config = load(paths);
  for (const name of Object.keys(accounts)) {
    const account = getAccount(config, paths.home, name)!;
    if (account.kind === "login") prepareAccountDir(account);
  }
  const store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 60 });
  const registry = new SkillRegistry(paths.skillsDir);
  const secrets = () => ({ ...ENV, ...Object.fromEntries(Object.entries(readEnv(paths.envFile))) });
  const readiness = new ReadinessCache({ config: () => config, env: () => baseRunEnv({ secrets: secrets(), processEnv: ENV }), secrets, ttlMs: () => 0 });
  const queue = new JobQueue({ store, config, registry, secrets, fileSecrets: secrets, logger: silentLogger, readiness, processEnv: ENV });
  return { paths, config, store, registry, queue, dir: (name: string) => getAccount(config, paths.home, name)!.dir };
}

function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

describe("accounts: the queue picks, fails over and remembers", () => {
  it("runs as the pool's first usable account, skipping a logged-out one before the run", async () => {
    const { paths, config, store, registry, queue, dir } = setup({ a: { runner: "claude" }, b: { runner: "claude" } });
    writeFileSync(path.join(dir("a"), "logged-out"), "");
    const record = path.join(paths.home, "record.json");
    writeSkill(paths, "pooled", `description: Pooled.\nskillhook:\n  account: [a, b]\n  env: [FAKE_CLAUDE_RECORD]\n  auth:\n    type: none`);
    writeEnv(paths, { FAKE_CLAUDE_RECORD: record, ANTHROPIC_API_KEY: "sk-should-not-reach" });
    const job = createManualJob({ config, store }, { skill: registry.get("pooled")!, payload: {}, trigger: "cli" });
    expect(job.runner).toBe("claude");
    queue.enqueue(job);
    const done = await queue.waitFor(job.id, 20_000);
    expect(done).toMatchObject({ status: "succeeded", account: "b" });
    expect(done?.runner_reason).toContain("a: not logged in");
    expect(done?.attempts).toBeUndefined();
    const recorded = JSON.parse(readFileSync(record, "utf8")) as { env: Record<string, string> };
    expect(recorded.env.CLAUDE_CONFIG_DIR).toBe(dir("b"));
    expect(recorded.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(recorded.env.SKILLHOOK_ACCOUNT).toBe("b");
    expect(done?.resume_command).toContain("skillhook accounts exec b -- claude --resume");
    // What the run taught: used, succeeded, and the 5h window from its rate-limit notice.
    const state = new AccountStateStore(paths.jobsDir).get("b");
    expect(state).toMatchObject({ last_job: job.id, last_success_at: expect.any(String), usage: { windows: [{ id: "five_hour", used_percent: 31 }] } });
    expect(store.list({ account: "b" }).map((j) => j.id)).toEqual([job.id]);
    await queue.shutdown();
  });

  it("fails over to the next account when a run hits a usage limit, and skips the limited one until it resets", async () => {
    const { paths, config, store, registry, queue, dir } = setup({ a: { runner: "claude" }, b: { runner: "claude" } });
    writeFileSync(path.join(dir("a"), "limited"), "");
    writeSkill(paths, "pooled", `description: Pooled.\nskillhook:\n  account: [a, b]\n  auth:\n    type: none`);
    const first = createManualJob({ config, store }, { skill: registry.get("pooled")!, payload: {}, trigger: "cli" });
    queue.enqueue(first);
    const done = await queue.waitFor(first.id, 20_000);
    expect(done).toMatchObject({ status: "succeeded", account: "b", attempts: [{ runner: "claude", account: "a", status: "failed", failure: { kind: "usage_limit" } }] });
    expect(done?.runner_reason).toBe("account a failed (usage_limit); now b");
    const a = new AccountStateStore(paths.jobsDir).get("a");
    expect(isLimited(a)).toBe(true);
    // From the rejected five_hour window: about two hours from now.
    expect(Date.parse(a.limited_until!) - Date.now()).toBeGreaterThan(7_000_000);
    // The next job does not even try a.
    const second = createManualJob({ config, store }, { skill: registry.get("pooled")!, payload: {}, trigger: "cli" });
    queue.enqueue(second);
    const next = await queue.waitFor(second.id, 20_000);
    expect(next).toMatchObject({ status: "succeeded", account: "b" });
    // A limited account sorts last, so b is tried first and nothing was skipped on the way.
    expect(next?.attempts).toBeUndefined();
    expect(next?.runner_reason).toBeUndefined();
    await queue.shutdown();
  });

  it("fails fast with every account's reason when none is usable, as usage_limit when all are limited", async () => {
    const { paths, config, store, registry, queue, dir } = setup({ a: { runner: "claude" }, b: { runner: "claude", disabled: true }, c: { runner: "claude", kind: "token" } });
    writeFileSync(path.join(dir("a"), "expired"), "");
    writeSkill(paths, "pooled", `description: Pooled.\nskillhook:\n  account: [a, b, c, ghost]\n  auth:\n    type: none`);
    const job = createManualJob({ config, store }, { skill: registry.get("pooled")!, payload: {}, trigger: "cli" });
    queue.enqueue(job);
    const done = await queue.waitFor(job.id, 20_000);
    expect(done).toMatchObject({ status: "failed", failure: { kind: "auth" } });
    expect(done?.error).toContain("no usable claude account");
    expect(done?.error).toContain("a: login expired (skillhook accounts login a)");
    expect(done?.error).toContain("b: disabled");
    expect(done?.error).toContain("c: SKILLHOOK_ACCOUNT_C_TOKEN is not set");
    expect(done?.error).toContain("ghost: not defined");
    await queue.shutdown();
  });

  it("runs a token account with its token and a Codex account with its own CODEX_HOME", async () => {
    const { paths, config, store, registry, queue } = setup({ ci: { runner: "claude", kind: "token" }, pro: { runner: "codex" } });
    writeEnv(paths, { SKILLHOOK_ACCOUNT_CI_TOKEN: `sk-ant-oat01-${"y".repeat(60)}`, FAKE_CLAUDE_RECORD: path.join(paths.home, "c.json"), FAKE_CODEX_RECORD: path.join(paths.home, "x.json") });
    writeSkill(paths, "tok", `description: Token.\nskillhook:\n  account: ci\n  env: [FAKE_CLAUDE_RECORD]\n  auth:\n    type: none`);
    writeSkill(paths, "cdx", `description: Codex.\nskillhook:\n  account: pro\n  env: [FAKE_CODEX_RECORD]\n  auth:\n    type: none`);
    const tok = createManualJob({ config, store }, { skill: registry.get("tok")!, payload: {}, trigger: "cli" });
    const cdx = createManualJob({ config, store }, { skill: registry.get("cdx")!, payload: {}, trigger: "cli" });
    expect(cdx.runner).toBe("codex");
    queue.enqueue(tok);
    queue.enqueue(cdx);
    expect(await queue.waitFor(tok.id, 20_000)).toMatchObject({ status: "succeeded", account: "ci" });
    expect(await queue.waitFor(cdx.id, 20_000)).toMatchObject({ status: "succeeded", account: "pro", resume_command: expect.stringContaining("skillhook accounts exec pro -- codex resume") });
    const recorded = JSON.parse(readFileSync(path.join(paths.home, "c.json"), "utf8")) as { env: Record<string, string> };
    expect(recorded.env.CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^sk-ant-oat01-/);
    expect(recorded.env.SKILLHOOK_ACCOUNT_CI_TOKEN).toBeUndefined();
    // The dry run shows the same environment.
    const prepared = prepareRun({ skill: registry.get("cdx")!, config, secrets: {}, store, job: { ...cdx, account: "pro" }, event: store.readEvent(cdx.id), writePrompt: false, processEnv: ENV });
    expect(prepared.invocation.env.CODEX_HOME).toBe(path.join(paths.home, "accounts", "pro"));
    await queue.shutdown();
  });

  it("validates account references in skills", () => {
    const paths = tempHome("skillhook-accounts-");
    writeSkill(paths, "named", "description: Named.\nskillhook:\n  account: [work, home]");
    const loaded = loadSkills(paths.skillsDir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.skills[0]?.config.account).toEqual(["work", "home"]);
    writeSkill(paths, "bad", "description: Bad.\nskillhook:\n  account: Not A Name");
    expect(loadSkills(paths.skillsDir).errors.map((e) => e.name)).toEqual(["bad"]);
  });
});

describe("accounts: what serve does between jobs", () => {
  it("checks every account at start and notifies on the desktop when one stops working (opt-in)", async () => {
    const { paths, config, store, registry, dir } = setup({ a: { runner: "claude" } }, { account_policy: { notify: "desktop" } });
    writeFileSync(path.join(dir("a"), "expired"), "");
    const events = new Events(silentLogger);
    const secrets = () => ({});
    const readiness = new ReadinessCache({ config: () => config, env: () => baseRunEnv({ secrets: {}, processEnv: ENV }), secrets, ttlMs: () => 60_000, events });
    const notes: string[] = [];
    const watch = new AccountWatch({ config, paths, events, logger: silentLogger, readiness, registry, store, secrets, baseEnv: () => baseRunEnv({ secrets: {}, processEnv: ENV }), notify: (_title, body) => notes.push(body), tickMs: 60_000 });
    const changed = new Promise((resolve) => events.on("account.changed", resolve));
    watch.start();
    await changed;
    expect(notes).toEqual(["Account a login expired: skillhook accounts login a"]);
    events.emit("account.updated", { account: "a", reason: "limited", state: {} });
    events.emit("account.updated", { account: "a", reason: "usage", state: {} });
    expect(notes).toHaveLength(2);
    expect(notes[1]).toBe("Account a hit its usage limit");
    watch.stop();
    // Off by default: nothing is shown.
    config.account_policy.notify = "none";
    events.emit("account.updated", { account: "a", reason: "auth_failed", state: {} });
    expect(notes).toHaveLength(2);
  });
});
