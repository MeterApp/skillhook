import { statSync } from "node:fs";
import path from "node:path";
import { DefinitionCache } from "./definitions.js";
import { managedSkillDir, managedStateReader, type ManagedState } from "./managed-state.js";
import type { Paths } from "./paths.js";
import { loadProject, projectIsFresh, type LoadedProject } from "./projects.js";
import { loadSkill, loadSkills, SkillError, skillFile, type Skill, type SkillLoadResult, type SkillSource } from "./skills.js";
import { isValidSkillName, readJsonFileOr } from "./util.js";

/** A skill or hook that appeared, changed (another file or mtime) or disappeared since the registry last saw it. */
export interface SkillChange {
  name: string;
  action: "added" | "changed" | "removed";
  source: SkillSource;
  /** The content hash of the definition as it now is; null when removed or without one. */
  definition_sha256: string | null;
}

export interface RegistryOptions {
  /** Linked project entries (directories or skillhook.yaml paths), re-read on every lookup so `skillhook link` needs no restart. */
  projects?: () => string[];
  /** Base for relative project entries (default: the process cwd). */
  base?: string;
  /** Where cloud-managed skills live (`<home>/cloud-skills`, src/managed-state.ts); without it none are served. */
  cloudSkillsDir?: string;
  /** Whether cloud-managed skills are served at all (`cloud.managed_skills`, read at every lookup); default: yes when `cloudSkillsDir` is given. */
  managedEnabled?: () => boolean;
  /** Called for every change noticed after the first `list()`; `onChange()` on the instance adds more listeners. */
  onChange?: (change: SkillChange) => void;
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
 * config order, then the skills Skillhook Cloud assigned to this machine (`<home>/cloud-skills`, docs/cloud.md).
 * `get()` re-reads a skill whose SKILL.md changed, a project whose skillhook.yaml (or a referenced SKILL.md) changed and
 * a cloud skill whose installed definition changed; `list()` rescans everything. Edits apply to the next webhook without
 * a restart. A name defined twice belongs to the earlier source; the later definition is reported as an error, so a
 * local file always wins over what the cloud sent.
 * Changes noticed by either call are reported to `onChange` listeners once a first `list()` has primed the registry
 * (the server lists at startup), so a listener sees edits, not the initial inventory. Every skill carries its
 * `definition` (the content hash of its files, src/definitions.ts), recomputed only when those files change.
 */
export class SkillRegistry {
  private cache = new Map<string, Skill>();
  private projectCache = new Map<string, LoadedProject>();
  private cloudCache = new Map<string, Skill>();
  private known = new Map<string, { file: string; mtimeMs: number; source: SkillSource }>();
  private primed = false;
  private watchers = new Set<(change: SkillChange) => void>();
  private readonly definitions = new DefinitionCache();
  private readonly managed?: () => ManagedState;

  constructor(
    public readonly skillsDir: string,
    private readonly options: RegistryOptions = {},
  ) {
    if (options.cloudSkillsDir) {
      const read = managedStateReader(options.cloudSkillsDir);
      // With the switch off the machine serves none of them, whatever is on disk: turning it off is immediate and fails closed.
      this.managed = () => (options.managedEnabled?.() === false ? { version: 1, skills: {} } : read());
    }
  }

  /** Adds a change listener; returns the unsubscribe function. */
  onChange(fn: (change: SkillChange) => void): () => void {
    this.watchers.add(fn);
    return () => {
      this.watchers.delete(fn);
    };
  }

  private notify(change: SkillChange): void {
    for (const fn of [this.options.onChange, ...this.watchers]) {
      if (!fn) continue;
      try {
        fn(change);
      } catch {
        /* a listener must not break lookups */
      }
    }
  }

  /** Attaches the definition summary (cached by the files' stamps) and returns the skill. */
  private decorate(skill: Skill): Skill {
    try {
      skill.definition = this.definitions.summary(skill);
    } catch {
      skill.definition = undefined;
    }
    return skill;
  }

  private note(skill: Skill): void {
    const previous = this.known.get(skill.name);
    this.known.set(skill.name, { file: skill.file, mtimeMs: skill.mtimeMs, source: skill.source });
    if (!this.primed) return;
    const sha = skill.definition?.sha256 ?? null;
    if (!previous) this.notify({ name: skill.name, action: "added", source: skill.source, definition_sha256: sha });
    else if (previous.file !== skill.file || previous.mtimeMs !== skill.mtimeMs) this.notify({ name: skill.name, action: "changed", source: skill.source, definition_sha256: sha });
  }

  private forget(name: string): void {
    const previous = this.known.get(name);
    if (!previous) return;
    this.known.delete(name);
    if (this.primed) this.notify({ name, action: "removed", source: previous.source, definition_sha256: null });
  }

  private entries(): string[] {
    return this.options.projects?.() ?? [];
  }

  private project(entry: string): LoadedProject {
    const cached = this.projectCache.get(entry);
    if (cached && projectIsFresh(cached)) return cached;
    const loaded = loadProject(entry, this.options.base);
    for (const hook of loaded.hooks) this.decorate(hook);
    this.projectCache.set(entry, loaded);
    return loaded;
  }

  /** Every linked project, loaded (with errors, if any). */
  projects(): LoadedProject[] {
    const entries = this.entries();
    for (const key of [...this.projectCache.keys()]) if (!entries.includes(key)) this.projectCache.delete(key);
    return entries.map((entry) => this.project(entry));
  }

  /** One cloud-managed skill as its state entry says, from the cache while the installed definition and its file are unchanged. */
  private cloudSkill(name: string, entry: ManagedState["skills"][string]): Skill {
    const dir = managedSkillDir(this.options.cloudSkillsDir as string, name, entry.sha256);
    const file = skillFile(dir);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    const cached = this.cloudCache.get(name);
    if (cached && cached.source.type === "cloud" && cached.source.sha256 === entry.sha256 && cached.mtimeMs === mtimeMs) return cached;
    const skill = loadSkill(dir); // throws SkillError for a missing or invalid file
    skill.source = { type: "cloud", sha256: entry.sha256, installed_at: entry.installed_at };
    this.decorate(skill);
    this.cloudCache.set(name, skill);
    return skill;
  }

  /** The cloud-managed skills, in name order, with the ones that do not load. */
  private cloudSkills(): { skills: Skill[]; errors: { dir: string; name: string; error: string }[] } {
    const result = { skills: [] as Skill[], errors: [] as { dir: string; name: string; error: string }[] };
    if (!this.managed) return result;
    const state = this.managed();
    for (const key of [...this.cloudCache.keys()]) if (!state.skills[key]) this.cloudCache.delete(key);
    for (const name of Object.keys(state.skills).sort()) {
      const entry = state.skills[name] as ManagedState["skills"][string];
      if (!isValidSkillName(name)) continue;
      try {
        result.skills.push(this.cloudSkill(name, entry));
      } catch (error) {
        result.errors.push({ dir: managedSkillDir(this.options.cloudSkillsDir as string, name, entry.sha256), name, error: (error as Error).message });
      }
    }
    return result;
  }

  list(): RegistryListResult {
    const loaded = loadSkills(this.skillsDir);
    for (const skill of loaded.skills) this.decorate(skill);
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
    const cloud = this.cloudSkills();
    for (const skill of cloud.skills) {
      const existing = owner.get(skill.name);
      if (existing) {
        loaded.errors.push({ dir: skill.dir, name: skill.name, error: `cloud-managed skill "${skill.name}" is shadowed by ${existing} on this machine; the local definition runs` });
        continue;
      }
      owner.set(skill.name, skill.file);
      loaded.skills.push(skill);
    }
    loaded.errors.push(...cloud.errors);
    const seen = new Set<string>();
    for (const skill of loaded.skills) {
      seen.add(skill.name);
      this.note(skill);
    }
    for (const name of [...this.known.keys()]) if (!seen.has(name)) this.forget(name);
    this.primed = true;
    return { ...loaded, projects };
  }

  /** The skill or hook named `name`, or undefined. Throws `SkillError` when its definition exists but is invalid. */
  get(name: string, options: { reloadProject?: string } = {}): Skill | undefined {
    if (!isValidSkillName(name)) return undefined;
    const dir = path.join(this.skillsDir, name);
    const file = skillFile(dir);
    let mtimeMs: number | undefined;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      this.cache.delete(name);
      if (this.known.get(name)?.source.type === "home") this.forget(name);
    }
    if (mtimeMs !== undefined) {
      const cached = this.cache.get(name);
      if (cached && cached.mtimeMs === mtimeMs) return cached;
      const skill = this.decorate(loadSkill(dir)); // throws SkillError for an invalid file
      this.cache.set(name, skill);
      this.note(skill);
      return skill;
    }
    if (options.reloadProject) {
      for (const [entry, project] of this.projectCache) {
        if (project.dir === options.reloadProject) this.projectCache.delete(entry);
      }
    }
    for (const project of this.projects()) {
      const hook = project.hooks.find((h) => h.name === name);
      if (hook) {
        this.note(hook);
        return hook;
      }
      const broken = project.errors.find((e) => e.name === name);
      if (broken) throw new SkillError(broken.error, project.dir);
    }
    if (this.managed) {
      const entry = this.managed().skills[name];
      if (entry) {
        const skill = this.cloudSkill(name, entry); // throws SkillError when the installed files are unusable
        this.note(skill);
        return skill;
      }
      this.cloudCache.delete(name);
      if (this.known.get(name)?.source.type === "cloud") this.forget(name);
    }
    return undefined;
  }
}
