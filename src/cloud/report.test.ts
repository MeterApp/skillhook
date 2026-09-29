import { afterEach, describe, expect, it } from "vitest";
import type { Paths } from "../paths.js";
import { FakeCloud } from "../test-support/fake-cloud.js";
import { startFakeServer } from "../test-support/fake-server.js";
import { FAKE_CLAUDE, FAKE_CODEX, tempHome, writeConfigFile, writeEnv } from "../test-support/helpers.js";
import { VERSION } from "../version.js";
import { IssueDiagnosticsSchema } from "./protocol.js";
import { gatherDiagnostics, IssueReportError, reportIssue } from "./report.js";

// Placeholder values: nothing here is a real credential.
const ENV_VALUE = "placeholder-report-env-value";
const RUNNERS = { claude: { command: FAKE_CLAUDE }, codex: { command: FAKE_CODEX } };
/** No Tailscale or launchd/systemd probes from a test. */
const HEALTH = { exposure: false, service: false };

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function cloud(): Promise<FakeCloud> {
  const fake = await FakeCloud.start();
  cleanups.push(() => fake.close());
  return fake;
}

function pairedHome(fake: FakeCloud): Paths {
  const paths = tempHome("skillhook-report-");
  writeConfigFile(paths, { runners: RUNNERS, cloud: { enabled: true, url: fake.url, machine_id: fake.machineId } });
  writeEnv(paths, { SKILLHOOK_CLOUD_TOKEN: fake.token, SKILLHOOK_SECRET_HELLO: ENV_VALUE });
  return paths;
}

describe("cloud report", () => {
  it("sends the person's words and what the running server knows, scrubbed of every .env value", async () => {
    const fake = await cloud();
    const paths = pairedHome(fake);
    const server = await startFakeServer(paths, {
      cloud: { state: "degraded", reason: "network", mode: "observe", last_error: `fetch failed for ${fake.url}?t=${ENV_VALUE}` },
      checks: {
        ok: false,
        summary: { ok: 5, warn: 2, fail: 1, skip: 2 },
        checks: [
          { name: "node", status: "ok", detail: "node 22", group: "system" },
          { name: "cloud link", status: "warn", detail: "degraded (network)", group: "skillhook" },
          { name: "claude", status: "fail", detail: `not logged in (${ENV_VALUE})`, hint: "run `claude login`", group: "runners" },
          { name: "skill hello", status: "warn", detail: "x".repeat(700), group: "skills" },
        ],
      },
      runners: [
        { runner: "claude", ready: false, found: true, detail: "not logged in", authenticated: false },
        { runner: "codex", ready: true, found: true, detail: "logged in", authenticated: true },
        { runner: "shell", ready: true, found: true, detail: "runs the skill's own command", authenticated: null },
      ],
    });
    cleanups.push(() => server.close());

    const result = await reportIssue(paths, {}, { title: `  GitHub deliveries fail with ${ENV_VALUE}  `, body: `Since the update every delivery gets 401.\nThe token ${ENV_VALUE} is right.\n`, kind: "bug", severity: "high", contact_email: "ada@example.com", job_id: "20260929T101500Z-a1b2c3", delivery_id: `d-${ENV_VALUE}`, skill: "hello" });
    expect(result.issue).toEqual({ ok: true, issue_id: "iss_41", number: 41, url: `${fake.url}/o/fake/issues/41`, acknowledged: true });
    expect(fake.invalid).toEqual([]);
    const sent = fake.issues[0];
    expect(sent).toEqual(result.request);
    expect(JSON.stringify(sent)).not.toContain(ENV_VALUE);
    expect(sent).toMatchObject({ title: "GitHub deliveries fail with [redacted]", body: "Since the update every delivery gets 401.\nThe token [redacted] is right.", kind: "bug", severity: "high", contact_email: "ada@example.com", job_id: "20260929T101500Z-a1b2c3", delivery_id: "d-[redacted]", skill: "hello" });
    expect(sent?.report_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/); // one per report, for the cloud to recognise a retry
    expect(sent?.diagnostics).toEqual({
      skillhook_version: VERSION,
      node_version: process.versions.node,
      os: process.platform,
      arch: process.arch,
      mode: "observe",
      link: { state: "degraded", reason: "network", last_error: `fetch failed for ${fake.url}?t=[redacted]` },
      // Readiness is only whether each runner is ready; the details stay home.
      runners: [
        { runner: "claude", ready: false },
        { runner: "codex", ready: true },
        { runner: "shell", ready: true },
      ],
      // Failures first, then warnings; hints stay home and a long detail is cut to the protocol's 500 characters.
      health: {
        ok: false,
        summary: { ok: 5, warn: 2, fail: 1, skip: 2 },
        failing: [
          { id: "claude", status: "fail", message: "not logged in ([redacted])" },
          { id: "cloud link", status: "warn", message: "degraded (network)" },
          { id: "skill hello", status: "warn", message: "x".repeat(500) },
        ],
      },
    });
    // The server's cached answers, the quick flavour without network probes.
    expect(server.requests).toEqual(expect.arrayContaining(["/health", "/health/checks?deep=0&network=0", "/runners"]));
  });

  it("asks a quick local check and the runners when no server runs, and leaves out what it cannot read", async () => {
    const paths = tempHome("skillhook-report-");
    writeConfigFile(paths, { runners: RUNNERS });
    writeEnv(paths, { SKILLHOOK_SECRET_HELLO: ENV_VALUE });
    const diagnostics = await gatherDiagnostics(paths, {}, { health: HEALTH });
    expect(IssueDiagnosticsSchema.parse(diagnostics)).toEqual(diagnostics);
    expect(diagnostics).toMatchObject({ skillhook_version: VERSION, os: process.platform, mode: "observe", runners: [{ runner: "claude", ready: true }, { runner: "codex", ready: true }, { runner: "shell", ready: true }] });
    expect(diagnostics.link).toBeUndefined(); // no server, no link
    expect(diagnostics.health?.failing).toEqual(expect.arrayContaining([{ id: "server", status: "warn", message: expect.stringContaining("not running") }]));

    // A server that predates the routes: the basics and the link's state still travel.
    const older = tempHome("skillhook-report-");
    const server = await startFakeServer(older, { cloud: { state: "connected", mode: "control" } });
    cleanups.push(() => server.close());
    expect(await gatherDiagnostics(older, {}, { health: HEALTH })).toEqual({ skillhook_version: VERSION, node_version: process.versions.node, os: process.platform, arch: process.arch, mode: "observe", link: { state: "connected" } });

    // Something else answering on that port (or another version): the report still goes, with the basics only.
    const odd = tempHome("skillhook-report-");
    const other = await startFakeServer(odd, { cloud: { state: "connected", mode: "observe" }, checks: { ok: true, checks: "none" } as never, runners: [{ runner: "claude" }] });
    cleanups.push(() => other.close());
    expect(await gatherDiagnostics(odd, {}, { health: HEALTH })).toEqual({ skillhook_version: VERSION, node_version: process.versions.node, os: process.platform, arch: process.arch, mode: "observe" });
  });

  it("sends only the person's words when diagnostics are off", async () => {
    const fake = await cloud();
    const paths = pairedHome(fake);
    const result = await reportIssue(paths, {}, { title: "Where do hosted URLs come from?", body: "  ", kind: "question", diagnostics: false });
    expect(fake.issues).toEqual([{ title: "Where do hosted URLs come from?", kind: "question", report_id: expect.any(String) }]);
    expect(result.issue).toMatchObject({ number: 41, acknowledged: false });
  });

  it("refuses without a pairing, under the kill switch, to an insecure URL and for what the protocol cannot carry", async () => {
    const fake = await cloud();
    const unpaired = tempHome("skillhook-report-");
    writeConfigFile(unpaired, { runners: RUNNERS, cloud: { url: fake.url } });
    const title = { title: "Webhooks fail", diagnostics: false };
    await expect(reportIssue(unpaired, {}, title)).rejects.toThrow(/not paired.*skillhook cloud connect --code/);
    const tokenless = tempHome("skillhook-report-");
    writeConfigFile(tokenless, { cloud: { enabled: true, url: fake.url, machine_id: fake.machineId } });
    await expect(reportIssue(tokenless, {}, title)).rejects.toThrow(/SKILLHOOK_CLOUD_TOKEN is missing/);
    const paths = pairedHome(fake);
    await expect(reportIssue(paths, { SKILLHOOK_NO_CLOUD: "1" }, title)).rejects.toThrow(/SKILLHOOK_NO_CLOUD is set/);
    await expect(reportIssue(paths, { SKILLHOOK_CLOUD_URL: "http://cloud.example.invalid" }, title)).rejects.toThrow(/must use https/);
    await expect(reportIssue(paths, {}, { ...title, title: "   " })).rejects.toThrow(/needs a title/);
    await expect(reportIssue(paths, {}, { ...title, title: "t".repeat(201) })).rejects.toThrow(/201 characters; at most 200/);
    await expect(reportIssue(paths, {}, { ...title, body: "b".repeat(20_001) })).rejects.toThrow(/at most 20000/);
    await expect(reportIssue(paths, {}, { ...title, contact_email: "ada at example" })).rejects.toThrow(/contact_email/);
    await expect(reportIssue(paths, {}, { ...title, report_id: "short" })).rejects.toThrow(/report_id/);
    const listed = pairedHome(fake);
    writeEnv(listed, { SKILLHOOK_CLOUD_TOKEN: fake.token, ALERT_EMAIL: "ops-team@example.com" });
    await expect(reportIssue(listed, {}, { ...title, contact_email: "ops-team@example.com" })).rejects.toThrow(/contact address is a value from \.env/);
    // Within the character limits but not the byte limit: control characters travel JSON-escaped, six bytes each.
    await expect(reportIssue(paths, {}, { ...title, body: "\u0001".repeat(11_000) })).rejects.toThrow(/bytes; at most 65536/);
    await expect(reportIssue(paths, {}, title)).resolves.toMatchObject({ issue: { number: 41 } });
    expect(fake.issues).toHaveLength(1);
  });

  it("says what the cloud answered: a refused token, a disabled machine, a limit, a cloud without the route", async () => {
    const fake = await cloud();
    const paths = pairedHome(fake);
    const title = { title: "Webhooks fail", diagnostics: false };
    const quick = { backoffMs: () => 5, timeoutMs: 2_000 };
    // A 4xx (and a long 429) is said at once; a 5xx only after three attempts.
    const expectations: [FakeCloud["issuesMode"], RegExp, number][] = [
      ["401", /refused this machine's token.*skillhook cloud connect --code XXXX-XXXX --force/, 1],
      ["403", /takes no reports from this machine \(machine_disabled.*disabled on the dashboard/, 1],
      ["404", /does not take issue reports yet \(http_404.*github\.com\/MeterApp\/skillhook\/issues/, 1],
      ["413", /too large.*shorten the body/, 1],
      ["429", /Too many reports.*try again in 90 s/, 1],
      ["500", /could not take the report after 3 attempts \(server_error: internal error\)/, 3],
      ["garbage", /does not understand/, 1],
    ];
    for (const [mode, message, attempts] of expectations) {
      fake.issuesMode = mode;
      const before = fake.issueRequests;
      await expect(reportIssue(paths, {}, title, quick)).rejects.toThrow(message);
      expect(fake.issueRequests - before, mode).toBe(attempts);
    }
    const unreachable = reportIssue(paths, { SKILLHOOK_CLOUD_URL: "http://127.0.0.1:1" }, title, quick);
    await expect(unreachable).rejects.toThrow(IssueReportError);
    await expect(unreachable).rejects.toThrow(/Could not reach http:\/\/127\.0\.0\.1:1 after 3 attempts/);
    expect(fake.issues).toEqual([]);
  });

  it("retries what may pass with the same report_id, so a report is filed once even when its answer was lost", async () => {
    const fake = await cloud();
    const paths = pairedHome(fake);
    const title = { title: "Webhooks fail", diagnostics: false };
    const quick = { backoffMs: () => 5, timeoutMs: 300 };
    // A 5xx and a dropped connection, then the answer.
    fake.issuesScript.push("500", "reset");
    const retried = await reportIssue(paths, {}, title, quick);
    expect(retried.issue.number).toBe(41);
    expect(fake.issueRequests).toBe(3);
    // Filed, but the answer never came: the retry carries the same report_id and gets the original report back.
    fake.hangMs = 1_000;
    fake.issuesScript.push("filed-then-hang");
    const replayed = await reportIssue(paths, {}, title, quick);
    expect(replayed.issue).toEqual({ ok: true, issue_id: "iss_42", number: 42, url: `${fake.url}/o/fake/issues/42`, acknowledged: false });
    expect(fake.issueRequests).toBe(5);
    expect(fake.issues).toHaveLength(2);
    expect(fake.issues[1]?.report_id).toBe(replayed.request.report_id);
    // A 429 with a short pause is waited out; a longer one is said (the test above).
    fake.issuesScript.push("429");
    await expect(reportIssue(paths, {}, title, quick)).resolves.toMatchObject({ issue: { number: 43 } });
    expect(fake.issueRequests).toBe(7);
    // Every report has its own id.
    expect(new Set(fake.issues.map((issue) => issue.report_id)).size).toBe(3);
  });
});
