import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureDir, exists } from "./util.js";
import type { Paths } from "./paths.js";

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/;

/** Parses dotenv-style text. Supports `export KEY=`, single/double quotes and `#` comments. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = LINE_RE.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    let value = (match[2] ?? "").trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

function quote(value: string): string {
  if (/^[A-Za-z0-9_@./:+=-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function readEnvFile(file: string): Record<string, string> {
  if (!exists(file)) return {};
  return parseEnv(readFileSync(file, "utf8"));
}

/** Rewrites a single key in the env file, preserving the other lines and comments. Creates the file (mode 600) if needed. */
export function upsertEnvVar(file: string, key: string, value: string): void {
  ensureDir(path.dirname(file));
  const current = exists(file) ? readFileSync(file, "utf8") : "";
  const lines = current.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((line) => {
    const match = LINE_RE.exec(line);
    if (match && match[1] === key && !line.trim().startsWith("#")) {
      replaced = true;
      return `${key}=${quote(value)}`;
    }
    return line;
  });
  if (!replaced) {
    if (next.length && next[next.length - 1] !== "") next.push("");
    next.splice(next.length - 1, 0, `${key}=${quote(value)}`);
  }
  writeFileSync(file, next.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  ensureSecretFileMode(file);
}

export function removeEnvVar(file: string, key: string): boolean {
  if (!exists(file)) return false;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const kept = lines.filter((line) => {
    const match = LINE_RE.exec(line);
    return !(match && match[1] === key && !line.trim().startsWith("#"));
  });
  const removed = kept.length !== lines.length;
  if (removed) writeFileSync(file, kept.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  return removed;
}

export function ensureSecretFileMode(file: string): void {
  try {
    const mode = statSync(file).mode & 0o777;
    if (mode !== 0o600) chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
}

export function secretFileMode(file: string): number | null {
  try {
    return statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

export type Secrets = Readonly<Record<string, string>>;

/**
 * Secrets visible to the server: the `.env` file in the skillhook directory, with the process
 * environment layered on top (so `SKILLHOOK_SECRET_X=... skillhook serve` still overrides).
 */
export function loadSecrets(paths: Paths, env: NodeJS.ProcessEnv = process.env): Secrets {
  const fromFile = readEnvFile(paths.envFile);
  const merged: Record<string, string> = { ...fromFile };
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") merged[key] = value;
  }
  return merged;
}

/** Env var name that holds a skill's default bearer secret: `SKILLHOOK_SECRET_<NAME>`. */
export function defaultSecretEnvFor(skillName: string): string {
  return `SKILLHOOK_SECRET_${skillName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export const ADMIN_TOKEN_ENV = "SKILLHOOK_ADMIN_TOKEN";

/** Never print these; used by `secret list` and redaction. */
export function redactValue(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 3)}…${value.slice(-2)} (${value.length} chars)`;
}
