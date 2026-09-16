import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileHook, loadProject, parseProjectFile, PROJECT_FILE_NAMES, renderProjectTemplate, resolveProject } from "./projects.js";
import { tempHome } from "./test-support/helpers.js";

function project(yaml: string, extra: (dir: string) => void = () => {}): string {
  const dir = path.join(tempHome("skillhook-project-").home, "repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "skillhook.yaml"), yaml);
  extra(dir);
  return dir;
}

describe("skillhook.yaml", () => {
  it("compiles a run hook into a shell skill that works in the project directory", () => {
    const dir = project(`hooks:\n  pull:\n    run: git pull --ff-only\n    auth: { type: github, secret_env: GH_SECRET }\n    when:\n      - { header: x-github-event, equals: pull_request }\n`);
    const loaded = loadProject(dir);
    expect(loaded.error).toBeUndefined();
    expect(loaded.errors).toEqual([]);
    const [hook] = loaded.hooks;
    expect(hook).toMatchObject({ name: "pull", dir, file: path.join(dir, "skillhook.yaml"), enabled: true, source: { type: "project", dir, kind: "run" } });
    expect(hook?.config).toMatchObject({ runner: "shell", shell: { command: "git pull --ff-only" }, cwd: dir });
    expect(hook?.auth).toMatchObject({ type: "hmac", preset: "github", secret_env: "GH_SECRET" });
    expect(hook?.description).toContain("git pull --ff-only");
    expect(hook?.config.when).toHaveLength(1);
  });

  it("wires a SKILL.md from the repository under the hook's name, letting the hook override its block", () => {
    const dir = project(`hooks:\n  on-release:\n    skill: .claude/skills/release-notes\n    model: sonnet\n    cwd: packages/app\n    auth: { type: bearer }\n`, (d) => {
      mkdirSync(path.join(d, ".claude", "skills", "release-notes"), { recursive: true });
      mkdirSync(path.join(d, "packages", "app"), { recursive: true });
      writeFileSync(path.join(d, ".claude", "skills", "release-notes", "SKILL.md"), `---\nname: release-notes\ndescription: Writes release notes.\nallowed-tools: Read Bash(gh:*)\nskillhook:\n  model: opus\n  timeout_seconds: 60\n  claude:\n    permission_mode: acceptEdits\n---\n\nWrite notes for {{payload.release.tag_name}}.\n`);
    });
    const loaded = loadProject(dir);
    expect(loaded.errors).toEqual([]);
    const [hook] = loaded.hooks;
    expect(hook?.name).toBe("on-release");
    expect(hook?.description).toBe("Writes release notes.");
    expect(hook?.body).toContain("{{payload.release.tag_name}}");
    expect(hook?.allowedTools).toEqual(["Read", "Bash(gh:*)"]);
    expect(hook?.dir).toBe(path.join(dir, ".claude", "skills", "release-notes"));
    expect(hook?.file).toBe(path.join(dir, ".claude", "skills", "release-notes", "SKILL.md"));
    expect(hook?.config).toMatchObject({ model: "sonnet", timeout_seconds: 60, cwd: path.join(dir, "packages", "app"), claude: { permission_mode: "acceptEdits" } });
    expect(hook?.auth).toMatchObject({ type: "bearer", secret_env: "SKILLHOOK_SECRET_ON_RELEASE" });
    expect(hook?.source).toMatchObject({ type: "project", kind: "skill" });
    expect(Object.keys(loaded.stamps)).toEqual([path.join(dir, "skillhook.yaml"), path.join(dir, ".claude", "skills", "release-notes", "SKILL.md")]);
  });

  it("accepts inline prompts and the SKILL.md file path itself", () => {
    const dir = project(`hooks:\n  summarize:\n    prompt: Summarize {{payload}} into {{job_dir}}/summary.md\n    model: haiku\n  by-file:\n    skill: skills/thing/SKILL.md\n`, (d) => {
      mkdirSync(path.join(d, "skills", "thing"), { recursive: true });
      writeFileSync(path.join(d, "skills", "thing", "SKILL.md"), `---\nname: thing\ndescription: Thing.\n---\nDo the thing.\n`);
    });
    const loaded = loadProject(dir);
    expect(loaded.errors).toEqual([]);
    const summarize = loaded.hooks.find((h) => h.name === "summarize");
    expect(summarize).toMatchObject({ body: "Summarize {{payload}} into {{job_dir}}/summary.md", dir, source: { kind: "prompt" } });
    expect(summarize?.config).toMatchObject({ model: "haiku", cwd: dir });
    expect(summarize?.config.runner).toBeUndefined();
    expect(loaded.hooks.find((h) => h.name === "by-file")?.dir).toBe(path.join(dir, "skills", "thing"));
  });

  it("reports per-hook problems without losing the other hooks", () => {
    const dir = project(`hooks:\n  fine:\n    run: "true"\n  missing:\n    skill: nowhere\n`);
    const loaded = loadProject(dir);
    expect(loaded.hooks.map((h) => h.name)).toEqual(["fine"]);
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0]).toMatchObject({ name: "missing" });
    expect(loaded.errors[0]?.error).toContain("does not exist");
  });

  it("rejects hooks that do not say what runs, or say it twice", () => {
    const file = "/repo/skillhook.yaml";
    expect(() => parseProjectFile(`hooks:\n  x:\n    model: opus\n`, file)).toThrow(/exactly one of/);
    expect(() => parseProjectFile(`hooks:\n  x:\n    run: ls\n    prompt: hi\n`, file)).toThrow(/exactly one of/);
    expect(() => parseProjectFile(`hooks:\n  x:\n    run: ls\n    runner: claude\n`, file)).toThrow(/shell runner/);
    expect(() => parseProjectFile(`hooks:\n  x:\n    run: ls\n    shell: { command: ls }\n`, file)).toThrow(/keep one/);
    expect(() => parseProjectFile(`hooks:\n  Bad_Name:\n    run: ls\n`, file)).toThrow(/Invalid hook name "Bad_Name"/);
    expect(() => parseProjectFile(`hooks:\n  x:\n    run: ls\n    unknown: 1\n`, file)).toThrow(/Unrecognized key/);
    expect(() => parseProjectFile(`hooks:\n  x:\n    run: ls\nextra: true\n`, file)).toThrow(/Unrecognized key/);
    expect(() => parseProjectFile(`- a\n- b\n`, file)).toThrow(/YAML mapping/);
    expect(() => parseProjectFile(`hooks: [\n`, file)).toThrow(/Cannot parse/);
    expect(parseProjectFile(`hooks: {}\n`, file).hooks).toEqual({});
  });

  it("resolves directories, yaml files and tilde paths", () => {
    const dir = project(`hooks: {}\n`);
    expect(resolveProject(dir)).toEqual({ entry: dir, dir, file: path.join(dir, "skillhook.yaml") });
    expect(resolveProject(path.join(dir, "skillhook.yaml"))).toEqual({ entry: path.join(dir, "skillhook.yaml"), dir, file: path.join(dir, "skillhook.yaml") });
    expect(resolveProject("repo", path.dirname(dir)).dir).toBe(dir);
    expect(resolveProject("~/x").dir.startsWith("/")).toBe(true);
    const missing = loadProject(path.join(dir, "nope"));
    expect(missing.error).toContain("not a directory");
    const empty = tempHome("skillhook-empty-").home;
    expect(loadProject(empty).error).toContain(`No ${PROJECT_FILE_NAMES.join(" or ")}`);
    writeFileSync(path.join(empty, "skillhook.yml"), "hooks:\n  a:\n    run: ls\n");
    expect(loadProject(empty).hooks.map((h) => h.name)).toEqual(["a"]);
  });

  it("ships a starter file that parses and compiles", () => {
    const dir = project(renderProjectTemplate());
    const loaded = loadProject(dir);
    expect(loaded.error).toBeUndefined();
    expect(loaded.errors).toEqual([]);
    expect(loaded.hooks.map((h) => h.name)).toEqual(["pull-after-merge"]);
    expect(loaded.hooks[0]?.config).toMatchObject({ runner: "shell", shell: { command: "git pull --ff-only" } });
    expect(loaded.hooks[0]?.auth).toMatchObject({ preset: "github", secret_env: "GITHUB_WEBHOOK_SECRET" });
    expect(renderProjectTemplate().startsWith("# yaml-language-server: $schema=")).toBe(true);
  });

  it("compileHook validates names", () => {
    const ref = { entry: "/repo", dir: "/repo", file: "/repo/skillhook.yaml" };
    expect(() => compileHook(ref, "Nope", { run: "ls" })).toThrow(/Invalid hook name/);
    expect(compileHook(ref, "ok", { run: ["python3", "handle.py"], cwd: "~/elsewhere" }).config.cwd?.startsWith("/")).toBe(true);
    expect(compileHook(ref, "ok", { run: ["python3", "handle.py"] }).description).toContain("python3 handle.py");
  });
});
