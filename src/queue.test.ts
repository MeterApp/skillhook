import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { loadSecrets } from "./env.js";
import { JobStore } from "./jobs.js";
import { silentLogger } from "./logger.js";
import { createAdhocJob } from "./manual.js";
import { JobQueue } from "./queue.js";
import { ReadinessCache, type RunnerReadiness } from "./readiness.js";
import { SkillRegistry } from "./registry.js";
import { SkillError } from "./skills.js";
import { FAKE_CLAUDE, HUNG_CLAUDE, tempHome, writeConfigFile } from "./test-support/helpers.js";

const SHELL_SKILL = '---\nname: adhoc-shell\ndescription: Ad-hoc shell skill.\nskillhook:\n  runner: shell\n  shell:\n    command: ["sh", "-c", "echo adhoc-ran; cat"]\n---\nBody\n';

describe("JobQueue with ad-hoc jobs", () => {
  it("runs a SKILL.md kept in the job directory, also after a restart, without touching the registry", async () => {
    const paths = tempHome("skillhook-queue-");
    writeConfigFile(paths, { concurrency: 1 });
    const config = loadConfig(paths);
    const store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 60 });
    const registry = new SkillRegistry(paths.skillsDir);
    const secrets = () => loadSecrets(paths, {});
    const { job, skill } = createAdhocJob({ config, store }, { skillMd: SHELL_SKILL, payload: { a: 1 } });
    expect(job).toMatchObject({ adhoc: true, trigger: "test", skill: "adhoc-shell", status: "queued", source: { method: "TEST" } });
    expect(skill.source).toEqual({ type: "adhoc", job: job.id });
    expect(job.skill_file).toBe(skill.file);
    expect(existsSync(skill.file)).toBe(true);
    expect(readFileSync(skill.file, "utf8")).toBe(SHELL_SKILL);
    // A restart re-queues it; the queue loads the skill from the job directory.
    const recovered = store.recoverOnStartup();
    expect(recovered.queued.map((j) => j.id)).toEqual([job.id]);
    const queue = new JobQueue({ store, config, registry, secrets, fileSecrets: secrets, logger: silentLogger });
    queue.enqueue(job);
    const done = await queue.waitFor(job.id, 15_000);
    expect(done).toMatchObject({ status: "succeeded", outcome: "completed", cwd: skill.dir });
    expect(done?.result).toContain("adhoc-ran");
    expect(done?.result).toContain('"a": 1');
    expect(registry.get("adhoc-shell")).toBeUndefined();
    await queue.shutdown();
  });

  it("refuses an invalid ad-hoc document before creating anything", () => {
    const paths = tempHome("skillhook-queue-");
    const config = loadConfig(paths);
    const store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 60 });
    expect(() => createAdhocJob({ config, store }, { skillMd: "---\nname: Bad Name\ndescription: x\n---\nb", payload: {} })).toThrow(SkillError);
    expect(() => createAdhocJob({ config, store }, { skillMd: "---\nname: ok\n---\nno description", payload: {} })).toThrow(/Invalid SKILL.md frontmatter/);
    expect(() => createAdhocJob({ config, store }, { skillMd: "---\nname: ok\ndescription: d\n", payload: {} })).toThrow(/Unterminated frontmatter/);
    expect(() => createAdhocJob({ config, store }, { skillMd: "no frontmatter at all", payload: {} })).toThrow(/valid `name`/);
    expect(store.ids()).toEqual([]);
  });
});

const CLAUDE_SKILL = '---\nname: adhoc-claude\ndescription: Ad-hoc Claude skill.\nskillhook:\n  runner: claude\n---\nSay hello.\n';

describe("JobQueue when the readiness probe hangs", () => {
  it("still starts queued jobs: a probe that never answers counts as a failed check, not as a runner that is not ready", async () => {
    const paths = tempHome("skillhook-queue-hung-");
    writeConfigFile(paths, { concurrency: 2, runners: { claude: { command: FAKE_CLAUDE } } });
    const config = loadConfig(paths);
    const store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 60 });
    const registry = new SkillRegistry(paths.skillsDir);
    const secrets = () => loadSecrets(paths, {});
    let probes = 0;
    const readiness = new ReadinessCache({
      config: () => config,
      env: () => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/" }),
      deadlineMs: () => 500,
      check: () => {
        probes += 1;
        return new Promise<RunnerReadiness>(() => {}); // the CLI is stuck behind a dialog: no answer, ever
      },
    });
    const queue = new JobQueue({ store, config, registry, secrets, fileSecrets: secrets, logger: silentLogger, readiness });
    const first = createAdhocJob({ config, store }, { skillMd: CLAUDE_SKILL, payload: { n: 1 } }).job;
    const second = createAdhocJob({ config, store }, { skillMd: CLAUDE_SKILL, payload: { n: 2 } }).job;
    const started = Date.now();
    queue.enqueue(first);
    queue.enqueue(second);
    const [a, b] = await Promise.all([queue.waitFor(first.id, 15_000), queue.waitFor(second.id, 15_000)]);
    expect(Date.now() - started).toBeLessThan(12_000);
    expect(a).toMatchObject({ status: "succeeded", runner: "claude" });
    expect(b).toMatchObject({ status: "succeeded", runner: "claude" });
    expect(a?.runner_requested).toBeUndefined(); // no fallback was taken
    expect(probes).toBeGreaterThanOrEqual(1);
    await queue.shutdown();
  });

  it("with the real probe: a `claude` that ignores SIGTERM is killed and the job runs on its runner anyway", async () => {
    const paths = tempHome("skillhook-queue-hung-real-");
    // The probe runs the hung CLI; the job itself runs the fake one, so the run can succeed once the pre-flight gives up.
    writeConfigFile(paths, { concurrency: 1, runners: { claude: { command: HUNG_CLAUDE } }, health: { probe_timeout_seconds: 1 } });
    const probeConfig = loadConfig(paths);
    writeConfigFile(paths, { concurrency: 1, runners: { claude: { command: FAKE_CLAUDE } }, health: { probe_timeout_seconds: 1 } });
    const config = loadConfig(paths);
    const store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 60 });
    const registry = new SkillRegistry(paths.skillsDir);
    const secrets = () => loadSecrets(paths, {});
    const readiness = new ReadinessCache({ config: () => probeConfig, env: () => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/" }) });
    const queue = new JobQueue({ store, config, registry, secrets, fileSecrets: secrets, logger: silentLogger, readiness });
    const { job } = createAdhocJob({ config, store }, { skillMd: CLAUDE_SKILL, payload: {} });
    const started = Date.now();
    queue.enqueue(job);
    const done = await queue.waitFor(job.id, 20_000);
    expect(Date.now() - started).toBeLessThan(15_000);
    // The pre-flight could not tell, so the job was neither failed fast nor handed to a fallback: it started on claude.
    expect(done?.runner).toBe("claude");
    expect(done?.runner_requested).toBeUndefined();
    expect(done?.status).not.toBe("queued");
    await queue.shutdown();
  });
});
