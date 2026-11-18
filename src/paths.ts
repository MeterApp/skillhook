import { homedir } from "node:os";
import path from "node:path";
import { expandTilde } from "./util.js";

export interface Paths {
  /** The skillhook directory (default `~/.skillhook`, override with `SKILLHOOK_HOME` or `--dir`). */
  home: string;
  configFile: string;
  envFile: string;
  skillsDir: string;
  /** Skills Skillhook Cloud assigns to this machine (`cloud.managed_skills`): `<name>/<sha256>/<name>/SKILL.md` and `.state.json`, written only by the cloud link. */
  cloudSkillsDir: string;
  jobsDir: string;
  logsDir: string;
  /** Written by `serve` so other commands (CLI, MCP) can find the running server. */
  serverStateFile: string;
}

export const DEFAULT_HOME_DIRNAME = ".skillhook";

export function resolveHome(dir?: string | null): string {
  const candidate = dir?.trim() || process.env.SKILLHOOK_HOME?.trim() || path.join(homedir(), DEFAULT_HOME_DIRNAME);
  return path.resolve(expandTilde(candidate));
}

export function pathsFor(home: string): Paths {
  return {
    home,
    configFile: path.join(home, "skillhook.json"),
    envFile: path.join(home, ".env"),
    skillsDir: path.join(home, "skills"),
    cloudSkillsDir: path.join(home, "cloud-skills"),
    jobsDir: path.join(home, "jobs"),
    logsDir: path.join(home, "logs"),
    serverStateFile: path.join(home, "server.json"),
  };
}

export function resolvePaths(dir?: string | null): Paths {
  return pathsFor(resolveHome(dir));
}
