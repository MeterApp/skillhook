import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError, ConfigRef, diffConfig, HOT_CONFIG_KEYS, RESTART_CONFIG_KEYS, updateConfig, coerceConfigValue, defaultConfig, loadConfig, setConfigValue } from "./config.js";
import { tempHome, writeConfigFile } from "./test-support/helpers.js";

describe("config", () => {
  it("provides defaults when no file exists", () => {
    const paths = tempHome();
    const config = loadConfig(paths);
    expect(config.port).toBe(8787);
    expect(config.defaults.runner).toBe("claude");
    expect(config.runners.claude.permission_mode).toBe("bypassPermissions");
    expect(config.runners.codex.sandbox).toBe("workspace-write");
    expect(config.jobs.dedupe_in_flight).toBe(true);
    expect(config.deliveries).toEqual({ max: 2000, store_bodies: true, body_max_bytes: 65_536 });
    expect(config.update_check).toBe(true);
    expect(defaultConfig()).toEqual(config);
  });

  it("rejects unknown keys with a readable message", () => {
    const paths = tempHome();
    writeFileSync(paths.configFile, JSON.stringify({ prot: 1 }));
    expect(() => loadConfig(paths)).toThrow(/Invalid .*skillhook.json/s);
  });

  it("sets dotted values without baking in defaults", () => {
    const paths = tempHome();
    setConfigValue(paths, "defaults.model", "opus");
    setConfigValue(paths, "port", 9000);
    expect(JSON.parse(String(require("node:fs").readFileSync(paths.configFile, "utf8")))).toEqual({ defaults: { model: "opus" }, port: 9000 });
    expect(loadConfig(paths).defaults.model).toBe("opus");
    expect(() => setConfigValue(paths, "port", "nope")).toThrow(/invalid config/);
  });

  it("refuses keys that would reach Object.prototype", () => {
    const paths = tempHome();
    for (const key of ["__proto__.polluted", "constructor.prototype.polluted", "defaults.__proto__", "prototype", "defaults..model", ""]) {
      expect(() => setConfigValue(paths, key, true), key).toThrow(/Invalid config key/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(loadConfig(paths)).toEqual(defaultConfig());
  });

  it("coerces CLI values", () => {
    expect(coerceConfigValue("8787")).toBe(8787);
    expect(coerceConfigValue("true")).toBe(true);
    expect(coerceConfigValue('["a"]')).toEqual(["a"]);
    expect(coerceConfigValue("opus")).toBe("opus");
  });
});

describe("live config", () => {
  it("updates several keys in one validated write and refuses $schema and prototype keys", () => {
    const paths = tempHome();
    const { raw, config } = updateConfig(paths, { set: { concurrency: 3, "defaults.model": "sonnet" } });
    expect(raw).toEqual({ concurrency: 3, defaults: { model: "sonnet" } });
    expect(config.concurrency).toBe(3);
    expect(updateConfig(paths, { unset: ["defaults.model"], set: { "rate_limit.requests_per_minute": 7 } }).raw).toEqual({ concurrency: 3, defaults: {}, rate_limit: { requests_per_minute: 7 } });
    expect(() => updateConfig(paths, { set: { concurrency: "lots" } })).toThrow(ConfigError);
    expect(loadConfig(paths).concurrency).toBe(3); // nothing was written
    expect(() => updateConfig(paths, { set: { $schema: "x" } })).toThrow(/\$schema/);
    expect(() => updateConfig(paths, { set: { "__proto__.polluted": true } })).toThrow(/Invalid config key/);
    expect(() => updateConfig(paths, { unset: ["constructor.prototype"] })).toThrow(/Invalid config key/);
    expect(HOT_CONFIG_KEYS).toContain("concurrency");
    expect(HOT_CONFIG_KEYS).not.toContain("port");
    expect(RESTART_CONFIG_KEYS).toEqual(["host", "port"]);
    expect(diffConfig(loadConfig(paths), { ...loadConfig(paths), concurrency: 9, port: 1 })).toEqual(["port", "concurrency"].sort((a, b) => a.localeCompare(b)).length === 2 ? expect.arrayContaining(["concurrency", "port"]) : []);
  });

  it("reloads a live config in place and knows what waits for a restart", () => {
    const paths = tempHome();
    writeConfigFile(paths, { concurrency: 2 });
    const events: { changed: string[]; applied: string[]; restart_required: string[]; pending_restart: string[] }[] = [];
    const onChange: string[][] = [];
    const ref = new ConfigRef(paths, loadConfig(paths), { events: { emit: (_type: string, data: unknown) => events.push(data as (typeof events)[number]) } as never, onChange: (applied) => onChange.push([...applied]) });
    const live = ref.current;
    expect(ref.reload()).toEqual({ changed: [], applied: [], restart_required: [], pending_restart: [] });
    expect(events).toEqual([]);
    updateConfig(paths, { set: { concurrency: 7, port: 9999, "jobs.max_jobs": 5 } });
    const reload = ref.reload();
    expect(reload.changed.sort()).toEqual(["concurrency", "jobs", "port"]);
    expect(reload.applied.sort()).toEqual(["concurrency", "jobs"]);
    expect(reload.restart_required).toEqual(["port"]);
    expect(reload.pending_restart).toEqual(["port"]);
    expect(ref.current).toBe(live); // the same object everyone holds
    expect(live.concurrency).toBe(7);
    expect(live.jobs.max_jobs).toBe(5);
    expect(live.port).toBe(8787); // restart-only: the file says 9999, the process keeps listening where it is
    expect(ref.pendingRestart()).toEqual(["port"]);
    expect(onChange).toEqual([expect.arrayContaining(["concurrency", "jobs"])]);
    expect(events).toHaveLength(1);
    // Back to the value the server started with: nothing pends any more.
    updateConfig(paths, { unset: ["port"] });
    expect(ref.reload()).toEqual({ changed: [], applied: [], restart_required: [], pending_restart: [] });
    // An invalid file leaves the live config untouched.
    writeFileSync(paths.configFile, "{ nope");
    expect(() => ref.reload()).toThrow(ConfigError);
    expect(live.concurrency).toBe(7);
    // poll() only reloads when the file changed, and reports errors instead of throwing.
    const errors: unknown[] = [];
    expect(ref.poll((e) => errors.push(e))).toBeUndefined();
    expect(errors).toHaveLength(0);
    writeConfigFile(paths, { concurrency: 1 });
    const polled = ref.poll((e) => errors.push(e));
    expect(polled?.applied.sort()).toEqual(["concurrency", "jobs"]); // the rewrite also dropped jobs.max_jobs
    expect(live.concurrency).toBe(1);
    expect(live.jobs.max_jobs).toBe(1000);
    expect(ref.poll()).toBeUndefined();
  });
});
