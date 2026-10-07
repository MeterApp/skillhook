import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signRequest } from "./auth.js";
import { ConfigRef, loadConfig, setConfigValue } from "./config.js";
import { DeliveryLog } from "./delivery-log.js";
import { Events } from "./events.js";
import { HealthCache } from "./health.js";
import { ReadinessCache } from "./readiness.js";
import { baseRunEnv } from "./runners/env.js";
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
let config: ReturnType<typeof loadConfig>;
let events: Events;
let readiness: ReadinessCache;
let supervised = false;
const restartCalls: { force: boolean; waitSeconds: number }[] = [];
let ENV_BASE: Record<string, string> = {};
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
  ENV_BASE = {
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
    FAKE_CLAUDE_WRITE_RESPONSE: '{"outcome":"nothing_to_do","title":"Check the order","headline":"Nothing to do: already shipped","summary":"Nothing to do here","links":["https://example.com/x",{"url":"https://example.com/order/1","title":"Order 1","kind":"source"}]}',

    FAKE_CODEX_OUTCOME: "partial",
    SKILLHOOK_SECRET_ASKER: "ask",
    SKILLHOOK_SECRET_ASKALONE: "alone",
    FAKE_CLAUDE_ASK: "Deploy A or B?",
    FAKE_CLAUDE_ASK_WAIT_MS: "4000",
    SKILLHOOK_SECRET_FLAKY: "fl",
    SKILLHOOK_SECRET_RETRIER: "re",
    SKILLHOOK_SECRET_FALLBACKY: "fb",
    FAKE_CLAUDE_FAIL_KIND: "rate_limit",
  };
  writeEnv(paths, ENV_BASE);
  // `asker` would time out after 2 s but waits up to 4 s for a person: the clock has to pause while it waits.
  writeSkill(paths, "asker", "description: ask\nskillhook:\n  timeout_seconds: 2\n  human_wait_seconds: 20\n  env: [FAKE_CLAUDE_ASK, FAKE_CLAUDE_ASK_WAIT_MS]");
  writeSkill(paths, "askalone", "description: alone\nskillhook:\n  timeout_seconds: 30\n  env: [FAKE_CLAUDE_ASK, FAKE_CLAUDE_ASK_WAIT_MS]");
  writeSkill(paths, "flaky", "description: fl\nskillhook:\n  env: [FAKE_CLAUDE_FAIL_KIND]\n  fallback:\n    runners: [codex]\n    on: [not_ready, rate_limit]");
  writeSkill(paths, "retrier", "description: re\nskillhook:\n  env: [FAKE_CLAUDE_FAIL_KIND]\n  retry:\n    attempts: 1\n    on: [rate_limit]\n    backoff_seconds: 0");
  writeSkill(paths, "fallbacky", "description: fb\nskillhook:\n  fallback:\n    runners: [codex]");
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
  config = loadConfig(paths);
  const registry = new SkillRegistry(paths.skillsDir, { projects: () => [projectDir] });
  store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 3600 });
  const { loadSecrets } = await import("./env.js");
  const secrets = () => loadSecrets(paths, {});
  events = new Events(silentLogger);
  const deliveryLog = new DeliveryLog(paths.jobsDir, () => config.deliveries);
  readiness = new ReadinessCache({ config: () => config, env: () => baseRunEnv({ secrets: secrets(), fileSecrets: secrets(), processEnv: process.env }), ttlMs: () => 60_000, events });
  queue = new JobQueue({ store, config, registry, secrets, fileSecrets: secrets, logger: silentLogger, events, processEnv: { ...process.env, SKILLHOOK_BIN: "skillhook-test-bin" }, progressPollMs: 100, readiness });
  const scheduler = new Scheduler({ registry, store, queue, config, logger: silentLogger, now: () => new Date("2026-09-23T10:00:00Z"), events });
  const health = new HealthCache(paths, { ttlMs: () => 60_000, options: () => ({ env: { SKILLHOOK_NO_UPDATE_CHECK: "1" }, exposure: false, service: false, live: () => ({ started_at: new Date().toISOString(), queue: queue.stats() }) }), events });
  const configRef = new ConfigRef(paths, config, { events });
  server = createServer({
    config,
    paths,
    store,
    queue,
    registry,
    secrets,
    logger: silentLogger,
    events,
    deliveryLog,
    health,
    readiness,
    configRef,
    control: { supervised: async () => supervised, restart: (options) => void restartCalls.push(options) },
    serviceStatus: async () => ({ platform: "launchd", installed: true, running: true, pid: 4242, file: "/tmp/skillhook.plist", logFile: path.join(paths.logsDir, "service.log") }),
    serviceLog: (lines) => `${["one", "two", "three"].slice(-lines).join("\n")}\n`,
    applyUpdate: async ({ install }) => ({ ok: true, current: "0.3.0", latest: "0.3.0", available: false, checked_at: "2026-09-28T00:00:00.000Z", registry: "http://registry.invalid", cached: false, install: { method: "npm", command: "npm install -g @meterapp/skillhook@latest" }, release_notes: null, installed: install, service_restarted: false, service_note: null }),
    schedules: () => scheduler.status(),
  });
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
    expect(fi).toMatchObject({ status: "succeeded", outcome: "nothing_to_do", title: "Check the order", response: { outcome: "nothing_to_do", title: "Check the order", headline: "Nothing to do: already shipped", summary: "Nothing to do here", links: ["https://example.com/x", { url: "https://example.com/order/1", title: "Order 1", kind: "source" }] } });
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

  it("runs a SKILL.md that is not installed through POST /skills/test", async () => {
    const auth = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };
    const skillMd = "---\nname: scratch-test\ndescription: Ad-hoc.\nskillhook:\n  model: haiku\n  env: [FAKE_CLAUDE_RECORD]\n---\n\nTry {{payload.thing}} now.\n";
    const res = await fetch(`${base}/skills/test`, { method: "POST", headers: auth, body: JSON.stringify({ skill_md: skillMd, payload: { thing: "adhoc" }, wait: 20 }) });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ status: "succeeded", adhoc: true, outcome: "unknown" });
    const job = store.get(String(body.job_id))!;
    expect(job).toMatchObject({ trigger: "test", adhoc: true, skill: "scratch-test", model: "haiku", source: { method: "TEST" } });
    const skillFile = path.join(store.pathsFor(job.id).skillDir, "scratch-test", "SKILL.md");
    expect(job.skill_file).toBe(skillFile);
    expect(readFileSync(skillFile, "utf8")).toBe(skillMd);
    expect(readFileSync(store.pathsFor(job.id).prompt, "utf8")).toContain("Try adhoc now.");
    const record = JSON.parse(readFileSync(recordFile, "utf8")) as { env: Record<string, string>; cwd: string; args: string[] };
    expect(record.env.SKILLHOOK_SKILL_DIR).toBe(path.dirname(skillFile));
    expect(record.env.SKILLHOOK_TRIGGER).toBe("test");
    expect(record.cwd).toBe(path.dirname(skillFile));
    expect(record.args).toContain("haiku");
    const installed = (await json(await fetch(`${base}/skills`, { headers: auth }))) as unknown as { skills: { name: string }[] };
    expect(installed.skills.map((s) => s.name)).not.toContain("scratch-test");
    const invalid = await fetch(`${base}/skills/test`, { method: "POST", headers: auth, body: JSON.stringify({ skill_md: "---\nname: Bad Name\ndescription: x\n---\nx" }) });
    expect(invalid.status).toBe(400);
    expect((await json(invalid)).error).toBe("invalid_skill_document");
    expect((await fetch(`${base}/skills/test`, { method: "POST", headers: auth, body: JSON.stringify({ payload: {} }) })).status).toBe(400);
    expect((await fetch(`${base}/skills/test`, { method: "POST", headers: auth, body: JSON.stringify({ skill_md: skillMd, runner: "gemini" }) })).status).toBe(400);
    expect((await fetch(`${base}/skills/test`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.1" }, body: "{}" })).status).toBe(401);
    const tests = (await json(await fetch(`${base}/jobs?trigger=test`, { headers: auth }))) as unknown as { jobs: { id: string }[] };
    expect(tests.jobs.map((j) => j.id)).toContain(job.id);
  });

  it("delivers a person's answer to a running job, pauses its timeout meanwhile and streams the exchange", async () => {
    const auth = { authorization: `Bearer ${ADMIN}` };
    const waiting = await fetch(`${base}/events?types=job.progress,job.waiting_human`, { headers: auth });
    const posted = await json(await fetch(`${base}/hooks/asker`, { method: "POST", body: '{"env":"prod"}', headers: { authorization: "Bearer ask", "content-type": "application/json" } }));
    const id = String(posted.job_id);
    const got = await readSse(waiting, (event) => event.event === "job.waiting_human" && (JSON.parse(event.data) as { data: { job: { id: string } } }).data.job.id === id, 10_000);
    const askedAt = Date.now();
    expect(got.some((event) => event.event === "job.progress" && (JSON.parse(event.data) as { data: { entry: { message: string } } }).data.entry.message === "looking at the payload")).toBe(true);
    const asked = JSON.parse(got.at(-1)!.data) as { data: { job: { id: string; status: string; progress: { state: string }; question: { id: string; text: string; options: string[] } }; question: { text: string } } };
    expect(asked.data.job).toMatchObject({ id, title: "Fake task", status: "running", progress: { state: "waiting_human" }, question: { id: "fakeq", text: "Deploy A or B?", options: ["A", "B"], recommended: "B" } });
    // Meanwhile the job shows up as waiting, with its progress and question.
    const list = (await json(await fetch(`${base}/jobs?waiting=1`, { headers: auth }))) as unknown as { jobs: { id: string }[] };
    expect(list.jobs.map((j) => j.id)).toContain(id);
    const progress = await json(await fetch(`${base}/jobs/${id}/progress`, { headers: auth }));
    expect(progress).toMatchObject({ job_id: id, status: "running", waiting: true, question: { text: "Deploy A or B?" } });
    expect((progress.timeline as { type: string }[]).map((e) => e.type)).toEqual(["progress", "question"]);
    // The agent runs with the job API injected and SKILLHOOK_BIN set.
    const command = store.get(id)!.command!.join(" ");
    expect(command).toContain("--mcp-config");
    expect(JSON.parse(store.get(id)!.command![store.get(id)!.command!.indexOf("--mcp-config") + 1]!) as unknown).toMatchObject({ mcpServers: { "skillhook-job": { command: "skillhook-test-bin", args: ["mcp", "--job", "--dir", paths.home], env: { SKILLHOOK_JOB_ID: id, SKILLHOOK_JOB_DIR: store.pathsFor(id).dir } } } });
    expect(command).toContain("mcp__skillhook-job");
    // Answer only once the 2 s timeout would have fired without the pause.
    await sleep(Math.max(0, 2300 - (Date.now() - askedAt)));
    expect(store.get(id)?.status).toBe("running");
    const answered = await fetch(`${base}/events?types=job.answered,job.finished`, { headers: auth });
    expect((await fetch(`${base}/jobs/${id}/answer`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" })).status).toBe(400);
    const reply = await json(await fetch(`${base}/jobs/${id}/answer`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ answer: "Go with A", option: "A", by: "ada" }) }));
    expect(reply).toMatchObject({ ok: true, job_id: id, delivered: "live", resume_job_id: null, answer: { question_id: "fakeq", text: "Go with A", option: "A", by: "ada" } });
    const rest = await readSse(answered, (event) => event.event === "job.finished" && (JSON.parse(event.data) as { data: { job: { id: string } } }).data.job.id === id, 10_000);
    expect(rest.map((event) => event.event)).toEqual(["job.answered", "job.finished"]);
    expect((JSON.parse(rest[0]!.data) as { data: { delivered: string } }).data.delivered).toBe("live");
    const finished = store.get(id)!;
    expect(finished).toMatchObject({ status: "succeeded", question: { id: "fakeq", answered_at: expect.any(String) }, answer: { text: "Go with A", option: "A", by: "ada" } });
    expect(finished.result).toContain("answer=Go with A");
    expect(finished.error).toBeUndefined();
    const after = (await json(await fetch(`${base}/jobs?waiting=1`, { headers: auth }))) as unknown as { jobs: { id: string }[] };
    expect(after.jobs.map((j) => j.id)).not.toContain(id);
    // Nothing left to answer.
    const again = await fetch(`${base}/jobs/${id}/answer`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ answer: "more" }) });
    expect(again.status).toBe(409);
    expect((await json(again)).error).toBe("not_waiting");
    expect((await fetch(`${base}/jobs/${id}/answer`, { method: "POST", headers: { "x-forwarded-for": "203.0.113.1", "content-type": "application/json" }, body: JSON.stringify({ answer: "x" }) })).status).toBe(401);
  });

  it("resumes the agent's session when a person answers a job that ended waiting", async () => {
    const auth = { authorization: `Bearer ${ADMIN}` };
    // Nobody answers: the run ends with its question open, which counts as needs_human.
    const alone = await json(await fetch(`${base}/hooks/askalone?wait=20`, { method: "POST", body: '{"env":"stage"}', headers: { authorization: "Bearer alone", "content-type": "application/json" } }));
    expect(alone).toMatchObject({ status: "succeeded", outcome: "needs_human", response: null });
    expect(String(alone.result)).toContain("answer=none");
    const aloneId = String(alone.job_id);
    expect(store.get(aloneId)).toMatchObject({ question: { text: "Deploy A or B?" }, outcome: "needs_human" });
    // A job that reported needs_human itself, without asking, waits too.
    const st = await json(await fetch(`${base}/hooks/structured?wait=20`, { method: "POST", body: '{"k":"resume"}', headers: { authorization: "Bearer st", "content-type": "application/json" } }));
    const stId = String(st.job_id);
    const waiting = (await json(await fetch(`${base}/jobs?waiting=1`, { headers: auth }))) as unknown as { jobs: { id: string }[] };
    expect(waiting.jobs.map((j) => j.id)).toEqual(expect.arrayContaining([aloneId, stId]));
    // The answer starts a new job that continues the session, linked both ways.
    const reply = await json(await fetch(`${base}/jobs/${aloneId}/answer`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ answer: "Go with B", option: "B", by: "grace", wait: 20 }) }));
    expect(reply).toMatchObject({ ok: true, job_id: aloneId, delivered: "resumed", answer: { question_id: "fakeq", text: "Go with B", option: "B", by: "grace" } });
    const resumeId = String(reply.resume_job_id);
    const original = store.get(aloneId)!;
    expect(original).toMatchObject({ resolved_by: resumeId, answer: { text: "Go with B" }, question: { answered_at: expect.any(String) } });
    const resumed = store.get(resumeId)!;
    expect(resumed).toMatchObject({ trigger: "resume", status: "succeeded", skill: "askalone", title: "Fake task", runner: "claude", resume_of: aloneId, resume: { session_id: original.session_id, runner: "claude" }, question: { id: "fakeq" }, answer: { text: "Go with B", by: "grace" }, source: { method: "RESUME" }, cwd: original.cwd });
    expect(resumed.command!.join(" ")).toContain(`--resume ${original.session_id}`);
    expect(resumed.result).toContain(`resumed=${original.session_id}`);
    expect(reply.resume_job).toMatchObject({ id: resumeId, status: "succeeded" });
    const prompt = readFileSync(store.pathsFor(resumeId).prompt, "utf8");
    expect(prompt).toContain("# Skill: askalone (resumed)");
    expect(prompt).toContain("<human_question>\nDeploy A or B?\nOptions: A | B\n</human_question>");
    expect(prompt).toContain("<human_answer>\nB: Go with B\n(answered by grace)\n</human_answer>");
    expect(original.title).toBe("Fake task");
    expect(store.readEvent(resumeId)).toMatchObject({ trigger: "resume", payload: { env: "stage" }, headers: { "x-skillhook-resume-of": aloneId } });
    const after = (await json(await fetch(`${base}/jobs?waiting=1`, { headers: auth }))) as unknown as { jobs: { id: string }[] };
    expect(after.jobs.map((j) => j.id)).not.toContain(aloneId);
    expect(after.jobs.map((j) => j.id)).not.toContain(resumeId);
    expect((await json(await fetch(`${base}/jobs?trigger=resume`, { headers: auth })) as unknown as { jobs: { id: string }[] }).jobs.map((j) => j.id)).toContain(resumeId);
    // `resume: never` only records the answer; the job then no longer waits.
    const recorded = await json(await fetch(`${base}/jobs/${stId}/answer`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ answer: "Handled by hand", resume: "never" }) }));
    expect(recorded).toMatchObject({ delivered: "recorded", resume_job_id: null, answer: { text: "Handled by hand" } });
    expect((recorded.answer as { question_id?: string }).question_id).toBeUndefined();
    expect(store.get(stId)).toMatchObject({ answer: { text: "Handled by hand" } });
    expect(store.get(stId)?.resolved_by).toBeUndefined();
    const last = (await json(await fetch(`${base}/jobs?waiting=1`, { headers: auth }))) as unknown as { jobs: { id: string }[] };
    expect(last.jobs.map((j) => j.id)).not.toContain(stId);
    expect((await fetch(`${base}/jobs/${stId}/answer`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ answer: "x", resume: "maybe" }) })).status).toBe(400);
    expect((await fetch(`${base}/jobs/20200101T000000Z-zzzzzz/answer`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ answer: "x" }) })).status).toBe(404);
  });

  it("serves the cached health report and the quick doctor to admins", async () => {
    const auth = { authorization: `Bearer ${ADMIN}` };
    expect((await fetch(`${base}/health/checks`, { headers: { "x-forwarded-for": "203.0.113.1" } })).status).toBe(401);
    expect((await fetch(`${base}/health/checks`, { method: "POST", headers: auth })).status).toBe(405);
    const stream = await fetch(`${base}/events?types=health.changed`, { headers: auth });
    const quick = await json(await fetch(`${base}/health/checks?deep=0`, { headers: auth }));
    expect(quick).toMatchObject({ deep: false, network: false, cached: false, ok: expect.any(Boolean) });
    const quickChecks = quick.checks as { name: string; status: string; detail: string; group: string }[];
    expect(quickChecks.find((c) => c.name === "server")).toMatchObject({ status: "ok", group: "skillhook", detail: expect.stringContaining("this server") });
    expect(quickChecks.find((c) => c.name === "claude")).toMatchObject({ status: "ok", group: "runners", detail: expect.stringContaining("2.1.270") });
    expect(quickChecks.some((c) => c.group === "tools")).toBe(false);
    expect(quickChecks.some((c) => c.name === "tailscale" || c.name === "service")).toBe(false);
    const again = await json(await fetch(`${base}/health/checks?deep=0`, { headers: auth }));
    expect(again.cached).toBe(true);
    expect(again.generated_at).toBe(quick.generated_at);
    const fresh = await json(await fetch(`${base}/health/checks?deep=0&refresh=1`, { headers: auth }));
    expect(fresh.cached).toBe(false);
    const deep = await json(await fetch(`${base}/health/checks`, { headers: auth }));
    expect(deep).toMatchObject({ deep: true, cached: false });
    const deepChecks = deep.checks as { name: string; status: string; detail: string; hint?: string; group: string }[];
    expect(deepChecks.find((c) => c.name === "claude mcp stitch")).toMatchObject({ status: "ok", group: "tools" });
    expect(deepChecks.find((c) => c.name === "claude mcp sentry")).toMatchObject({ status: "warn" });
    expect(deepChecks.find((c) => c.name === "claude mcp slack")).toMatchObject({ status: "fail", detail: expect.stringContaining("CONNECTION_CLOSED") });
    expect(deepChecks.find((c) => c.name === "claude plugins")).toMatchObject({ status: "ok", detail: expect.stringContaining("supabase@claude-plugins-official@0.1.15") });
    expect(deepChecks.find((c) => c.name === "codex doctor")).toMatchObject({ status: "warn", hint: expect.stringContaining("codex mcp login linear") });
    expect(deepChecks.find((c) => c.name === "skill hello")?.detail).toContain("last run succeeded");
    expect(deep.groups).toMatchObject({ tools: { fail: 1 } });
    const doctor = await json(await fetch(`${base}/doctor`, { headers: auth }));
    expect(doctor).toMatchObject({ deep: false, network: true });
    expect((doctor.checks as { name: string }[]).some((c) => c.name.startsWith("claude mcp"))).toBe(false);
    const got = await readSse(stream, (event) => event.event === "health.changed", 10_000);
    const first = JSON.parse(got[0]!.data) as { data: { report: { deep: boolean }; changed: { name: string; from: string | null; to: string }[] } };
    expect(first.data.report.deep).toBe(false);
    expect(first.data.changed.find((c) => c.name === "node")).toEqual({ name: "node", from: null, to: "ok" });
  });

  it("classifies failures, retries on the same runner and falls back to another after a failed run", async () => {
    const auth = { authorization: `Bearer ${ADMIN}` };
    const retried = await json(await fetch(`${base}/hooks/retrier?wait=20`, { method: "POST", body: "{}", headers: { authorization: "Bearer re" } }));
    expect(retried).toMatchObject({ status: "failed", outcome: "failed" });
    const retriedJob = store.get(String(retried.job_id))!;
    expect(retriedJob.failure).toEqual({ kind: "rate_limit", code: "error_during_execution", retryable: true, message: expect.stringContaining("429") });
    expect(retriedJob.attempts).toHaveLength(1);
    expect(retriedJob.attempts?.[0]).toMatchObject({ runner: "claude", status: "failed", failure: { kind: "rate_limit" } });
    expect(retriedJob.runner).toBe("claude");
    expect(retriedJob.runner_requested).toBeUndefined();
    expect(readFileSync(store.pathsFor(retriedJob.id).stdout, "utf8")).toContain("--- attempt 2 (claude) ---");
    const fell = await json(await fetch(`${base}/hooks/flaky?wait=20`, { method: "POST", body: "{}", headers: { authorization: "Bearer fl" } }));
    expect(fell).toMatchObject({ status: "succeeded", outcome: "unknown" });
    const fellJob = store.get(String(fell.job_id))!;
    expect(fellJob).toMatchObject({ runner: "codex", runner_requested: "claude", runner_reason: "fallback: claude failed (rate_limit)" });
    expect(fellJob.attempts).toEqual([expect.objectContaining({ runner: "claude", status: "failed", failure: expect.objectContaining({ kind: "rate_limit" }) })]);
    expect(fellJob.failure).toBeUndefined();
    expect(String(fell.result)).toContain("FAKE CODEX OK");
    const failed = await json(await fetch(`${base}/hooks/failing?wait=20`, { method: "POST", body: "{}", headers: { authorization: "Bearer x" } }));
    expect(store.get(String(failed.job_id))?.failure).toEqual({ kind: "unknown", code: "error", retryable: false, message: "simulated failure" });
    const byKind = (await json(await fetch(`${base}/jobs?failure=rate_limit`, { headers: auth }))) as unknown as { jobs: { id: string; failure: { kind: string } }[] };
    expect(byKind.jobs.map((j) => j.id)).toContain(retriedJob.id);
    expect(byKind.jobs.every((j) => j.failure.kind === "rate_limit")).toBe(true);
    expect((await fetch(`${base}/jobs?failure=nope`, { headers: auth })).status).toBe(400);
  });

  it("checks runner readiness before a job: a logged-out runner falls back or fails fast", async () => {
    const auth = { authorization: `Bearer ${ADMIN}` };
    const before = (await json(await fetch(`${base}/runners`, { headers: auth }))) as unknown as { runners: { runner: string; ready: boolean; version?: string }[]; default_runner: string };
    expect(before.default_runner).toBe("claude");
    expect(before.runners.map((r) => [r.runner, r.ready])).toEqual([
      ["claude", true],
      ["codex", true],
      ["shell", true],
    ]);
    expect(before.runners[0]?.version).toBe("2.1.270");
    expect((await fetch(`${base}/runners`, { headers: { "x-forwarded-for": "203.0.113.1" } })).status).toBe(401);
    // Claude logs out (the job environment sees CLAUDE_CONFIG_DIR from .env, like a real install).
    const loggedOut = path.join(paths.home, "claude-logged-out");
    mkdirSync(loggedOut, { recursive: true });
    writeFileSync(path.join(loggedOut, "logged-out"), "");
    writeEnv(paths, { ...ENV_BASE, CLAUDE_CONFIG_DIR: loggedOut });
    try {
      const stream = await fetch(`${base}/events?types=runners.changed`, { headers: auth });
      const refreshed = (await json(await fetch(`${base}/runners?refresh=1`, { headers: auth }))) as unknown as { runners: { runner: string; ready: boolean; authenticated: boolean | null; hint?: string }[] };
      expect(refreshed.runners[0]).toMatchObject({ runner: "claude", ready: false, authenticated: false, hint: expect.stringContaining("claude login") });
      expect(refreshed.runners[1]).toMatchObject({ runner: "codex", ready: true });
      const changed = await readSse(stream, (event) => event.event === "runners.changed" && (JSON.parse(event.data) as { data: { runner: string } }).data.runner === "claude", 10_000);
      expect((JSON.parse(changed.at(-1)!.data) as { data: { readiness: { ready: boolean }; previous: { ready: boolean } } }).data).toMatchObject({ readiness: { ready: false }, previous: { ready: true } });
      // With a fallback the job runs on codex; without one it fails before spawning anything.
      const fell = await json(await fetch(`${base}/hooks/fallbacky?wait=20`, { method: "POST", body: "{}", headers: { authorization: "Bearer fb" } }));
      expect(fell).toMatchObject({ status: "succeeded" });
      expect(store.get(String(fell.job_id))).toMatchObject({ runner: "codex", runner_requested: "claude", runner_reason: "fallback: claude not logged in" });
      expect(store.get(String(fell.job_id))?.attempts).toBeUndefined();
      const fast = await json(await fetch(`${base}/hooks/hello?wait=20`, { method: "POST", body: '{"name":"NoAuth"}', headers: { authorization: "Bearer hello-secret", "content-type": "application/json" } }));
      expect(fast).toMatchObject({ status: "failed", outcome: "failed" });
      const fastJob = store.get(String(fast.job_id))!;
      expect(fastJob.error).toContain("claude is not ready: not logged in");
      expect(fastJob.failure).toEqual({ kind: "auth", retryable: false, message: "not logged in" });
      expect(fastJob.command).toBeUndefined();
      expect(fastJob.started_at).toBeDefined();
    } finally {
      writeEnv(paths, ENV_BASE);
    }
    const restored = (await json(await fetch(`${base}/runners?refresh=1`, { headers: auth }))) as unknown as { runners: { runner: string; ready: boolean }[] };
    expect(restored.runners[0]).toMatchObject({ runner: "claude", ready: true });
    const ok = await json(await fetch(`${base}/hooks/hello?wait=20`, { method: "POST", body: '{"name":"Back"}', headers: { authorization: "Bearer hello-secret", "content-type": "application/json" } }));
    expect(ok.status).toBe("succeeded");
  });

  it("serves stats over the jobs and deliveries it recorded", async () => {
    const auth = { authorization: `Bearer ${ADMIN}` };
    expect((await fetch(`${base}/stats`, { headers: { "x-forwarded-for": "203.0.113.1" } })).status).toBe(401);
    expect((await fetch(`${base}/stats?since=yesterday`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/stats?until=nope`, { headers: auth })).status).toBe(400);
    const all = (await json(await fetch(`${base}/stats`, { headers: auth }))) as unknown as { window: { since: string | null }; jobs: { total: number; by_status: Record<string, number>; by_failure_kind: Record<string, number>; success_rate: number | null; cost_usd: number; tokens: { input: number } }; deliveries: { total: number; by_outcome: Record<string, number>; by_http_status: Record<string, number> }; skills: Record<string, { jobs: number; deliveries: number }> };
    expect(all.window.since).toBeNull();
    expect(all.jobs.total).toBeGreaterThan(10);
    expect(all.jobs.by_status.succeeded).toBeGreaterThan(5);
    expect(all.jobs.by_failure_kind.rate_limit).toBeGreaterThanOrEqual(1);
    expect(all.jobs.success_rate).toBeGreaterThan(0);
    expect(all.jobs.cost_usd).toBeGreaterThan(0);
    expect(all.jobs.tokens.input).toBeGreaterThan(0);
    expect(all.deliveries.total).toBeGreaterThan(all.jobs.total - 5);
    expect(all.deliveries.by_outcome.rejected).toBeGreaterThan(0);
    expect(all.deliveries.by_http_status["401"]).toBeGreaterThan(0);
    const hello = all.skills.hello!;
    expect(hello).toMatchObject({ jobs: expect.any(Number) });
    expect(hello.deliveries).toBeGreaterThan(hello.jobs - 1);
    const recent = (await json(await fetch(`${base}/stats?since=1h&skill=hello`, { headers: auth }))) as unknown as { window: { skill: string; since: string }; jobs: { total: number }; skills: Record<string, unknown> };
    expect(recent.window.skill).toBe("hello");
    expect(Date.parse(recent.window.since)).toBeGreaterThan(Date.now() - 3_700_000);
    expect(recent.jobs.total).toBe(hello.jobs);
    expect(Object.keys(recent.skills)).toEqual(["hello"]);
    const none = (await json(await fetch(`${base}/stats?until=2020-01-01T00:00:00Z`, { headers: auth }))) as unknown as { jobs: { total: number }; deliveries: { total: number } };
    expect(none).toMatchObject({ jobs: { total: 0 }, deliveries: { total: 0 } });
  });

  it("reads, patches and reloads the live config through the admin API", async () => {
    const auth = { authorization: `Bearer ${ADMIN}` };
    const jsonHeaders = { ...auth, "content-type": "application/json" };
    expect((await fetch(`${base}/config`, { headers: { "x-forwarded-for": "203.0.113.1" } })).status).toBe(401);
    const shown = await json(await fetch(`${base}/config`, { headers: auth }));
    expect(shown).toMatchObject({ exists: true, file: paths.configFile, restart_keys: ["host", "port"], pending_restart: [] });
    expect((shown.config as { concurrency: number }).concurrency).toBe(4);
    expect(shown.hot_keys).toContain("concurrency");
    const stream = await fetch(`${base}/events?types=config.changed`, { headers: auth });
    // A hot key applies at once: ?wait= is now clamped to one second, so a slow job answers 202.
    const patched = await json(await fetch(`${base}/config`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ set: { max_wait_seconds: 1 } }) }));
    expect(patched).toMatchObject({ ok: true, applied: ["max_wait_seconds"], restart_required: false, restart_required_keys: [], pending_restart: [] });
    expect(config.max_wait_seconds).toBe(1);
    const slow = await fetch(`${base}/hooks/slow?wait=20`, { method: "POST", body: JSON.stringify({ hot: true }), headers: { authorization: "Bearer s", "content-type": "application/json" } });
    expect(slow.status).toBe(202);
    expect(String((await json(slow)).note)).toContain("after 1s");
    const changed = await readSse(stream, (event) => event.event === "config.changed", 10_000);
    expect((JSON.parse(changed.at(-1)!.data) as { data: { applied: string[]; config: { max_wait_seconds: number } } }).data).toMatchObject({ applied: ["max_wait_seconds"], config: { max_wait_seconds: 1 } });
    await fetch(`${base}/config`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ set: { max_wait_seconds: 30 } }) });
    expect(config.max_wait_seconds).toBe(30);
    // A restart-only key is written but waits.
    const port = await json(await fetch(`${base}/config`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ set: { port: 9999 } }) }));
    expect(port).toMatchObject({ ok: true, applied: [], restart_required: true, restart_required_keys: ["port"], pending_restart: ["port"] });
    expect((port.config as { port: number }).port).toBe(8787);
    expect((await json(await fetch(`${base}/config`, { headers: auth }))).pending_restart).toEqual(["port"]);
    const back = await json(await fetch(`${base}/config`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ unset: ["port"] }) }));
    expect(back).toMatchObject({ restart_required: false, pending_restart: [] });
    // Bad patches change nothing.
    expect((await json(await fetch(`${base}/config`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ set: { $schema: "x" } }) }))).error).toBe("config_key_not_allowed");
    expect((await json(await fetch(`${base}/config`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ set: { "__proto__.polluted": true } }) }))).error).toBe("config_key_not_allowed");
    expect((await json(await fetch(`${base}/config`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ set: { concurrency: "lots" } }) }))).error).toBe("config_invalid");
    expect((await fetch(`${base}/config`, { method: "PATCH", headers: jsonHeaders, body: "{}" })).status).toBe(400);
    expect((await fetch(`${base}/config`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ set: [] }) })).status).toBe(400);
    expect(config.concurrency).toBe(4);
    // A file edited by hand is picked up by an explicit reload.
    setConfigValue(paths, "concurrency", 5);
    const reloaded = await json(await fetch(`${base}/config/reload`, { method: "POST", headers: auth }));
    expect(reloaded).toMatchObject({ ok: true, applied: ["concurrency"], restart_required: false });
    expect(config.concurrency).toBe(5);
    setConfigValue(paths, "concurrency", 4);
    await fetch(`${base}/config/reload`, { method: "POST", headers: auth });
    expect(config.concurrency).toBe(4);
    expect((await fetch(`${base}/config`, { method: "DELETE", headers: auth })).status).toBe(405);
  });

  it("restarts only when supervised, and serves the service status, its log and the update check", async () => {
    const auth = { authorization: `Bearer ${ADMIN}` };
    const jsonHeaders = { ...auth, "content-type": "application/json" };
    supervised = false;
    const refused = await fetch(`${base}/control/restart`, { method: "POST", headers: jsonHeaders, body: "{}" });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toBe("not_a_service");
    expect(restartCalls).toEqual([]);
    supervised = true;
    const accepted = await json(await fetch(`${base}/control/restart`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ wait_seconds: 5 }) }));
    expect(accepted).toMatchObject({ ok: true, restarting: true, force: false, wait_seconds: 5 });
    await sleep(50);
    expect(restartCalls).toEqual([{ force: false, waitSeconds: 5 }]);
    const forced = await json(await fetch(`${base}/control/restart`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ force: true, wait_seconds: 100000 }) }));
    expect(forced).toMatchObject({ force: true, wait_seconds: 600 });
    await sleep(50);
    expect(restartCalls[1]).toEqual({ force: true, waitSeconds: 600 });
    supervised = false;
    expect((await fetch(`${base}/control/restart`, { method: "POST", headers: { "x-forwarded-for": "203.0.113.1" } })).status).toBe(401);
    const service = await json(await fetch(`${base}/service`, { headers: auth }));
    expect(service).toMatchObject({ service: { platform: "launchd", running: true, pid: 4242 }, this_pid: process.pid, supervised: false });
    const logs = await json(await fetch(`${base}/logs?lines=2`, { headers: auth }));
    expect(logs).toMatchObject({ lines: ["two", "three"], file: path.join(paths.logsDir, "service.log") });
    expect(((await json(await fetch(`${base}/logs`, { headers: auth }))).lines as string[]).length).toBe(3);
    const checked = await json(await fetch(`${base}/update`, { method: "POST", headers: jsonHeaders, body: "{}" }));
    expect(checked).toMatchObject({ ok: true, latest: "0.3.0", available: false, installed: false });
    const installed = await json(await fetch(`${base}/update`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ install: true }) }));
    expect(installed.installed).toBe(true);
    expect((await fetch(`${base}/update`, { headers: auth })).status).toBe(405);
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
