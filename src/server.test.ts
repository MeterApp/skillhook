import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signRequest } from "./auth.js";
import { loadConfig } from "./config.js";
import { DeliveryLog } from "./delivery-log.js";
import { Events } from "./events.js";
import { JobStore } from "./jobs.js";
import { silentLogger } from "./logger.js";
import { JobQueue } from "./queue.js";
import { Scheduler } from "./scheduler.js";
import { createServer } from "./server.js";
import { SkillRegistry } from "./registry.js";
import { FAKE_CLAUDE, FAKE_CODEX, readSse, tempHome, writeConfigFile, writeEnv, writeSkill } from "./test-support/helpers.js";
import type { Server } from "node:http";

const paths = tempHome();
let server: Server;
let base = "";
let queue: JobQueue;
let store: JobStore;
let events: Events;
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
    SKILLHOOK_SECRET_STRUCTURED: "st",
    SKILLHOOK_SECRET_FILER: "fi",
    SKILLHOOK_SECRET_CODEXST: "cs",
    FAKE_CLAUDE_RECORD: recordFile,
    FAKE_CLAUDE_FAIL: "simulated failure",
    FAKE_CLAUDE_SLEEP_MS: "4000",
    FAKE_CLAUDE_OUTCOME: "needs_human",
    FAKE_CLAUDE_WRITE_RESPONSE: '{"outcome":"nothing_to_do","summary":"Nothing to do here","links":["https://example.com/x"]}',
    FAKE_CODEX_OUTCOME: "partial",
  });
  writeSkill(paths, "structured", "description: st\nskillhook:\n  response:\n    mode: structured\n  env: [FAKE_CLAUDE_OUTCOME]");
  writeSkill(paths, "filer", "description: fi\nskillhook:\n  env: [FAKE_CLAUDE_WRITE_RESPONSE]");
  writeSkill(paths, "codexst", "description: cs\nskillhook:\n  runner: codex\n  response:\n    mode: structured\n  env: [FAKE_CODEX_OUTCOME]");
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
  writeSkill(paths, "nightly", "description: n\nskillhook:\n  webhook: false\n  schedule: \"0 3 * * *\"");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, "skillhook.yaml"), ["hooks:", "  where-am-i:", "    description: Prints the working directory and the payload it got on stdin.", '    run: printf "%s\\n" "$PWD" && cat', "    auth: { type: bearer, secret_env: SKILLHOOK_SECRET_HELLO }", "    when:", "      - { path: action, equals: closed }", "  by-skill:", "    skill: skills/greeter", "    model: haiku", "    auth: { type: bearer, secret_env: SKILLHOOK_SECRET_HELLO }", ""].join("\n"));
  mkdirSync(path.join(projectDir, "skills", "greeter"), { recursive: true });
  writeFileSync(path.join(projectDir, "skills", "greeter", "SKILL.md"), "---\nname: greeter\ndescription: Greets.\nskillhook:\n  model: opus\n  env: [FAKE_CLAUDE_RECORD]\n---\n\nGreet {{payload.name}} from the project.\n");
  const config = loadConfig(paths);
  const registry = new SkillRegistry(paths.skillsDir, { projects: () => [projectDir] });
  store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 3600 });
  const { loadSecrets } = await import("./env.js");
  const secrets = () => loadSecrets(paths, {});
  events = new Events(silentLogger);
  const deliveryLog = new DeliveryLog(paths.jobsDir, () => config.deliveries);
  queue = new JobQueue({ store, config, registry, secrets, fileSecrets: secrets, logger: silentLogger, events });
  const scheduler = new Scheduler({ registry, store, queue, config, logger: silentLogger, now: () => new Date("2026-09-23T10:00:00Z"), events });
  server = createServer({ config, paths, store, queue, registry, secrets, logger: silentLogger, events, deliveryLog, schedules: () => scheduler.status() });
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

  it("answers 404 for a schedule-only hook, lists schedules in health, and still lets admins run it", async () => {
    const post = await fetch(`${base}/hooks/nightly`, { method: "POST", body: "{}", headers: { authorization: "Bearer anything" } });
    expect(post.status).toBe(404);
    expect((await json(post)).error).toBe("schedule_only");
    expect((await fetch(`${base}/hooks/nightly`)).status).toBe(404);
    const health = await json(await fetch(`${base}/health`));
    expect((health.schedules as { skill: string }[]).find((s) => s.skill === "nightly")).toMatchObject({ cron: "0 3 * * *", timezone: "UTC", webhook: false, enabled: true, next_due: "2026-09-24T03:00:00.000Z", last_job: null });
    const proxied = await json(await fetch(`${base}/health`, { headers: { "x-forwarded-proto": "https" } }));
    expect(proxied.schedules).toBeUndefined();
    const skills = await json(await fetch(`${base}/skills`, { headers: { authorization: `Bearer ${ADMIN}` } }));
    const list = skills.skills as { name: string; webhook: boolean; schedule: { cron: string; next_run_at: string | null } | null }[];
    expect(list.find((s) => s.name === "nightly")).toMatchObject({ webhook: false, schedule: { cron: "0 3 * * *", timezone: "UTC", catch_up: "latest", overlap: "skip" } });
    expect(list.find((s) => s.name === "nightly")?.schedule?.next_run_at).toMatch(/T03:00:00\.000Z$/);
    expect(list.find((s) => s.name === "hello")).toMatchObject({ webhook: true, schedule: null });
    const run = await fetch(`${base}/skills/nightly/run`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ payload: { manual: true }, wait: 20 }) });
    expect((await json(run)).status).toBe("succeeded");
  });

  it("streams the event bus to admins over SSE", async () => {
    expect((await fetch(`${base}/events`, { headers: { "x-forwarded-for": "203.0.113.1" } })).status).toBe(401);
    expect((await fetch(`${base}/events?types=nope`, { headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(400);
    const stream = await fetch(`${base}/events?types=job.queued,job.finished`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const posted = await json(await fetch(`${base}/hooks/hello`, { method: "POST", body: JSON.stringify({ name: "Sse" }), headers: { authorization: "Bearer hello-secret" } }));
    const got = await readSse(stream, (event) => event.event === "job.finished" && (JSON.parse(event.data) as { data: { job: { id: string } } }).data.job.id === posted.job_id);
    const types = got.map((event) => event.event);
    expect(types).toContain("job.queued");
    expect(types.every((type) => type === "job.queued" || type === "job.finished")).toBe(true);
    const last = JSON.parse(got.at(-1)!.data) as { seq: number; type: string; at: string; data: { job: { id: string; status: string } } };
    expect(last).toMatchObject({ type: "job.finished", data: { job: { id: posted.job_id, status: "succeeded" } } });
    expect(got.at(-1)!.id).toBe(String(last.seq));
    expect(events.listenerCount()).toBeGreaterThanOrEqual(0);
  });

  it("follows one job's output and status over SSE and serves raw artifacts", async () => {
    const posted = await json(await fetch(`${base}/hooks/slow`, { method: "POST", body: JSON.stringify({ stream: true }), headers: { authorization: "Bearer s", "content-type": "application/json" } }));
    const id = String(posted.job_id);
    const stream = await fetch(`${base}/jobs/${id}/events?streams=stdout,stderr`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(stream.status).toBe(200);
    const got = await readSse(stream, (event) => event.event === "end", 20_000);
    expect(got[0]?.event).toBe("status");
    expect((JSON.parse(got[0]!.data) as { id: string }).id).toBe(id);
    expect(got.some((event) => event.event === "status" && (JSON.parse(event.data) as { status: string }).status === "running")).toBe(true);
    const output = got.filter((event) => event.event === "stdout").map((event) => JSON.parse(event.data) as string).join("");
    expect(output).toContain('"subtype":"init"');
    expect(output).toContain("FAKE OK");
    expect((JSON.parse(got.at(-1)!.data) as { status: string }).status).toBe("succeeded");
    // A job that has already finished answers at once with everything it has.
    const done = await readSse(await fetch(`${base}/jobs/${id}/events`, { headers: { authorization: `Bearer ${ADMIN}` } }), (event) => event.event === "end");
    expect(done.map((event) => event.event)).toEqual(["status", "stdout", "end"]);
    expect((await fetch(`${base}/jobs/${id}/events?streams=nope`, { headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(400);
    expect((await fetch(`${base}/jobs/${id}/events`, { headers: { "x-forwarded-for": "203.0.113.1" } })).status).toBe(401);
    // Raw artifacts.
    const prompt = await fetch(`${base}/jobs/${id}/artifacts/prompt`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(prompt.status).toBe(200);
    expect(prompt.headers.get("content-type")).toContain("text/plain");
    expect(await prompt.text()).toContain("# Skill: slow");
    const payload = await fetch(`${base}/jobs/${id}/artifacts/payload`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(payload.headers.get("content-type")).toContain("application/json");
    expect(await payload.json()).toEqual({ stream: true });
    const tail = await fetch(`${base}/jobs/${id}/artifacts/stdout?tail=5`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect((await tail.text()).length).toBe(5);
    expect(tail.headers.get("x-artifact-truncated")).toBe("true");
    expect(Number(tail.headers.get("x-artifact-bytes"))).toBeGreaterThan(5);
    const missing = await fetch(`${base}/jobs/${id}/artifacts/nope`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(missing.status).toBe(404);
    expect((await json(missing)).error).toBe("unknown_artifact");
  });

  it("does not warn about listener limits when many callers wait at once", async () => {
    const warn = vi.spyOn(process, "emitWarning");
    try {
      const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => fetch(`${base}/hooks/hello?wait=20`, { method: "POST", body: JSON.stringify({ name: `Wait${i}` }), headers: { authorization: "Bearer hello-secret" } })));
      expect(responses.map((r) => r.status)).toEqual(Array(12).fill(200));
      const maxListeners = warn.mock.calls.filter((call) => `${String(call[0])} ${String((call[0] as { name?: string })?.name)} ${String(call[1])}`.includes("MaxListeners"));
      expect(maxListeners).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("records every delivery with its outcome and serves the log to admins", async () => {
    const auth = { authorization: `Bearer ${ADMIN}` };
    const before = ((await json(await fetch(`${base}/health`))).deliveries as { total: number }).total;
    await fetch(`${base}/hooks/hello`, { method: "POST", body: '{"marker":"dl-401"}', headers: { "content-type": "application/json" } });
    await fetch(`${base}/hooks/unconfigured`, { method: "POST", body: "{}", headers: { authorization: "Bearer x" } });
    await fetch(`${base}/hooks/nosuchskill`, { method: "POST", body: '{"marker":"dl-404"}', headers: { "content-type": "application/json" } });
    await fetch(`${base}/hooks/hello`, { method: "POST", body: JSON.stringify({ big: "x".repeat(3000) }), headers: { authorization: "Bearer hello-secret" } });
    await fetch(`${base}/hooks/filtered`, { method: "POST", body: '{"action":"deleted","marker":"dl-skip"}', headers: { authorization: "Bearer f", "content-type": "application/json" } });
    const gh = new SkillRegistry(paths.skillsDir).get("gh")!;
    const ghBody = Buffer.from(JSON.stringify({ action: "opened" }));
    await fetch(`${base}/hooks/gh`, { method: "POST", body: ghBody, headers: { ...signRequest(gh.auth, "gh-secret", ghBody, { deliveryId: "delivery-1" }), "content-type": "application/json" } });
    const accepted = await json(await fetch(`${base}/hooks/hello?wait=20`, { method: "POST", body: '{"name":"Log"}', headers: { authorization: "Bearer hello-secret", "content-type": "application/json", "x-marker": "dl-ok" } }));
    const slack = new SkillRegistry(paths.skillsDir).get("slacky")!;
    const challenge = Buffer.from(JSON.stringify({ type: "url_verification", challenge: "c2" }));
    await fetch(`${base}/hooks/slacky`, { method: "POST", body: challenge, headers: { ...signRequest(slack.auth, "slack-secret", challenge), "content-type": "application/json" } });

    expect((await fetch(`${base}/deliveries`, { headers: { "x-forwarded-for": "203.0.113.1" } })).status).toBe(401);
    expect((await fetch(`${base}/deliveries?outcome=nope`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/deliveries?since=yesterday`, { headers: auth })).status).toBe(400);
    const page = (await json(await fetch(`${base}/deliveries?limit=50`, { headers: auth }))) as unknown as { deliveries: Record<string, unknown>[]; next_after: string | null };
    const find = (skillName: string, outcome: string, code?: string) => page.deliveries.find((d) => d.skill === skillName && d.outcome === outcome && (code === undefined || d.code === code));
    expect(find("hello", "rejected", "missing_token")).toMatchObject({ http_status: 401, body_stored: true, bytes: 19, ip: "127.0.0.1", method: "POST", path: "/hooks/hello" });
    expect(find("unconfigured", "rejected", "skill_not_configured")).toMatchObject({ http_status: 503 });
    expect(find("nosuchskill", "rejected", "unknown_skill")).toMatchObject({ http_status: 404, body_stored: true, bytes: 19 });
    expect(find("hello", "rejected", "payload_too_large")).toMatchObject({ http_status: 413, body_stored: false });
    const skipped = find("filtered", "skipped") as Record<string, unknown>;
    expect(skipped).toMatchObject({ http_status: 200, code: "skipped", body_stored: true, body_kind: "json" });
    expect(String(skipped.reason)).toContain("action");
    expect(find("gh", "duplicate")).toMatchObject({ http_status: 200, code: "duplicate", delivery_id: "delivery-1" });
    expect(typeof find("gh", "duplicate")?.job_id).toBe("string");
    const ok = page.deliveries.find((d) => d.job_id === accepted.job_id) as Record<string, unknown>;
    expect(ok).toMatchObject({ skill: "hello", outcome: "accepted", http_status: 202, body_stored: false, body_kind: "json", bytes: 14 });
    expect((ok.headers as Record<string, string>)["x-marker"]).toBe("dl-ok");
    expect((ok.headers as Record<string, string>).authorization).toBeUndefined();
    expect(typeof ok.duration_ms).toBe("number");
    expect(find("slacky", "challenge")).toMatchObject({ http_status: 200, code: "challenge" });
    const rejected = (await json(await fetch(`${base}/deliveries?outcome=rejected&skill=hello`, { headers: auth }))) as unknown as { deliveries: { outcome: string; skill: string }[] };
    expect(rejected.deliveries.length).toBeGreaterThan(0);
    expect(rejected.deliveries.every((d) => d.outcome === "rejected" && d.skill === "hello")).toBe(true);
    const firstPage = (await json(await fetch(`${base}/deliveries?limit=2`, { headers: auth }))) as unknown as { deliveries: { id: string }[]; next_after: string };
    expect(firstPage.deliveries).toHaveLength(2);
    const nextPage = (await json(await fetch(`${base}/deliveries?limit=2&after=${firstPage.next_after}`, { headers: auth }))) as unknown as { deliveries: { id: string }[] };
    expect(nextPage.deliveries.map((d) => d.id)).not.toContain(firstPage.deliveries[0]?.id);
    expect(nextPage.deliveries.map((d) => d.id)).not.toContain(firstPage.next_after);
    const detail = await json(await fetch(`${base}/deliveries/${skipped.id}?include=body`, { headers: auth }));
    expect((detail.delivery as { id: string }).id).toBe(skipped.id);
    expect(detail.body).toMatchObject({ encoding: "utf8", truncated: false, source: "log" });
    expect(JSON.parse((detail.body as { text: string }).text)).toEqual({ action: "deleted", marker: "dl-skip" });
    const viaJob = await json(await fetch(`${base}/deliveries/${ok.id}?include=body`, { headers: auth }));
    expect(viaJob.body).toMatchObject({ source: "job", encoding: "utf8" });
    expect((await json(await fetch(`${base}/deliveries/${ok.id}`, { headers: auth }))).body).toBeUndefined();
    const missing = await fetch(`${base}/deliveries/20200101T000000Z-aaaaaa`, { headers: auth });
    expect(missing.status).toBe(404);
    expect((await json(missing)).error).toBe("unknown_delivery");
    const health = await json(await fetch(`${base}/health`));
    expect((health.deliveries as { total: number }).total).toBeGreaterThan(before);
    expect(typeof (health.deliveries as { last_received_at: string }).last_received_at).toBe("string");
  });

  it("publishes delivery.received on the event stream", async () => {
    const stream = await fetch(`${base}/events?types=delivery.received`, { headers: { authorization: `Bearer ${ADMIN}` } });
    await fetch(`${base}/hooks/filtered`, { method: "POST", body: '{"action":"deleted","marker":"dl-event"}', headers: { authorization: "Bearer f", "content-type": "application/json" } });
    const got = await readSse(stream, (event) => (JSON.parse(event.data) as { data: { delivery: { skill: string } } }).data.delivery.skill === "filtered");
    const last = JSON.parse(got.at(-1)!.data) as { type: string; data: { delivery: { outcome: string; code: string; body_stored: boolean } } };
    expect(last.type).toBe("delivery.received");
    expect(last.data.delivery).toMatchObject({ outcome: "skipped", code: "skipped", body_stored: true });
  });

  it("records the task outcome from structured output or response.json and filters jobs by it", async () => {
    const auth = { authorization: `Bearer ${ADMIN}` };
    const st = await json(await fetch(`${base}/hooks/structured?wait=20`, { method: "POST", body: "{}", headers: { authorization: "Bearer st" } }));
    expect(st).toMatchObject({ status: "succeeded", outcome: "needs_human", response: { outcome: "needs_human", links: ["https://example.com/pr/1"] } });
    expect(String((st.response as { summary: string }).summary)).toContain("structured");
    const stJob = store.get(String(st.job_id))!;
    expect(stJob.outcome).toBe("needs_human");
    expect(stJob.command?.join(" ")).toContain("--json-schema");
    expect(existsSync(store.pathsFor(stJob.id).response)).toBe(true);
    expect(existsSync(store.pathsFor(stJob.id).responseSchema)).toBe(true);
    const detail = await json(await fetch(`${base}/jobs/${stJob.id}?include=response`, { headers: auth }));
    expect(JSON.parse(String((detail.artifacts as Record<string, string>).response))).toMatchObject({ outcome: "needs_human" });
    const fi = await json(await fetch(`${base}/hooks/filer?wait=20`, { method: "POST", body: "{}", headers: { authorization: "Bearer fi" } }));
    expect(fi).toMatchObject({ status: "succeeded", outcome: "nothing_to_do", response: { outcome: "nothing_to_do", summary: "Nothing to do here", links: ["https://example.com/x"] } });
    const cs = await json(await fetch(`${base}/hooks/codexst?wait=20`, { method: "POST", body: "{}", headers: { authorization: "Bearer cs" } }));
    expect(cs).toMatchObject({ status: "succeeded", outcome: "partial", response: { outcome: "partial" } });
    expect(String(cs.result)).toContain("structured codex");
    expect(store.get(String(cs.job_id))?.command?.join(" ")).toContain("--output-schema");
    const plain = await json(await fetch(`${base}/hooks/hello?wait=20`, { method: "POST", body: '{"name":"Outcome"}', headers: { authorization: "Bearer hello-secret", "content-type": "application/json" } }));
    expect(plain).toMatchObject({ status: "succeeded", outcome: "unknown", response: null });
    // `hello` lists FAKE_CLAUDE_RECORD, so the record file holds this run's environment.
    const record = JSON.parse(readFileSync(recordFile, "utf8")) as { env: Record<string, string> };
    expect(record.env.SKILLHOOK_RESPONSE_PATH).toBe(store.pathsFor(String(plain.job_id)).response);
    const failed = await json(await fetch(`${base}/hooks/failing?wait=20`, { method: "POST", body: '{"o":1}', headers: { authorization: "Bearer x", "content-type": "application/json" } }));
    expect(failed).toMatchObject({ status: "failed", outcome: "failed" });
    const shell = await json(await fetch(`${base}/hooks/where-am-i?wait=20`, { method: "POST", body: JSON.stringify({ action: "closed", o: 2 }), headers: { authorization: "Bearer hello-secret", "content-type": "application/json" } }));
    expect(shell).toMatchObject({ status: "succeeded", outcome: "completed" });
    const needs = (await json(await fetch(`${base}/jobs?outcome=needs_human`, { headers: auth }))) as unknown as { jobs: { id: string; outcome: string }[] };
    expect(needs.jobs.map((j) => j.id)).toContain(stJob.id);
    expect(needs.jobs.every((j) => j.outcome === "needs_human")).toBe(true);
    expect((await fetch(`${base}/jobs?outcome=nope`, { headers: auth })).status).toBe(400);
  });

  it("replays deliveries and jobs as new jobs with trigger replay", async () => {
    const auth = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };
    // A filtered delivery is skipped again on replay unless the filters are skipped.
    await fetch(`${base}/hooks/filtered`, { method: "POST", body: '{"action":"deleted","marker":"rp-skip"}', headers: { authorization: "Bearer f", "content-type": "application/json" } });
    const skippedList = (await json(await fetch(`${base}/deliveries?skill=filtered&outcome=skipped&limit=1`, { headers: auth }))) as unknown as { deliveries: { id: string }[] };
    const skippedId = skippedList.deliveries[0]!.id;
    const again = await fetch(`${base}/deliveries/${skippedId}/replay`, { method: "POST", headers: auth, body: "{}" });
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ ok: true, skipped: true, replay_of: { delivery: skippedId } });
    const forced = await json(await fetch(`${base}/deliveries/${skippedId}/replay`, { method: "POST", headers: auth, body: JSON.stringify({ skip_filters: true, wait: 20 }) }));
    expect(forced).toMatchObject({ ok: true, status: "succeeded", replay_of: { delivery: skippedId } });
    const replayJob = store.get(String(forced.job_id))!;
    expect(replayJob).toMatchObject({ trigger: "replay", replay_of: { delivery: skippedId }, source: { method: "REPLAY", ip: "127.0.0.1" } });
    expect(replayJob.delivery_id).toBeUndefined();
    expect(replayJob.fingerprint).toBeUndefined();
    const event = store.readEvent(replayJob.id);
    expect(event).toMatchObject({ trigger: "replay", body_kind: "json", payload: { action: "deleted", marker: "rp-skip" } });
    expect(event.headers["x-skillhook-replay-of"]).toBe(skippedId);
    expect(readFileSync(store.pathsFor(replayJob.id).prompt, "utf8")).toContain("replay");
    // A rejected delivery needs force; overrides apply.
    await fetch(`${base}/hooks/hello`, { method: "POST", body: '{"name":"rp-401"}', headers: { "content-type": "application/json" } });
    const rejectedList = (await json(await fetch(`${base}/deliveries?skill=hello&outcome=rejected&limit=1`, { headers: auth }))) as unknown as { deliveries: { id: string }[] };
    const rejectedId = rejectedList.deliveries[0]!.id;
    const needsForce = await fetch(`${base}/deliveries/${rejectedId}/replay`, { method: "POST", headers: auth, body: "{}" });
    expect(needsForce.status).toBe(409);
    expect((await json(needsForce)).error).toBe("replay_needs_force");
    const forcedRejected = await json(await fetch(`${base}/deliveries/${rejectedId}/replay`, { method: "POST", headers: auth, body: JSON.stringify({ force: true, wait: 20, model: "sonnet" }) }));
    expect(forcedRejected).toMatchObject({ status: "succeeded", replay_of: { delivery: rejectedId } });
    expect(String(forcedRejected.result)).toContain("model=sonnet");
    // An accepted delivery replays through its job, a job replays directly, and neither is folded into an in-flight twin.
    const original = await json(await fetch(`${base}/hooks/hello?wait=20`, { method: "POST", body: '{"name":"rp-job"}', headers: { authorization: "Bearer hello-secret", "content-type": "application/json" } }));
    const viaJob = await json(await fetch(`${base}/jobs/${original.job_id}/replay`, { method: "POST", headers: auth, body: JSON.stringify({ wait: 20 }) }));
    expect(viaJob).toMatchObject({ status: "succeeded", replay_of: { job: original.job_id } });
    expect(viaJob.job_id).not.toBe(original.job_id);
    const acceptedList = (await json(await fetch(`${base}/deliveries?skill=hello&outcome=accepted&limit=10`, { headers: auth }))) as unknown as { deliveries: { id: string; job_id: string }[] };
    const acceptedDelivery = acceptedList.deliveries.find((d) => d.job_id === original.job_id)!;
    const viaDelivery = await json(await fetch(`${base}/deliveries/${acceptedDelivery.id}/replay`, { method: "POST", headers: auth, body: "{}" }));
    expect(viaDelivery).toMatchObject({ status: "queued", replay_of: { delivery: acceptedDelivery.id, job: original.job_id } });
    await waitForJob(String(viaDelivery.job_id));
    const twin = await json(await fetch(`${base}/hooks/twin`, { method: "POST", body: '{"replay":"twin"}', headers: { authorization: "Bearer tw", "content-type": "application/json" } }));
    const twinReplay = await json(await fetch(`${base}/jobs/${twin.job_id}/replay`, { method: "POST", headers: auth, body: "{}" }));
    expect(twinReplay.status).toBe("queued");
    expect(twinReplay.job_id).not.toBe(twin.job_id);
    await waitForJob(String(twin.job_id), 25_000);
    await waitForJob(String(twinReplay.job_id), 25_000);
    expect((await fetch(`${base}/jobs/20200101T000000Z-aaaaaa/replay`, { method: "POST", headers: auth, body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/deliveries/20200101T000000Z-aaaaaa/replay`, { method: "POST", headers: auth, body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/jobs/${original.job_id}/replay`, { method: "POST", headers: auth, body: JSON.stringify({ runner: "gemini" }) })).status).toBe(400);
    expect((await fetch(`${base}/jobs/${original.job_id}/replay`, { method: "POST", headers: { "x-forwarded-for": "203.0.113.1", "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    const replays = (await json(await fetch(`${base}/jobs?trigger=replay&limit=20`, { headers: auth }))) as unknown as { jobs: { trigger: string }[] };
    expect(replays.jobs.length).toBeGreaterThanOrEqual(5);
    expect(replays.jobs.every((j) => j.trigger === "replay")).toBe(true);
  });

  it("pages and filters jobs", async () => {
    const auth = { authorization: `Bearer ${ADMIN}` };
    const first = (await json(await fetch(`${base}/jobs?limit=2`, { headers: auth }))) as unknown as { jobs: { id: string }[]; next_after: string | null };
    expect(first.jobs).toHaveLength(2);
    expect(first.next_after).toBe(first.jobs[1]?.id);
    const next = (await json(await fetch(`${base}/jobs?limit=2&after=${first.next_after}`, { headers: auth }))) as unknown as { jobs: { id: string }[] };
    expect(next.jobs.map((j) => j.id)).not.toContain(first.jobs[0]?.id);
    expect(next.jobs.every((j) => j.id < (first.next_after as string))).toBe(true);
    const api = (await json(await fetch(`${base}/jobs?trigger=api`, { headers: auth }))) as unknown as { jobs: { trigger: string }[] };
    expect(api.jobs.length).toBeGreaterThan(0);
    expect(api.jobs.every((j) => j.trigger === "api")).toBe(true);
    expect((await fetch(`${base}/jobs?status=nope`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/jobs?trigger=nope`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/jobs?since=nope`, { headers: auth })).status).toBe(400);
    const future = (await json(await fetch(`${base}/jobs?since=2999-01-01T00:00:00Z`, { headers: auth }))) as unknown as { jobs: unknown[] };
    expect(future.jobs).toEqual([]);
    const defaulted = (await json(await fetch(`${base}/jobs?limit=abc`, { headers: auth }))) as unknown as { jobs: unknown[] };
    expect(defaulted.jobs.length).toBeGreaterThan(0);
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
