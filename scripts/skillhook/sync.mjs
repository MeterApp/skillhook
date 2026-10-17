// Hook skillhook-repo-sync: fast-forward the served checkout (~/dev/skillhook) to origin/main.
// A checkout with local changes or on another branch fails the job and is left untouched. Skillhook
// re-reads skillhook.yaml when it changes, so this is also how a hook change is deployed.
import { fail, isMain, outcome, sync } from "./runtime.mjs";

if (isMain(import.meta.url)) {
  try {
    if (process.argv.includes("--dry-run")) {
      outcome({ outcome: "completed", summary: "Dry run: would fast-forward the clean served checkout to origin/main" });
    } else {
      const { before, after } = sync();
      outcome(before === after
        ? { outcome: "nothing_to_do", summary: `Served checkout already at ${after.slice(0, 7)}` }
        : { outcome: "completed", summary: `Served checkout ${before.slice(0, 7)} → ${after.slice(0, 7)}` });
    }
  } catch (error) {
    fail(error, "Served checkout not updated (dirty, off main, or not a fast-forward); left untouched");
  }
}
