import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { JobStore } from "./jobs.js";
import { silentLogger } from "./logger.js";
import { createManualJob } from "./manual.js";
import type { ReadinessCache } from "./readiness.js";
import { JobQueue } from "./queue.js";
import { SkillRegistry } from "./registry.js";
import { enqueueReplay, planReplay } from "./replay.js";
import { createControlHandlers } from "./cloud/control.js";
import type { CommandDeps } from "./cloud/commands.js";
import type { Command } from "./cloud/protocol.js";
import { tempHome, writeConfigFile, writeSkill } from "./test-support/helpers.js";

// Real subprocesses, gated by files in a disposable home; no real jobs or checkouts.
const command = `const fs=require('node:fs'), p=require('node:path');
const e=JSON.parse(fs.readFileSync(p.join(process.env.SKILLHOOK_JOB_DIR,'event.json'),'utf8')).payload;
if(e.draft) fs.writeFileSync('draft.txt','sibling edit');
if(e.clean) fs.rmSync(e.cleanPath||'draft.txt',{force:true});
fs.writeFileSync(p.join(process.env.SKILLHOOK_JOB_DIR,'spawned'),'1');
const timer=setInterval(()=>{if(!e.gate || fs.existsSync(e.gate)){clearInterval(timer);if(e.draft && fs.readFileSync('draft.txt','utf8')!=='sibling edit')process.exit(2);process.exit(e.fail?1:0);}},5);`;
function harness(concurrency = 1) {
  const paths = tempHome("skillhook-runtime-safety-");
  writeConfigFile(paths, { concurrency });
  const config = loadConfig(paths);
  const store = new JobStore(paths.jobsDir, { maxJobs: 1000, dedupeWindowSeconds: 60 });
  const registry = new SkillRegistry(paths.skillsDir);
  const secrets = () => ({});
  const queue = new JobQueue({ store, registry, config, secrets, logger: silentLogger });
  const deps = { paths, config, store, registry, queue, secrets, fileSecrets: secrets, logger: silentLogger };
  const skill = (name: string, cwd = paths.home, exclusive?: boolean, dedupe = true) => {
    writeSkill(paths, name, `description: fixture\nskillhook:\n  runner: shell\n  concurrency: 4\n${exclusive === undefined ? "" : `  serialize_cwd: ${exclusive}\n`}  dedupe: { in_flight: ${dedupe} }\n  cwd: ${JSON.stringify(cwd)}\n  shell:\n    command: ${JSON.stringify([process.execPath, "-e", command])}`);
    return registry.get(name)!;
  };
  const job = (name: string, payload: unknown, trigger: "api" | "replay" = "api") => createManualJob(deps, { skill: registry.get(name)!, payload, trigger });
  const gate = path.join(paths.home, "release");
  const release = () => writeFileSync(gate, "1");
  const spawned = async (id: string) => {
    const until = Date.now() + 10_000;
    while (!existsSync(path.join(store.pathsFor(id).dir, "spawned"))) {
      if (Date.now() > until) throw new Error(`job did not spawn: ${id}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const finish = async (id: string) => { expect((await queue.waitFor(id, 10_000))?.status).toBe("succeeded"); };
  return { ...deps, skill, job, gate, release, spawned, finish };
}

describe("recovery admission and fair scheduling", () => {
  it("folds repeated recovery, replay chains and cloud recovery of one source, but keeps separate turns", async () => {
    const h = harness(); h.skill("reply");
    const old = h.job("reply", { conversation: "same", source: "one", gate: h.gate });
    h.store.update(old.id, { status: "timed_out" });
    const plan = () => {
      const p = planReplay(h, { source: "job", id: old.id });
      if (!p.ok) throw new Error(p.reason);
      return p.input;
    };
    try {
      const first = enqueueReplay(h, plan());
      expect(first.duplicate).toBe(false);
      await h.spawned(first.job.id);
      expect(enqueueReplay(h, plan())).toMatchObject({ duplicate: true, job: { id: first.job.id } });
      const anotherOriginal = h.job("reply", { source: "one", gate: h.gate, conversation: "same" });
      h.store.update(anotherOriginal.id, { status: "failed" });
      const anotherPlan = planReplay(h, { source: "job", id: anotherOriginal.id });
      if (!anotherPlan.ok) throw new Error(anotherPlan.reason);
      expect(enqueueReplay(h, anotherPlan.input).job.id).toBe(first.job.id);
      const chain = planReplay(h, { source: "job", id: first.job.id });
      if (!chain.ok) throw new Error(chain.reason);
      expect(enqueueReplay(h, chain.input).job.id).toBe(first.job.id);
      const handlers = createControlHandlers(h);
      const cloud = await handlers["job.replay"]!({ id: old.id } as never, { id: "cloud-recovery", type: "job.replay", issued_at: new Date().toISOString() } as Command, {} as CommandDeps);
      expect(cloud.result).toMatchObject({ duplicate: true, in_flight: true, job_id: first.job.id });
      const second = enqueueReplay(h, { ...plan(), payload: { conversation: "same", source: "two", gate: h.gate } });
      expect(second.duplicate).toBe(false);
      expect(second.job.id).not.toBe(first.job.id);
      expect(enqueueReplay(h, { ...plan(), payload: { source: "two", conversation: "same", gate: h.gate } }).job.id).toBe(second.job.id);

      h.release();
      await h.finish(first.job.id); await h.finish(second.job.id);
      const later = enqueueReplay(h, plan());
      expect(later.duplicate).toBe(false); // not a permanent side-effect receipt
      await h.finish(later.job.id);
    } finally { h.release(); await h.queue.shutdown(); }
  });

  it("reuses a legacy queued binary job without a persisted fingerprint", async () => {
    const h = harness(); const skill = h.skill("reply");
    const blocker = h.job("reply", { gate: h.gate }); h.queue.enqueue(blocker); await h.spawned(blocker.id);
    const bytes = Buffer.from([0, 255, 128, 10]);
    const input = { skill, payload: { binary: true, bytes: 4 }, trigger: "replay" as const, body: { kind: "binary" as const, contentType: "application/octet-stream", raw: bytes } };
    const legacy = createManualJob(h, input);
    const retained = h.store.update(legacy.id, { fingerprint: undefined });
    h.queue.enqueue(retained);
    try {
      expect(enqueueReplay(h, input)).toMatchObject({ duplicate: true, job: { id: legacy.id } });
      expect(enqueueReplay(h, { ...input, body: { ...input.body, raw: Buffer.from([0, 255, 127, 10]) } }).duplicate).toBe(false);
    } finally { h.release(); await h.queue.shutdown(); }
  });

  it("alternates eligible fresh turns and recovery, preserving each lane's FIFO", async () => {
    const h = harness(); h.skill("reply");
    const blocker = h.job("reply", { gate: h.gate });
    const started: string[] = [];
    h.queue.events.on("job.started", ({ data }) => started.push(data.job.id));
    h.queue.enqueue(blocker); await h.spawned(blocker.id);
    const replay = [1, 2, 3].map((source) => h.job("reply", { source }, "replay"));
    replay.forEach((j) => h.queue.enqueue(j));
    const fresh = [4, 5, 6].map((source) => h.job("reply", { source }));
    fresh.forEach((j) => h.queue.enqueue(j));
    try {
      h.release();
      for (const j of [blocker, ...replay, ...fresh]) await h.finish(j.id);
      // At most one replay runs before the fresh turn, even with a batch ahead.
      expect(started).toEqual([blocker.id, replay[0]!.id, fresh[0]!.id, replay[1]!.id, fresh[1]!.id, replay[2]!.id, fresh[2]!.id]);
    } finally { h.release(); await h.queue.shutdown(); }
  });
});

describe("exclusive cwd ownership", () => {
  it("prevents sibling cleanup across skills and symlink aliases while other workspaces run", async () => {
    const h = harness(4);
    const shared = path.join(h.paths.home, "shared"); mkdirSync(shared);
    const alias = path.join(h.paths.home, "alias"); symlinkSync(shared, alias, "dir");
    const other = path.join(h.paths.home, "other"); mkdirSync(other);
    h.skill("writer", shared, true); h.skill("cleaner", alias); h.skill("unrelated", other);
    const writer = h.job("writer", { draft: true, gate: h.gate });
    const cleaner = h.job("cleaner", { clean: true });
    const independent = h.job("unrelated", {});
    try {
      h.queue.enqueue(writer); await h.spawned(writer.id);
      h.queue.enqueue(cleaner); h.queue.enqueue(independent);
      await h.finish(independent.id);
      expect(h.store.require(cleaner.id).status).toBe("queued");
      expect(readFileSync(path.join(shared, "draft.txt"), "utf8")).toBe("sibling edit");
      // An eligible replay can run even though the fresh cleaner is blocked.
      const recovery = h.job("unrelated", {}, "replay"); h.queue.enqueue(recovery); await h.finish(recovery.id);
      h.release(); await h.finish(writer.id); await h.finish(cleaner.id);
      expect(existsSync(path.join(shared, "draft.txt"))).toBe(false);
    } finally { h.release(); await h.queue.shutdown(); }
  });

  it("defaults to exclusive Git worktree ownership across root and subdirectory jobs", async () => {
    const h = harness(4);
    const repo = path.join(h.paths.home, "repo"); mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "--quiet"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
    writeFileSync(path.join(repo, "tracked.txt"), "base");
    git("add", "tracked.txt"); git("commit", "--quiet", "-m", "fixture");
    const sub = path.join(repo, "backend"); mkdirSync(sub);
    const independent = path.join(h.paths.home, "independent");
    git("worktree", "add", "--quiet", "--detach", independent, "HEAD");
    h.skill("root", repo); h.skill("child", sub); h.skill("another-tree", independent);
    const root = h.job("root", { draft: true, gate: h.gate });
    const child = h.job("child", { clean: true, cleanPath: "../draft.txt" });
    const other = h.job("another-tree", {});
    try {
      h.queue.enqueue(root); await h.spawned(root.id);
      h.queue.enqueue(child); h.queue.enqueue(other);
      await h.finish(other.id);
      expect(h.store.require(child.id).status).toBe("queued");
      expect(readFileSync(path.join(repo, "draft.txt"), "utf8")).toBe("sibling edit");
      h.release(); await h.finish(root.id); await h.finish(child.id);
    } finally { h.release(); await h.queue.shutdown(); }
  });

  it("keeps the reserved cwd through fallback even if defaults change during readiness", async () => {
    const h = harness(4);
    const before = path.join(h.paths.home, "before"); const after = path.join(h.paths.home, "after");
    mkdirSync(before); mkdirSync(after); h.config.defaults.cwd = before;
    writeSkill(h.paths, "fallback", `description: fallback fixture\nskillhook:\n  runner: claude\n  serialize_cwd: true\n  fallback:\n    runners: [shell]\n  shell:\n    command: ${JSON.stringify([process.execPath, "-e", command])}`);
    const readiness = {
      get: async (runner: "claude" | "shell") => {
        h.config.defaults.cwd = after; // simulate hot reload during asynchronous preflight
        return { runner, found: true, authenticated: runner === "shell" ? null : false, ready: runner === "shell", detail: "fixture", checked_at: new Date().toISOString() };
      },
    } as unknown as ReadinessCache;
    const queue = new JobQueue({ ...h, readiness });
    const job = h.job("fallback", { draft: true });
    try {
      queue.enqueue(job);
      const done = await queue.waitFor(job.id, 10_000);
      expect(done).toMatchObject({ status: "succeeded", runner: "shell", cwd: before });
      expect(readFileSync(path.join(before, "draft.txt"), "utf8")).toBe("sibling edit");
      expect(existsSync(path.join(after, "draft.txt"))).toBe(false);
    } finally { await queue.shutdown(); }
  });

  it("holds the cwd when the exclusive job arrives second, and releases after cancellation and failure", async () => {
    const h = harness(4); h.skill("plain"); h.skill("exclusive", h.paths.home, true);
    const plain = h.job("plain", { gate: h.gate });
    const exclusive = h.job("exclusive", { fail: true });
    const next = h.job("exclusive", {});
    try {
      h.queue.enqueue(plain); await h.spawned(plain.id);
      h.queue.enqueue(exclusive); h.queue.enqueue(next);
      expect(h.queue.cancel(plain.id)).toBe(true);
      expect((await h.queue.waitFor(plain.id, 10_000))?.status).toBe("cancelled");
      expect((await h.queue.waitFor(exclusive.id, 10_000))?.status).toBe("failed");
      await h.finish(next.id);
    } finally { h.release(); await h.queue.shutdown(); }
  });
});
