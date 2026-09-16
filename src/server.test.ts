import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signRequest } from "./auth.js";
import { loadConfig } from "./config.js";
import { JobStore } from "./jobs.js";
import { silentLogger } from "./logger.js";
import { JobQueue } from "./queue.js";
import { createServer } from "./server.js";
import { SkillRegistry } from "./registry.js";
import { FAKE_CLAUDE, FAKE_CODEX, tempHome, writeConfigFile, writeEnv, writeSkill } from "./test-support/helpers.js";
import type { Server } from "node:http";

const paths = tempHome();
let server: Server;
let base = "";
let queue: JobQueue;
let store: JobStore;
const recordFile = path.join(paths.home, "record.json");
const projectDir = path.join(paths.home, "repo");
const ADMIN = "admin-token-123";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown> & { job?: Record<string, unknown> };
}

async function waitForJob(id: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = store.get(id);
    if (job && !["queued", "running"].includes(job.status)) return job;
    await sleep(100);
  }
  throw new Error(`job ${id} did not finish`);
}

beforeAll(async () => {
  writeConfigFile(paths, {
    concurrency: 4,
    max_body_bytes: 2000,
    max_wait_seconds: 30,
    rate_limit: { requests_per_minute: 1000, auth_failures_per_minute: 50 },
    runners: { claude: { command: FAKE_CLAUDE }, codex: { command: FAKE_CODEX } },
  });
  writeEnv(paths, {
    SKILLHOOK_ADMIN_TOKEN: ADMIN,
    SKILLHOOK_SECRET_HELLO: "hello-secret",
    GH_SECRET: "gh-secret",
    SKILLHOOK_SECRET_FILTERED: "f",
    SKILLHOOK_SECRET_CODEXY: "c",
    SKILLHOOK_SECRET_FAILING: "x",
    SKILLHOOK_SECRET_SLOW: "s",
    SKILLHOOK_SECRET_SLOWTIMEOUT: "t",
    SKILLHOOK_SECRET_TWIN: "tw",
    SKILLHOOK_SECRET_TWINOFF: "two",
    SLACK_SECRET: "slack-secret",
    FAKE_CLAUDE_RECORD: recordFile,
    FAKE_CLAUDE_FAIL: "simulated failure",
    FAKE_CLAUDE_SLEEP_MS: "4000",
  });
  writeSkill(paths, "hello", "description: hello\nskillhook:\n  model: haiku\n  env: [FAKE_CLAUDE_RECORD]", "Say hi to {{payload.name}}.\n\n{{payload}}\n");
  writeSkill(paths, "gh", "description: gh\nskillhook:\n  auth:\n    type: github\n    secret_env: GH_SECRET");
  writeSkill(paths, "filtered", "description: f\nskillhook:\n  when:\n    - path: action\n      equals: created");
  writeSkill(paths, "codexy", "description: c\nskillhook:\n  runner: codex\n  model: gpt-5-codex");
  writeSkill(paths, "failing", "description: x\nskillhook:\n  env: [FAKE_CLAUDE_FAIL]");
  writeSkill(paths, "slow", "description: s\nskillhook:\n  env: [FAKE_CLAUDE_SLEEP_MS]");
  writeSkill(paths, "slowtimeout", "description: t\nskillhook:\n  timeout_seconds: 1\n  env: [FAKE_CLAUDE_SLEEP_MS]");
  writeSkill(paths, "open", "description: o\nskillhook:\n  auth:\n    type: none");
  writeSkill(paths, "twin", "description: tw\nskillhook:\n  env: [FAKE_CLAUDE_SLEEP_MS]");
  writeSkill(paths, "twinoff", "description: two\nskillhook:\n  dedupe:\n    in_flight: false\n  env: [FAKE_CLAUDE_SLEEP_MS]");
  writeSkill(paths, "slacky", "description: sl\nskillhook:\n  auth:\n    type: slack\n    secret_env: SLACK_SECRET");
  writeSkill(paths, "unconfigured", "description: u");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, "skillhook.yaml"), ["hooks:", "  where-am-i:", "    description: Prints the working directory and the payload it got on stdin.", '    run: printf "%s\\n" "$PWD" && cat', "    auth: { type: bearer, secret_env: SKILLHOOK_SECRET_HELLO }", "    when:", "      - { path: action, equals: closed }", "  by-skill:", "    skill: skills/greeter", "    model: haiku", "    auth: { type: bearer, secret_env: SKILLHOOK_SECRET_HELLO }", ""].join("\n"));
  mkdirSync(path.join(projectDir, "skills", "greeter"), { recursive: true });
  writeFileSync(path.join(projectDir, "skills", "greeter", "SKILL.md"), "---\nname: greeter\ndescription: Greets.\nskillhook:\n  model: opus\n  env: [FAKE_CLAUDE_RECORD]\n---\n\nGreet {{payload.name}} from the project.\n");
  const config = loadConfig(paths);
  const registry = new SkillRegistry(paths.skillsDir, { projects: () => [projectDir] });
  store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 3600 });
  const { loadSecrets } = await import("./env.js");
  const secrets = () => loadSecrets(paths, {});
  queue = new JobQueue({ store, config, registry, secrets, fileSecrets: secrets, logger: silentLogger });
  server = createServer({ config, paths, store, queue, registry, secrets, logger: silentLogger });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await queue.shutdown();
  server.close();
});

describe("HTTP surface", () => {
  it("serves health and hook info", async () => {
    const local = await json(await fetch(`${base}/health`));
    expect(local.ok).toBe(true);
    expect(local.queue).toBeDefined();
    const proxied = await json(await fetch(`${base}/health`, { headers: { "x-forwarded-proto": "https" } }));
    expect(proxied).toEqual({ ok: true, version: proxied.version });
    expect((await fetch(`${base}/hooks/hello`)).status).toBe(200);
    expect((await fetch(`${base}/hooks/nope`)).status).toBe(404);
    expect((await fetch(`${base}/hooks/../etc`)).status).toBe(404);
    expect((await fetch(`${base}/hooks/hello`, { method: "DELETE" })).status).toBe(405);
  });

  it("rejects missing or wrong bearer tokens", async () => {
    const missing = await fetch(`${base}/hooks/hello`, { method: "POST", body: "{}" });
    expect(missing.status).toBe(401);
    expect((await json(missing)).error).toBe("missing_token");
    const wrong = await fetch(`${base}/hooks/hello`, { method: "POST", body: "{}", headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });

  it("returns 503 when a skill's secret is not configured", async () => {
    const res = await fetch(`${base}/hooks/unconfigured`, { method: "POST", body: "{}", headers: { authorization: "Bearer x" } });
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe("skill_not_configured");
  });

  it("accepts an authenticated webhook, runs the fake runner and records artifacts", async () => {
    const res = await fetch(`${base}/hooks/hello?wait=20`, { method: "POST", body: JSON.stringify({ name: "Ada" }), headers: { authorization: "Bearer hello-secret", "content-type": "application/json", "x-custom": "yes" } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("succeeded");
    expect(String(body.result)).toContain("FAKE OK model=haiku");
    const job = store.get(String(body.job_id));
    expect(job?.runner).toBe("claude");
    expect(job?.cost_usd).toBe(0.0123);
    expect(job?.session_id).toMatch(/^fake-session-/);
    expect(job?.resume_command).toContain("claude --resume");
    const prompt = readFileSync(store.pathsFor(job!.id).prompt, "utf8");
    expect(prompt).toContain("Say hi to Ada.");
    expect(prompt).toContain('"name": "Ada"');
    const record = JSON.parse(readFileSync(recordFile, "utf8")) as { args: string[]; prompt: string; env: Record<string, string>; cwd: string };
    expect(record.args).toContain("--model");
    expect(record.env.SKILLHOOK_JOB_ID).toBe(job!.id);
    expect(record.env.SKILLHOOK_SKILL).toBe("hello");
    expect(record.cwd).toBe(path.join(paths.skillsDir, "hello"));
    const event = store.readEvent(job!.id);
    expect(event.headers["x-custom"]).toBe("yes");
    expect(event.headers.authorization).toBeUndefined();
  });

  it("returns 202 immediately without wait and the job completes in the background", async () => {
    const res = await fetch(`${base}/hooks/hello`, { method: "POST", body: JSON.stringify({ name: "Bob" }), headers: { authorization: "Bearer hello-secret" } });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.status).toBe("queued");
    const job = await waitForJob(String(body.job_id));
    expect(job.status).toBe("succeeded");
  });

  it("honours Prefer: wait=N like ?wait=", async () => {
    const res = await fetch(`${base}/hooks/hello`, { method: "POST", body: JSON.stringify({ name: "Pref" }), headers: { authorization: "Bearer hello-secret", prefer: "wait=20" } });
    expect(res.status).toBe(200);
    expect((await json(res)).status).toBe("succeeded");
  });

  it("verifies GitHub signatures and de-duplicates deliveries", async () => {
    const skill = new SkillRegistry(paths.skillsDir).get("gh")!;
    const body = Buffer.from(JSON.stringify({ action: "opened" }));
    const headers = signRequest(skill.auth, "gh-secret", body, { deliveryId: "delivery-1" });
    const first = await fetch(`${base}/hooks/gh`, { method: "POST", body, headers: { ...headers, "content-type": "application/json" } });
    expect(first.status).toBe(202);
    const firstBody = await json(first);
    const second = await fetch(`${base}/hooks/gh`, { method: "POST", body, headers: { ...headers, "content-type": "application/json" } });
    expect(second.status).toBe(200);
    const secondBody = await json(second);
    expect(secondBody.duplicate).toBe(true);
    expect(secondBody.job_id).toBe(firstBody.job_id);
    const bad = await fetch(`${base}/hooks/gh`, { method: "POST", body: "{}", headers: { ...headers, "content-type": "application/json" } });
    expect(bad.status).toBe(401);
    await waitForJob(String(firstBody.job_id));
  });

  it("skips deliveries that fail the when filter", async () => {
    const skipped = await fetch(`${base}/hooks/filtered`, { method: "POST", body: JSON.stringify({ action: "deleted" }), headers: { authorization: "Bearer f" } });
    expect(skipped.status).toBe(200);
    expect((await json(skipped)).skipped).toBe(true);
    const accepted = await fetch(`${base}/hooks/filtered`, { method: "POST", body: JSON.stringify({ action: "created" }), headers: { authorization: "Bearer f" } });
    expect(accepted.status).toBe(202);
    await waitForJob(String((await json(accepted)).job_id));
  });

  it("rejects oversized bodies", async () => {
    const res = await fetch(`${base}/hooks/hello`, { method: "POST", body: JSON.stringify({ big: "x".repeat(3000) }), headers: { authorization: "Bearer hello-secret" } });
    expect(res.status).toBe(413);
  });

  it("runs codex skills", async () => {
    const res = await fetch(`${base}/hooks/codexy?wait=20`, { method: "POST", body: "{}", headers: { authorization: "Bearer c" } });
    const body = await json(res);
    expect(body.status).toBe("succeeded");
    expect(String(body.result)).toContain("FAKE CODEX OK model=gpt-5-codex");
    expect(store.get(String(body.job_id))?.resume_command).toContain("codex resume");
  });

  it("records runner failures", async () => {
    const res = await fetch(`${base}/hooks/failing?wait=20`, { method: "POST", body: "{}", headers: { authorization: "Bearer x" } });
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.status).toBe("failed");
    expect(String(body.error)).toContain("simulated failure");
  });

  it("times out slow jobs", async () => {
    const res = await fetch(`${base}/hooks/slowtimeout`, { method: "POST", body: "{}", headers: { authorization: "Bearer t" } });
    const job = await waitForJob(String((await json(res)).job_id), 20_000);
    expect(job.status).toBe("timed_out");
    expect(job.error).toContain("timed out");
  });

  it("cancels running jobs through the admin API", async () => {
    const res = await fetch(`${base}/hooks/slow`, { method: "POST", body: "{}", headers: { authorization: "Bearer s" } });
    const id = String((await json(res)).job_id);
    await sleep(700);
    const cancel = await fetch(`${base}/jobs/${id}/cancel`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
    expect(cancel.status).toBe(200);
    const job = await waitForJob(id);
    expect(job.status).toBe("cancelled");
  });

  it("accepts unauthenticated skills that opt in", async () => {
    const res = await fetch(`${base}/hooks/open?wait=20`, { method: "POST", body: JSON.stringify({ ping: 1 }) });
    expect((await json(res)).status).toBe("succeeded");
  });

  it("answers Slack URL verification challenges", async () => {
    const skill = new SkillRegistry(paths.skillsDir).get("slacky")!;
    const body = Buffer.from(JSON.stringify({ type: "url_verification", challenge: "abc123" }));
    const res = await fetch(`${base}/hooks/slacky`, { method: "POST", body, headers: { ...signRequest(skill.auth, "slack-secret", body), "content-type": "application/json" } });
    expect(await json(res)).toEqual({ challenge: "abc123" });
  });

  it("exposes admin endpoints with the token or from direct localhost", async () => {
    const skills = await json(await fetch(`${base}/skills`, { headers: { authorization: `Bearer ${ADMIN}` } }));
    expect((skills.skills as { name: string }[]).map((s) => s.name)).toContain("hello");
    const viaProxy = await fetch(`${base}/skills`, { headers: { "x-forwarded-for": "203.0.113.1" } });
    expect(viaProxy.status).toBe(401);
    const viaOtherProxy = await fetch(`${base}/skills`, { headers: { "x-real-ip": "203.0.113.1" } });
    expect(viaOtherProxy.status).toBe(401);
    const wrongToken = await fetch(`${base}/skills`, { headers: { authorization: "Bearer nope" } });
    expect(wrongToken.status).toBe(401);
    const local = await fetch(`${base}/jobs?skill=hello`);
    expect(local.status).toBe(200);
    expect(((await json(local)).jobs as unknown[]).length).toBeGreaterThan(0);
    const run = await fetch(`${base}/skills/hello/run`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ payload: { name: "Cy" }, wait: 20, model: "sonnet" }) });
    const runBody = await json(run);
    expect(runBody.status).toBe("succeeded");
    expect(String(runBody.result)).toContain("model=sonnet");
    const detail = await json(await fetch(`${base}/jobs/${runBody.job_id}?include=result,prompt`, { headers: { authorization: `Bearer ${ADMIN}` } }));
    expect((detail.artifacts as Record<string, string>).prompt).toContain("Cy");
    expect((detail.job as { trigger: string }).trigger).toBe("api");
  });

  it("does not queue a delivery identical to one still in flight", async () => {
    const post = (body: string, suffix = "", extra: Record<string, string> = {}) => fetch(`${base}/hooks/twin${suffix}`, { method: "POST", body, headers: { authorization: "Bearer tw", "content-type": "application/json", ...extra } });
    const first = await json(await post('{"note": "n1", "x": 1}'));
    expect(first.status).toBe("queued");
    expect(store.get(String(first.job_id))?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Same payload, different key order, whitespace and headers: the sender is pointed at the job that is already running.
    const same = await post('{ "x": 1,   "note": "n1" }', "", { "x-request-id": "another-delivery" });
    expect(same.status).toBe(200);
    const sameBody = await json(same);
    expect(sameBody).toMatchObject({ ok: true, duplicate: true, in_flight: true, job_id: first.job_id });
    expect(["queued", "running"]).toContain(sameBody.status);
    expect(String(sameBody.status_url)).toBe(`/jobs/${first.job_id}`);
    // A different payload, or a different query string, is new work.
    const other = await json(await post('{"note": "n2", "x": 1}'));
    expect(other.status).toBe("queued");
    expect(other.job_id).not.toBe(first.job_id);
    const otherQuery = await json(await post('{"note": "n1", "x": 1}', "?env=prod"));
    expect(otherQuery.job_id).not.toBe(first.job_id);
    // ?wait= on a duplicate waits for the original job and returns its result, still marked as a duplicate.
    const waited = await post('{"x":1,"note":"n1"}', "?wait=20");
    expect(waited.status).toBe(200);
    const waitedBody = await json(waited);
    expect(waitedBody).toMatchObject({ ok: true, duplicate: true, in_flight: true, job_id: first.job_id, status: "succeeded" });
    expect(String(waitedBody.result)).toContain("FAKE OK");
    // Once the job has finished, the same payload runs again.
    const again = await json(await post('{"note": "n1", "x": 1}'));
    expect(again.status).toBe("queued");
    expect(again.job_id).not.toBe(first.job_id);
    for (const id of [other.job_id, otherQuery.job_id, again.job_id]) await waitForJob(String(id), 25_000);
  });

  it("serves the hooks of a linked project: a shell command in the project directory, and a SKILL.md under the hook's name", async () => {
    const skipped = await fetch(`${base}/hooks/where-am-i`, { method: "POST", body: JSON.stringify({ action: "opened" }), headers: { authorization: "Bearer hello-secret", "content-type": "application/json" } });
    expect((await json(skipped)).skipped).toBe(true);
    const res = await fetch(`${base}/hooks/where-am-i?wait=20`, { method: "POST", body: JSON.stringify({ action: "closed", pr: 7 }), headers: { authorization: "Bearer hello-secret", "content-type": "application/json" } });
    const body = await json(res);
    expect(body.status).toBe("succeeded");
    expect(String(body.result).split("\n")[0]).toBe(projectDir);
    expect(String(body.result)).toContain('"pr": 7');
    const job = store.get(String(body.job_id));
    expect(job).toMatchObject({ runner: "shell", cwd: projectDir });
    expect(job?.command?.slice(0, 2)).toEqual(["/bin/sh", "-c"]);

    const viaSkill = await fetch(`${base}/hooks/by-skill?wait=20`, { method: "POST", body: JSON.stringify({ name: "Grace" }), headers: { authorization: "Bearer hello-secret", "content-type": "application/json" } });
    const skillBody = await json(viaSkill);
    expect(skillBody.status).toBe("succeeded");
    expect(String(skillBody.result)).toContain("model=haiku");
    const record = JSON.parse(readFileSync(recordFile, "utf8")) as { prompt: string; cwd: string; env: Record<string, string>; args: string[] };
    expect(record.prompt).toContain("Greet Grace from the project.");
    expect(record.cwd).toBe(projectDir);
    expect(record.env.SKILLHOOK_SKILL).toBe("by-skill");
    expect(record.env.SKILLHOOK_SKILL_DIR).toBe(path.join(projectDir, "skills", "greeter"));
    expect(record.args).toContain(path.join(projectDir, "skills", "greeter"));

    const skills = await json(await fetch(`${base}/skills`, { headers: { authorization: `Bearer ${ADMIN}` } }));
    const hook = (skills.skills as { name: string; source: { type: string; kind?: string; dir?: string }; cwd: string }[]).find((s) => s.name === "where-am-i");
    expect(hook).toMatchObject({ source: { type: "project", kind: "run", dir: projectDir }, cwd: projectDir });
    expect((skills.skills as { name: string; source: { type: string } }[]).find((s) => s.name === "hello")?.source).toEqual({ type: "home" });
  });

  it("runs identical deliveries when in-flight de-duplication is off for the skill", async () => {
    const post = () => fetch(`${base}/hooks/twinoff`, { method: "POST", body: '{"same": true}', headers: { authorization: "Bearer two" } });
    const a = await json(await post());
    const b = await json(await post());
    expect(a.status).toBe("queued");
    expect(b.status).toBe("queued");
    expect(b.job_id).not.toBe(a.job_id);
    await waitForJob(String(a.job_id));
    await waitForJob(String(b.job_id));
  });
});
