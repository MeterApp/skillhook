import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathsFor, type Paths } from "../paths.js";
import { ensureDir } from "../util.js";

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test/fixtures");
export const FAKE_CLAUDE = [process.execPath, path.join(FIXTURES, "fake-claude.mjs")];
export const FAKE_CODEX = [process.execPath, path.join(FIXTURES, "fake-codex.mjs")];

export function tempHome(prefix = "skillhook-test-"): Paths {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  const paths = pathsFor(home);
  ensureDir(paths.skillsDir);
  ensureDir(paths.jobsDir);
  return paths;
}

export function writeSkill(paths: Paths, name: string, frontmatter: string, body = "Do the thing.\n"): string {
  const dir = path.join(paths.skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n${frontmatter.trimEnd()}\n---\n\n${body}`);
  return dir;
}

export function writeEnv(paths: Paths, vars: Record<string, string>): void {
  writeFileSync(paths.envFile, `${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n")}\n`, { mode: 0o600 });
}

export function writeConfigFile(paths: Paths, config: Record<string, unknown>): void {
  writeFileSync(paths.configFile, JSON.stringify(config, null, 2));
}
