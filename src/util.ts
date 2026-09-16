import { mkdirSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/** Shortens a path under the home directory to `~/…` for display. */
export function displayPath(p: string, home = homedir()): string {
  if (p === home) return "~";
  return p.startsWith(`${home}${path.sep}`) ? `~${p.slice(home.length)}` : p;
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function readJsonFile<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function readJsonFileOr<T>(file: string, fallback: T): T {
  try {
    return readJsonFile<T>(file);
  } catch {
    return fallback;
  }
}

/** Atomic JSON write (write to a sibling temp file, then rename). */
export function writeJsonFile(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function truncate(text: string, max: number, note = "… [truncated]"): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - note.length))}${note}`;
}

export function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/** Removes every trailing occurrence of `char` in linear time (a regex such as `/x*$/` backtracks quadratically on long runs). */
export function trimTrailing(text: string, char: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === char) end--;
  return end === text.length ? text : text.slice(0, end);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Dotted-path lookup (`a.b.0.c`) into plain data. Returns undefined when any segment is missing. */
export function getPath(value: unknown, dotted: string): unknown {
  if (!dotted) return value;
  let current: unknown = value;
  for (const segment of dotted.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Stringifies for humans: strings as-is, everything else as JSON. */
export function display(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64);
}

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && SKILL_NAME_RE.test(name);
}
