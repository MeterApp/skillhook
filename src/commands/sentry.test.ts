import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { tempHome } from "../test-support/helpers.js";
import { main } from "./main.js";
import type { CliIO } from "./shared.js";

async function fixture(body: Record<string, unknown> = {}, status = 200, token?: string) {
  const paths = tempHome("skillhook-sentry-cli-");
  const requests: { method: string; path: string; authorization?: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let received = "";
    for await (const chunk of req) received += chunk;
    requests.push({ method: req.method!, path: req.url!, authorization: req.headers.authorization, body: received });
    const health = req.url === "/health";
    res.writeHead(health ? 200 : status, { "content-type": "application/json" });
    res.end(JSON.stringify(health ? { ok: true, version: "test" } : body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  writeFileSync(paths.serverStateFile, JSON.stringify({ host: "127.0.0.1", port: address.port }));
  const run = async (...args: string[]) => {
    let output = "";
    let error = "";
    const io: CliIO = { stdout: (s) => { output += s; }, stderr: (s) => { error += s; }, isTTY: false, env: { SKILLHOOK_NO_UPDATE_CHECK: "1", ...(token ? { SKILLHOOK_ADMIN_TOKEN: token } : {}) } };
    const code = await main(["sentry", ...args, "--dir", paths.home, "--json"], io);
    return { code, output, error, json: () => JSON.parse(output) as Record<string, unknown> };
  };
  return { paths, requests, run, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("skillhook sentry", () => {
  it("reads disabled status without an admin token and does not opt in", async () => {
    const f = await fixture({ enabled: false, configured: false, pending: 0, rate_limited: false, last_error: null, dsn: "private" });
    try {
      const result = await f.run();
      expect(result.code).toBe(0);
      expect(result.json()).toEqual({ enabled: false, configured: false, pending: 0, rate_limited: false, last_error: null });
      expect(f.requests.map((r) => [r.method, r.path])).toEqual([["GET", "/health"], ["GET", "/diagnostics/sentry"]]);
    } finally { await f.close(); }
  });

  it("requires explicit admin credentials before it sends a test", async () => {
    const f = await fixture();
    try {
      const result = await f.run("test");
      expect(result.code).toBe(1);
      expect(result.output).toContain("skillhook secret generate admin");
      expect(f.requests).toEqual([]);
    } finally { await f.close(); }
  });

  it("tests through the authenticated running daemon without accepting event data", async () => {
    const eventId = "a".repeat(32);
    const f = await fixture({ enabled: true, event_id: eventId, delivered: true, dsn: "private" }, 200, "private-admin");
    try {
      const result = await f.run("test");
      expect(result.code).toBe(0);
      expect(result.json()).toEqual({ enabled: true, event_id: eventId, delivered: true });
      expect(f.requests[1]).toEqual({ method: "POST", path: "/diagnostics/sentry", authorization: "Bearer private-admin", body: "" });
      const bad = await f.run("test", "custom-message");
      expect(bad.code).toBe(2);
      expect(f.requests).toHaveLength(2);
    } finally { await f.close(); }
  });

  it.each([200, 503, 429, 404])("fails safely when daemon cannot deliver (HTTP %i)", async (status) => {
    const f = await fixture({ enabled: false, delivered: false, error: "private-admin private-dsn" }, status, "private-admin");
    try {
      const result = await f.run("test");
      expect(result.code).toBe(1);
      expect(result.output + result.error).not.toContain("private-admin");
      expect(result.output + result.error).not.toContain("private-dsn");
    } finally { await f.close(); }
  });

  it("requires a real running daemon even when credentials are configured", async () => {
    const f = await fixture({}, 200, "private-admin");
    await f.close();
    for (const action of ["status", "test"]) {
      const result = await f.run(action);
      expect(result.code).toBe(1);
      expect(result.output).toContain("No running skillhook daemon");
    }
  });
});
