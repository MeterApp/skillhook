import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatDoctor, runDoctor } from "./doctor.js";
import { Events } from "./events.js";
import { diffHealth, formatHealth, formatUptime, HealthCache, runHealth, type HealthReport } from "./health.js";
import { JobStore } from "./jobs.js";
import { silentLogger } from "./logger.js";
import type { Paths } from "./paths.js";
import { FAKE_CLAUDE, FAKE_CODEX, tempHome, writeConfigFile, writeEnv, writeSkill } from "./test-support/helpers.js";
import type { WebhookEvent } from "./payload.js";

const NO_NET = { SKILLHOOK_NO_UPDATE_CHECK: "1" };
const OFFLINE = { env: NO_NET, network: false, exposure: false, service: false } as const;

function home(): Paths {
  const paths = tempHome("skillhook-health-");
  writeConfigFile(paths, { runners: { claude: { command: FAKE_CLAUDE }, codex: { command: FAKE_CODEX } } });
  writeEnv(paths, { SKILLHOOK_ADMIN_TOKEN: "t", SKILLHOOK_SECRET_BETA: "b", SKILLHOOK_SECRET_ALPHA: "a", SKILLHOOK_SECRET_CODY: "c", SKILLHOOK_SECRET_SHELLY: "s" });
  writeSkill(paths, "beta", "description: b");
  writeSkill(paths, "alpha", "description: a\nskillhook:\n  env: [MISSING_VAR]");
  writeSkill(paths, "cody", "description: c\nskillhook:\n  runner: codex");
  writeSkill(paths, "shelly", "description: s\nskillhook:\n  runner: shell\n  shell:\n    command: [\"definitely-not-a-binary-xyz\", \"x\"]");
  return paths;
}

function byName(report: HealthReport, name: string) {
  return report.checks.find((c) => c.name === name);
}

describe("runHealth", () => {
  it("groups every check and probes the CLIs, their MCP servers, plugins and doctors when deep", async () => {
    const paths = home();
    const store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 60 });
    const event: WebhookEvent = { id: "", skill: "beta", trigger: "webhook", received_at: new Date().toISOString(), method: "POST", path: "/hooks/beta", query: {}, headers: {}, source_ip: "1.1.1.1", content_type: "application/json", content_length: 2, body_kind: "json", payload: {} };
    const job = store.create({ skill: "beta", trigger: "webhook", runner: "claude", source: { ip: "", method: "POST", path: "", content_type: null }, event });
    store.update(job.id, { status: "succeeded", outcome: "completed", finished_at: "2026-09-28T12:00:00.000Z" });

    const report = await runHealth(paths, { ...OFFLINE, deep: true });
    expect(report).toMatchObject({ deep: true, network: false, ok: false });
    expect(Object.keys(report.groups)).toEqual(["system", "skillhook", "runners", "tools", "skills", "exposure"]);
    expect(byName(report, "node")).toMatchObject({ group: "system", status: "ok", data: { platform: process.platform } });
    expect(["ok", "warn"]).toContain(byName(report, "disk")?.status);
    expect(byName(report, "version")).toMatchObject({ group: "skillhook", status: "skip" });
    expect(byName(report, "secrets")).toMatchObject({ status: "ok" });
    expect(byName(report, "admin token")).toMatchObject({ status: "ok" });
    expect(byName(report, "skills")).toMatchObject({ group: "skills", status: "ok", data: { skills: ["alpha", "beta", "cody", "shelly"] } });
    expect(byName(report, "skill alpha")).toMatchObject({ status: "warn", detail: expect.stringContaining("missing env: MISSING_VAR"), hint: "run: skillhook secret set MISSING_VAR", data: { missing_env: ["MISSING_VAR"] } });
    expect(byName(report, "skill beta")).toMatchObject({ status: "ok", detail: expect.stringContaining(`last run succeeded (completed) 2026-09-28T12:00:00.000Z`), data: { last_job: { id: job.id, status: "succeeded", outcome: "completed" } } });
    expect(byName(report, "skill cody")?.detail).toContain("no runs yet");
    expect(byName(report, "skill shelly")).toMatchObject({ status: "fail", detail: expect.stringContaining("definitely-not-a-binary-xyz not found on PATH") });
    expect(byName(report, "claude")).toMatchObject({ group: "runners", status: "ok", detail: "2.1.270, logged in (claude.ai)", data: { version: "2.1.270", logged_in: true } });
    expect(byName(report, "codex")).toMatchObject({ group: "runners", status: "ok", detail: "0.153.4, Logged in using ChatGPT" });
    expect(byName(report, "claude mcp stitch")).toMatchObject({ group: "tools", status: "ok", detail: "https://stitch.example/mcp (HTTP): connected" });
    expect(byName(report, "claude mcp sentry")).toMatchObject({ status: "warn", hint: expect.stringContaining("/mcp") });
    expect(byName(report, "claude mcp slack")).toMatchObject({ status: "fail", detail: "npx mcp-remote https://slack.example/mcp: CONNECTION_CLOSED: Connection closed", hint: "run: claude mcp get slack   (and check the command or URL)" });
    expect(byName(report, "claude mcp config")).toMatchObject({ status: "warn", detail: expect.stringContaining("CROWDIN_API_TOKEN") });
    expect(byName(report, "claude plugins")).toMatchObject({ status: "ok", detail: "2 plugin(s): supabase@claude-plugins-official@0.1.15, car-image@meterapp@1.0.0 (disabled)", data: { disabled: ["car-image@meterapp"] } });
    expect(byName(report, "codex mcp analytics-mcp")).toMatchObject({ status: "ok", detail: expect.stringContaining("configured (auth unsupported)") });
    expect(byName(report, "codex mcp codex_app")).toMatchObject({ status: "skip", detail: expect.stringContaining("disabled in config") });
    expect(byName(report, "codex mcp linear")).toMatchObject({ status: "warn", hint: "run: codex mcp login linear" });
    expect(byName(report, "codex doctor")).toMatchObject({ status: "warn", detail: "warning: mcp.servers: 1 MCP server needs login", hint: "run `codex mcp login linear`" });
    expect(byName(report, "server")).toMatchObject({ group: "skillhook", status: "warn", detail: expect.stringContaining("not running") });
    expect(report.checks.some((c) => c.group === "exposure")).toBe(false);
    expect(byName(report, "service")).toBeUndefined();
    expect(report.groups.tools).toEqual({ ok: 4, warn: 4, fail: 1, skip: 1 });
    expect(report.summary.fail).toBe(2);
    const text = formatHealth(report);
    expect(text).toContain("tools\n");
    expect(text).toContain("✗ claude mcp slack");
    expect(text).toContain("→ run: codex mcp login linear");
    expect(text).toMatch(/\d+ ok, \d+ warnings, 2 failures, \d+ skipped \(deep, [\d.]+s\)/);
  });

  it("stays quick without deep, reads the login state from the CLIs' config directories and describes a live server", async () => {
    const paths = home();
    const quick = await runHealth(paths, { ...OFFLINE, deep: false, live: () => ({ started_at: new Date(Date.now() - 3_600_000).toISOString(), queue: { running: 1, queued: 2 } }) });
    expect(quick.deep).toBe(false);
    expect(quick.checks.some((c) => c.group === "tools")).toBe(false);
    expect(byName(quick, "skill beta")?.detail).not.toContain("last run");
    expect(byName(quick, "claude")).toMatchObject({ status: "ok", detail: "2.1.270, logged in (claude.ai)" });
    expect(byName(quick, "server")).toMatchObject({ status: "ok", detail: expect.stringContaining("this server"), data: { queue: { running: 1, queued: 2 } } });
    expect(byName(quick, "server")?.detail).toContain("up 1h 0m");
    // Logged-out CLIs, seen through the same environment the jobs get (CLAUDE_CONFIG_DIR / CODEX_HOME from .env).
    const claudeDir = path.join(paths.home, "claude-config");
    const codexDir = path.join(paths.home, "codex-home");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(path.join(claudeDir, "logged-out"), "");
    writeFileSync(path.join(codexDir, "logged-out"), "");
    writeEnv(paths, { SKILLHOOK_ADMIN_TOKEN: "t", SKILLHOOK_SECRET_BETA: "b", SKILLHOOK_SECRET_ALPHA: "a", SKILLHOOK_SECRET_CODY: "c", SKILLHOOK_SECRET_SHELLY: "s", CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir });
    const out = await runHealth(paths, { ...OFFLINE, deep: false });
    expect(byName(out, "claude")).toMatchObject({ status: "fail", detail: "2.1.270, not logged in", hint: expect.stringContaining("claude login") });
    expect(byName(out, "codex")).toMatchObject({ status: "fail", detail: "0.153.4, Not logged in" });
    // An API key in .env is enough.
    writeEnv(paths, { SKILLHOOK_ADMIN_TOKEN: "t", SKILLHOOK_SECRET_BETA: "b", SKILLHOOK_SECRET_ALPHA: "a", SKILLHOOK_SECRET_CODY: "c", SKILLHOOK_SECRET_SHELLY: "s", CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir, ANTHROPIC_API_KEY: "sk-test", OPENAI_API_KEY: "sk-test" });
    const keyed = await runHealth(paths, { ...OFFLINE, deep: false });
    expect(byName(keyed, "claude")).toMatchObject({ status: "ok", detail: "2.1.270, ANTHROPIC_API_KEY set", data: { api_key: true, logged_in: false } });
    expect(byName(keyed, "codex")).toMatchObject({ status: "ok", detail: "0.153.4, OPENAI_API_KEY set" });
    // doctor is the quick flavour, printed flat.
    const doctor = await runDoctor(paths, { env: NO_NET });
    expect(doctor.deep).toBe(false);
    expect(doctor.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["node", "config", "version", "secrets", "admin token", "skills", "projects", "skill beta", "claude", "codex", "server"]));
    expect(formatDoctor(doctor)).toMatch(/\d+ ok, \d+ warnings, \d+ failures$/m);
    expect(formatUptime(59)).toBe("0m 59s");
    expect(formatUptime(3725)).toBe("1h 2m");
    expect(formatUptime(90_000)).toBe("1d 1h");
  });

  it("reports a missing home and a broken config without probing anything", async () => {
    const paths = tempHome("skillhook-health-");
    const missing = await runHealth(path.join(paths.home, "nope") === paths.home ? paths : { ...paths, home: path.join(paths.home, "nope"), configFile: path.join(paths.home, "nope", "skillhook.json"), envFile: path.join(paths.home, "nope", ".env"), skillsDir: path.join(paths.home, "nope", "skills"), jobsDir: path.join(paths.home, "nope", "jobs") }, { ...OFFLINE, deep: true });
    expect(byName(missing, "home")).toMatchObject({ status: "fail", hint: "run: skillhook init" });
    expect(missing.checks.some((c) => c.group === "runners" || c.group === "tools")).toBe(false);
    writeFileSync(paths.configFile, "{ not json");
    const broken = await runHealth(paths, { ...OFFLINE, deep: true });
    expect(byName(broken, "config")?.status).toBe("fail");
    expect(broken.ok).toBe(false);
  });
});

describe("HealthCache", () => {
  it("reuses a report within the TTL, shares one run between concurrent callers and emits health.changed on changes", async () => {
    const paths = home();
    const events = new Events(silentLogger);
    const seen: { report: HealthReport; changed: { name: string; from: string | null; to: string }[] }[] = [];
    events.on("health.changed", (event) => seen.push(event.data));
    let ttl = 60_000;
    const cache = new HealthCache(paths, { ttlMs: () => ttl, options: () => ({ ...OFFLINE }), events });
    expect(cache.last()).toBeUndefined();
    const [a, b] = await Promise.all([cache.get({ deep: false }), cache.get({ deep: false })]);
    expect(a.report).toBe(b.report);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.changed.find((c) => c.name === "claude")).toEqual({ name: "claude", from: null, to: "ok" });
    const c = await cache.get({ deep: false });
    expect(c).toEqual({ report: a.report, cached: true });
    expect(cache.last()).toBe(a.report);
    // The same checks again: no event.
    const d = await cache.get({ deep: false, refresh: true });
    expect(d.cached).toBe(false);
    expect(d.report).not.toBe(a.report);
    expect(seen).toHaveLength(1);
    // A different flavour is its own entry.
    const deep = await cache.get({ deep: true });
    expect(deep.report.deep).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.changed.some((c) => c.name === "claude mcp stitch")).toBe(true);
    // Something changes (Claude logs out): the next refresh says which checks moved.
    const claudeDir = path.join(paths.home, "claude-config");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(path.join(claudeDir, "logged-out"), "");
    writeEnv(paths, { SKILLHOOK_ADMIN_TOKEN: "t", SKILLHOOK_SECRET_BETA: "b", SKILLHOOK_SECRET_ALPHA: "a", SKILLHOOK_SECRET_CODY: "c", SKILLHOOK_SECRET_SHELLY: "s", CLAUDE_CONFIG_DIR: claudeDir });
    ttl = 0;
    const e = await cache.get({ deep: false });
    expect(e.cached).toBe(false);
    expect(seen).toHaveLength(3);
    expect(seen[2]?.changed).toEqual([{ name: "claude", from: "ok", to: "fail" }]);
    expect(diffHealth(a.report, e.report)).toEqual([{ name: "claude", from: "ok", to: "fail" }]);
  });
});
