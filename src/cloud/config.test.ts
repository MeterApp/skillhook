import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { buildRunEnv } from "../runners/env.js";
import { parseSkillDocument } from "../skills.js";
import { tempHome, writeConfigFile } from "../test-support/helpers.js";
import { assertSecureCloudUrl, CLOUD_TOKEN_ENV, cloudDisabledByEnv, commandAllowed, commandMatches, DEFAULT_CLOUD_URL, InsecureCloudUrlError, isSecureCloudUrl, resolveCloudUrl, trimTrailingSlashes } from "./config.js";

describe("cloud config", () => {
  it("has safe defaults and validates the cloud block", () => {
    const paths = tempHome("skillhook-cloud-");
    expect(loadConfig(paths).cloud).toEqual({ enabled: false, url: DEFAULT_CLOUD_URL, mode: "observe", allow_commands: [], deny_commands: [], upload_payloads: true, upload_artifacts: true, ingress: true, snapshot_interval_seconds: 60, health_interval_seconds: 600, outbox_max_events: 5000 });
    writeConfigFile(paths, { cloud: { enabled: true, url: "https://cloud.example", machine_id: "m_1", mode: "control", allow_commands: ["secret.set"], deny_commands: ["update.*"] } });
    expect(loadConfig(paths).cloud).toMatchObject({ enabled: true, url: "https://cloud.example", machine_id: "m_1", mode: "control", allow_commands: ["secret.set"], deny_commands: ["update.*"] });
    writeConfigFile(paths, { cloud: { mode: "root" } });
    expect(() => loadConfig(paths)).toThrow(/mode/);
    writeConfigFile(paths, { cloud: { url: "not a url" } });
    expect(() => loadConfig(paths)).toThrow(/url/);
  });

  it("resolves the URL and insists on https except for loopback", () => {
    // A machine that names no cloud talks to Skillhook Cloud's production deployment.
    expect(DEFAULT_CLOUD_URL).toBe("https://skillhook.dev");
    expect(isSecureCloudUrl(DEFAULT_CLOUD_URL)).toBe(true);
    expect(resolveCloudUrl({}, {})).toBe(DEFAULT_CLOUD_URL);
    expect(resolveCloudUrl({}, { url: "https://a.example/" })).toBe("https://a.example");
    expect(resolveCloudUrl({ SKILLHOOK_CLOUD_URL: "https://env.example" }, { url: "https://a.example" })).toBe("https://env.example");
    expect(resolveCloudUrl({ SKILLHOOK_CLOUD_URL: "https://env.example" }, { url: "https://a.example" }, "https://flag.example//")).toBe("https://flag.example");
    expect(trimTrailingSlashes("https://a.example/x///")).toBe("https://a.example/x");
    expect(trimTrailingSlashes("///")).toBe("");
    // Linear in the input: a long run of slashes (CodeQL js/polynomial-redos) is trimmed at once.
    expect(trimTrailingSlashes(`https://a.example${"/".repeat(100_000)}x`)).toHaveLength(`https://a.example${"/".repeat(100_000)}x`.length);
    expect(isSecureCloudUrl("https://cloud.example")).toBe(true);
    expect(isSecureCloudUrl("http://127.0.0.1:4000")).toBe(true);
    expect(isSecureCloudUrl("http://localhost:4000")).toBe(true);
    expect(isSecureCloudUrl("http://cloud.example")).toBe(false);
    expect(isSecureCloudUrl("http://cloud.example", { SKILLHOOK_CLOUD_ALLOW_INSECURE: "1" })).toBe(true);
    expect(isSecureCloudUrl("ftp://cloud.example")).toBe(false);
    expect(isSecureCloudUrl("nope")).toBe(false);
    expect(() => assertSecureCloudUrl("http://cloud.example")).toThrow(InsecureCloudUrlError);
    expect(cloudDisabledByEnv({})).toBe(false);
    expect(cloudDisabledByEnv({ SKILLHOOK_NO_CLOUD: "1" })).toBe(true);
    expect(cloudDisabledByEnv({ SKILLHOOK_NO_CLOUD: "false" })).toBe(false);
  });

  it("decides what a command may do from the mode and the lists", () => {
    const observe = { mode: "observe" as const, allow_commands: [], deny_commands: [] };
    const control = { ...observe, mode: "control" as const };
    expect(commandAllowed("ping", observe)).toEqual({ allowed: true });
    expect(commandAllowed("job.list", observe)).toEqual({ allowed: true });
    expect(commandAllowed("skill.run", observe)).toMatchObject({ allowed: false, reason: expect.stringContaining("cloud.mode: control") });
    expect(commandAllowed("skill.run", control)).toEqual({ allowed: true });
    expect(commandAllowed("secret.set", control)).toMatchObject({ allowed: false, reason: expect.stringContaining("allow_commands") });
    expect(commandAllowed("secret.set", { ...control, allow_commands: ["secret.set"] })).toEqual({ allowed: true });
    expect(commandAllowed("job.answer", { ...observe, allow_commands: ["job.*"] })).toEqual({ allowed: true });
    expect(commandAllowed("job.answer", { ...control, deny_commands: ["job.answer"] })).toMatchObject({ allowed: false, reason: expect.stringContaining("deny_commands") });
    expect(commandAllowed("ping", { ...control, deny_commands: ["*"] })).toMatchObject({ allowed: false });
    expect(commandAllowed("rm.rf", control)).toMatchObject({ allowed: false, reason: expect.stringContaining("unknown") });
    expect(commandMatches("job.answer", "job.*")).toBe(true);
    expect(commandMatches("jobs.answer", "job.*")).toBe(false);
    expect(commandMatches("job.answer", " * ")).toBe(true);
  });

  it("keeps the cloud credentials out of every run, even when a skill asks for them", () => {
    const paths = tempHome("skillhook-cloud-");
    const skill = parseSkillDocument("---\nname: leaky\ndescription: l\nskillhook:\n  env: [SKILLHOOK_CLOUD_TOKEN, SKILLHOOK_CLOUD_PRIVATE_KEY, GH_TOKEN]\n---\nBody", "/skills/leaky");
    const config = loadConfig(paths);
    config.env_passthrough.push("SKILLHOOK_CLOUD_URL");
    const env = buildRunEnv({ secrets: { [CLOUD_TOKEN_ENV]: "secret", SKILLHOOK_CLOUD_PRIVATE_KEY: "key", SKILLHOOK_CLOUD_URL: "https://x", GH_TOKEN: "gh" }, skill, config, jobVars: {}, processEnv: { PATH: "/bin", HOME: "/home/x" } });
    expect(env.GH_TOKEN).toBe("gh");
    expect(env.SKILLHOOK_CLOUD_TOKEN).toBeUndefined();
    expect(env.SKILLHOOK_CLOUD_PRIVATE_KEY).toBeUndefined();
    expect(env.SKILLHOOK_CLOUD_URL).toBeUndefined();
  });
});
