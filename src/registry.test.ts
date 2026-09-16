import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configProjects, SkillRegistry } from "./registry.js";
import { tempHome, writeConfigFile, writeSkill } from "./test-support/helpers.js";

function touchLater(file: string, seconds: number): void {
  const future = new Date(Date.now() + seconds * 1000);
  utimesSync(file, future, future);
}

function makeProject(root: string, name: string, yaml: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "skillhook.yaml"), yaml);
  return dir;
}

describe("SkillRegistry", () => {
  it("reloads a home skill when its SKILL.md changes", () => {
    const paths = tempHome();
    const dir = writeSkill(paths, "live", "description: v1");
    const registry = new SkillRegistry(paths.skillsDir);
    expect(registry.get("live")?.description).toBe("v1");
    writeFileSync(path.join(dir, "SKILL.md"), "---\nname: live\ndescription: v2\n---\nbody");
    touchLater(path.join(dir, "SKILL.md"), 5);
    expect(registry.get("live")?.description).toBe("v2");
    expect(registry.get("../etc")).toBeUndefined();
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.list().projects).toEqual([]);
  });

  it("merges linked projects after home skills and reports shadowed names", () => {
    const paths = tempHome();
    writeSkill(paths, "hello", "description: home hello");
    const api = makeProject(paths.home, "api", "hooks:\n  deploy:\n    run: ./deploy.sh\n  hello:\n    run: echo shadowed\n");
    const web = makeProject(paths.home, "web", "hooks:\n  deploy:\n    run: npm run deploy\n  build:\n    prompt: Build it.\n");
    const registry = new SkillRegistry(paths.skillsDir, { projects: () => [api, web] });
    const listed = registry.list();
    expect(listed.skills.map((s) => s.name)).toEqual(["hello", "deploy", "build"]);
    expect(listed.skills.find((s) => s.name === "hello")?.source).toEqual({ type: "home" });
    expect(listed.skills.find((s) => s.name === "deploy")?.dir).toBe(api);
    expect(listed.errors.map((e) => e.name).sort()).toEqual(["deploy", "hello"]);
    expect(listed.errors.find((e) => e.name === "deploy")?.error).toContain("shadowed by");
    expect(listed.projects.map((p) => p.dir)).toEqual([api, web]);
    // get() follows the same precedence.
    expect(registry.get("hello")?.description).toBe("home hello");
    expect(registry.get("deploy")?.config.shell).toEqual({ command: "./deploy.sh" });
    expect(registry.get("build")?.body).toBe("Build it.");
    expect(registry.get("nope")).toBeUndefined();
  });

  it("reloads a project when its skillhook.yaml or a referenced SKILL.md changes, and drops unlinked ones", () => {
    const paths = tempHome();
    const repo = makeProject(paths.home, "repo", "hooks:\n  a:\n    run: echo one\n");
    let entries = [repo];
    const registry = new SkillRegistry(paths.skillsDir, { projects: () => entries });
    expect(registry.get("a")?.config.shell).toEqual({ command: "echo one" });
    writeFileSync(path.join(repo, "skillhook.yaml"), "hooks:\n  a:\n    run: echo two\n  b:\n    skill: skills/b\n");
    touchLater(path.join(repo, "skillhook.yaml"), 5);
    mkdirSync(path.join(repo, "skills", "b"), { recursive: true });
    writeFileSync(path.join(repo, "skills", "b", "SKILL.md"), "---\nname: b\ndescription: b1\n---\nB one\n");
    expect(registry.get("a")?.config.shell).toEqual({ command: "echo two" });
    expect(registry.get("b")?.description).toBe("b1");
    writeFileSync(path.join(repo, "skills", "b", "SKILL.md"), "---\nname: b\ndescription: b2\n---\nB two\n");
    touchLater(path.join(repo, "skills", "b", "SKILL.md"), 10);
    expect(registry.get("b")?.description).toBe("b2");
    entries = [];
    expect(registry.get("a")).toBeUndefined();
    expect(registry.list().projects).toEqual([]);
  });

  it("throws for a hook whose definition exists but is broken, like an invalid SKILL.md", () => {
    const paths = tempHome();
    const repo = makeProject(paths.home, "repo", "hooks:\n  broken:\n    skill: skills/broken\n  fine:\n    run: ls\n");
    mkdirSync(path.join(repo, "skills", "broken"), { recursive: true });
    writeFileSync(path.join(repo, "skills", "broken", "SKILL.md"), "---\nname: broken\n---\nno description\n");
    const registry = new SkillRegistry(paths.skillsDir, { projects: () => [repo] });
    expect(() => registry.get("broken")).toThrow(/Invalid SKILL.md frontmatter/);
    expect(registry.get("fine")?.name).toBe("fine");
    const listed = registry.list();
    expect(listed.errors.map((e) => e.name)).toEqual(["broken"]);
    const missingDir = new SkillRegistry(paths.skillsDir, { projects: () => [path.join(paths.home, "gone")] }).list();
    expect(missingDir.errors[0]?.error).toContain("not a directory");
    expect(missingDir.projects[0]?.error).toContain("not a directory");
  });

  it("reads the project list from skillhook.json and notices edits", () => {
    const paths = tempHome();
    const repo = makeProject(paths.home, "repo", "hooks:\n  a:\n    run: ls\n");
    const projects = configProjects(paths);
    expect(projects()).toEqual([]);
    writeConfigFile(paths, { projects: [repo] });
    touchLater(paths.configFile, 5);
    expect(projects()).toEqual([repo]);
    writeConfigFile(paths, { projects: [repo, 42, ""] });
    touchLater(paths.configFile, 10);
    expect(projects()).toEqual([repo]);
    writeFileSync(paths.configFile, "{ not json");
    touchLater(paths.configFile, 15);
    expect(projects()).toEqual([]);
    const registry = new SkillRegistry(paths.skillsDir, { projects: configProjects(paths) });
    writeConfigFile(paths, { projects: ["repo"] });
    touchLater(paths.configFile, 20);
    expect(new SkillRegistry(paths.skillsDir, { projects: configProjects(paths), base: paths.home }).get("a")?.dir).toBe(repo);
    expect(registry.list().projects).toHaveLength(1);
  });
});
