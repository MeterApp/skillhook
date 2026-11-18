// The file model of cloud-managed skills: `<home>/cloud-skills/.state.json` says which definition (by content hash) each
// skill currently serves, and `<home>/cloud-skills/<name>/<sha256>/<name>/SKILL.md` holds the files of every version
// kept. The registry reads this (so a change is live without a restart) and src/cloud/managed.ts writes it; nothing
// else does. Kept apart from the cloud code so the registry and the CLI depend on no networking.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MANAGED_STATE_FILE = ".state.json";

export interface ManagedEntry {
  /** The definition this skill serves (src/definitions.ts). */
  sha256: string;
  installed_at: string;
  /** Who asked (the cloud command's requester, `sync`, `adopt`). */
  by?: string;
  /** A person accepted `auth: none` for this skill. */
  allow_unauthenticated?: boolean;
  /** Earlier definitions still on disk, newest first (at most two). */
  previous?: string[];
  /** For a skill adopted from `<home>/skills`: where its old directory was kept. */
  adopted_from?: string;
}

export interface ManagedState {
  version: 1;
  skills: Record<string, ManagedEntry>;
}

export function managedStateFile(dir: string): string {
  return path.join(dir, MANAGED_STATE_FILE);
}

/** The directory a version's SKILL.md lives in (its basename is the skill's name, as a SKILL.md requires). */
export function managedSkillDir(dir: string, name: string, sha256: string): string {
  return path.join(dir, name, sha256, name);
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/** The state, or an empty one when the file is missing or unreadable (a broken file never takes every skill down). */
export function readManagedState(dir: string): ManagedState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(managedStateFile(dir), "utf8")) as unknown;
  } catch {
    return { version: 1, skills: {} };
  }
  const skills: Record<string, ManagedEntry> = {};
  const record = raw && typeof raw === "object" ? (raw as { skills?: unknown }).skills : undefined;
  if (record && typeof record === "object" && !Array.isArray(record)) {
    for (const [name, value] of Object.entries(record as Record<string, unknown>)) {
      if (name === "__proto__" || !value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) continue;
      skills[name] = {
        sha256: entry.sha256,
        installed_at: typeof entry.installed_at === "string" && entry.installed_at.length >= 20 ? entry.installed_at : "1970-01-01T00:00:00.000Z",
        ...(typeof entry.by === "string" ? { by: entry.by } : {}),
        ...(entry.allow_unauthenticated === true ? { allow_unauthenticated: true } : {}),
        ...(Array.isArray(entry.previous) ? { previous: entry.previous.filter((p): p is string => typeof p === "string" && SHA256_RE.test(p)) } : {}),
        ...(typeof entry.adopted_from === "string" ? { adopted_from: entry.adopted_from } : {}),
      };
    }
  }
  return { version: 1, skills };
}

/** Writes the state atomically (a temporary file renamed into place). */
export function writeManagedState(dir: string, state: ManagedState): void {
  mkdirSync(dir, { recursive: true });
  const file = managedStateFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** The state, re-read only when the file's mtime changed (what the registry calls on every lookup). */
export function managedStateReader(dir: string): () => ManagedState {
  let stamp = -1;
  let cached: ManagedState = { version: 1, skills: {} };
  return () => {
    let mtime = 0;
    try {
      mtime = statSync(managedStateFile(dir)).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (mtime !== stamp) {
      stamp = mtime;
      cached = readManagedState(dir);
    }
    return cached;
  };
}
