import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { FakeCloud } from "../test-support/fake-cloud.js";
import { tempHome, writeConfigFile, writeEnv } from "../test-support/helpers.js";
import { connectMcp, type McpTestClient } from "../test-support/mcp-client.js";
import { buildCloudMcpServer, connectCloud } from "./bridge.js";

/** Polls of a browser sign-in that wait until the test allows them, so the test decides when the person approved. */
function gatedPolls() {
  let budget = 0;
  let wake: (() => void) | undefined;
  return {
    async sleep() {
      while (budget === 0) await new Promise<void>((resolve) => (wake = resolve));
      budget--;
    },
    allow(n: number) {
      budget += n;
      wake?.();
    },
  };
}

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
    expect(admin.text).toContain("SKILLHOOK_ADMIN_TOKEN is mac-mini's own credential, not a skill's secret");
    const legacy = await client.call("generate_secret", { machine: "mac-mini", skill: "legacy", force: true });
    expect(legacy).toMatchObject({ isError: true });
    expect(legacy.text).toContain("SKILLHOOK_ADMIN_TOKEN is mac-mini's own credential");
    expect(fake.secretRequests.map((r) => r.name)).not.toContain("SKILLHOOK_ADMIN_TOKEN");
  });

  it("keeps its own generate_secret when the catalogue lists one, and skips what it cannot read", async () => {
    const fake = await FakeCloud.start();
    clouds.push(fake);
    fake.apiScopes = ["fleet:admin"];
    fake.extraTools = [
      { name: "generate_secret", description: "Returns the secret in the clear.", scope: "fleet:admin", kind: "write", allowed: true, input_schema: { type: "object" } },
      { name: "Not A Name", description: "x", input_schema: { type: "object" } },
      // Malformed schemas are left out; they never take the other tools down with them.
      { name: "not_an_object", description: "x", allowed: true, input_schema: { type: "string" } },
      { name: "null_parameter", description: "x", allowed: true, input_schema: { type: "object", properties: { a: null } } },
    ];
    const paths = tempHome("skillhook-cloud-mcp-");
    writeConfigFile(paths, { cloud: { url: fake.url } });
    writeEnv(paths, { SKILLHOOK_CLOUD_API_KEY: fake.apiKey });
    const env = { SKILLHOOK_NO_UPDATE_CHECK: "1" };
    const client = await connectMcp(buildCloudMcpServer(paths, env, await connectCloud(paths, env)));
    clients.push(client);
    const listed = ((await client.request("tools/list")).result as { tools: { name: string; description: string }[] }).tools;
    expect(listed.filter((t) => t.name === "generate_secret")).toEqual([expect.objectContaining({ description: expect.stringContaining("the cloud never sees it") })]);
    expect(listed.map((t) => t.name)).not.toContain("Not A Name");
    expect(listed.map((t) => t.name)).not.toContain("not_an_object");
    expect(listed.map((t) => t.name)).not.toContain("null_parameter");
    expect(listed.map((t) => t.name)).toEqual(expect.arrayContaining(["describe_cloud", "list_jobs", "answer_job"]));
    const made = await client.call("generate_secret", { machine: "mac-mini", skill: "hello" });
    expect(made.data).toMatchObject({ secret: fake.secretValue });
    expect(fake.toolCalls.map((call) => call.name)).not.toContain("generate_secret");
  });

  it("without a key, signs in with the browser: the link and the code for the person, then the cloud's tools", async () => {
    const fake = await FakeCloud.start();
    clouds.push(fake);
    const paths = tempHome("skillhook-cloud-mcp-");
    writeConfigFile(paths, { cloud: { url: fake.url } });
    const env = { SKILLHOOK_NO_UPDATE_CHECK: "1" };
    const opened: string[] = [];
    const polls = gatedPolls();
    const client = await connectMcp(buildCloudMcpServer(paths, env, await connectCloud(paths, env), { openUrl: (url) => opened.push(url) > 0, sleep: polls.sleep }));
    clients.push(client);
    expect(await client.tools()).toEqual(["skillhook_cloud_setup"]);
    const instructions = String((client.init.result as { instructions: string }).instructions);
    expect(instructions).toContain("Skillhook Cloud is not connected on this computer: No organisation API key.");
    expect(instructions).toContain("To connect, call skillhook_cloud_setup: it signs in with the browser");
    expect(instructions).toContain("Never ask the person to paste a key into this conversation");

    // The first call starts the sign-in, opens the page on this computer and returns at once with what to show.
    const page = `${fake.url}/activate?user_code=WXYZ-2345`;
    const started = await client.call("skillhook_cloud_setup");
    expect(started).toMatchObject({ isError: false, data: { connected: false, signing_in: true, cloud: fake.url, url: page, code: "WXYZ-2345", browser_opened: true, expires_in_seconds: 600 } });
    expect(started.text).toContain(`The sign-in page is open in the person's browser on this computer: ${page}\nIt must show the code WXYZ-2345`);
    expect(opened).toEqual([page]);
    // Asked again before the person approved: the same sign-in, not another one.
    const again = await client.call("skillhook_cloud_setup");
    expect(again.data).toMatchObject({ signing_in: true, code: "WXYZ-2345" });
    expect(fake.signIns).toHaveLength(1);
    expect(fake.signIns[0]).toMatchObject({ clientName: expect.stringMatching(/^skillhook CLI on /), authorization: undefined, polls: 0 });

    // Approved after one more pending poll: the key is kept and the tools load; wait_seconds waits for it.
    fake.signInScript.push("pending");
    polls.allow(2);
    const connected = await client.call("skillhook_cloud_setup", { wait_seconds: 30 });
    expect(connected).toMatchObject({ isError: false, data: { connected: true, organisation: { name: "Fake Org" }, tools: 6 } });
    expect(fake.signIns[0]).toMatchObject({ polls: 2, claimed: true });
    expect(await client.tools()).toEqual(["describe_cloud", "get_delivery", "get_job", "list_jobs", "list_skills", "report_issue"]);
    expect((await client.call("describe_cloud")).data).toMatchObject({ organisation: { name: "Fake Org" } });
    expect(readFileSync(paths.envFile, "utf8")).toContain(`SKILLHOOK_CLOUD_API_KEY=${fake.apiKey}\nSKILLHOOK_CLOUD_API_URL=${fake.url}`);
    for (const result of [started, again, connected]) expect(result.text).not.toContain(fake.apiKey);
  });

  it("starts again after a sign-in the person cancelled, and leaves a key from the environment to whoever set it", async () => {
    const fake = await FakeCloud.start();
    clouds.push(fake);
    const paths = tempHome("skillhook-cloud-mcp-");
    writeConfigFile(paths, { cloud: { url: fake.url } });
    const polls = gatedPolls();
    const client = await connectMcp(buildCloudMcpServer(paths, {}, await connectCloud(paths, {}), { sleep: polls.sleep }));
    clients.push(client);
    const started = await client.call("skillhook_cloud_setup");
    expect(started.data).toMatchObject({ signing_in: true, browser_opened: false });
    expect(started.text).toContain(`Give the person this link, to open in a browser where they can sign in: ${fake.url}/activate?user_code=WXYZ-2345`);
    fake.signInScript.push("deny");
    polls.allow(1);
    const denied = await client.call("skillhook_cloud_setup", { wait_seconds: 30 });
    expect(denied).toMatchObject({ isError: true });
    expect(denied.text).toContain("The sign-in was not approved: The sign-in was cancelled in the browser.\nCall skillhook_cloud_setup again to start a new one.");
    const fresh = await client.call("skillhook_cloud_setup");
    expect(fresh.data).toMatchObject({ signing_in: true });
    expect(fake.signIns).toHaveLength(2);

    // A refused key in this server's environment wins over anything a sign-in would keep: say so, start nothing.
    const env = { SKILLHOOK_CLOUD_API_KEY: "shc_placeholder-revoked-key-0123456789", SKILLHOOK_CLOUD_URL: fake.url };
    const stuck = await connectMcp(buildCloudMcpServer(paths, env, await connectCloud(paths, env), { sleep: polls.sleep }));
    clients.push(stuck);
    const refused = await stuck.call("skillhook_cloud_setup");
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain("refused the API key");
    expect(refused.text).toContain("SKILLHOOK_CLOUD_API_KEY is set in this MCP server's environment and wins over a key kept by signing in");
    expect(fake.signIns).toHaveLength(2);
  });

  it("without a key on a machine that names no cloud, signs in to Skillhook Cloud itself", async () => {
    const paths = tempHome("skillhook-cloud-mcp-");
    const env = { SKILLHOOK_NO_UPDATE_CHECK: "1" };
    const connection = await connectCloud(paths, env);
    expect(connection).toEqual({ problem: "No organisation API key. Sign in with the browser: skillhook cloud login   (or set SKILLHOOK_CLOUD_API_KEY)", code: "no_key" });
    const client = await connectMcp(buildCloudMcpServer(paths, env, connection));
    clients.push(client);
    const instructions = String((client.init.result as { instructions: string }).instructions);
    expect(instructions).toContain("In a terminal, `skillhook cloud login` does the same (with `--url https://…` for a Skillhook Cloud other than https://skillhook.dev)");
    expect(instructions).not.toContain("https://<");
    const listed = ((await client.request("tools/list")).result as { tools: { name: string; description: string; annotations: { readOnlyHint: boolean } }[] }).tools;
    expect(listed).toEqual([expect.objectContaining({ name: "skillhook_cloud_setup", description: expect.stringContaining("signs in with the browser"), annotations: expect.objectContaining({ readOnlyHint: false }) })]);
  });

  it("says what is wrong when the cloud cannot be used: the kill switch, plain http, an older cloud", async () => {
    const paths = tempHome("skillhook-cloud-mcp-");
    writeEnv(paths, { SKILLHOOK_CLOUD_API_KEY: "shc_placeholder-organisation-key-0123456789abc" });
    const killed = await connectCloud(paths, { SKILLHOOK_NO_CLOUD: "1" });
    expect(killed).toEqual({ problem: expect.stringContaining("SKILLHOOK_NO_CLOUD is set"), code: "disabled" });
    // Signing in would not help there: the setup tool says what is wrong and starts nothing.
    const client = await connectMcp(buildCloudMcpServer(paths, { SKILLHOOK_NO_CLOUD: "1" }, killed));
    clients.push(client);
    const setupCall = await client.call("skillhook_cloud_setup");
    expect(setupCall).toMatchObject({ isError: true });
    expect(setupCall.text).toContain("SKILLHOOK_NO_CLOUD is set");
    writeConfigFile(paths, { cloud: { url: "http://cloud.example.invalid" } });
    expect(await connectCloud(paths, {})).toEqual({ problem: expect.stringContaining("must use https"), code: "insecure_url" });
    // Without a key the problem is the key, but the sign-in that would fix it goes over https only too.
    writeEnv(paths, {});
    const plain = await connectMcp(buildCloudMcpServer(paths, {}, await connectCloud(paths, {}), { openUrl: () => true }));
    clients.push(plain);
    const refused = await plain.call("skillhook_cloud_setup");
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain("the cloud URL must use https (got http://cloud.example.invalid)");
    const fake = await FakeCloud.start();
    clouds.push(fake);
    fake.catalogMode = "missing";
    writeConfigFile(paths, { cloud: { url: fake.url } });
    writeEnv(paths, { SKILLHOOK_CLOUD_API_KEY: fake.apiKey });
    expect(await connectCloud(paths, {})).toMatchObject({ problem: expect.stringContaining("has no tool catalogue") });
  });
});
