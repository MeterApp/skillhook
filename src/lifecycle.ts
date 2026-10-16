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
