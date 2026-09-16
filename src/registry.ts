import { statSync } from "node:fs";
import path from "node:path";
import type { Paths } from "./paths.js";
import { loadProject, projectIsFresh, type LoadedProject } from "./projects.js";
import { loadSkill, loadSkills, SkillError, skillFile, type Skill, type SkillLoadResult } from "./skills.js";
import { isValidSkillName, readJsonFileOr } from "./util.js";

export interface RegistryOptions {
  /** Linked project entries (directories or skillhook.yaml paths), re-read on every lookup so `skillhook link` needs no restart. */
  projects?: () => string[];
  /** Base for relative project entries (default: the process cwd). */
  base?: string;
}

export interface RegistryListResult extends SkillLoadResult {
  projects: LoadedProject[];
}

/** The `projects` array of `skillhook.json`, cached until the file's mtime changes; tolerant of a missing or invalid file. */
export function configProjects(paths: Paths): () => string[] {
  let stamp = -1;
  let cached: string[] = [];
  return () => {
    let mtime = 0;
    try {
      mtime = statSync(paths.configFile).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (mtime !== stamp) {
      stamp = mtime;
      const raw = readJsonFileOr<{ projects?: unknown }>(paths.configFile, {});
      cached = Array.isArray(raw.projects) ? raw.projects.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
    }
    return cached;
  };
}

/**
 * Every routable skill: the directories under `<home>/skills` first, then the hooks of each linked project in
 * config order. `get()` re-reads a skill whose SKILL.md changed and a project whose skillhook.yaml (or a
 * referenced SKILL.md) changed; `list()` rescans everything. Edits apply to the next webhook without a restart.
 * A name defined twice belongs to the earlier source; the later definition is reported as an error.
 */
export class SkillRegistry {
  private cache = new Map<string, Skill>();
  private projectCache = new Map<string, LoadedProject>();

  constructor(
    public readonly skillsDir: string,
    private readonly options: RegistryOptions = {},
  ) {}

  private entries(): string[] {
    return this.options.projects?.() ?? [];
  }

  private project(entry: string): LoadedProject {
    const cached = this.projectCache.get(entry);
    if (cached && projectIsFresh(cached)) return cached;
    const loaded = loadProject(entry, this.options.base);
    this.projectCache.set(entry, loaded);
    return loaded;
  }

  /** Every linked project, loaded (with errors, if any). */
  projects(): LoadedProject[] {
    const entries = this.entries();
    for (const key of [...this.projectCache.keys()]) if (!entries.includes(key)) this.projectCache.delete(key);
    return entries.map((entry) => this.project(entry));
  }

  list(): RegistryListResult {
    const loaded = loadSkills(this.skillsDir);
    this.cache = new Map(loaded.skills.map((s) => [s.name, s]));
    const owner = new Map<string, string>(loaded.skills.map((s) => [s.name, s.file]));
    const projects = this.projects();
    for (const project of projects) {
      if (project.error) {
        loaded.errors.push({ dir: project.dir, name: path.basename(project.dir), error: project.error });
        continue;
      }
      for (const hook of project.hooks) {
        const existing = owner.get(hook.name);
        if (existing) {
          loaded.errors.push({ dir: project.dir, name: hook.name, error: `hook "${hook.name}" in ${project.file} is shadowed by ${existing}; rename one of them` });
          continue;
        }
        owner.set(hook.name, project.file);
        loaded.skills.push(hook);
      }
      for (const error of project.errors) loaded.errors.push({ dir: project.dir, name: error.name, error: error.error });
    }
    return { ...loaded, projects };
  }

  /** The skill or hook named `name`, or undefined. Throws `SkillError` when its definition exists but is invalid. */
  get(name: string): Skill | undefined {
    if (!isValidSkillName(name)) return undefined;
    const dir = path.join(this.skillsDir, name);
    const file = skillFile(dir);
    let mtimeMs: number | undefined;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      this.cache.delete(name);
    }
    if (mtimeMs !== undefined) {
      const cached = this.cache.get(name);
      if (cached && cached.mtimeMs === mtimeMs) return cached;
      const skill = loadSkill(dir); // throws SkillError for an invalid file
      this.cache.set(name, skill);
      return skill;
    }
    for (const project of this.projects()) {
      const hook = project.hooks.find((h) => h.name === name);
      if (hook) return hook;
      const broken = project.errors.find((e) => e.name === name);
      if (broken) throw new SkillError(broken.error, project.dir);
    }
    return undefined;
  }
}
