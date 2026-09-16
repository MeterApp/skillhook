import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSecretEnvFor, parseEnv, readEnvFile, removeEnvVar, upsertEnvVar, loadSecrets } from "./env.js";
import { tempHome } from "./test-support/helpers.js";

describe("env file handling", () => {
  it("parses dotenv syntax", () => {
    const parsed = parseEnv(`# comment\nA=1\nexport B="two words"\nC='single # not comment'\nD=plain # trailing comment\n\nBAD LINE\nE=\n`);
    expect(parsed).toEqual({ A: "1", B: "two words", C: "single # not comment", D: "plain", E: "" });
  });

  it("upserts and removes keys while preserving other lines", () => {
    const paths = tempHome();
    writeFileSync(paths.envFile, "# secrets\nKEEP=1\nCHANGE=old\n");
    upsertEnvVar(paths.envFile, "CHANGE", "new value");
    upsertEnvVar(paths.envFile, "ADDED", "x");
    const text = readFileSync(paths.envFile, "utf8");
    expect(text).toContain("# secrets\nKEEP=1\n");
    expect(readEnvFile(paths.envFile)).toEqual({ KEEP: "1", CHANGE: "new value", ADDED: "x" });
    expect(statSync(paths.envFile).mode & 0o777).toBe(0o600);
    expect(removeEnvVar(paths.envFile, "KEEP")).toBe(true);
    expect(readEnvFile(paths.envFile)).toEqual({ CHANGE: "new value", ADDED: "x" });
  });

  it("creates the file with mode 600", () => {
    const paths = tempHome();
    upsertEnvVar(path.join(paths.home, "nested", ".env"), "K", "v");
    expect(statSync(path.join(paths.home, "nested", ".env")).mode & 0o777).toBe(0o600);
  });

  it("layers process env over the file", () => {
    const paths = tempHome();
    writeFileSync(paths.envFile, "FROM_FILE=1\nBOTH=file\n");
    const secrets = loadSecrets(paths, { BOTH: "process", ONLY_PROCESS: "yes" });
    expect(secrets).toMatchObject({ FROM_FILE: "1", BOTH: "process", ONLY_PROCESS: "yes" });
  });

  it("derives secret env names from skill names", () => {
    expect(defaultSecretEnvFor("granola-meeting")).toBe("SKILLHOOK_SECRET_GRANOLA_MEETING");
  });
});
