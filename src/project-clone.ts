// `skillhook link <remote>`: check a repository out under <home>/repos so a machine nobody set up by hand (a server,
// a container) can serve its hooks. Only a person's `link` command clones; the server never does. Git authenticates
// with whatever the machine already has (a credential helper, `gh auth setup-git`, an SSH key): skillhook holds no
// repository credential and refuses a URL that carries one.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface RemoteSpec {
  /** What `git clone` is given. */
  url: string;
  /** Path segments under <home>/repos, e.g. ["acme", "api"]. */
  segments: string[];
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function segmentsOf(pathname: string): string[] | undefined {
  const parts = pathname.split("/").filter(Boolean);
  const last = parts.at(-1);
  if (!last) return undefined;
  const repo = last.endsWith(".git") ? last.slice(0, -4) : last;
  const owner = parts.at(-2);
  const segments = owner ? [owner, repo] : [repo];
  return segments.every((s) => SEGMENT.test(s) && s !== "." && s !== "..") ? segments : undefined;
}

/**
 * A remote `link` clones: `github:owner/repo`, an https://, ssh:// or file:// URL, or `git@host:owner/repo.git`.
 * Anything else (a directory, a file) is `undefined`: a mistyped path never turns into a request to a server.
 * Throws for a remote it will not clone: a credential inside the URL, plain http or git://, or a path it cannot name.
 */
export function parseRemote(target: string): RemoteSpec | undefined {
  const github = /^(?:github|gh):([^/\s]+)\/([^/\s]+)$/.exec(target);
  if (github) {
    const segments = segmentsOf(`${github[1]}/${github[2]}`);
    if (!segments || segments.length !== 2) throw new Error(`Cannot read "${target}" as github:owner/repo`);
    return { url: `https://github.com/${segments[0]}/${segments[1]}.git`, segments };
  }
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):([^\s]+)$/.exec(target);
  if (scp) {
    const segments = segmentsOf(scp[2]!);
    if (!segments) throw new Error(`Cannot name a directory for "${target}"`);
    return { url: target, segments };
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return undefined;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(`Not a URL: ${target}`);
  }
  if (!["https:", "ssh:", "file:"].includes(url.protocol)) throw new Error(`skillhook clones https://, ssh:// and file:// remotes, not ${url.protocol}//`);
  if (url.password || (url.protocol === "https:" && url.username)) {
    throw new Error("The URL carries a credential, which Git would store in the checkout. Remove it and let Git authenticate itself (gh auth setup-git, a credential helper or an SSH key).");
  }
  const segments = segmentsOf(decodeURIComponent(url.pathname));
  if (!segments) throw new Error(`Cannot name a directory for "${target}"`);
  return { url: target, segments };
}

export function cloneDestination(home: string, spec: RemoteSpec, into?: string): string {
  return into ? path.resolve(into) : path.join(home, "repos", ...spec.segments);
}

const gitEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv, timeout = 10_000): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: gitEnv(env), timeout, encoding: "utf8", maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

export interface CloneResult {
  dir: string;
  /** False when the destination already held this repository. */
  cloned: boolean;
  /** The checked-out branch; `project_refresh` only follows `main`. */
  branch: string;
}

/**
 * Clone `spec` into `dest`, or accept `dest` when it already is a checkout of the same remote (so the command can be
 * run again). Never prompts; Git's own message is not repeated, since it can quote a credential helper's output.
 */
export async function cloneRemote(spec: RemoteSpec, dest: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 600_000): Promise<CloneResult> {
  if (existsSync(dest) && readdirSync(dest).length) {
    let origin: string;
    try {
      if (realpathSync(await git(dest, ["rev-parse", "--show-toplevel"], env)) !== realpathSync(dest)) throw new Error();
      origin = await git(dest, ["remote", "get-url", "origin"], env);
    } catch {
      throw new Error(`${dest} exists and is not a Git checkout root; choose another directory with --into`);
    }
    if (origin !== spec.url) throw new Error(`${dest} is a checkout of another remote; choose another directory with --into`);
    return { dir: realpathSync(dest), cloned: false, branch: await git(dest, ["branch", "--show-current"], env) };
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await git(path.dirname(dest), ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--no-recurse-submodules", "--", spec.url, dest], env, timeoutMs);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw new Error(missing ? "git is not installed" : `git clone failed for ${spec.url}: check that the repository exists and that Git can authenticate without a prompt (gh auth setup-git, a credential helper or an SSH key)`);
  }
  return { dir: realpathSync(dest), cloned: true, branch: await git(dest, ["branch", "--show-current"], env) };
}
