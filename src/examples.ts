import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillDocument, type Skill } from "./skills.js";

/** Bundled example skills live in `examples/skills/<name>/` at the package root. */
export function examplesDir(): string {
  const here = fileURLToPath(import.meta.url); // dist/examples.js or src/examples.ts
  return path.resolve(path.dirname(here), "..", "examples", "skills");
}

export interface ExampleSkill {
  name: string;
  dir: string;
  description: string;
  skill?: Skill;
  error?: string;
}

export function listExamples(dir = examplesDir()): ExampleSkill[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const skillDir = path.join(dir, e.name);
      try {
        const skill = parseSkillDocument(readFileSync(path.join(skillDir, "SKILL.md"), "utf8"), skillDir);
        return { name: e.name, dir: skillDir, description: skill.description, skill };
      } catch (error) {
        return { name: e.name, dir: skillDir, description: "", error: (error as Error).message };
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function findExample(name: string, dir = examplesDir()): ExampleSkill | undefined {
  return listExamples(dir).find((e) => e.name === name);
}

// ---------------------------------------------------------------------------
// Project templates: `skillhook projects init --template <name>`
// ---------------------------------------------------------------------------

/** Bundled project templates live in `examples/projects/<name>/` at the package root. */
export function projectTemplatesDir(): string {
  return path.resolve(examplesDir(), "..", "projects");
}

export function listProjectTemplates(dir = projectTemplatesDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** Hook names are `<project>-task` and so on: the repository's directory name as letters, digits and dashes. */
export function projectSlug(dir: string): string {
  const slug = path.basename(path.resolve(dir)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "project";
}

/** `owner/repo` of a GitHub `origin`, read from the checkout's Git configuration (no request is made). */
export function githubRepoOf(dir: string): string | undefined {
  let url: string;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3_000 }).trim();
  } catch {
    return undefined;
  }
  const match = /github\.com[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export interface TemplateWrite {
  /** Files written, relative to the target directory. */
  written: string[];
  /** Files that already existed and were kept. */
  kept: string[];
  project: string;
  /** `owner/repo`, or the placeholder `OWNER/REPO` when the directory has no GitHub origin: edit it in the files. */
  repo: string;
}

/**
 * Copies a project template into `target`: `dot-<name>` path segments become `.<name>`, and `__PROJECT__` / `__REPO__`
 * in the files become the directory's slug and its GitHub repository. An existing file is kept unless `force`.
 */
export function writeProjectTemplate(name: string, target: string, options: { force?: boolean; dir?: string } = {}): TemplateWrite {
  const root = path.join(options.dir ?? projectTemplatesDir(), name);
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(root)) throw new Error(`Unknown template "${name}". Available: ${listProjectTemplates(options.dir).join(", ") || "none"}`);
  const project = projectSlug(target);
  const repo = githubRepoOf(target) ?? "OWNER/REPO";
  const result: TemplateWrite = { written: [], kept: [], project, repo };
  const walk = (from: string, relative: string): void => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const rel = path.join(relative, entry.name.startsWith("dot-") ? `.${entry.name.slice(4)}` : entry.name);
      const source = path.join(from, entry.name);
      if (entry.isDirectory()) {
        walk(source, rel);
        continue;
      }
      const dest = path.join(target, rel);
      if (existsSync(dest) && !options.force) {
        result.kept.push(rel);
        continue;
      }
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(source, "utf8").replaceAll("__PROJECT__", project).replaceAll("__REPO__", repo));
      result.written.push(rel);
    }
  };
  walk(root, "");
  return result;
}
