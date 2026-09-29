import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { JobStore } from "./jobs.js";
import { buildMcpServer } from "./mcp.js";
import { FakeCloud } from "./test-support/fake-cloud.js";
import { FAKE_CLAUDE, FAKE_CODEX, tempHome, writeConfigFile, writeEnv, writeSkill } from "./test-support/helpers.js";
import { connectMcp, type McpTestClient } from "./test-support/mcp-client.js";
import type { WebhookEvent } from "./payload.js";

const clients: McpTestClient[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
});

async function client(paths: ReturnType<typeof tempHome>, env: NodeJS.ProcessEnv = {}) {
  const c = await connectMcp(buildMcpServer(paths, { SKILLHOOK_NO_UPDATE_CHECK: "1", ...env }));
  clients.push(c);
  return c;
}

function event(skill: string): WebhookEvent {
  return { id: "", skill, trigger: "webhook", received_at: new Date().toISOString(), method: "POST", path: `/hooks/${skill}`, query: {}, headers: {}, source_ip: "203.0.113.1", content_type: "application/json", content_length: 2, body_kind: "json", payload: {} };
}

describe("skillhook mcp", () => {
  it("offers the tools of this version, and no way for an agent to pair the machine with a cloud account", async () => {
    const c = await client(tempHome("skillhook-mcp-"));
    const tools = await c.tools();
    for (const name of ["answer_job", "get_health", "get_runners", "get_stats", "get_config", "update_config", "restart_server", "check_update", "cloud_status", "cloud_disconnect", "cloud_report_issue", "test_skill", "replay_job", "list_deliveries"]) expect(tools).toContain(name);
    expect(tools).not.toContain("cloud_connect");
    expect((c.init.result as { instructions: string }).instructions).toContain("never by an agent");
  });

  it("reports and ends the Skillhook Cloud pairing, never showing the token", async () => {
    const fake = await FakeCloud.start();
    try {
      const paths = tempHome("skillhook-mcp-");
      writeConfigFile(paths, { cloud: { enabled: true, url: fake.url, machine_id: fake.machineId, mode: "control" } });
      writeEnv(paths, { SKILLHOOK_CLOUD_TOKEN: fake.token, SKILLHOOK_CLOUD_PRIVATE_KEY: "placeholder-private-key" });
      const c = await client(paths);
      const status = await c.call("cloud_status");
      expect(status.data).toMatchObject({ enabled: true, url: fake.url, machine_id: fake.machineId, mode: "control", token_present: true, server_running: false, link: null });
      expect(status.text).not.toContain(fake.token);
      const off = await c.call("cloud_disconnect");
      expect(off.data).toMatchObject({ ok: true, was_enabled: true, token_removed: true, revoked: true });
      expect(fake.disconnects).toBe(1);
      const env = readFileSync(paths.envFile, "utf8");
      expect(env).not.toContain("SKILLHOOK_CLOUD_TOKEN");
      expect(env).not.toContain("SKILLHOOK_CLOUD_PRIVATE_KEY");
      expect((await c.call("cloud_status")).data).toMatchObject({ enabled: false, token_present: false });
    } finally {
      await fake.close();
    }
  });

  it("reports an issue for the person from a paired machine, and says why it cannot from one that is not", async () => {
    const fake = await FakeCloud.start();
    try {
      const paths = tempHome("skillhook-mcp-");
      const c = await client(paths);
      const unpaired = await c.call("cloud_report_issue", { title: "Webhooks fail", diagnostics: false });
      expect(unpaired.isError).toBe(true);
      expect(unpaired.text).toContain("not paired with Skillhook Cloud");
      writeConfigFile(paths, { cloud: { enabled: true, url: fake.url, machine_id: fake.machineId } });
      writeEnv(paths, { SKILLHOOK_CLOUD_TOKEN: fake.token, SKILLHOOK_SECRET_HELLO: "placeholder-hello-value" });
      const preview = await c.call("cloud_report_issue", { title: "Webhooks fail with placeholder-hello-value", diagnostics: false, dry_run: true });
      expect(preview.data).toEqual({ dry_run: true, url: fake.url, request: { title: "Webhooks fail with [redacted]" } });
      expect(preview.text).toContain("Nothing was sent");
      expect(fake.issues).toEqual([]);
      const sent = await c.call("cloud_report_issue", { title: "Webhooks fail with placeholder-hello-value", body: "Since this morning.", kind: "bug", contact_email: "ada@example.com", job_id: "20260929T101500Z-a1b2c3", diagnostics: false });
      expect(sent.isError).toBe(false);
      expect(sent.data).toEqual({ ok: true, issue_id: "iss_41", number: 41, url: `${fake.url}/o/fake/issues/41`, acknowledged: true, cloud_url: fake.url, diagnostics: null });
      expect(sent.text).toContain(`Reported as #41: ${fake.url}/o/fake/issues/41 (a confirmation email was sent)`);
      expect(fake.issues).toEqual([{ title: "Webhooks fail with [redacted]", body: "Since this morning.", kind: "bug", contact_email: "ada@example.com", job_id: "20260929T101500Z-a1b2c3" }]);
      const invalid = await c.call("cloud_report_issue", { title: "Webhooks fail", kind: "complaint" });
      expect(invalid.isError).toBe(true);
      expect(fake.issues).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  it("answers stats, readiness, config and waiting jobs from the files when no server runs", async () => {
    const paths = tempHome("skillhook-mcp-");
    writeConfigFile(paths, { runners: { claude: { command: FAKE_CLAUDE }, codex: { command: FAKE_CODEX } } });
    writeEnv(paths, { SKILLHOOK_SECRET_HELLO: "placeholder-hello-value" });
    writeSkill(paths, "hello", "description: hello");
    const store = new JobStore(paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 60 });
    const job = store.create({ skill: "hello", trigger: "webhook", runner: "claude", source: { ip: "203.0.113.1", method: "POST", path: "/hooks/hello", content_type: "application/json" }, event: event("hello") });
    store.update(job.id, { status: "succeeded", outcome: "needs_human", response: { outcome: "needs_human", summary: "Which branch?" }, duration_ms: 1200, cost_usd: 0.01 });
    const c = await client(paths);
    const stats = await c.call("get_stats", { since: "7d" });
    expect(stats.data).toMatchObject({ jobs: { total: 1, waiting_for_human: 1, by_outcome: { needs_human: 1 } }, skills: { hello: { jobs: 1 } } });
    expect(stats.text).toContain("1 waiting for a person");
    expect((await c.call("get_stats", { since: "lately" })).isError).toBe(true);
    const waiting = await c.call("list_jobs", { waiting: true });
    expect((waiting.data.jobs as { id: string }[]).map((j) => j.id)).toEqual([job.id]);
    const runners = await c.call("get_runners");
    expect(runners.data).toMatchObject({ via: "local", default_runner: "claude" });
    expect((runners.data.runners as { runner: string; ready: boolean }[]).map((r) => [r.runner, r.ready])).toEqual([
      ["claude", true],
      ["codex", true],
      ["shell", true],
    ]);
    const config = await c.call("get_config");
    expect(config.data).toMatchObject({ via: "local", restart_keys: ["host", "port"] });
    const updated = await c.call("update_config", { set: { concurrency: 3 } });
    expect(updated.data).toMatchObject({ via: "local", ok: true });
    expect(JSON.parse(readFileSync(paths.configFile, "utf8")).concurrency).toBe(3);
    const refused = await c.call("update_config", { set: { concurrency: "lots" } });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(readFileSync(paths.configFile, "utf8")).concurrency).toBe(3);
    expect((await c.call("update_config", {})).isError).toBe(true);
    expect((await c.call("restart_server", {})).text).toContain("No running server");
  });
});
