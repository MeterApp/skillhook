import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkills, parseSkillDocument, renderSkillTemplate, describeAuth } from "./skills.js";
import { tempHome, writeSkill } from "./test-support/helpers.js";

describe("parseSkillDocument", () => {
  it("parses standard fields plus the skillhook block", () => {
    const text = `---
name: sentry-triage
description: Investigate Sentry issues.
allowed-tools: Bash(git:*) Read
skillhook:
  runner: codex
  model: gpt-5-codex
  effort: high
  cwd: ~/dev/repo
  timeout_seconds: 1200
  auth:
    type: sentry
    secret_env: SENTRY_CLIENT_SECRET
  when:
    - path: action
      equals: created
  env: [SENTRY_AUTH_TOKEN]
  codex:
    sandbox: danger-full-access
---

# Triage
Do it.
`;
    const skill = parseSkillDocument(text, "/tmp/x/sentry-triage");
    expect(skill.name).toBe("sentry-triage");
    expect(skill.config.runner).toBe("codex");
    expect(skill.config.model).toBe("gpt-5-codex");
    expect(skill.allowedTools).toEqual(["Bash(git:*)", "Read"]);
    expect(skill.auth).toMatchObject({ type: "hmac", preset: "sentry", secret_env: "SENTRY_CLIENT_SECRET", header: "sentry-hook-signature" });
    expect(skill.body).toBe("# Triage\nDo it.");
    expect(describeAuth(skill.auth)).toContain("sentry");
  });

  it("rejects a name that does not match the directory", () => {
    expect(() => parseSkillDocument(`---\nname: other\ndescription: x\n---\nbody`, "/tmp/x/demo")).toThrow(/must match its directory/);
  });

  it("rejects invalid names and unknown skillhook keys", () => {
    expect(() => parseSkillDocument(`---\nname: Bad_Name\ndescription: x\n---\nbody`, "/tmp/x/Bad_Name")).toThrow(/Invalid skill name/);
    expect(() => parseSkillDocument(`---\nname: demo\ndescription: x\nskillhook:\n  runer: claude\n---\nbody`, "/tmp/x/demo")).toThrow(/Invalid SKILL.md frontmatter/);
    expect(() => parseSkillDocument(`---\nname: demo\ndescription: x\nskillhook:\n  runner: gemini\n---\nbody`, "/tmp/x/demo")).toThrow(/runner/);
  });

  it("requires frontmatter", () => {
    expect(() => parseSkillDocument("# no frontmatter", "/tmp/x/demo")).toThrow(/no frontmatter/);
  });

  it("round-trips the scaffold template", () => {
    const text = renderSkillTemplate({ name: "hello-world", description: "Says hello.", runner: "claude", model: "haiku", authType: "bearer" });
    const skill = parseSkillDocument(text, "/tmp/skills/hello-world");
    expect(skill.config).toMatchObject({ runner: "claude", model: "haiku", timeout_seconds: 900 });
    expect(skill.auth).toMatchObject({ type: "bearer", secret_env: "SKILLHOOK_SECRET_HELLO_WORLD" });
  });
});

describe("dedupe options", () => {
  it("accepts path, header and in_flight and rejects anything else", () => {
    const doc = (block: string) => `---\nname: d\ndescription: d\nskillhook:\n  dedupe:\n${block}\n---\nBody\n`;
    const skill = parseSkillDocument(doc("    path: event.id\n    in_flight: false"), "/tmp/d");
    expect(skill.config.dedupe).toEqual({ path: "event.id", in_flight: false });
    expect(parseSkillDocument(doc("    header: X-Delivery"), "/tmp/d").config.dedupe).toEqual({ header: "X-Delivery" });
    expect(parseSkillDocument(`---\nname: d\ndescription: d\n---\nBody\n`, "/tmp/d").config.dedupe).toBeUndefined();
    expect(() => parseSkillDocument(doc("    in_flight: sometimes"), "/tmp/d")).toThrow();
    expect(() => parseSkillDocument(doc("    window: 5"), "/tmp/d")).toThrow();
  });
});

describe("loadSkills / SkillRegistry", () => {
  it("loads valid skills and reports broken ones", () => {
    const paths = tempHome();
    writeSkill(paths, "good", "description: Good skill.");
    mkdirSync(path.join(paths.skillsDir, "broken"));
    writeFileSync(path.join(paths.skillsDir, "broken", "SKILL.md"), "---\nname: broken\n---\nmissing description");
    mkdirSync(path.join(paths.skillsDir, ".hidden"));
    const result = loadSkills(paths.skillsDir);
    expect(result.skills.map((s) => s.name)).toEqual(["good"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.name).toBe("broken");
  });
});

describe("schedule options", () => {
  const doc = (block: string) => `---\nname: s\ndescription: s\nskillhook:\n${block}\n---\nBody\n`;

  it("accepts a cron string, a full object, and false", () => {
    const short = parseSkillDocument(doc('  schedule: "*/30 * * * *"'), "/tmp/s");
    expect(short.schedule).toMatchObject({ cron: "*/30 * * * *", timezone: "UTC", catch_up: "latest", overlap: "skip" });
    expect(short.schedule?.spec.minutes).toEqual(new Set([0, 30]));
    expect(short.webhook).toBe(true);
    const full = parseSkillDocument(doc('  schedule:\n    cron: "@daily"\n    timezone: Europe/Berlin\n    catch_up: all\n    overlap: queue\n    payload: { reason: digest }\n  webhook: false'), "/tmp/s");
    expect(full.schedule).toMatchObject({ cron: "0 0 * * *", timezone: "Europe/Berlin", catch_up: "all", overlap: "queue", payload: { reason: "digest" } });
    expect(full.webhook).toBe(false);
    expect(parseSkillDocument(doc("  schedule: false"), "/tmp/s").schedule).toBeUndefined();
    expect(parseSkillDocument(`---\nname: s\ndescription: s\n---\nBody\n`, "/tmp/s")).toMatchObject({ webhook: true });
    expect(parseSkillDocument(`---\nname: s\ndescription: s\n---\nBody\n`, "/tmp/s").schedule).toBeUndefined();
  });

  it("rejects unusable schedules with the reason", () => {
    expect(() => parseSkillDocument(doc('  schedule: "* * * *"'), "/tmp/s")).toThrow(/invalid schedule: .*5 fields/);
    expect(() => parseSkillDocument(doc('  schedule: "61 * * * *"'), "/tmp/s")).toThrow(/out of range/);
    expect(() => parseSkillDocument(doc('  schedule:\n    cron: "0 9 * * *"\n    timezone: Mars/Olympus'), "/tmp/s")).toThrow(/unknown time zone "Mars\/Olympus"/);
    expect(() => parseSkillDocument(doc('  schedule:\n    cron: "0 9 * * *"\n    catch_up: sometimes'), "/tmp/s")).toThrow(/Invalid SKILL.md frontmatter/);
    expect(() => parseSkillDocument(doc('  schedule:\n    cron: "0 9 * * *"\n    every: 5m'), "/tmp/s")).toThrow(/Invalid SKILL.md frontmatter/);
    expect(() => parseSkillDocument(doc("  webhook: false"), "/tmp/s")).toThrow(/needs a `schedule`/);
  });
});
