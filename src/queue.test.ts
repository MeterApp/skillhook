import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { loadSecrets } from "./env.js";
import { JobStore } from "./jobs.js";
import { silentLogger } from "./logger.js";
import { createAdhocJob } from "./manual.js";
import { JobQueue } from "./queue.js";
import { SkillRegistry } from "./registry.js";
import { SkillError } from "./skills.js";
import { tempHome, writeConfigFile } from "./test-support/helpers.js";

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
