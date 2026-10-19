// First command of the skillhook-agent hook: `node scripts/skillhook/prepare-agent.mjs task`; each subagent
// it spawns runs `node scripts/skillhook/prepare-agent.mjs sub-<piece>` for a worktree of its own.
// Creates the job's private worktree under ~/dev/skillhook-wt from origin/main and prints its path.
// The agent works there; the served checkout (~/dev/skillhook) is never edited.
import { isMain, workspace } from "./runtime.mjs";

export const LANES = ["task"];
/** `task`, or `sub-<piece>` for a subagent's own worktree within the same job (one writer per set of files). */
export function validLane(lane) {
  return LANES.includes(lane) || /^sub-[a-z0-9][a-z0-9-]{0,30}$/.test(lane ?? "");
}

if (isMain(import.meta.url)) {
  try {
    const lane = process.argv[2];
    if (!validLane(lane)) throw new Error(`Unknown agent lane; expected ${LANES.join(", ")} or sub-<piece>`);
    if (process.argv.includes("--dry-run")) console.log(JSON.stringify({ lane, plan: "Create a private job worktree from origin/main under ~/dev/skillhook-wt" }));
    else console.log(workspace(lane));
  } catch (error) {
    // No outcome file here: the agent that runs this owns the job's response.
    console.error(`Could not prepare the job worktree: ${String(error.message).split("\n")[0]}`);
    process.exitCode = 1;
  }
}
