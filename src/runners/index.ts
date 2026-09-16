import type { RunnerName } from "../config.js";
import { claudeRunner } from "./claude.js";
import { codexRunner } from "./codex.js";
import { shellRunner } from "./shell.js";
import type { Runner } from "./types.js";

export const RUNNERS: Record<RunnerName, Runner> = {
  claude: claudeRunner,
  codex: codexRunner,
  shell: shellRunner,
};

export function getRunner(name: RunnerName): Runner {
  const runner = RUNNERS[name];
  if (!runner) throw new Error(`Unknown runner "${name}"`);
  return runner;
}

export * from "./types.js";
export { buildRunEnv, mergedPath } from "./env.js";
export { claudeRunner, codexRunner, shellRunner };
