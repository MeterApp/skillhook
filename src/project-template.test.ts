import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "./commands/main.js";
import type { CliIO } from "./commands/shared.js";
import { githubRepoOf, listProjectTemplates, projectSlug, writeProjectTemplate } from "./examples.js";
import { loadProject } from "./projects.js";
import { tempHome } from "./test-support/helpers.js";

function io() {
  const out: string[] = [];
  const cli: CliIO = { stdout: (t) => out.push(t), stderr: () => undefined, env: { PATH: process.env.PATH, HOME: process.env.HOME, SKILLHOOK_NO_UPDATE_CHECK: "1" }, isTTY: false };
  return { cli, json: () => JSON.parse(out.join("")) as Record<string, unknown> };
}

function repo(root: string, name: string, origin?: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
  if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  return dir;
}

describe("project templates", () => {
  it("names hooks after the directory and reads the GitHub repository from origin", () => {
    const paths = tempHome();
    expect(projectSlug("/srv/Acme Shop_v2")).toBe("acme-shop-v2");
    expect(projectSlug("/")).toBe("project");
    expect(githubRepoOf(repo(paths.home, "a", "git@github.com:acme/shop.git"))).toBe("acme/shop");
    expect(githubRepoOf(repo(paths.home, "b", "https://github.com/acme/shop"))).toBe("acme/shop");
    expect(githubRepoOf(repo(paths.home, "c", "https://gitlab.example.com/acme/shop.git"))).toBeUndefined();
    expect(githubRepoOf(repo(paths.home, "d"))).toBeUndefined();
    expect(listProjectTemplates()).toContain("company");
    expect(() => writeProjectTemplate("../company", paths.home)).toThrow(/Unknown template/);
    expect(() => writeProjectTemplate("nope", paths.home)).toThrow(/Available: .*company/);
  });

  it("writes the company template as a valid project whose hooks load, and keeps files that exist", async () => {
    const paths = tempHome();
    const dir = repo(paths.home, "acme-shop", "git@github.com:acme/shop.git");
    const kept = path.join(dir, ".claude", "skills", "company-rules.md");
    mkdirSync(path.dirname(kept), { recursive: true });
    writeFileSync(kept, "our own rules\n");

    const init = io();
    expect(await main(["projects", "init", dir, "--template", "company", "--dir", paths.home, "--json"], init.cli)).toBe(0);
    const result = init.json() as { ok: boolean; template: { name: string; project: string; repo: string; written: string[]; kept: string[] }; project: { hooks: { name: string }[]; errors: unknown[] } };
    expect(result.ok).toBe(true);
    expect(result.template).toMatchObject({ name: "company", project: "acme-shop", repo: "acme/shop", kept: [path.join(".claude", "skills", "company-rules.md")] });
    expect(result.template.written).toEqual(expect.arrayContaining(["skillhook.yaml", path.join(".claude", "skills", "company-task", "SKILL.md"), path.join(".claude", "skills", "company-incident", "SKILL.md"), path.join(".claude", "skills", "company-daily", "SKILL.md")]));
    expect(result.project.hooks.map((h) => h.name)).toEqual(["acme-shop-task", "acme-shop-incident", "acme-shop-daily", "acme-shop-health"]);
    expect(result.project.errors).toEqual([]);
    expect(readFileSync(kept, "utf8")).toBe("our own rules\n");

    // Nothing of the template's own placeholders is left, and skillhook's {{payload…}} placeholders are.
    for (const file of result.template.written) {
      const text = readFileSync(path.join(dir, file), "utf8");
      expect(text).not.toMatch(/__PROJECT__|__REPO__/);
    }
    expect(readFileSync(path.join(dir, ".claude", "skills", "company-task", "SKILL.md"), "utf8")).toContain("{{payload.issue.number}}");
    const yaml = readFileSync(path.join(dir, "skillhook.yaml"), "utf8");
    expect(yaml).toContain("{ path: repository.full_name, equals: acme/shop }");

    const project = loadProject(dir);
    const byName = Object.fromEntries(project.hooks.map((h) => [h.name, h]));
    expect(byName["acme-shop-task"]?.auth).toMatchObject({ secret_env: "GITHUB_WEBHOOK_SECRET" });
    expect(byName["acme-shop-daily"]).toMatchObject({ webhook: false, schedule: { cron: "5 7 * * *" } });
    expect(byName["acme-shop-health"]).toMatchObject({ webhook: false, schedule: { cron: "*/15 * * * *" } });

    // A second run writes nothing; --force writes the kept file too.
    const again = io();
    expect(await main(["projects", "init", dir, "--template", "company", "--dir", paths.home, "--json"], again.cli)).toBe(0);
    expect((again.json() as { template: { written: string[] } }).template.written).toEqual([]);
    const forced = io();
    expect(await main(["projects", "init", dir, "--template", "company", "--force", "--dir", paths.home, "--json"], forced.cli)).toBe(0);
    expect(readFileSync(kept, "utf8")).toContain("Rules for the agents that work on acme/shop");
  });

  it("leaves OWNER/REPO to fill in when the directory has no GitHub origin, and refuses an unknown template", async () => {
    const paths = tempHome();
    const dir = path.join(paths.home, "plain");
    const init = io();
    expect(await main(["projects", "init", dir, "--template", "company", "--dir", paths.home, "--json"], init.cli)).toBe(0);
    expect((init.json() as { template: { repo: string } }).template.repo).toBe("OWNER/REPO");
    expect(existsSync(path.join(dir, "skillhook.yaml"))).toBe(true);
    const bad = io();
    expect(await main(["projects", "init", path.join(paths.home, "x"), "--template", "nope", "--dir", paths.home, "--json"], bad.cli)).toBe(1);
  });
});
