import { rmSync } from "node:fs";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { JobStore } from "./jobs.js";
import { createLogger } from "./logger.js";
import { JobQueue } from "./queue.js";
import { SkillRegistry } from "./registry.js";
import { createServer, type ServerDeps } from "./server.js";
import { tempHome, writeSkill } from "./test-support/helpers.js";

const ADMIN = "test-admin-token";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { sentry?: ServerDeps["sentry"]; admin?: string | null } = {}) {
  const paths = tempHome("skillhook-sentry-http-");
  const config = loadConfig(paths);
  const onError = vi.fn();
  const logger = createLogger({ stream: new Writable({ write(_chunk, _encoding, done) { done(); } }), onError });
  const registry = new SkillRegistry(paths.skillsDir);
  const store = new JobStore(paths.jobsDir, { maxJobs: 10, dedupeWindowSeconds: 60 });
  const secrets = (): Record<string, string> => options.admin === null ? {} : { SKILLHOOK_ADMIN_TOKEN: options.admin ?? ADMIN, SKILLHOOK_SECRET_HELLO: "hook-secret" };
  const queue = new JobQueue({ store, config, registry, secrets, logger });
  const server = createServer({ config, paths, store, queue, registry, secrets, logger, sentry: options.sentry });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test listener");
  cleanups.push(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); rmSync(paths.home, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${address.port}`, registry, onError, paths };
}

function reporter(delivered = true) {
  return {
    status: vi.fn(() => ({ enabled: true, configured: true, pending: 0, rate_limited: false })),
    verify: vi.fn(async () => ({ enabled: true, delivered, event_id: "0123456789abcdef0123456789abcdef", ...(delivered ? {} : { error: "transport_error" }) })),
  };
}
const auth = { authorization: `Bearer ${ADMIN}` };

describe("daemon Sentry diagnostics", () => {
  it("allows the existing local admin status read without revealing destination credentials", async () => {
    const sentry = reporter();
    const { base } = await fixture({ sentry });
    const response = await fetch(`${base}/diagnostics/sentry`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ configured: true, enabled: true });
    expect(JSON.stringify(body)).not.toMatch(/dsn|sentry_key|https:/i);
    expect(sentry.verify).not.toHaveBeenCalled();
  });

  it("requires the configured admin bearer even for loopback verification", async () => {
    const sentry = reporter();
    const { base } = await fixture({ sentry });
    for (const headers of [{}, { authorization: "Bearer invalid" }]) {
      const response = await fetch(`${base}/diagnostics/sentry`, { method: "POST", headers });
      expect(response.status).toBe(401);
    }
    expect((await fetch(`${base}/diagnostics/sentry`, { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
    expect(sentry.verify).not.toHaveBeenCalled();
  });

  it("cannot verify when no admin bearer is configured", async () => {
    const sentry = reporter();
    const { base } = await fixture({ sentry, admin: null });
    const response = await fetch(`${base}/diagnostics/sentry`, { method: "POST", headers: auth });
    expect(response.status).toBe(401);
    expect(sentry.verify).not.toHaveBeenCalled();
  });

  it.each([undefined, "{}"])("reports the fixed verification event and rate limits repetitions (body %s)", async (body) => {
    const sentry = reporter();
    const { base } = await fixture({ sentry });
    const response = await fetch(`${base}/diagnostics/sentry`, { method: "POST", headers: auth, body });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ delivered: true, event_id: "0123456789abcdef0123456789abcdef" });
    expect(sentry.verify.mock.calls).toEqual([[]]);
    const repeat = await fetch(`${base}/diagnostics/sentry`, { method: "POST", headers: auth });
    expect(repeat.status).toBe(429);
    expect(sentry.verify).toHaveBeenCalledTimes(1);
  });

  it.each(['{"message":"private payload"}', "[]", "null", "broken"])("rejects caller event data before sending (%s)", async (body) => {
    const sentry = reporter();
    const { base } = await fixture({ sentry });
    const response = await fetch(`${base}/diagnostics/sentry`, { method: "POST", headers: auth, body });
    expect(response.status).toBe(400);
    expect(sentry.verify).not.toHaveBeenCalled();
  });

  it("returns 503 for a failed delivery", async () => {
    const sentry = reporter(false);
    const { base } = await fixture({ sentry });
    const response = await fetch(`${base}/diagnostics/sentry`, { method: "POST", headers: auth });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ delivered: false, error: "transport_error" });
  });

  it("returns 503 when reporting is disabled", async () => {
    const sentry = { status: () => ({ enabled: false, configured: false, pending: 0, rate_limited: false }), verify: vi.fn(async () => ({ enabled: false, delivered: false, error: "disabled" })) };
    const { base } = await fixture({ sentry });
    const response = await fetch(`${base}/diagnostics/sentry`, { method: "POST", headers: auth });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ delivered: false, error: "disabled" });
  });

  it("preserves unknown route behavior and cannot send without a reporter", async () => {
    const { base } = await fixture();
    expect((await fetch(`${base}/diagnostics/unknown`)).status).toBe(404);
    const response = await fetch(`${base}/diagnostics/sentry`, { method: "POST", headers: auth });
    expect(response.status).toBe(503);
  });

  it("observes unexpected request failures with their original cause, but not expected rejections", async () => {
    const { base, registry, onError, paths } = await fixture();
    writeSkill(paths, "hello", "description: test hook");
    expect((await fetch(`${base}/hooks/hello`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${base}/not-a-route`)).status).toBe(404);
    expect(onError).not.toHaveBeenCalled();
    const cause = new TypeError("private request failure");
    vi.spyOn(registry, "get").mockImplementation(() => { throw cause; });
    const response = await fetch(`${base}/hooks/hello`, { method: "POST", headers: { authorization: "Bearer hook-secret" }, body: "{}" });
    expect(response.status).toBe(500);
    expect(onError.mock.calls).toEqual([["unhandled request error", cause]]);
    expect(await response.text()).not.toContain(cause.message);
  });
});
