import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { CommandSpecSchema } from "./config.js";
import { ClaudeOptionsSchema, loadSkill, normalizeAuth, resolveSchedule, SkillError, SkillhookBlockSchema, type ClaudeOptions, type Skill, type SkillhookBlock } from "./skills.js";
import { displayPath, exists, expandTilde, isDirectory, isValidSkillName, SKILL_NAME_RE } from "./util.js";

// ---------------------------------------------------------------------------
// skillhook.yaml: hooks a repository declares, version-controlled with the code they act on.
// ---------------------------------------------------------------------------

/** File names looked up in a linked directory, in order. */
export const PROJECT_FILE_NAMES = ["skillhook.yaml", "skillhook.yml"] as const;

export const PROJECT_SCHEMA_URL = "https://raw.githubusercontent.com/MeterApp/skillhook/main/schema/skillhook.yaml.schema.json";

/**
 * One hook = the `skillhook:` block of a SKILL.md plus what runs: exactly one of `run` (a shell command),
 * `skill` (a SKILL.md directory in the project) or `prompt` (inline instructions for the agent runner).
 */
export const HookSchema = SkillhookBlockSchema.extend({
  /** What the hook does; shown by `skills list`, the MCP tools and `GET /skills`. Defaults to the SKILL.md description or a line about the command. */
  description: z.string().min(1).max(1024).optional(),
  /** A skill declared under `skills:` as `@<name>`, or a SKILL.md directory (or the file itself) relative to the project directory; its `skillhook:` block applies, keys set here win. */
  skill: z.string().min(1).optional(),
  /** A shell command run in the project directory: a string for `/bin/sh -c`, an array to execute directly. Implies `runner: shell`. */
  run: CommandSpecSchema.optional(),
  /** Inline instructions for Claude Code or Codex, with the same `{{placeholders}}` as a SKILL.md body. */
  prompt: z.string().min(1).optional(),
}).superRefine((hook, ctx) => {
  const kinds = [hook.run, hook.skill, hook.prompt].filter((v) => v !== undefined).length;
  if (kinds !== 1) ctx.addIssue({ code: "custom", message: "A hook needs exactly one of `run` (a shell command), `skill` (a SKILL.md directory) or `prompt` (inline instructions)" });
  if (hook.run !== undefined && hook.runner !== undefined && hook.runner !== "shell") ctx.addIssue({ code: "custom", message: "`run` always uses the shell runner; drop `runner` or use `skill`/`prompt` for an agent" });
  if (hook.run !== undefined && hook.shell !== undefined) ctx.addIssue({ code: "custom", message: "`run` and `shell.command` are the same thing; keep one" });
});
export type Hook = z.infer<typeof HookSchema>;

const hookName = z.string().min(1).max(64).regex(SKILL_NAME_RE, "hook names use 1-64 lowercase letters, digits and single hyphens");
const declaredSkillName = z.string().min(1).max(64).regex(SKILL_NAME_RE, "skill names use 1-64 lowercase letters, digits and single hyphens, and equal the SKILL.md's name");

/**
 * A skill the repository owns, declared under `skills:` by name: where its SKILL.md directory (or the file itself) is,
 * relative to the repository, as a path or `{ path }`. The name must equal the SKILL.md's `name` (and so its directory's
 * name). Hooks refer to it as `skill: "@<name>"`; the list is also what a repository publishes as its skills.
 */
export const ProjectSkillSchema = z.union([z.string().min(1), z.object({ path: z.string().min(1) }).strict()]);
export type ProjectSkillEntry = z.infer<typeof ProjectSkillSchema>;

export const ProjectFileSchema = z
  .object({
    $schema: z.string().optional(),
    /** Claude Code options for every hook of this file (`config_dir` above all: the account this repository's hooks run as). A hook's own `claude:` keys, and those of the SKILL.md it names, win key by key. */
    claude: ClaudeOptionsSchema.optional(),
    /** Skill name → where it lives in the repository. The skills this repository owns; hooks name them as `@<name>`. */
    skills: z.record(declaredSkillName, ProjectSkillSchema).optional(),
    /** Webhook name → hook. Each is served at `POST /hooks/<name>`. */
    hooks: z.record(hookName, HookSchema),
  })
  .strict();
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

/** The path a `skills:` entry names. */
export function projectSkillPath(entry: ProjectSkillEntry): string {
  return typeof entry === "string" ? entry : entry.path;
}

/** The name a `skill: "@name"` reference points at, or undefined for a path. */
export function declaredSkillReference(skill: string): string | undefined {
  return skill.startsWith("@") ? skill.slice(1) : undefined;
}

// ---------------------------------------------------------------------------
// Resolving and loading
// ---------------------------------------------------------------------------

export interface ProjectRef {
  /** What the config or the user named: a directory, or the YAML file itself. */
  entry: string;
  /** The project (repository) directory. */
  dir: string;
  /** The skillhook.yaml (the first of PROJECT_FILE_NAMES that exists, else the default name). */
  file: string;
}

/** A directory entry points at `skillhook.yaml` inside it; an entry ending in `.yaml`/`.yml` is the file itself. */
export function resolveProject(entry: string, base = process.cwd()): ProjectRef {
  const resolved = path.resolve(base, expandTilde(entry));
  if (/\.ya?ml$/i.test(resolved) && !isDirectory(resolved)) return { entry, dir: path.dirname(resolved), file: resolved };
  const file = PROJECT_FILE_NAMES.map((name) => path.join(resolved, name)).find((candidate) => exists(candidate)) ?? path.join(resolved, PROJECT_FILE_NAMES[0]);
  return { entry, dir: resolved, file };
}

/** A skill declared under `skills:`, resolved. */
export interface ProjectSkill {
  name: string;
  /** The SKILL.md directory. */
  dir: string;
  file: string;
  /** The hooks that refer to it as `@name`. */
  hooks: string[];
  /** Set when the directory or its SKILL.md is missing, invalid or named otherwise; no hook can use it then. */
  error?: string;
}

export interface LoadedProject extends ProjectRef {
  /** Set when the file is missing or invalid as a whole; `hooks` is then empty. */
  error?: string;
  /** Hooks that compiled, as routable skills. */
  hooks: Skill[];
  /** Hooks that did not compile (bad name, missing SKILL.md, …); the name is not routable. A declared skill that does not load is listed as `@<name>`. */
  errors: { name: string; error: string }[];
  /** The skills the repository declares under `skills:`, in file order. */
  skills: ProjectSkill[];
  /** mtime of every file the project was compiled from; `SkillRegistry` reloads when one changes. */
  stamps: Record<string, number>;
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function parseProjectFile(text: string, file: string): ProjectFile {
  let raw: unknown;
  try {
    raw = YAML.parse(text) ?? {};
  } catch (error) {
    throw new SkillError(`Cannot parse ${file}: ${(error as Error).message}`, path.dirname(file));
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SkillError(`${file} must be a YAML mapping with a \`hooks:\` key`, path.dirname(file));
  const hooks = (raw as { hooks?: unknown }).hooks;
  if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) {
    for (const name of Object.keys(hooks)) if (!isValidSkillName(name)) throw new SkillError(`Invalid hook name "${name}" in ${file}: use 1-64 lowercase letters, digits and single hyphens`, path.dirname(file));
  }
  const skills = (raw as { skills?: unknown }).skills;
  if (skills && typeof skills === "object" && !Array.isArray(skills)) {
    for (const name of Object.keys(skills)) if (!isValidSkillName(name)) throw new SkillError(`Invalid skill name "${name}" under skills: in ${file}: use 1-64 lowercase letters, digits and single hyphens (the SKILL.md's name)`, path.dirname(file));
  }
  const parsed = ProjectFileSchema.safeParse(raw);
  if (!parsed.success) throw new SkillError(`Invalid ${file}:\n${z.prettifyError(parsed.error)}`, path.dirname(file));
  return parsed.data;
}

/** Reads and compiles a project; never throws (problems land in `error` / `errors`). */
export function loadProject(entry: string, base = process.cwd()): LoadedProject {
  const ref = resolveProject(entry, base);
  const project: LoadedProject = { ...ref, hooks: [], errors: [], skills: [], stamps: { [ref.file]: mtimeOf(ref.file) } };
  if (!isDirectory(ref.dir)) {
    project.error = `${ref.dir} is not a directory`;
    return project;
  }
  let text: string;
  try {
    text = readFileSync(ref.file, "utf8");
  } catch {
    project.error = `No ${PROJECT_FILE_NAMES.join(" or ")} in ${ref.dir} (create one with: skillhook projects init ${displayPath(ref.dir)})`;
    return project;
  }
  let parsed: ProjectFile;
  try {
    parsed = parseProjectFile(text, ref.file);
  } catch (error) {
    project.error = (error as Error).message;
    return project;
  }
  // The declared skills first: every one is checked (it exists, it parses, its name is the key), whether a hook uses it or not.
  const declared: Record<string, string> = {};
  for (const [name, entry] of Object.entries(parsed.skills ?? {})) {
    const skillDir = resolveSkillDir(ref.dir, projectSkillPath(entry));
    const file = path.join(skillDir, "SKILL.md");
    project.stamps[file] = mtimeOf(file);
    declared[name] = skillDir;
    const skill: ProjectSkill = { name, dir: skillDir, file, hooks: [] };
    try {
      const doc = loadSkill(skillDir);
      if (doc.name !== name) throw new SkillError(`skills.${name}: the SKILL.md in ${displayPath(skillDir)} is named "${doc.name}"; the key under skills: must be the skill's name`, ref.dir);
    } catch (error) {
      skill.error = (error as Error).message;
      project.errors.push({ name: `@${name}`, error: skill.error });
    }
    project.skills.push(skill);
  }
  for (const [name, hook] of Object.entries(parsed.hooks)) {
    if (hook.skill !== undefined && declaredSkillReference(hook.skill) === undefined) {
      const skillDir = resolveSkillDir(ref.dir, hook.skill);
      project.stamps[path.join(skillDir, "SKILL.md")] = mtimeOf(path.join(skillDir, "SKILL.md"));
    }
    try {
      project.hooks.push(compileHook(ref, name, hook, parsed.claude, declared));
      const reference = hook.skill !== undefined ? declaredSkillReference(hook.skill) : undefined;
      if (reference) project.skills.find((s) => s.name === reference)?.hooks.push(name);
    } catch (error) {
      project.errors.push({ name, error: (error as Error).message });
    }
  }
  return project;
}

/** True while none of the files a project was compiled from has changed. */
export function projectIsFresh(project: LoadedProject): boolean {
  return Object.entries(project.stamps).every(([file, stamp]) => mtimeOf(file) === stamp);
}

function resolveSkillDir(projectDir: string, skillPath: string): string {
  const resolved = path.resolve(projectDir, expandTilde(skillPath));
  return path.basename(resolved) === "SKILL.md" ? path.dirname(resolved) : resolved;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function describeCommand(command: string | string[]): string {
  return Array.isArray(command) ? command.join(" ") : command;
}

/**
 * Turns a hook into the same `Skill` shape a SKILL.md produces, so the server, runners and CLI need no special case.
 * `cwd` defaults to the project directory (a relative `cwd` is resolved against it) rather than the skill directory.
 * `declared` maps the names under `skills:` to their directories, for `skill: "@name"` references.
 */
export function compileHook(project: ProjectRef, name: string, hook: Hook, projectClaude?: ClaudeOptions, declared: Record<string, string> = {}): Skill {
  if (!isValidSkillName(name)) throw new SkillError(`Invalid hook name "${name}": use 1-64 lowercase letters, digits and single hyphens`, project.dir);
  const { skill: skillPath, run, prompt, description, ...overrides } = hook;
  const block = stripUndefined(overrides) as SkillhookBlock;
  // A config_dir written in skillhook.yaml (for the file or the hook) is relative to the repository.
  const fromFile = (options: ClaudeOptions | undefined): ClaudeOptions | undefined => (options?.config_dir ? { ...options, config_dir: path.resolve(project.dir, expandTilde(options.config_dir)) } : options);
  const fileClaude = fromFile(projectClaude);
  if (block.claude) block.claude = fromFile(block.claude);

  if (skillPath !== undefined) {
    const reference = declaredSkillReference(skillPath);
    let skillDir: string;
    if (reference !== undefined) {
      const dir = Object.hasOwn(declared, reference) ? declared[reference] : undefined;
      if (!dir) {
        const names = Object.keys(declared).map((k) => `@${k}`);
        throw new SkillError(`Hook "${name}": ${skillPath} is not declared under skills: in ${path.basename(project.file)}${names.length ? ` (declared: ${names.join(", ")})` : " (the file declares no skills)"}`, project.dir);
      }
      skillDir = dir;
    } else {
      skillDir = resolveSkillDir(project.dir, skillPath);
    }
    if (!isDirectory(skillDir)) throw new SkillError(`Hook "${name}": skill directory ${skillDir} does not exist (paths are relative to ${project.dir})`, project.dir);
    const doc = loadSkill(skillDir);
    const config: SkillhookBlock = { ...doc.config, ...block };
    const claude = { ...fileClaude, ...doc.config.claude, ...block.claude };
    if (Object.keys(claude).length) config.claude = claude;
    config.cwd = path.resolve(project.dir, expandTilde(block.cwd ?? doc.config.cwd ?? "."));
    const { schedule, ...rest } = doc;
    void schedule; // the hook's own schedule (possibly inherited, possibly `false`) replaces the SKILL.md's
    return {
      ...rest,
      name,
      description: description ?? doc.description,
      config,
      auth: normalizeAuth(name, config.auth),
      ...resolveSchedule(name, config, project.dir),
      enabled: config.enabled !== false,
      source: { type: "project", dir: project.dir, file: project.file, kind: "skill", ...(reference !== undefined ? { skill: reference } : {}) },
    };
  }

  const config: SkillhookBlock = run !== undefined ? { ...block, runner: "shell", shell: { command: run } } : block;
  if (fileClaude) config.claude = { ...fileClaude, ...block.claude };
  config.cwd = path.resolve(project.dir, expandTilde(block.cwd ?? "."));
  return {
    name,
    description: description ?? (run !== undefined ? `Runs \`${describeCommand(run)}\` in ${path.basename(project.dir)} when the webhook fires.` : `Runs the instructions in ${path.basename(project.file)} when the webhook fires.`),
    dir: project.dir,
    file: project.file,
    body: prompt?.trim() ?? "",
    frontmatter: { name, description, ...hook },
    config,
    auth: normalizeAuth(name, config.auth),
    ...resolveSchedule(name, config, project.dir),
    allowedTools: [],
    enabled: config.enabled !== false,
    mtimeMs: mtimeOf(project.file),
    source: { type: "project", dir: project.dir, file: project.file, kind: run !== undefined ? "run" : "prompt" },
  };
}

/** Starter `skillhook.yaml` for `skillhook projects init`. */
export function renderProjectTemplate(): string {
  return `# yaml-language-server: $schema=${PROJECT_SCHEMA_URL}
# skillhook.yaml — the webhooks of this repository, version-controlled with the code they act on.
#
# On a machine that runs skillhook:  skillhook link .      (then: skillhook skills list)
# Every hook is served at POST <public_url>/hooks/<name>. Secrets never live here; they are named by
# secret_env and stored on each machine with \`skillhook secret set NAME\`.
# Reference: https://github.com/MeterApp/skillhook/blob/main/docs/projects.md

# The skills this repository owns: Agent Skills (a directory with a SKILL.md, usually under .claude/skills so
# Claude Code finds them too), by name. The name must equal the SKILL.md's name. Hooks below refer to one as
# skill: "@name", and this list is what the repository publishes as its skills.
# skills:
#   release-notes: .claude/skills/release-notes

hooks:
  # A shell command, run in this directory with the payload on stdin (never on the command line).
  # GitHub → Settings → Webhooks: content type application/json, event "Pull requests", secret from
  # \`skillhook secret generate GITHUB_WEBHOOK_SECRET\`, payload URL from \`skillhook url pull-after-merge\`.
  pull-after-merge:
    description: Fast-forward this checkout when a pull request merges.
    run: git pull --ff-only
    auth: { type: github, secret_env: GITHUB_WEBHOOK_SECRET }
    when:
      - { header: x-github-event, equals: pull_request }
      - { path: action, equals: closed }
      - { path: pull_request.merged, equals: true }

  # An Agent Skill from this repository, declared under skills: above (a path works too). Keys set here override its skillhook: block.
  # release-notes:
  #   skill: "@release-notes"
  #   model: sonnet
  #   auth: { type: github, secret_env: GITHUB_WEBHOOK_SECRET }
  #   when:
  #     - { header: x-github-event, equals: release }
  #     - { path: action, equals: published }

  # Inline instructions for the agent runner, without a SKILL.md.
  # summarize:
  #   prompt: Summarize the payload in three bullet points and write them to {{job_dir}}/summary.md.
  #   model: haiku
`;
}
