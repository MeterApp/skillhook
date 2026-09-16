import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { coerceConfigValue, defaultConfig, loadConfig, setConfigValue } from "./config.js";
import { tempHome } from "./test-support/helpers.js";

describe("config", () => {
  it("provides defaults when no file exists", () => {
    const paths = tempHome();
    const config = loadConfig(paths);
    expect(config.port).toBe(8787);
    expect(config.defaults.runner).toBe("claude");
    expect(config.runners.claude.permission_mode).toBe("bypassPermissions");
    expect(config.runners.codex.sandbox).toBe("workspace-write");
    expect(config.jobs.dedupe_in_flight).toBe(true);
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

  it("coerces CLI values", () => {
    expect(coerceConfigValue("8787")).toBe(8787);
    expect(coerceConfigValue("true")).toBe(true);
    expect(coerceConfigValue('["a"]')).toEqual(["a"]);
    expect(coerceConfigValue("opus")).toBe("opus");
  });
});
