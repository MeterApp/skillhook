import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkills, parseSkillDocument, renderSkillTemplate, SkillRegistry, describeAuth } from "./skills.js";
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

  it("reloads a skill when its SKILL.md changes", () => {
    const paths = tempHome();
    const dir = writeSkill(paths, "live", "description: v1");
    const registry = new SkillRegistry(paths.skillsDir);
    expect(registry.get("live")?.description).toBe("v1");
    writeFileSync(path.join(dir, "SKILL.md"), "---\nname: live\ndescription: v2\n---\nbody");
    const future = new Date(Date.now() + 5000);
    utimesSync(path.join(dir, "SKILL.md"), future, future);
    expect(registry.get("live")?.description).toBe("v2");
    expect(registry.get("../etc")).toBeUndefined();
    expect(registry.get("missing")).toBeUndefined();
  });
});
