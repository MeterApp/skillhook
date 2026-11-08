import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveProject } from "./projects.js";
import type { Skill } from "./skills.js";

const exec = promisify(execFile);
const refreshing = new Map<string, Promise<string>>();

function canonicalProject(entry: string, base: string): string {
  const { dir } = resolveProject(entry, base);
  try { return realpathSync(dir); } catch { return dir; }
}

/** Resolve only explicitly opted-in projects; never run Git for discovery or home skills. */
export function refreshProjectDir(entries: readonly string[], dir: string, base: string): string | undefined {
  if (!entries.length) return undefined;
  const canonical = canonicalProject(dir, base);
  return entries.some((entry) => canonicalProject(entry, base) === canonical) ? canonical : undefined;
}

/** Record what authorized a webhook without saving credentials or any request material. */
export function webhookPolicy(skill: Skill): string {
  return createHash("sha256").update(JSON.stringify({
    auth: skill.auth,
    when: skill.config.when,
    dedupe: skill.config.dedupe,
    webhook: skill.webhook,
  })).digest("hex");
}

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0" };
const gitOptions = { encoding: "utf8" as const, timeout: 20_000, env: gitEnv, maxBuffer: 64 * 1024 };
const gitConfig = ["-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false"];
const headArgs = ["rev-parse", "--verify", "HEAD^{commit}"];

function localGit(dir: string, args: string[]): string {
  return execFileSync("git", [...gitConfig, ...args], {
    ...gitOptions, timeout: 3_000, cwd: dir, stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function refresh(dir: string): Promise<string> {
  async function git(...args: string[]): Promise<string> {
    try {
      const { stdout } = await exec("git", [...gitConfig, ...args], { cwd: dir, ...gitOptions });
      return stdout.trim();
    } catch {
      // Git stderr can contain credentials embedded in a remote URL.
      throw new Error(`project refresh: git ${args[0]} failed or exceeded 20 seconds`);
    }
  }

  const root = await git("rev-parse", "--show-toplevel");
  if (realpathSync(root) !== dir) throw new Error("project refresh: link the Git checkout root");
  // Fetch a named ref atomically; another tool's FETCH_HEAD is not a source of truth.
  await git("fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head",
    "origin", "+refs/heads/main:refs/remotes/origin/main");
  const target = await git("rev-parse", "--verify", "refs/remotes/origin/main^{commit}");
  if (await git("branch", "--show-current") !== "main" || await git("status", "--porcelain", "--untracked-files=no")) {
    throw new Error("project refresh: checkout must be on main with no tracked changes");
  }
  const head = await git(...headArgs);
  if (head !== target) {
    try {
      await git("merge-base", "--is-ancestor", head, target);
    } catch {
      throw new Error("project refresh: local main cannot fast-forward to origin/main");
    }
    await git("merge", "--quiet", "--ff-only", target);
  }
  assertProjectCommit(dir, target);
  return target;
}

/** A concurrent dispatch can share the fetch already in flight for this checkout. */
export async function refreshProject(dir: string): Promise<string> {
  const active = refreshing.get(dir);
  if (active) return active;
  const pending = refresh(dir);
  refreshing.set(dir, pending);
  try { return await pending; }
  finally { refreshing.delete(dir); }
}

/** Check immediately before spawning, after account probes and any retry delay. */
export function assertProjectCommit(dir: string, expected: string): void {
  try {
    const head = localGit(dir, headArgs);
    const changes = localGit(dir, ["status", "--porcelain", "--untracked-files=no"]);
    if (head === expected && !changes) return;
  } catch { /* fail closed if the checkout was moved or Git is unavailable */ }
  throw new Error("project refresh: the checkout changed before the runner started");
}


/** The SHA only identifies files actually supplied by the refreshed Git tree. */
export function assertProjectDefinition(dir: string, commit: string, projectFile: string, skillFile: string): void {
  for (const file of new Set([projectFile, skillFile])) {
    try {
      const relative = path.relative(dir, realpathSync(file));
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error();
      if (localGit(dir, ["cat-file", "-t", `${commit}:${relative}`]) === "blob") continue;
    } catch { /* do not claim an untracked or external definition came from this revision */ }
    throw new Error("project refresh: hook and skill files must be tracked inside the refreshed checkout");
  }
}
