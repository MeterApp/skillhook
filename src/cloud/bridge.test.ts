import { afterEach, describe, expect, it } from "vitest";
import { FakeCloud } from "../test-support/fake-cloud.js";
import { tempHome, writeConfigFile, writeEnv } from "../test-support/helpers.js";
import { connectMcp, type McpTestClient } from "../test-support/mcp-client.js";
import { buildCloudMcpServer, connectCloud } from "./bridge.js";

const clients: McpTestClient[] = [];
const clouds: FakeCloud[] = [];
afterEach(async () => {
  while (clients.length) await clients.pop()?.close();
  while (clouds.length) await clouds.pop()?.close();
});

async function setup(options: { loggedIn?: boolean; scopes?: ("fleet:read" | "fleet:run" | "fleet:admin")[] } = {}) {
  const fake = await FakeCloud.start();
  clouds.push(fake);
  if (options.scopes) fake.apiScopes = options.scopes;
  const paths = tempHome("skillhook-cloud-mcp-");
  writeConfigFile(paths, { cloud: { url: fake.url } });
  if (options.loggedIn !== false) writeEnv(paths, { SKILLHOOK_CLOUD_API_KEY: fake.apiKey });
  const env = { SKILLHOOK_NO_UPDATE_CHECK: "1" };
  const client = await connectMcp(buildCloudMcpServer(paths, env, await connectCloud(paths, env)));
  clients.push(client);
  return { fake, paths, client };
}

describe("skillhook mcp --cloud", () => {
  it("offers the cloud's catalogue as tools, as far as the key's scope goes, and forwards each call", async () => {
    const { fake, client } = await setup();
    const tools = await client.tools();
    expect(tools).toEqual(["describe_cloud", "get_delivery", "get_job", "list_jobs", "list_skills", "report_issue"]);
    const instructions = String((client.init.result as { instructions: string }).instructions);
    expect(instructions).toContain('Skillhook Cloud for Fake Org (key "laptop": fleet:read)');
    expect(instructions).toContain("Start with describe_cloud");
    expect(instructions).not.toContain("generate_secret");

    const listed = (await client.request("tools/list")).result as { tools: { name: string; inputSchema: unknown; annotations: { readOnlyHint: boolean } }[] };
    const listJobs = listed.tools.find((t) => t.name === "list_jobs")!;
    expect(listJobs.inputSchema).toMatchObject({ type: "object", properties: { waiting: { type: "boolean" } } });
    expect(listJobs.annotations.readOnlyHint).toBe(true);

    const waiting = await client.call("list_jobs", { waiting: true });
    expect(waiting.isError).toBe(false);
    expect(fake.toolCalls.at(-1)).toEqual({ name: "list_jobs", input: { waiting: true } });
    expect((waiting.data.jobs as { local_id: string }[]).map((j) => j.local_id)).toEqual(["20260929T101500Z-a1b2c3"]);

    // The cloud validates and refuses; its words reach the agent.
    const missing = await client.call("get_job", { job: "nope" });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toContain('unknown_job: No job "nope" in Fake Org.');
    expect(fake.toolCalls.every((call) => call.name !== "answer_job")).toBe(true);
    expect(fake.requests).toEqual([]);
  });

  it("sends the key only to the cloud it was checked against, whatever cloud.url says now", async () => {
    const fake = await FakeCloud.start();
    clouds.push(fake);
    const paths = tempHome("skillhook-cloud-mcp-");
    writeConfigFile(paths, { cloud: { url: "https://somewhere-else.example.invalid" } });
    writeEnv(paths, { SKILLHOOK_CLOUD_API_KEY: fake.apiKey, SKILLHOOK_CLOUD_API_URL: fake.url });
    const connection = await connectCloud(paths, {});
    expect(connection).toMatchObject({ client: { url: fake.url } });
    expect(fake.apiRequests).toMatchObject([{ path: "/api/v1/tools", authorization: `Bearer ${fake.apiKey}` }]);
  });

  it("adds what a wider key may do, and generate_secret for admin keys, opened only here", async () => {
    const { fake, client } = await setup({ scopes: ["fleet:admin"] });
    expect(await client.tools()).toEqual(expect.arrayContaining(["answer_job", "run_skill", "save_skill", "generate_secret"]));
    const answered = await client.call("answer_job", { job: "20260929T101500Z-a1b2c3", answer: "yes", option: "yes" });
    expect(answered.data).toMatchObject({ delivered: "live", pending: false });

    const secret = await client.call("generate_secret", { machine: "mac-mini", skill: "hello" });
    expect(secret.isError).toBe(false);
    expect(secret.data).toMatchObject({ machine: "mac-mini", name: "SKILLHOOK_SECRET_HELLO", secret: fake.secretValue, existed: false });
    expect(fake.secretRequests[0]?.recipient_key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const kept = await client.call("generate_secret", { machine: "mac-mini", skill: "SKILLHOOK_SECRET_KEPT" });
    expect(kept.data).toMatchObject({ secret: null, existed: true });
    expect(kept.text).toContain("force: true replaces it");
    const admin = await client.call("generate_secret", { machine: "mac-mini", skill: "SKILLHOOK_ADMIN_TOKEN", force: true });
    expect(admin).toMatchObject({ isError: true });
    expect(admin.text).toContain("SKILLHOOK_ADMIN_TOKEN is not a skill's secret on mac-mini");
  });

  it("keeps its own generate_secret when the catalogue lists one, and skips what it cannot read", async () => {
    const fake = await FakeCloud.start();
    clouds.push(fake);
    fake.apiScopes = ["fleet:admin"];
    fake.extraTools = [{ name: "generate_secret", description: "Returns the secret in the clear.", scope: "fleet:admin", kind: "write", allowed: true, input_schema: { type: "object" } }, { name: "Not A Name", description: "x", input_schema: { type: "object" } }];
    const paths = tempHome("skillhook-cloud-mcp-");
    writeConfigFile(paths, { cloud: { url: fake.url } });
    writeEnv(paths, { SKILLHOOK_CLOUD_API_KEY: fake.apiKey });
    const env = { SKILLHOOK_NO_UPDATE_CHECK: "1" };
    const client = await connectMcp(buildCloudMcpServer(paths, env, await connectCloud(paths, env)));
    clients.push(client);
    const listed = ((await client.request("tools/list")).result as { tools: { name: string; description: string }[] }).tools;
    expect(listed.filter((t) => t.name === "generate_secret")).toEqual([expect.objectContaining({ description: expect.stringContaining("the cloud never sees it") })]);
    expect(listed.map((t) => t.name)).not.toContain("Not A Name");
    const made = await client.call("generate_secret", { machine: "mac-mini", skill: "hello" });
    expect(made.data).toMatchObject({ secret: fake.secretValue });
    expect(fake.toolCalls.map((call) => call.name)).not.toContain("generate_secret");
  });

  it("without a key, offers only the setup tool, which loads the cloud's tools once the person logged in", async () => {
    const { fake, paths, client } = await setup({ loggedIn: false });
    expect(await client.tools()).toEqual(["skillhook_cloud_setup"]);
    const instructions = String((client.init.result as { instructions: string }).instructions);
    expect(instructions).toContain("Skillhook Cloud is not connected on this computer: No organisation API key.");
    expect(instructions).toContain("skillhook cloud login --url");
    expect(instructions).toContain("Never ask them to paste the key into this conversation");

    const still = await client.call("skillhook_cloud_setup");
    expect(still.isError).toBe(true);
    expect(still.text).toContain("No organisation API key");
    expect(fake.apiRequests).toEqual([]);

    writeEnv(paths, { SKILLHOOK_CLOUD_API_KEY: fake.apiKey });
    const connected = await client.call("skillhook_cloud_setup");
    expect(connected).toMatchObject({ isError: false, data: { connected: true, organisation: { name: "Fake Org" }, tools: 6 } });
    expect(await client.tools()).toEqual(["describe_cloud", "get_delivery", "get_job", "list_jobs", "list_skills", "report_issue"]);
    expect((await client.call("describe_cloud")).data).toMatchObject({ organisation: { name: "Fake Org" } });
  });

  it("says what is wrong when the cloud cannot be used: no URL, the kill switch, an older cloud", async () => {
    const paths = tempHome("skillhook-cloud-mcp-");
    writeEnv(paths, { SKILLHOOK_CLOUD_API_KEY: "shc_placeholder-organisation-key-0123456789abc" });
    expect(await connectCloud(paths, {})).toEqual({ problem: expect.stringContaining("This machine has no cloud URL") });
    expect(await connectCloud(paths, { SKILLHOOK_NO_CLOUD: "1" })).toEqual({ problem: expect.stringContaining("SKILLHOOK_NO_CLOUD is set") });
    const fake = await FakeCloud.start();
    clouds.push(fake);
    fake.catalogMode = "missing";
    writeConfigFile(paths, { cloud: { url: fake.url } });
    writeEnv(paths, { SKILLHOOK_CLOUD_API_KEY: fake.apiKey });
    expect(await connectCloud(paths, {})).toEqual({ problem: expect.stringContaining("has no tool catalogue") });
  });
});
