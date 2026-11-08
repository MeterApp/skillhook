import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { JobStore } from "./jobs.js";
import { silentLogger } from "./logger.js";
import { createManualJob } from "./manual.js";
import { JobQueue } from "./queue.js";
import { createServer } from "./server.js";
import { SkillRegistry } from "./registry.js";
import { tempHome, writeConfigFile } from "./test-support/helpers.js";

function fixture() {
  const paths = tempHome();
  const dir = realpathSync(paths.home);
  const origin = path.join(dir, "origin");
  const writer = path.join(dir, "writer");
  const served = path.join(dir, "served");
  const state = path.join(dir, "state");
  mkdirSync(state);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Skillhook Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(dir, "init", "--bare", "-b", "main", origin);
  git(dir, "clone", origin, writer);
  const save = (name: string, auth = "none") => {
    writeFileSync(path.join(writer, "skillhook.yaml"), [
      "hooks:", "  test:", `    cwd: ${state}`,
      `    run: printf '%s\\n' "${name}" "$SKILLHOOK_PROJECT_COMMIT" "$PWD"`,
      `    auth: { type: ${auth} }`,
    ].join("\n"));
    git(writer, "add", "skillhook.yaml");
    git(writer, "commit", "-m", name);
    git(writer, "push", "origin", "main");
    return git(writer, "rev-parse", "HEAD");
  };
  const first = save("old");
  git(dir, "clone", origin, served);
  writeConfigFile(paths, { projects: [served], project_refresh: [served] });
  const config = loadConfig(paths);
  const registry = new SkillRegistry(paths.skillsDir, { projects: () => [served] });
  const store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 60 });
  const queue = new JobQueue({ config, registry, store, secrets: () => ({}), logger: silentLogger });
  const run = async () => {
    const skill = registry.get("test")!;
    const job = createManualJob({ config, store }, { skill, trigger: "api", payload: {} });
    queue.enqueue(job);
    return queue.waitFor(job.id, 5_000);
  };
  return { git, save, run, first, served, state, registry, paths, config, store, queue };
}

it("refreshes before loading a queued job, keeps its explicit cwd, and logs the executed SHA", async () => {
  const { git, save, run, first, served, state, registry, store } = fixture();
  expect(registry.get("test")?.description).toContain("old");
  const target = save("new");
  expect(registry.list().skills[0]?.description).toContain("old");
  expect(git(served, "rev-parse", "HEAD")).toBe(first);
  const done = await run();
  expect(done).toMatchObject({ status: "succeeded", project_commit: target, cwd: state });
  expect(done?.result).toBe(`new\n${target}\n${state}`);
  expect(store.readArtifact(done!.id, "stderr")).toContain(`Skillhook project commit: ${target}`);
});

it("leaves a dirty checkout intact and fails without a project commit", async () => {
  const { git, save, run, first, served } = fixture();
  save("new");
  writeFileSync(path.join(served, "skillhook.yaml"), git(served, "show", "HEAD:skillhook.yaml") + "\n# local edit\n");
  expect(await run()).toMatchObject({ status: "failed", error: expect.stringContaining("no tracked changes") });
  expect(git(served, "rev-parse", "HEAD")).toBe(first);
  expect(git(served, "status", "--porcelain")).toContain("skillhook.yaml");
});

it("rejects a webhook admitted with an obsolete policy", async () => {
  const { save, registry, paths, config, store, queue } = fixture();
  expect(registry.get("test")?.auth.type).toBe("none");
  save("requires token", "bearer");
  const server = createServer({ config, paths, registry, store, queue, secrets: () => ({}), logger: silentLogger });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    const response = await fetch(`http://127.0.0.1:${address.port}/hooks/test`, { method: "POST" });
    expect(response.status).toBe(202);
    const { job_id } = await response.json() as { job_id: string };
    const done = await queue.waitFor(job_id, 5_000);
    expect(done).toMatchObject({ status: "failed", error: expect.stringContaining("webhook policy changed") });
    expect(done?.project_commit).toBeUndefined();
    expect(registry.get("test")?.auth.type).toBe("bearer");
  } finally {
    server.close();
    await once(server, "close");
    await queue.shutdown();
  }
});

it("fails closed when origin cannot be fetched", async () => {
  const { git, run, first, served } = fixture();
  git(served, "remote", "set-url", "origin", path.join(served, "nonexistent-origin"));
  const done = await run();
  expect(done).toMatchObject({ status: "failed", error: expect.stringContaining("git fetch failed") });
  expect(done?.project_commit).toBeUndefined();
  expect(done?.result).toBeUndefined();
  expect(git(served, "rev-parse", "HEAD")).toBe(first);
});
