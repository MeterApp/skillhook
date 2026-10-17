// Shared helpers for this repository's own Skillhook hooks (skillhook.yaml at the root).
// Plain Node ESM, no dependencies and no build: the hooks run before `npm ci` ever has.
//
// Host layout (the Mac mini):
//   ~/dev/skillhook             the served checkout of main, linked with `skillhook link`
//   ~/dev/skillhook-wt          private job worktrees, one per agent run, cut from origin/main
//   ~/.skillhook/skillhook-cli  host state: merge queue, health state, dispatch receipts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPO = "MeterApp/skillhook";
export const PACKAGE = "@meterapp/skillhook";
/** Every GitHub comment, issue and PR body the automation writes starts with this, so it never triggers itself. */
export const MARKER = "<!-- skillhook-cli-skillhook -->";
/** Private job worktrees live beside the served checkout, never inside it. */
export const WORKTREES = path.join(os.homedir(), "dev/skillhook-wt");
export const root = path.resolve(import.meta.dirname, "../..");

/** Host state for these hooks: `<SKILLHOOK_HOME>/skillhook-cli` (~/.skillhook/skillhook-cli). */
export function stateDir(env = process.env) {
  const home = env.SKILLHOOK_HOME || path.join(os.homedir(), ".skillhook");
  const dir = path.join(home, "skillhook-cli");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * The environment for `gh`: a GH_TOKEN / GITHUB_TOKEN the host shares with other apps may
 * belong to another account, so gh uses its own login on this machine.
 */
export function ghEnv(env = process.env) {
  const next = { ...env, GH_PROMPT_DISABLED: "1" };
  delete next.GH_TOKEN;
  delete next.GITHUB_TOKEN;
  return next;
}

export function command(bin, args, options = {}) {
  const env = bin === "gh" ? ghEnv(options.env ?? process.env) : options.env ?? process.env;
  return execFileSync(bin, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options, env }).trim();
}

export function gh(args, options = {}) {
  return command("gh", args, options);
}

export function ghJson(args, options = {}) {
  return JSON.parse(gh(args, options) || "null");
}

/** Fast-forwards the served checkout; refuses (and leaves untouched) a dirty or off-main tree. */
export function sync(cwd = root) {
  const git = (args) => command("git", args, { cwd });
  const branch = git(["branch", "--show-current"]);
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  if (branch !== "main") throw new Error(`Served checkout is on "${branch || "a detached HEAD"}", not main; left untouched`);
  if (dirty) throw new Error("Served checkout has local changes; left untouched");
  const before = git(["rev-parse", "HEAD"]);
  git(["fetch", "--quiet", "origin", "main"]);
  git(["merge", "--ff-only", "--quiet", "origin/main"]);
  return { before, after: git(["rev-parse", "HEAD"]) };
}

/** A private worktree per job, cut from origin/main. Re-entrant for the same job id. */
export function workspace(lane, env = process.env) {
  const job = env.SKILLHOOK_JOB_ID ?? `manual-${Date.now()}`;
  if (!/^[a-zA-Z0-9-]+$/.test(job)) throw new Error("Invalid job ID");
  if (!/^[a-z0-9-]+$/.test(lane)) throw new Error("Invalid lane");
  const dir = path.join(WORKTREES, `skillhook-${lane}-${job}`);
  if (fs.existsSync(dir)) return dir;
  fs.mkdirSync(WORKTREES, { recursive: true });
  command("git", ["fetch", "--quiet", "origin", "main"]);
  command("git", ["worktree", "add", "--quiet", "-b", `skillhook/${lane}-${job}`, dir, "origin/main"]);
  return dir;
}

/** Writes a JSON file atomically with owner-only permissions. */
export function saveJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

/** Writes the structured job response Skillhook reads (`response: { mode: file }`). */
export function outcome(value, env = process.env) {
  if (env.SKILLHOOK_RESPONSE_PATH) fs.writeFileSync(env.SKILLHOOK_RESPONSE_PATH, JSON.stringify(value, null, 2));
  console.log(JSON.stringify(value));
}

/** True when this module is the script node was started with. */
export function isMain(url) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(url);
}

/** Prints the first line of an error, records a failed outcome and sets the exit code. */
export function fail(error, summary, env = process.env) {
  console.error(String(error?.message ?? error).split("\n")[0]);
  outcome({ outcome: "failed", summary }, env);
  process.exitCode = 1;
}
