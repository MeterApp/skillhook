import type { JobQueue } from "./queue.js";

/** Commit a restart only after the queue is idle; a bounded timeout always restores dispatch. */
export async function prepareRestart(queue: Pick<JobQueue, "drain" | "resumeDispatch" | "shutdown">, options: { force: boolean; waitSeconds: number }): Promise<boolean> {
  if (options.force) {
    await queue.shutdown();
    return true;
  }
  if ((await queue.drain(options.waitSeconds * 1000)) === 0) return true;
  queue.resumeDispatch();
  return false;
}

/**
 * The signals that stop `skillhook serve`, each the same way, with the signal's name as the reason (the last sync to
 * Skillhook Cloud carries it as `link.stopped` `reason`). SIGHUP comes from closing the terminal a server was started in
 * by hand. Node ends at once on it, under `nohup` too (Node resets inherited signal dispositions at startup), so the
 * cloud saw such a server go quiet exactly as after a crash and could not say why a new machine went offline (MI-029).
 * The terminal is gone by then and every write to it fails with EIO: after SIGHUP those stream errors are dropped, so
 * the shutdown's own log lines cannot turn it into an uncaught exception. On SIGINT/SIGTERM the terminal (if any) is
 * still there and its errors stay visible.
 */
export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type StopSignal = (typeof STOP_SIGNALS)[number];

interface StreamErrors { on(event: "error", listener: (error: Error) => void): unknown }
export interface SignalTarget {
  on(event: StopSignal, listener: () => void): unknown;
  stdout: StreamErrors;
  stderr: StreamErrors;
}

export function installStopSignals(stop: (signal: StopSignal) => void, target: SignalTarget = process): void {
  let terminalGone = false;
  for (const signal of STOP_SIGNALS) {
    target.on(signal, () => {
      if (signal === "SIGHUP" && !terminalGone) {
        terminalGone = true;
        for (const stream of [target.stdout, target.stderr]) stream.on("error", () => {});
      }
      stop(signal);
    });
  }
}
