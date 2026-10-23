// A desktop notification, best effort: `osascript` on macOS, `notify-send` on Linux. Argv only, never a shell; the
// text is the caller's (an account's name and state), never a webhook payload. Used by `accounts check --notify` and,
// with `account_policy.notify: desktop`, by `serve` when an account stops being usable.
import { spawn } from "node:child_process";

function appleScriptString(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function notifyDesktop(title: string, body: string, platform: NodeJS.Platform = process.platform): boolean {
  const argv = platform === "darwin" ? ["osascript", "-e", `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`] : platform === "linux" ? ["notify-send", title, body] : undefined;
  if (!argv) return false;
  try {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* no notifier installed */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
