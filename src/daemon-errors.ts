import type { DaemonSentry } from "./sentry.js";

/** Fatal errors still terminate with status 1; wait only a bounded interval for the error envelope. */
export function installDaemonErrorReporting(
  sentry: Pick<DaemonSentry, "capture" | "flush">,
  options: {
    events?: Pick<NodeJS.Process, "on" | "removeListener">;
    beforeExit?: () => void;
    log?: (operation: string, cause: unknown) => void;
    exit?: (code: number) => void;
  } = {},
): () => void {
  const events = options.events ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let fatal = false;
  let exited = false;
  const exitOnce = () => { if (!exited) { exited = true; exit(1); } };
  const report = (operation: string, cause: unknown) => {
    if (fatal) return;
    fatal = true;
    try { (options.log ?? console.error)(operation, cause); } catch { /* preserve the fatal exit */ }
    try { options.beforeExit?.(); } catch { /* preserve the fatal exit */ }
    try { sentry.capture(operation, cause); } catch { /* never mask a fatal error */ }
    // Independent deadline still works if a future transport's flush never settles.
    const timer = setTimeout(exitOnce, 3_500);
    void Promise.resolve().then(() => sentry.flush(3_000)).catch(() => false).finally(() => {
      clearTimeout(timer);
      exitOnce();
    });
  };
  const uncaught = (error: unknown) => report("daemon uncaught exception", error);
  const rejection = (reason: unknown) => report("daemon unhandled rejection", reason);
  events.on("uncaughtException", uncaught);
  events.on("unhandledRejection", rejection);
  return () => {
    events.removeListener("uncaughtException", uncaught);
    events.removeListener("unhandledRejection", rejection);
  };
}
