import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { Events } from "./events.js";
import { silentLogger } from "./logger.js";
import { checkReadiness, ReadinessCache, RUNNER_NAMES } from "./readiness.js";
import { mergedPath } from "./runners/env.js";
import { FAKE_CLAUDE, FAKE_CODEX, tempHome, writeConfigFile } from "./test-support/helpers.js";

const ENV = { PATH: mergedPath(process.env.PATH), HOME: process.env.HOME ?? "/" };

function configured() {
  const paths = tempHome("skillhook-readiness-");
  writeConfigFile(paths, { runners: { claude: { command: FAKE_CLAUDE }, codex: { command: FAKE_CODEX } } });
  return { paths, config: loadConfig(paths) };
}

describe("checkReadiness", () => {
  it("says whether each runner is installed and logged in, or has an API key", async () => {
    const { paths, config } = configured();
    expect(await checkReadiness("claude", config, ENV)).toMatchObject({ runner: "claude", found: true, path: process.execPath, version: "2.1.270", authenticated: true, method: "subscription", detail: "logged in (claude.ai)", ready: true });
    expect(await checkReadiness("codex", config, ENV)).toMatchObject({ runner: "codex", found: true, version: "0.153.4", authenticated: true, method: "subscription", detail: "Logged in using ChatGPT", ready: true });
    expect(await checkReadiness("shell", config, ENV)).toMatchObject({ runner: "shell", found: true, authenticated: null, ready: true });
    // Logged out, as the job environment would see it.
    const claudeDir = path.join(paths.home, "claude");
    const codexDir = path.join(paths.home, "codex");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(path.join(claudeDir, "logged-out"), "");
    writeFileSync(path.join(codexDir, "logged-out"), "");
    const out = { ...ENV, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir };
    expect(await checkReadiness("claude", config, out)).toMatchObject({ found: true, authenticated: false, detail: "not logged in", ready: false, hint: expect.stringContaining("claude login") });
    expect(await checkReadiness("codex", config, out)).toMatchObject({ found: true, authenticated: false, detail: "Not logged in", ready: false, hint: expect.stringContaining("codex login") });
    expect(await checkReadiness("claude", config, { ...out, ANTHROPIC_API_KEY: "sk-test" })).toMatchObject({ authenticated: true, method: "api_key", detail: "ANTHROPIC_API_KEY set", ready: true });
    expect(await checkReadiness("codex", config, { ...out, OPENAI_API_KEY: "sk-test" })).toMatchObject({ authenticated: true, method: "api_key", ready: true });
    // Not installed.
    writeConfigFile(paths, { runners: { claude: { command: "definitely-not-a-binary-xyz" }, codex: { command: "/nonexistent/codex" } } });
    const missing = loadConfig(paths);
    expect(await checkReadiness("claude", missing, ENV)).toMatchObject({ found: false, authenticated: false, ready: false, detail: "definitely-not-a-binary-xyz not found on PATH", hint: expect.stringContaining("install Claude Code") });
    expect(await checkReadiness("codex", missing, ENV)).toMatchObject({ found: false, ready: false });
    expect(RUNNER_NAMES).toEqual(["claude", "codex", "shell"]);
  });
});

describe("ReadinessCache", () => {
  it("caches per runner, shares concurrent checks, forgets on demand and reports changes", async () => {
    const { paths, config } = configured();
    const events = new Events(silentLogger);
    const seen: { runner: string; ready: boolean; previous?: boolean }[] = [];
    events.on("runners.changed", (event) => seen.push({ runner: event.data.runner, ready: event.data.readiness.ready, previous: event.data.previous?.ready }));
    let env: Record<string, string> = ENV;
    let ttl = 60_000;
    const cache = new ReadinessCache({ config: () => config, env: () => env, ttlMs: () => ttl, events });
    expect(cache.last("claude")).toBeUndefined();
    const [a, b] = await Promise.all([cache.get("claude"), cache.get("claude")]);
    expect(a).toBe(b);
    expect(a.ready).toBe(true);
    expect(await cache.get("claude")).toBe(a);
    expect(cache.last("claude")).toBe(a);
    expect(seen).toEqual([{ runner: "claude", ready: true, previous: undefined }]);
    const all = await cache.all();
    expect(all.map((r) => [r.runner, r.ready])).toEqual([
      ["claude", true],
      ["codex", true],
      ["shell", true],
    ]);
    expect(seen).toHaveLength(3);
    // Claude logs out: nothing changes until the cache is refreshed or forgets.
    const claudeDir = path.join(paths.home, "claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(path.join(claudeDir, "logged-out"), "");
    env = { ...ENV, CLAUDE_CONFIG_DIR: claudeDir };
    expect((await cache.get("claude")).ready).toBe(true);
    cache.invalidate("claude");
    expect(cache.last("claude")?.ready).toBe(true); // still known, no longer trusted
    const out = await cache.get("claude");
    expect(out.ready).toBe(false);
    expect(seen.at(-1)).toEqual({ runner: "claude", ready: false, previous: true });
    // Same answer again: no event; a refresh after the TTL elapsed re-probes.
    await cache.get("claude", { refresh: true });
    expect(seen).toHaveLength(4);
    ttl = 0;
    expect((await cache.get("codex")).ready).toBe(true);
    expect(seen).toHaveLength(4);
  });
});
