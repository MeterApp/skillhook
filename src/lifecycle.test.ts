import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { JobStore } from "./jobs.js";
import { prepareRestart } from "./lifecycle.js";
import { silentLogger } from "./logger.js";
import { createAdhocJob } from "./manual.js";
import { JobQueue } from "./queue.js";
import { SkillRegistry } from "./registry.js";
import { FAKE_CLAUDE, tempHome, writeConfigFile } from "./test-support/helpers.js";

function fixture() {
  const paths = tempHome("skillhook-drain-");
  writeConfigFile(paths, { concurrency: 1 });
  const config = loadConfig(paths);
  const store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 60 });
  const queue = new JobQueue({ store, config, registry: new SkillRegistry(paths.skillsDir), secrets: () => ({}), logger: silentLogger });
  const gate = path.join(paths.home, "release");
  const script = `const fs = require('node:fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) process.exit(0); }, 10);`;
  const skillMd = `---\nname: gated\ndescription: Gated shell.\nskillhook:\n  runner: shell\n  shell:\n    command: ${JSON.stringify([process.execPath, "-e", script])}\n---\nBody\n`;
  const create = (payload: unknown) => createAdhocJob({ config, store }, { skillMd, payload }).job;
  return { paths, store, queue, gate, create };
}

describe("bounded restart", () => {
  it("resumes dispatch after timeout without terminating a running job or losing newly queued work", async () => {
    const { store, queue, gate, create } = fixture();
    const active = create({ active: true });
    queue.enqueue(active);
    await vi.waitFor(() => expect(store.get(active.id)?.status).toBe("running"));
    const pid = store.get(active.id)?.pid;
    const attempt = prepareRestart(queue, { force: false, waitSeconds: 0.03 });
    const pending = create({ unique: "received-during-drain" });
    queue.enqueue(pending);
    expect(await attempt).toBe(false);
    expect(store.get(active.id)).toMatchObject({ status: "running", pid });
    expect(store.get(pending.id)?.status).toBe("queued");
    expect(store.readEvent(pending.id).payload).toEqual({ unique: "received-during-drain" });
    writeFileSync(gate, "done");
    expect((await queue.waitFor(active.id, 5000))?.status).toBe("succeeded");
    expect((await queue.waitFor(pending.id, 5000))?.status).toBe("succeeded");
    await queue.shutdown();
  });

  it("commits only when all active work finishes and leaves queued records intact for recovery", async () => {
    const { store, queue, gate, create } = fixture();
    const active = create({ active: true });
    queue.enqueue(active);
    await vi.waitFor(() => expect(store.get(active.id)?.status).toBe("running"));
    const pending = create({ unique: "queued" });
    queue.enqueue(pending);
    const before = store.get(pending.id);
    const attempt = prepareRestart(queue, { force: false, waitSeconds: 5 });
    writeFileSync(gate, "done");
    expect(await attempt).toBe(true);
    expect(queue.stats()).toEqual({ running: 0, queued: 1, running_ids: [] });
    expect(store.get(active.id)?.status).toBe("succeeded");
    expect(store.get(pending.id)).toEqual(before);
    const recovered = store.recoverOnStartup();
    expect(recovered.interrupted).toEqual([]);
    expect(recovered.queued.map((job) => job.id)).toEqual([pending.id]);
    expect(store.readEvent(pending.id).payload).toEqual({ unique: "queued" });
    await queue.shutdown();
  });

  it("keeps a question answerable during a drain", async () => {
    const paths = tempHome("skillhook-drain-question-");
    writeConfigFile(paths, { runners: { claude: { command: FAKE_CLAUDE } } });
    const config = loadConfig(paths);
    const store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 60 });
    const env = { FAKE_CLAUDE_ASK: "Continue?", FAKE_CLAUDE_ASK_WAIT_MS: "5000" };
    const queue = new JobQueue({ store, config, registry: new SkillRegistry(paths.skillsDir), secrets: () => env, logger: silentLogger, progressPollMs: 10 });
    const skillMd = '---\nname: asker\ndescription: Question.\nskillhook:\n  runner: claude\n  env: [FAKE_CLAUDE_ASK, FAKE_CLAUDE_ASK_WAIT_MS]\n---\nBody\n';
    const job = createAdhocJob({ config, store }, { skillMd, payload: {} }).job;
    queue.enqueue(job);
    await vi.waitFor(() => expect(store.get(job.id)?.question).toBeDefined());
    const attempt = prepareRestart(queue, { force: false, waitSeconds: 5 });
    queue.answer(job.id, { text: "Yes", by: "test" });
    expect(await attempt).toBe(true);
    const done = store.get(job.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.answer?.text).toBe("Yes");
    expect(done?.error ?? "").not.toContain("shut down");
    await queue.shutdown();
  });

  it("allows an active execution to retry normally while new dispatch is paused", async () => {
    const paths = tempHome("skillhook-drain-retry-");
    writeConfigFile(paths, { runners: { claude: { command: FAKE_CLAUDE } } });
    const config = loadConfig(paths);
    const store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 60 });
    const env = { FAKE_CLAUDE_FAIL_KIND: "rate_limit", FAKE_CLAUDE_SLEEP_MS: "100" };
    const queue = new JobQueue({ store, config, registry: new SkillRegistry(paths.skillsDir), secrets: () => env, logger: silentLogger });
    const skillMd = '---\nname: retrier\ndescription: Retry.\nskillhook:\n  runner: claude\n  env: [FAKE_CLAUDE_FAIL_KIND, FAKE_CLAUDE_SLEEP_MS]\n  retry:\n    attempts: 1\n    on: [rate_limit]\n    backoff_seconds: 0\n---\nBody\n';
    const job = createAdhocJob({ config, store }, { skillMd, payload: {} }).job;
    queue.enqueue(job);
    await vi.waitFor(() => expect(store.get(job.id)?.status).toBe("running"));
    expect(await prepareRestart(queue, { force: false, waitSeconds: 5 })).toBe(true);
    const done = store.get(job.id);
    expect(done?.status).toBe("failed");
    expect(done?.attempts).toHaveLength(1);
    expect(done?.attempts?.every((a) => a.status === "failed")).toBe(true);
    expect(done?.error ?? "").not.toContain("shut down");
    await queue.shutdown();
  });

  it("only the explicit force path invokes shutdown", async () => {
    const queue = { drain: vi.fn().mockResolvedValue(1), resumeDispatch: vi.fn(), shutdown: vi.fn().mockResolvedValue(undefined) };
    expect(await prepareRestart(queue, { force: false, waitSeconds: 1 })).toBe(false);
    expect(queue.shutdown).not.toHaveBeenCalled();
    expect(queue.resumeDispatch).toHaveBeenCalledOnce();
    expect(await prepareRestart(queue, { force: true, waitSeconds: 1 })).toBe(true);
    expect(queue.shutdown).toHaveBeenCalledOnce();
    expect(queue.drain).toHaveBeenCalledOnce();
  });
});
