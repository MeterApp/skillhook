import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { limitFromUsage, parseClaudeAccount, parseClaudeStatus, parseClaudeUsage, parseCodexAccount, parseCodexRateLimits, probeClaudeAccount, probeCodexAccount } from "./account-probe.js";
import { mergedPath } from "./runners/env.js";
import { FAKE_CLAUDE, FAKE_CODEX, tempHome } from "./test-support/helpers.js";

// Captured from Claude Code 2.1.305 and codex-cli 0.163.0 (emails and ids replaced).
const CLAUDE_USAGE_LOGGED_OUT = { session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 282, total_lines_added: 0, total_lines_removed: 0, model_usage: {} }, subscription_type: null, rate_limits_available: false, rate_limits: null, behaviors: null };
const CLAUDE_STATUS_EXPIRED = { sections: [{ title: "Session", rows: [{ label: "Version", value: "2.1.305" }, { label: "Login", value: "Expired — log in again" }, { label: "Organization", value: "me@example.com's Organization" }, { label: "Email", value: "me@example.com" }, { label: "Anthropic base URL", value: "https://api.anthropic.com" }] }] };
const CODEX_ACCOUNT = { account: { type: "chatgpt", email: "me@example.com", planType: "pro" }, requiresOpenaiAuth: true, workspaceRouting: { chatgptAccountId: "acct", backendOrigin: "https://chatgpt.com", accountRoutingOverride: "NO_CONSTRAINT" } };
const CODEX_SNAPSHOT = { limitId: "codex", limitName: null, normalModelSlug: null, primary: { usedPercent: 48, windowDurationMins: 10080, resetsAt: 1793293771 }, secondary: null, credits: { hasCredits: false, unlimited: false, balance: "0" }, individualLimit: null, spendControlReached: false, planType: "pro", rateLimitReachedType: null };
const CODEX_LIMITS = { ordinaryUsageAllowed: true, rateLimits: CODEX_SNAPSHOT, rateLimitsByLimitId: { codex: CODEX_SNAPSHOT }, rateLimitResetCredits: { availableCount: 0, credits: [] }, accountId: "acct", rateLimitUpsell: null };

describe("account probe parsers", () => {
  it("reads Claude Code's initialize account the way t3code does", () => {
    expect(parseClaudeAccount({ tokenSource: "none", apiProvider: "firstParty" })).toEqual({ loggedIn: false, identity: {} });
    expect(parseClaudeAccount({ email: "me@example.com", subscriptionType: "claude_max_20x_subscription", tokenSource: "claude.ai", apiProvider: "firstParty" })).toEqual({ loggedIn: true, method: "subscription", identity: { email: "me@example.com", plan: "max_20x" } });
    expect(parseClaudeAccount({ tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" })).toMatchObject({ loggedIn: true, method: "api_key" });
    expect(parseClaudeAccount({ tokenSource: "none", apiProvider: "bedrock" })).toMatchObject({ loggedIn: true, method: "other" });
    expect(parseClaudeAccount(undefined)).toEqual({ loggedIn: false, identity: {} });
  });

  it("reads get_usage windows, per-model windows and spend", () => {
    expect(parseClaudeUsage(CLAUDE_USAGE_LOGGED_OUT)).toEqual({});
    const parsed = parseClaudeUsage({ subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: { utilization: 42.5, resets_at: "2026-10-23T14:00:00Z" }, seven_day: { utilization: 100, resets_at: "2026-10-27T00:00:00Z" }, model_scoped: [{ display_name: "Opus", utilization: 12, resets_at: "2026-10-27T00:00:00Z" }], spend: { enabled: true, used: { amount_minor: 1250, currency: "USD", exponent: 2 }, limit: { amount_minor: 5000, currency: "USD", exponent: 2 } } } });
    expect(parsed.plan).toBe("max");
    expect(parsed.usage?.windows).toEqual([
      { id: "five_hour", label: "5h", used_percent: 42.5, resets_at: "2026-10-23T14:00:00Z", window_minutes: 300 },
      { id: "seven_day", label: "weekly", used_percent: 100, resets_at: "2026-10-27T00:00:00Z", window_minutes: 10080 },
      { id: "seven_day_opus", label: "weekly (Opus)", used_percent: 12, resets_at: "2026-10-27T00:00:00Z", window_minutes: 10080 },
    ]);
    expect(parsed.usage?.credits).toEqual({ enabled: true, used: 12.5, limit: 50, currency: "USD" });
    expect(limitFromUsage(parsed.usage)).toEqual({ until: "2026-10-27T00:00:00Z", reason: "weekly usage limit reached" });
    expect(limitFromUsage({ windows: [{ id: "x", label: "5h", used_percent: 99 }] })).toBeUndefined();
  });

  it("tells an expired login from get_status", () => {
    expect(parseClaudeStatus(CLAUDE_STATUS_EXPIRED)).toEqual({ expired: true, email: "me@example.com", org: "me@example.com's Organization" });
    expect(parseClaudeStatus({ sections: [{ rows: [{ label: "Login", value: "Claude Max account" }] }] })).toEqual({ expired: false });
    expect(parseClaudeStatus(null)).toEqual({ expired: false });
  });

  it("reads Codex's account/read and account/rateLimits/read", () => {
    expect(parseCodexAccount(CODEX_ACCOUNT)).toEqual({ loggedIn: true, method: "subscription", identity: { email: "me@example.com", plan: "pro" } });
    expect(parseCodexAccount({ account: null, requiresOpenaiAuth: true })).toEqual({ loggedIn: false, identity: {} });
    expect(parseCodexAccount({ account: { type: "apiKey" }, requiresOpenaiAuth: true })).toMatchObject({ loggedIn: true, method: "api_key" });
    const parsed = parseCodexRateLimits(CODEX_LIMITS);
    expect(parsed.usage).toEqual({ windows: [{ id: "seven_day", label: "weekly", used_percent: 48, resets_at: new Date(1793293771 * 1000).toISOString(), window_minutes: 10080 }], plan: "pro", credits: { enabled: false, unlimited: false, balance: 0 } });
    expect(parsed.reached).toBeUndefined();
    const reached = parseCodexRateLimits({ ...CODEX_LIMITS, rateLimitsByLimitId: { codex: { ...CODEX_SNAPSHOT, primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1793293771 }, rateLimitReachedType: "rate_limit_reached" } } });
    expect(reached.reached).toBe("rate_limit_reached");
    expect(reached.usage?.windows[0]).toMatchObject({ id: "five_hour", label: "5h", used_percent: 100 });
    expect(parseCodexRateLimits(null)).toEqual({});
  });
});

describe("account probes against the CLIs", () => {
  const ENV = { PATH: mergedPath(process.env.PATH), HOME: process.env.HOME ?? "/" };

  it("asks Claude Code who is logged in and how much is used, without a prompt, hooks or MCP servers", async () => {
    const paths = tempHome("skillhook-probe-");
    const dir = path.join(paths.home, "claude-a");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "account"), "a@example.com\n");
    const record = path.join(paths.home, "record.json");
    const report = await probeClaudeAccount({ command: FAKE_CLAUDE, env: { ...ENV, CLAUDE_CONFIG_DIR: dir, FAKE_CLAUDE_RECORD: record } });
    expect(report).toMatchObject({ ok: true, loggedIn: true, method: "subscription", identity: { email: "a@example.com", plan: "max" }, usage: { windows: [{ id: "five_hour", used_percent: 42 }, { id: "seven_day", used_percent: 17 }, { id: "seven_day_opus", used_percent: 5 }] } });
    expect(report.limited).toBeUndefined();
    const { readFileSync } = await import("node:fs");
    const args = (JSON.parse(readFileSync(record, "utf8")) as { args: string[] }).args;
    expect(args).toEqual(expect.arrayContaining(["--no-session-persistence", "--strict-mcp-config", "--settings", '{"disableAllHooks":true}']));
    writeFileSync(path.join(dir, "expired"), "");
    expect(await probeClaudeAccount({ command: FAKE_CLAUDE, env: { ...ENV, CLAUDE_CONFIG_DIR: dir } })).toMatchObject({ ok: true, loggedIn: false, expired: true, identity: { email: "a@example.com" } });
    expect(await probeClaudeAccount({ command: "definitely-not-claude-xyz", env: ENV })).toMatchObject({ ok: false, error: "definitely-not-claude-xyz not found on PATH" });
  });

  it("asks codex app-server for the account and its rate limits", async () => {
    const paths = tempHome("skillhook-probe-");
    const home = path.join(paths.home, "codex-a");
    mkdirSync(home);
    writeFileSync(path.join(home, "auth.json"), JSON.stringify({ email: "c@example.com" }));
    expect(await probeCodexAccount({ command: FAKE_CODEX, env: { ...ENV, CODEX_HOME: home } })).toMatchObject({ ok: true, loggedIn: true, identity: { email: "c@example.com", plan: "pro" }, usage: { windows: [{ id: "seven_day", used_percent: 48 }] } });
    writeFileSync(path.join(home, "logged-out"), "");
    const out = await probeCodexAccount({ command: FAKE_CODEX, env: { ...ENV, CODEX_HOME: home } });
    expect(out).toMatchObject({ ok: true, loggedIn: false });
    expect(out.usage).toBeUndefined();
  });
});
