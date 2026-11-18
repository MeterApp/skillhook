// A skill's definition as Skillhook Cloud keeps it: the text of the files that define the skill, identified by a hash
// of their content and never by a path, so the same skill on three machines is one definition and a differing one is
// drift. For a skill in `<home>/skills` (or a cloud-managed one) that is the SKILL.md and the files next to it; for a
// hook of a `skillhook.yaml` it is that hook's block, the file's own `claude:` block and, for a `skill:` hook, the
// SKILL.md directory it names. The hash goes into every skill summary and every `skill.changed` event; the cloud asks
// for the text it lacks with `definitions.get`, and hands a definition back to a machine that serves it as a
// cloud-managed skill (src/cloud/managed.ts). Pure file reading and hashing: nothing here talks to the cloud.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Skill } from "./skills.js";

/** What a definition may carry: more files or bytes are listed without their text (`files_omitted`, `text_omitted`). */
export const DEFINITION_LIMITS = {
  /** Files in one definition; the rest is counted in `files_omitted`. */
  max_files: 200,
  /** One file's text travels only up to this size. */
  max_file_bytes: 256 * 1024,
  /** All the text of one definition. */
  max_bytes: 1024 * 1024,
} as const;

export const DEFINITION_KINDS = ["skill", "hook"] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

/** The virtual file that carries a hook's own block of `skillhook.yaml` (its key and the file-level `claude:` block). */
export const HOOK_FILE = "hook.yaml";

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * A path inside a definition: relative, `/`-separated segments of letters, digits, `.`, `_` and `-`, none of them `.` or
 * `..`. A segment may start with a dot (`.claude/skills/x` is where repositories keep skills); whether dotfiles belong in
 * a given definition is the collector's and the installer's decision, not the path rule's. The same function lives in
 * src/cloud/protocol.ts, which must stay free of imports.
 */
export function isDefinitionPath(value: string): boolean {
  if (!value || value.length > 512) return false;
  return value.split("/").every((segment) => SEGMENT_RE.test(segment) && segment !== "." && segment !== "..");
}

export interface DefinitionFile {
  /** Relative to the definition's root, with `/` separators. */
  path: string;
  /** Hex SHA-256 of the file's bytes. */
  sha256: string;
  bytes: number;
  /** The file's text, when it is UTF-8 and within the limits. */
  text?: string;
  /** Why `text` is absent. */
  text_omitted?: "binary" | "too_large";
}

export interface SkillDefinition {
  /** Hex SHA-256 over the kind, the name and the sorted `(path, sha256)` pairs: the same files hash alike wherever they sit. */
  sha256: string;
  kind: DefinitionKind;
  name: string;
  files: DefinitionFile[];
  /** The size of every listed file, text present or not. */
  bytes: number;
  /** Files beyond `DEFINITION_LIMITS.max_files` that were not listed. */
  files_omitted?: number;
}

/** What a skill summary and a `skill.changed` event carry about the definition: enough to know whether the cloud has it. */
export interface DefinitionSummary {
  sha256: string;
  kind: DefinitionKind;
  bytes: number;
  files: number;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Whether `bytes` decode as UTF-8 without loss. */
function isUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The definition's hash: over the kind, the name and the files' paths and content hashes, sorted, never over absolute paths or times. */
export function definitionDigest(kind: DefinitionKind, name: string, files: readonly { path: string; sha256: string }[]): string {
  const sorted = [...files].map((f) => [f.path, f.sha256] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Hex(JSON.stringify({ v: 1, kind, name, files: sorted }));
}

/**
 * Builds a definition from files given as bytes or text (tests, the fake cloud and the collector below share this).
 * Files are sorted by path; text is kept while the per-file and total limits allow and the bytes are UTF-8.
 */
export function buildDefinition(kind: DefinitionKind, name: string, files: Record<string, Buffer | string>, options: { omitted?: number } = {}): SkillDefinition {
  const entries = Object.entries(files)
    .map(([file, content]) => [file, typeof content === "string" ? Buffer.from(content, "utf8") : content] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let total = 0;
  let bytes = 0;
  const listed: DefinitionFile[] = entries.map(([file, content]) => {
    bytes += content.length;
    const entry: DefinitionFile = { path: file, sha256: sha256Hex(content), bytes: content.length };
    if (content.length > DEFINITION_LIMITS.max_file_bytes || total + content.length > DEFINITION_LIMITS.max_bytes) entry.text_omitted = "too_large";
    else if (!isUtf8(content)) entry.text_omitted = "binary";
    else {
      entry.text = content.toString("utf8");
      total += content.length;
    }
    return entry;
  });
  return { sha256: definitionDigest(kind, name, listed), kind, name, files: listed, bytes, ...(options.omitted ? { files_omitted: options.omitted } : {}) };
}

export function summarizeDefinition(definition: SkillDefinition): DefinitionSummary {
  return { sha256: definition.sha256, kind: definition.kind, bytes: definition.bytes, files: definition.files.length };
}

/** Directories never part of a definition. */
const SKIPPED_DIRS = new Set(["node_modules", "__pycache__"]);

/** Every regular file under `dir` (no dotfiles, no symlinks, no `node_modules`), as `/`-separated relative paths, sorted. */
export function listDefinitionFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path.join(current, entry.name), relative);
        continue;
      }
      if (entry.isFile() && isDefinitionPath(relative)) out.push(relative);
    }
  };
  walk(dir, "");
  return out;
}

/** A hook's own part of its `skillhook.yaml`: the file-level `claude:` block and the hook under its name, as canonical YAML. */
export function hookYaml(projectFileText: string, name: string): string {
  const raw = YAML.parse(projectFileText) as unknown;
  const file = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const hooks = file.hooks && typeof file.hooks === "object" && !Array.isArray(file.hooks) ? (file.hooks as Record<string, unknown>) : {};
  return YAML.stringify({ ...(file.claude !== undefined ? { claude: file.claude } : {}), hooks: { [name]: hooks[name] ?? {} } });
}

/** The files of a skill directory, read; `relativeTo` prefixes their paths (a hook's SKILL.md sits inside its repository). */
function readDirectoryFiles(dir: string, prefix: string): { files: Record<string, Buffer>; omitted: number } {
  const names = listDefinitionFiles(dir);
  const files: Record<string, Buffer> = {};
  for (const name of names.slice(0, DEFINITION_LIMITS.max_files)) {
    try {
      files[prefix ? `${prefix}/${name}` : name] = readFileSync(path.join(dir, name));
    } catch {
      // A file that vanished between the listing and the read is not part of the definition.
    }
  }
  return { files, omitted: Math.max(0, names.length - DEFINITION_LIMITS.max_files) };
}

/** Where a hook's SKILL.md directory sits inside the definition: its path in the repository, or `external/<name>` when it lies outside it. */
function hookSkillPrefix(projectDir: string, skillDir: string): string {
  const relative = path.relative(projectDir, skillDir).split(path.sep).join("/");
  if (!relative || relative === "." || relative.startsWith("../") || relative === ".." || path.isAbsolute(relative) || !isDefinitionPath(relative)) return `external/${path.basename(skillDir)}`;
  return relative;
}

/** Collects a skill's whole definition, text included. Ad-hoc skills (a job's own copy) have none. */
export function collectDefinition(skill: Skill): SkillDefinition | undefined {
  const source = skill.source;
  if (source.type === "adhoc") return undefined;
  if (source.type === "project") {
    let yamlText: string;
    try {
      yamlText = readFileSync(source.file, "utf8");
    } catch {
      return undefined;
    }
    const files: Record<string, Buffer | string> = { [HOOK_FILE]: hookYaml(yamlText, skill.name) };
    let omitted = 0;
    if (source.kind === "skill") {
      const read = readDirectoryFiles(skill.dir, hookSkillPrefix(source.dir, skill.dir));
      Object.assign(files, read.files);
      omitted = read.omitted;
    }
    return buildDefinition("hook", skill.name, files, { omitted });
  }
  const read = readDirectoryFiles(skill.dir, "");
  if (!read.files["SKILL.md"]) return undefined;
  return buildDefinition("skill", skill.name, read.files, { omitted: read.omitted });
}

/** A stamp of the files a definition is built from (paths, sizes, mtimes): equal stamps mean an unchanged definition. */
function definitionStamp(skill: Skill): string {
  const parts: string[] = [];
  const stat = (file: string) => {
    try {
      const s = statSync(file);
      parts.push(`${file}:${s.size}:${s.mtimeMs}`);
    } catch {
      parts.push(`${file}:-`);
    }
  };
  if (skill.source.type === "project") {
    stat(skill.source.file);
    if (skill.source.kind !== "skill") return parts.join("\n");
  }
  for (const name of listDefinitionFiles(skill.dir)) stat(path.join(skill.dir, name));
  try {
    parts.push(`dir:${lstatSync(skill.dir).mtimeMs}`);
  } catch {
    parts.push("dir:-");
  }
  return parts.join("\n");
}

/** Definitions by skill, recomputed only when one of their files changed (the registry lists skills far more often than they change). */
export class DefinitionCache {
  private readonly entries = new Map<string, { stamp: string; summary: DefinitionSummary }>();

  /** The summary for `skill`, from the cache when its files are unchanged; undefined for a skill without a definition. */
  summary(skill: Skill): DefinitionSummary | undefined {
    if (skill.source.type === "adhoc") return undefined;
    const key = `${skill.source.type}:${skill.file}:${skill.name}`;
    const stamp = definitionStamp(skill);
    const cached = this.entries.get(key);
    if (cached && cached.stamp === stamp) return cached.summary;
    const definition = collectDefinition(skill);
    if (!definition) {
      this.entries.delete(key);
      return undefined;
    }
    const summary = summarizeDefinition(definition);
    this.entries.set(key, { stamp, summary });
    return summary;
  }
}
