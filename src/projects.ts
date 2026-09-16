import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { CommandSpecSchema } from "./config.js";
import { loadSkill, normalizeAuth, SkillError, SkillhookBlockSchema, type Skill, type SkillhookBlock } from "./skills.js";
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
  /** A SKILL.md directory (or the file itself) relative to the project directory; its `skillhook:` block applies, keys set here win. */
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

export const ProjectFileSchema = z
  .object({
    $schema: z.string().optional(),
    /** Webhook name → hook. Each is served at `POST /hooks/<name>`. */
    hooks: z.record(hookName, HookSchema),
  })
  .strict();
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

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

export interface LoadedProject extends ProjectRef {
  /** Set when the file is missing or invalid as a whole; `hooks` is then empty. */
  error?: string;
  /** Hooks that compiled, as routable skills. */
  hooks: Skill[];
  /** Hooks that did not compile (bad name, missing SKILL.md, …); the name is not routable. */
  errors: { name: string; error: string }[];
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
  const parsed = ProjectFileSchema.safeParse(raw);
  if (!parsed.success) throw new SkillError(`Invalid ${file}:\n${z.prettifyError(parsed.error)}`, path.dirname(file));
  return parsed.data;
}

/** Reads and compiles a project; never throws (problems land in `error` / `errors`). */
export function loadProject(entry: string, base = process.cwd()): LoadedProject {
  const ref = resolveProject(entry, base);
  const project: LoadedProject = { ...ref, hooks: [], errors: [], stamps: { [ref.file]: mtimeOf(ref.file) } };
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
  for (const [name, hook] of Object.entries(parsed.hooks)) {
    if (hook.skill !== undefined) {
      const skillDir = resolveSkillDir(ref.dir, hook.skill);
      project.stamps[path.join(skillDir, "SKILL.md")] = mtimeOf(path.join(skillDir, "SKILL.md"));
    }
    try {
      project.hooks.push(compileHook(ref, name, hook));
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
 */
export function compileHook(project: ProjectRef, name: string, hook: Hook): Skill {
  if (!isValidSkillName(name)) throw new SkillError(`Invalid hook name "${name}": use 1-64 lowercase letters, digits and single hyphens`, project.dir);
  const { skill: skillPath, run, prompt, description, ...overrides } = hook;
  const block = stripUndefined(overrides) as SkillhookBlock;

  if (skillPath !== undefined) {
    const skillDir = resolveSkillDir(project.dir, skillPath);
    if (!isDirectory(skillDir)) throw new SkillError(`Hook "${name}": skill directory ${skillDir} does not exist (paths are relative to ${project.dir})`, project.dir);
    const doc = loadSkill(skillDir);
    const config: SkillhookBlock = { ...doc.config, ...block };
    config.cwd = path.resolve(project.dir, expandTilde(block.cwd ?? doc.config.cwd ?? "."));
    return {
      ...doc,
      name,
      description: description ?? doc.description,
      config,
      auth: normalizeAuth(name, config.auth),
      enabled: config.enabled !== false,
      source: { type: "project", dir: project.dir, file: project.file, kind: "skill" },
    };
  }

  const config: SkillhookBlock = run !== undefined ? { ...block, runner: "shell", shell: { command: run } } : block;
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

  # An Agent Skill from this repository (a directory with a SKILL.md). Keys set here override its skillhook: block.
  # release-notes:
  #   skill: .claude/skills/release-notes
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
