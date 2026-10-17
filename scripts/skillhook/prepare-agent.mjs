// First command of the skillhook-agent hook: `node scripts/skillhook/prepare-agent.mjs <lane>`.
// Creates the job's private worktree under ~/dev/skillhook-wt from origin/main and prints its path.
// The agent works there; the served checkout (~/dev/skillhook) is never edited.
import { isMain, workspace } from "./runtime.mjs";

export const LANES = ["task"];

if (isMain(import.meta.url)) {
  try {
    const lane = process.argv[2];
    if (!LANES.includes(lane)) throw new Error(`Unknown agent lane; expected one of ${LANES.join(", ")}`);
    if (process.argv.includes("--dry-run")) console.log(JSON.stringify({ lane, plan: "Create a private job worktree from origin/main under ~/dev/skillhook-wt" }));
    else console.log(workspace(lane));
  } catch (error) {
    // No outcome file here: the agent that runs this owns the job's response.
    console.error(`Could not prepare the job worktree: ${String(error.message).split("\n")[0]}`);
    process.exitCode = 1;
  }
}
