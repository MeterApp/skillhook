import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigRef, loadConfig, type Config } from "../config.js";
import { DeliveryLog } from "../delivery-log.js";
import { loadSecrets, readEnvFile } from "../env.js";
import { Events } from "../events.js";
import { JobStore, type JobRecord } from "../jobs.js";
import { silentLogger } from "../logger.js";
import type { WebhookEvent } from "../payload.js";
import { JobQueue } from "../queue.js";
import { SkillRegistry } from "../registry.js";
import { createServer } from "../server.js";
import { FakeCloud } from "../test-support/fake-cloud.js";
import { FAKE_CLAUDE, tempHome, writeConfigFile, writeEnv, writeSkill } from "../test-support/helpers.js";
import { createControlHandlers } from "./control.js";
import { CloudLink, type LinkTiming } from "./link.js";
import type { Command, CommandResult, EventEnvelope, IngressItem } from "./protocol.js";
import { machineKeyPair, openSealed, sealForRecipient } from "./seal.js";

// Placeholder values: nothing here is a real credential.
const SECRET = "placeholder-hello-value";
const TIMING: Partial<LinkTiming> = { disabledPollMs: 20, backoffMinMs: 5, backoffMaxMs: 30, revokedRetryMs: 40, upgradeRetryMs: 40, syncTimeoutMs: 3_000, stopSyncTimeoutMs: 1_000 };

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await sleep(10);
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

interface SetupOptions {
  cloud?: Partial<Config["cloud"]>;
  env?: NodeJS.ProcessEnv;
  localBaseUrl?: () => string | undefined;
  fetchImpl?: typeof fetch;
  /** Run jobs and accept control commands (a queue with the fake runner, the control handlers, a fake supervisor). */
  control?: boolean;
  extraEnv?: Record<string, string>;
}

async function setup(options: SetupOptions = {}) {
  const fake = await FakeCloud.start();
  cleanups.push(() => fake.close());
  const paths = tempHome("skillhook-link-");
  writeConfigFile(paths, { runners: { claude: { command: FAKE_CLAUDE } }, cloud: { enabled: true, url: fake.url, machine_id: fake.machineId, ...options.cloud } });
  writeEnv(paths, { SKILLHOOK_CLOUD_TOKEN: fake.token, SKILLHOOK_SECRET_HELLO: SECRET, ...options.extraEnv });
  writeSkill(paths, "hello", "description: hello");
  const config = loadConfig(paths);
  const events = new Events(silentLogger);
  const store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 60 });
  const deliveryLog = new DeliveryLog(paths.jobsDir, () => config.deliveries);
  const registry = new SkillRegistry(paths.skillsDir);
  const secrets = () => loadSecrets(paths, {});
  const fileSecrets = () => readEnvFile(paths.envFile);
  const restarts: { force: boolean; waitSeconds: number }[] = [];
  let queue: JobQueue | undefined;
  let control: ReturnType<typeof createControlHandlers> | undefined;
  if (options.control) {
    queue = new JobQueue({ store, config, registry, secrets, fileSecrets: secrets, logger: silentLogger, events });
    const configRef = new ConfigRef(paths, config, { events });
    control = createControlHandlers({ paths, config, configRef, secrets, fileSecrets, registry, store, deliveryLog, queue, events, logger: silentLogger, serverControl: { supervised: async () => true, restart: (o) => void restarts.push(o) }, applyUpdate: async ({ install }) => ({ ok: true, current: "0.4.0", latest: "0.4.1", available: true, checked_at: null, registry: "http://registry.invalid", cached: false, install: { method: "npm", command: "npm install -g @meterapp/skillhook@0.4.1" }, release_notes: null, installed: install, service_restarted: false, service_note: null }) });
    const q = queue;
    cleanups.push(() => q.shutdown());
  }
  const link = new CloudLink({ paths, config, secrets, fileSecrets, events, logger: silentLogger, registry, store, deliveryLog, serverState: () => undefined, localBaseUrl: options.localBaseUrl ?? (() => undefined), env: options.env ?? {}, fetchImpl: options.fetchImpl, timing: TIMING, control, queueStats: queue ? () => (queue as JobQueue).stats() : undefined });
  cleanups.push(() => link.stop("test"));
  return { fake, paths, config, events, store, deliveryLog, registry, link, secrets, queue, restarts };
}

async function runCommands(fake: FakeCloud, commands: Command[]): Promise<Record<string, CommandResult>> {
  for (const command of commands) fake.queueCommand(command);
  await fake.waitFor(() => commands.every((c) => fake.results.some((r) => r.command_id === c.id)), 15_000);
  return Object.fromEntries(fake.results.map((r) => [r.command_id, r]));
}

function cmd(id: string, type: Command["type"], args?: unknown): Command {
  return { id, type, ...(args === undefined ? {} : { args }), issued_at: new Date().toISOString(), requested_by: { kind: "user", name: "ada" } };
}

function event(skill: string): WebhookEvent {
  return { id: "", skill, trigger: "webhook", received_at: new Date().toISOString(), method: "POST", path: `/hooks/${skill}`, query: {}, headers: {}, source_ip: "203.0.113.1", content_type: "application/json", content_length: 2, body_kind: "json", payload: {} };
}

function newJob(store: JobStore): JobRecord {
  return store.create({ skill: "hello", trigger: "webhook", runner: "claude", source: { ip: "203.0.113.1", method: "POST", path: "/hooks/hello", content_type: "application/json" }, event: event("hello") });
}

function ingress(partial: Partial<IngressItem> & { id: string }): IngressItem {
  return { skill: "hello", received_at: new Date().toISOString(), method: "POST", path: "/hooks/hello", query: {}, headers: { "content-type": "application/json" }, body_base64: Buffer.from('{"a":1}').toString("base64"), content_type: "application/json", source_ip: "203.0.113.7", ...partial };
}

describe("CloudLink", () => {
  it("opens with link.started and a snapshot, then uploads events redacted and scrubbed of .env values", async () => {
    const { fake, link, events, store } = await setup();
    link.start();
    await fake.waitFor(() => fake.requests.length >= 1);
    const first = fake.requests[0]!;
    expect(first.machine.id).toBe(fake.machineId);
    expect(first.status.link.mode).toBe("observe");
    expect(first.snapshot?.skills.map((s) => s.name)).toEqual(["hello"]);
    expect(first.events.map((e) => e.type)).toEqual(["link.started"]);
    expect(first.events[0]).toMatchObject({ id: `${fake.machineId}:1`, seq: 1 });
    expect(fake.authHeaders[0]).toBe(`Bearer ${fake.token}`);

    const job = newJob(store);
    const finished = store.update(job.id, { status: "succeeded", result: `used ${SECRET} to call the API`, command: ["claude", "-p", SECRET] });
    events.emit("server.stopping", { reason: "test", running: 0 }); // stays local
    events.emit("job.finished", { job: finished });
    await fake.waitFor(() => fake.requests.some((r) => r.events.some((e) => e.type === "job.finished")));
    const uploaded = fake.requests.flatMap((r) => r.events).find((e) => e.type === "job.finished")!;
    const data = uploaded.data as { job: Record<string, unknown> };
    expect(data.job.result).toBe("used [redacted] to call the API");
    expect(data.job.command).toBeUndefined();
    expect(fake.requests.flatMap((r) => r.events).some((e) => (e.type as string).startsWith("server."))).toBe(false);
    const everything = JSON.stringify(fake.requests);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(fake.token);
    expect(fake.requests.slice(1).every((r) => r.snapshot === undefined)).toBe(true);
    await waitUntil(() => link.status().outbox_depth === 0);
    expect(link.status()).toMatchObject({ state: "connected", machine_id: fake.machineId, enabled: true, url: fake.url });
    expect(fake.invalid).toEqual([]);
  });

  it("runs read commands, refuses control commands in observe mode and reports every result", async () => {
    const { fake, link } = await setup();
    link.start();
    await fake.waitFor(() => fake.requests.length >= 1);
    const at = new Date().toISOString();
    const commands: Command[] = [
      { id: "c-ping", type: "ping", issued_at: at },
      { id: "c-jobs", type: "job.list", args: { limit: 5 }, issued_at: at },
      { id: "c-skill", type: "skill.get", args: { name: "hello" }, issued_at: at },
      { id: "c-missing", type: "skill.get", args: { name: "nope" }, issued_at: at },
      { id: "c-bad", type: "skill.get", args: {}, issued_at: at },
      { id: "c-run", type: "skill.run", args: { name: "hello" }, issued_at: at, requested_by: { kind: "user", name: "ada" } },
      { id: "c-old", type: "ping", issued_at: at, expires_at: "2020-01-01T00:00:00.000Z" },
      { id: "c-secrets", type: "secret.list", issued_at: at },
    ];
    for (const command of commands) fake.queueCommand(command);
    await fake.waitFor(() => commands.every((c) => fake.results.some((r) => r.command_id === c.id)));
    const byId = Object.fromEntries(fake.results.map((r) => [r.command_id, r]));
    expect(byId["c-ping"]).toMatchObject({ ok: true, result: { pong: true } });
    expect(byId["c-jobs"]).toMatchObject({ ok: true, result: { jobs: [], next_after: null } });
    expect(byId["c-skill"]).toMatchObject({ ok: true, result: { name: "hello", content: expect.stringContaining("name: hello") } });
    expect(byId["c-missing"]).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(byId["c-bad"]).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(byId["c-run"]).toMatchObject({ ok: false, error: { code: "denied_by_policy", message: expect.stringContaining("cloud.mode: control") } });
    expect(byId["c-old"]).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(byId["c-secrets"]).toMatchObject({ ok: true, result: { names: ["SKILLHOOK_CLOUD_TOKEN", "SKILLHOOK_SECRET_HELLO"] } });
    expect(JSON.stringify(fake.results)).not.toContain(SECRET);
    await fake.waitFor(() => fake.requests.some((r) => r.ack.commands_received.includes("c-ping")));
    // A command the cloud sends again is answered from what was kept, not run twice.
    const pingFinished = byId["c-ping"]!.finished_at;
    const resent = fake.requests.length;
    fake.queueCommand(commands[0]!);
    await fake.waitFor(() => fake.requests.length >= resent + 3);
    expect(fake.results.filter((r) => r.command_id === "c-ping")).toHaveLength(1);
    expect(fake.results.find((r) => r.command_id === "c-ping")?.finished_at).toBe(pingFinished);
  });

  it("backs off and reports degraded on server errors, stops on a revoked token or an old protocol, and comes back", async () => {
    const { fake, link } = await setup();
    link.start();
    await fake.waitFor(() => fake.requests.length >= 1);
    fake.mode = "500";
    const before = fake.requests.length;
    await fake.waitFor(() => fake.requests.length >= before + 3);
    await waitUntil(() => link.status().state === "degraded");
    expect(link.status()).toMatchObject({ reason: "server_error", last_error: "boom" });
    fake.mode = "ok";
    await waitUntil(() => link.status().state === "connected");
    expect(link.status().last_error).toBeNull();
    fake.mode = "401";
    await waitUntil(() => link.status().reason === "token_revoked");
    expect(link.status().state).toBe("disconnected");
    fake.mode = "426";
    await waitUntil(() => link.status().reason === "upgrade_required");
    expect(link.status().last_error).toContain("protocol 2");
    fake.mode = "ok";
    await waitUntil(() => link.status().state === "connected");
    // Coming back after being cut off is a new session for the cloud.
    await fake.waitFor(() => fake.requests.flatMap((r) => r.events).filter((e) => e.type === "link.started").length >= 2);
  });

  it("halves the batch when the cloud says it is too large, and gives up on an event that never fits", async () => {
    const { fake, link, events, store } = await setup();
    link.start();
    await fake.waitFor(() => fake.requests.length >= 1);
    await waitUntil(() => link.status().outbox_depth === 0);
    fake.maxEventsPerRequest = 4;
    const job = newJob(store);
    for (let i = 0; i < 10; i++) events.emit("job.updated", { job, fields: ["pid"] });
    await waitUntil(() => link.status().outbox_depth === 0);
    expect(fake.tooLarge).toBeGreaterThanOrEqual(1);
    const delivered = fake.requests.filter((r) => r.events.length <= 4).flatMap((r) => r.events).filter((e) => e.type === "job.updated");
    expect(new Set(delivered.map((e) => e.seq)).size).toBe(10);
    fake.maxEventsPerRequest = 0;
    events.emit("job.updated", { job, fields: ["pid"] });
    await waitUntil(() => link.status().dropped_total === 1);
    fake.maxEventsPerRequest = Number.POSITIVE_INFINITY;
    await waitUntil(() => link.status().state === "connected" && link.status().outbox_depth === 0);
  });

  it("stores a rotated token and uses it from the next sync on", async () => {
    const { fake, link, paths } = await setup();
    link.start();
    await fake.waitFor(() => fake.requests.length >= 1);
    const rotated = "rotated-placeholder-token-000000000";
    fake.rotateTo = rotated;
    await waitUntil(() => readEnvFile(paths.envFile).SKILLHOOK_CLOUD_TOKEN === rotated);
    const count = fake.authHeaders.length;
    await fake.waitFor(() => fake.authHeaders.length >= count + 2);
    expect(fake.authHeaders.at(-1)).toBe(`Bearer ${rotated}`);
    expect(link.status().state).toBe("connected");
  });

  it("sends nothing while disabled, by config, by SKILLHOOK_NO_CLOUD or for a URL that is not https, and follows the config live", async () => {
    const off = await setup({ cloud: { enabled: false } });
    off.link.start();
    off.events.emit("job.finished", { job: newJob(off.store) }); // not spooled while disabled
    await sleep(120);
    expect(off.fake.requests).toHaveLength(0);
    expect(off.link.status()).toMatchObject({ state: "disabled", enabled: false, outbox_depth: 0 });
    // Enabled live, the way `skillhook cloud connect` does it through the config file and a reload.
    off.config.cloud.enabled = true;
    off.events.emit("config.changed", { changed: ["cloud"], applied: ["cloud"], restart_required: [], pending_restart: [], config: off.config });
    await off.fake.waitFor(() => off.fake.requests.length >= 1);
    expect(off.fake.requests[0]?.events.map((e) => e.type)).toContain("link.started");

    const killed = await setup({ env: { SKILLHOOK_NO_CLOUD: "1" } });
    killed.link.start();
    await sleep(120);
    expect(killed.fake.requests).toHaveLength(0);
    expect(killed.link.status()).toMatchObject({ state: "disabled", reason: "env_disabled", enabled: false });

    let calls = 0;
    const insecure = await setup({
      cloud: { url: "http://cloud.example.invalid" },
      fetchImpl: async () => {
        calls++;
        throw new Error("must not be called");
      },
    });
    insecure.link.start();
    await waitUntil(() => insecure.link.status().reason === "insecure_url");
    expect(insecure.link.status().state).toBe("disconnected");
    expect(calls).toBe(0);
  });

  it("hands hosted deliveries to the local server once, with the sender's address, and acknowledges each", async () => {
    const hits: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
    const local = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        hits.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        const accepted = (req.url ?? "").startsWith("/hooks/hello");
        res.writeHead(accepted ? 202 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(accepted ? { ok: true, job_id: "20260928T120000Z-abcdef", status: "queued" } : { ok: false, error: "invalid_signature", message: "bad signature" }));
      });
    });
    const localUrl = await listen(local);
    cleanups.push(() => new Promise((resolve) => local.close(resolve)));
    const { fake, link, config } = await setup({ localBaseUrl: () => localUrl });
    link.start();
    const item = ingress({ id: "ing-1", query: { wait: "30", a: "1" }, headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=placeholder", host: "hooks.example", "x-forwarded-for": "10.9.9.9", "content-length": "7" } });
    fake.queueIngress(item);
    await fake.waitFor(() => fake.ingressAcks.some((a) => a.id === "ing-1"));
    expect(fake.ingressAcks.find((a) => a.id === "ing-1")).toEqual({ id: "ing-1", outcome: "accepted", http_status: 202, job_id: "20260928T120000Z-abcdef" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.url).toBe("/hooks/hello?a=1");
    expect(hits[0]?.headers["x-forwarded-for"]).toBe("203.0.113.7");
    expect(hits[0]?.headers["x-skillhook-ingress-id"]).toBe("ing-1");
    expect(hits[0]?.headers["x-hub-signature-256"]).toBe("sha256=placeholder");
    expect(hits[0]?.headers.host).not.toBe("hooks.example");
    expect(hits[0]?.body).toBe('{"a":1}');
    // The cloud sends it again: acknowledged again, not delivered twice.
    fake.queueIngress(item);
    await fake.waitFor(() => fake.requests.filter((r) => r.ingress_acks.some((a) => a.id === "ing-1")).length >= 2);
    expect(hits).toHaveLength(1);
    // A delivery the local server refuses is acknowledged as rejected, with its reason.
    fake.queueIngress(ingress({ id: "ing-2", skill: "other", path: "/hooks/other" }));
    await fake.waitFor(() => fake.ingressAcks.some((a) => a.id === "ing-2"));
    expect(fake.ingressAcks.find((a) => a.id === "ing-2")).toMatchObject({ outcome: "rejected", http_status: 401, code: "invalid_signature", reason: "bad signature" });
    // cloud.ingress: false declines without touching the server.
    config.cloud.ingress = false;
    fake.queueIngress(ingress({ id: "ing-3" }));
    await fake.waitFor(() => fake.ingressAcks.some((a) => a.id === "ing-3"));
    expect(fake.ingressAcks.find((a) => a.id === "ing-3")).toMatchObject({ outcome: "rejected", http_status: 503, code: "ingress_disabled" });
    expect(hits).toHaveLength(2);
  });

  it("runs a hosted delivery through the real webhook pipeline: the signature is checked here, the record says ingress", async () => {
    let base = "";
    const ctx = await setup({ localBaseUrl: () => base });
    const { fake, link, paths, config, events, store, deliveryLog, registry, secrets } = ctx;
    const queue = new JobQueue({ store, config, registry, secrets, fileSecrets: secrets, logger: silentLogger, events });
    const server = createServer({ config, paths, store, queue, registry, secrets, logger: silentLogger, events, deliveryLog });
    base = await listen(server);
    cleanups.push(async () => {
      await queue.shutdown();
      await new Promise((resolve) => server.close(resolve));
    });
    link.start();
    fake.queueIngress(ingress({ id: "real-1", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, body_base64: Buffer.from('{"name":"cloud"}').toString("base64"), source_ip: "203.0.113.8" }));
    fake.queueIngress(ingress({ id: "real-2", headers: { authorization: "Bearer wrong-placeholder", "content-type": "application/json" } }));
    await fake.waitFor(() => ["real-1", "real-2"].every((id) => fake.ingressAcks.some((a) => a.id === id)));
    const accepted = fake.ingressAcks.find((a) => a.id === "real-1")!;
    expect(accepted).toMatchObject({ outcome: "accepted", http_status: 202 });
    expect(fake.ingressAcks.find((a) => a.id === "real-2")).toMatchObject({ outcome: "rejected", http_status: 401, code: "invalid_token" });
    const records = deliveryLog.list({ limit: 10 }).deliveries;
    expect(records.find((d) => d.ingress_id === "real-1")).toMatchObject({ via: "ingress", outcome: "accepted", ip: "203.0.113.8", job_id: accepted.job_id });
    expect(records.find((d) => d.ingress_id === "real-2")).toMatchObject({ via: "ingress", outcome: "rejected", code: "invalid_token" });
    await waitUntil(() => store.get(accepted.job_id!)?.status === "succeeded", 15_000);
    await fake.waitFor(() => fake.requests.some((r) => r.events.some((e) => e.type === "job.finished" && (e.data as { job: { id: string } }).job.id === accepted.job_id)), 15_000);
    const uploadedDelivery = fake.requests.flatMap((r) => r.events).find((e) => e.type === "delivery.received" && (e.data as { delivery: { ingress_id?: string } }).delivery.ingress_id === "real-1");
    const uploaded = uploadedDelivery?.data as { delivery: Record<string, unknown>; body: { text: string } };
    expect(uploaded.delivery).toMatchObject({ via: "ingress", outcome: "accepted" });
    expect(JSON.parse(uploaded.body.text)).toEqual({ name: "cloud" }); // the job's payload.json, pretty-printed
    expect(JSON.stringify(fake.requests)).not.toContain(SECRET);
  });

  it("acts on the machine in control mode: runs, tests, replays, answers, patches config within bounds, restarts after the answer", async () => {
    const { fake, link, store, paths, config, restarts, registry } = await setup({ control: true, cloud: { mode: "control" } });
    link.start();
    await waitUntil(() => link.status().state === "connected");
    const first = await runCommands(fake, [cmd("run", "skill.run", { name: "hello", payload: { name: "cloud" }, model: "haiku" }), cmd("test", "skill.test", { skill_md: "---\nname: scratch\ndescription: Scratch.\n---\nTry it.\n", payload: { x: 1 } }), cmd("nosuch", "skill.run", { name: "nope" })]);
    expect(first.run).toMatchObject({ ok: true, result: { accepted: true, skill: "hello", runner: "claude" } });
    expect(first.test).toMatchObject({ ok: true, result: { accepted: true, skill: "scratch", adhoc: true } });
    expect(first.nosuch).toMatchObject({ ok: false, error: { code: "not_found" } });
    const runId = (first.run!.result as { job_id: string }).job_id;
    await waitUntil(() => store.get(runId)?.status === "succeeded", 15_000);
    const run = store.get(runId)!;
    expect(run).toMatchObject({ trigger: "api", model: "haiku", source: { method: "CLOUD" } });
    expect(store.readEvent(runId).headers).toMatchObject({ "x-skillhook-cloud-user": "ada", "user-agent": "skillhook-cloud" });

    // A job that ended needing a person, answered from the dashboard: a resume job continues its session.
    const needy = store.create({ skill: "hello", trigger: "webhook", runner: "claude", source: { ip: "203.0.113.1", method: "POST", path: "/hooks/hello", content_type: "application/json" }, event: event("hello") });
    store.update(needy.id, { status: "succeeded", outcome: "needs_human", response: { outcome: "needs_human", summary: "Which branch?" }, session_id: "sess-placeholder", finished_at: new Date().toISOString() });
    const second = await runCommands(fake, [
      cmd("replay", "job.replay", { id: runId }),
      cmd("cancel", "job.cancel", { id: runId }),
      cmd("answer", "job.answer", { id: needy.id, answer: "main" }),
      cmd("answer-again", "job.answer", { id: needy.id, answer: "main" }),
      cmd("patch", "config.patch", { set: { concurrency: 3 } }),
      cmd("patch-runner", "config.patch", { set: { "runners.claude.command": "/bin/sh" } }),
      cmd("patch-cloud", "config.patch", { set: { "cloud.mode": "observe" } }),
      cmd("patch-bad", "config.patch", { set: { concurrency: "lots" } }),
      cmd("sched", "schedule.run", { name: "hello" }),
      cmd("update", "update.install", {}),
    ]);
    expect(second.replay).toMatchObject({ ok: true, result: { accepted: true, replay_of: { job: runId } } });
    expect(second.cancel).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(second.answer).toMatchObject({ ok: true, result: { job_id: needy.id, delivered: "resumed", answer: { text: "main", by: "ada" } } });
    expect(store.get(needy.id)?.resolved_by).toBe((second.answer!.result as { resume_job_id: string }).resume_job_id);
    expect(second["answer-again"]).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(second.patch).toMatchObject({ ok: true, result: { applied: ["concurrency"] } });
    expect(config.concurrency).toBe(3);
    expect(second["patch-runner"]).toMatchObject({ ok: false, error: { code: "denied_by_policy" } });
    expect(second["patch-cloud"]).toMatchObject({ ok: false, error: { code: "denied_by_policy" } });
    expect(second["patch-bad"]).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(config.cloud.mode).toBe("control");
    expect(second.sched).toMatchObject({ ok: false, error: { code: "conflict", message: expect.stringContaining("no schedule") } });
    expect(second.update).toMatchObject({ ok: true, result: { installed: true, latest: "0.4.1" } });

    // A restart waits until the cloud has the answer.
    const third = await runCommands(fake, [cmd("restart", "service.restart", { when: "idle", wait_seconds: 5 })]);
    expect(third.restart).toMatchObject({ ok: true, result: { restarting: true, when: "idle", wait_seconds: 5 } });
    await waitUntil(() => restarts.length === 1);
    expect(restarts[0]).toEqual({ force: false, waitSeconds: 5 });

    // Skills written and removed from the dashboard: validated, never for a repository's hook, kept when removed.
    const skillMd = "---\nname: cloudy\ndescription: From the cloud.\n---\nDo cloudy things.\n";
    const fourth = await runCommands(fake, [
      cmd("put", "skill.put", { name: "cloudy", content: skillMd }),
      cmd("put-open", "skill.put", { name: "wide-open", content: "---\nname: wide-open\ndescription: Open.\nskillhook:\n  auth:\n    type: none\n---\nBody\n" }),
      cmd("put-mismatch", "skill.put", { name: "other", content: skillMd }),
    ]);
    expect(fourth.put).toMatchObject({ ok: true, result: { name: "cloudy", created: true, secret_env: "SKILLHOOK_SECRET_CLOUDY", secret_configured: false } });
    expect(readFileSync(path.join(paths.skillsDir, "cloudy", "SKILL.md"), "utf8")).toBe(skillMd);
    expect(registry.get("cloudy")?.description).toBe("From the cloud.");
    expect(fourth["put-open"]).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("allow_unauthenticated") } });
    expect(fourth["put-mismatch"]).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    const fifth = await runCommands(fake, [cmd("delete", "skill.delete", { name: "cloudy" }), cmd("delete-missing", "skill.delete", { name: "cloudy-nope" })]);
    const keptAt = (fifth.delete!.result as { kept_at: string }).kept_at;
    expect(fifth.delete).toMatchObject({ ok: true, result: { removed: true, restorable: true } });
    expect(existsSync(path.join(paths.skillsDir, "cloudy"))).toBe(false);
    expect(readFileSync(path.join(keptAt, "SKILL.md"), "utf8")).toBe(skillMd);
    expect(keptAt.startsWith(path.join(paths.jobsDir, ".removed-skills"))).toBe(true);
    expect(fifth["delete-missing"]).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(JSON.stringify(fake.results)).not.toContain(SECRET);
  });

  it("generates secrets only sealed to whoever asked, and sets one sealed to this machine when allow-listed", async () => {
    const machine = machineKeyPair();
    const { fake, link, paths, config } = await setup({ control: true, cloud: { mode: "control" }, extraEnv: { SKILLHOOK_CLOUD_PRIVATE_KEY: machine.privateKey } });
    link.start();
    await waitUntil(() => link.status().state === "connected");
    const requester = machineKeyPair(); // stands in for the dashboard user's browser key
    const results = await runCommands(fake, [
      cmd("gen", "secret.generate", { name: "hello", force: true, recipient_key: requester.publicKey }),
      cmd("gen-plain", "secret.generate", { name: "hello", force: true }),
      cmd("gen-cloud", "secret.generate", { name: "SKILLHOOK_CLOUD_TOKEN", force: true, recipient_key: requester.publicKey }),
      cmd("set-denied", "secret.set", { name: "PLACEHOLDER_API_KEY", sealed: sealForRecipient("placeholder-set-value", machine.publicKey) }),
    ]);
    expect(results.gen).toMatchObject({ ok: true, sensitive: true, result: { secret_env: "SKILLHOOK_SECRET_HELLO", generated: true } });
    const opened = openSealed(results.gen!.sealed!, requester.privateKey);
    expect(readEnvFile(paths.envFile).SKILLHOOK_SECRET_HELLO).toBe(opened);
    expect(opened).not.toBe(SECRET);
    expect(JSON.stringify(results.gen)).not.toContain(opened);
    expect(results["gen-plain"]).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("recipient_key") } });
    expect(results["gen-cloud"]).toMatchObject({ ok: false, error: { code: "denied_by_policy" } });
    expect(results["set-denied"]).toMatchObject({ ok: false, error: { code: "denied_by_policy", message: expect.stringContaining("allow_commands") } });
    // The machine owner allow-lists it; the cloud still only ever sees the sealed value.
    config.cloud.allow_commands = ["secret.set"];
    const set = await runCommands(fake, [cmd("set", "secret.set", { name: "PLACEHOLDER_API_KEY", sealed: sealForRecipient("placeholder-set-value", machine.publicKey) }), cmd("set-garbled", "secret.set", { name: "OTHER_PLACEHOLDER", sealed: sealForRecipient("x", machineKeyPair().publicKey) })]);
    expect(set.set).toMatchObject({ ok: true, result: { secret_env: "PLACEHOLDER_API_KEY", set: true } });
    expect(readEnvFile(paths.envFile).PLACEHOLDER_API_KEY).toBe("placeholder-set-value");
    expect(set["set-garbled"]).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    // The same command id again is not run twice, and a sensitive result is not kept for retries.
    const count = fake.results.length;
    fake.queueCommand(cmd("gen", "secret.generate", { name: "hello", force: true, recipient_key: requester.publicKey }));
    await waitUntil(() => fake.results.length === count || fake.requests.length > 0);
    await sleep(200);
    expect(readEnvFile(paths.envFile).SKILLHOOK_SECRET_HELLO).toBe(opened);
  });

  it("streams a watched job's output and uploads a large artifact in chunks", async () => {
    const { fake, link, store, paths } = await setup({ control: true, cloud: { mode: "control" }, extraEnv: { FAKE_CLAUDE_SLEEP_MS: "2500" } });
    writeSkill(paths, "slow", "description: slow\nskillhook:\n  env: [FAKE_CLAUDE_SLEEP_MS]");
    link.start();
    await waitUntil(() => link.status().state === "connected");
    const started = await runCommands(fake, [cmd("slow", "skill.run", { name: "slow" })]);
    const jobId = (started.slow!.result as { job_id: string }).job_id;
    await waitUntil(() => store.get(jobId)?.status === "running");
    const watched = await runCommands(fake, [cmd("watch", "job.watch", { id: jobId, ttl_s: 60 })]);
    expect(watched.watch).toMatchObject({ ok: true, result: { job_id: jobId, stream: "stdout", watching: 1 } });
    const outputs = () => fake.requests.flatMap((r) => r.events).filter((e): e is EventEnvelope => e.type === "job.output" && (e.data as { job_id: string }).job_id === jobId);
    await fake.waitFor(() => outputs().some((e) => (e.data as { eof?: boolean }).eof === true), 20_000);
    const text = outputs().map((e) => (e.data as { chunk: string }).chunk).join("");
    expect(text).toContain('"subtype":"init"');
    expect(text).toContain("FAKE OK");
    expect(outputs().every((e) => e.seq === null)).toBe(true);
    expect(outputs().at(-1)?.data).toMatchObject({ eof: true, status: "succeeded" });
    expect(fake.requests.some((r) => r.status.link.watched_jobs === 1)).toBe(true);
    await waitUntil(() => link.status().watched_jobs === 0);

    // An artifact larger than the inline limit goes up in chunks with its sha256.
    const stdout = store.pathsFor(jobId).stdout;
    const big = `${"x".repeat(1024 * 1024 + 100)}\nand ${SECRET} too\n`;
    writeFileSync(stdout, big);
    const art = await runCommands(fake, [cmd("art", "job.artifact", { id: jobId, name: "stdout", max_inline_bytes: 1024 }), cmd("small", "job.artifact", { id: jobId, name: "prompt" })]);
    expect(art.art).toMatchObject({ ok: true, result: { uploaded: true, chunks: 2 } });
    const uploaded = fake.artifacts.get(`${jobId}/stdout`)!;
    const data = Buffer.concat(uploaded.chunks).toString("utf8");
    expect(data).toContain("and [redacted] too");
    expect(data).not.toContain(SECRET);
    expect(uploaded.sha256).toBe(createHash("sha256").update(Buffer.from(data)).digest("hex"));
    expect(uploaded.ranges[0]).toMatch(/^bytes 0-1048575\/\d+$/);
    expect((art.art!.result as { sha256: string }).sha256).toBe(uploaded.sha256);
    expect(art.small).toMatchObject({ ok: true, result: { name: "prompt", truncated: false, text: expect.stringContaining("# Skill: slow") } });
  });

  it("says goodbye with link.stopped on the way out", async () => {
    const { fake, link } = await setup();
    link.start();
    await waitUntil(() => link.status().state === "connected");
    await link.stop("shutdown");
    expect(fake.requests.at(-1)?.events.map((e) => e.type)).toContain("link.stopped");
    expect(link.status().state).toBe("disconnected");
  });
});
