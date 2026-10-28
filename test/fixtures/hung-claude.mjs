#!/usr/bin/env node
// Emulates a `claude` whose every subcommand hangs the way Claude Code's binary did behind a stuck macOS keychain
// dialog: it prints nothing, never exits on its own and ignores SIGTERM (Bun binaries do), so only SIGKILL ends it.
// HUNG_CLAUDE_PID_FILE=<file> records its pid, so a test can check that it was killed.
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {
  /* ignored, like the real binary */
});
process.on("SIGINT", () => {
  /* ignored */
});
if (process.env.HUNG_CLAUDE_PID_FILE) writeFileSync(process.env.HUNG_CLAUDE_PID_FILE, `${process.pid}\n`);
setInterval(() => {}, 60_000);
