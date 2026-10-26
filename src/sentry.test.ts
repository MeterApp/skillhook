import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonSentry } from "./sentry.js";

const DSN = "https://publickey@o1.ingest.sentry.io/1234";
const ok: typeof fetch = async () => new Response(null, { status: 200 });
afterEach(() => vi.useRealTimers());

describe("daemon Sentry", () => {
  it("never sends without explicit valid opt-in; invalid DSNs and kill switches are safe", async () => {
    const fetchImpl = vi.fn(ok);
    const secrets: Record<string, string> = {};
    const sentry = new DaemonSentry({ secrets: () => secrets, version: "0.14.0", fetchImpl });
    expect(sentry.capture("daemon error")).toBeUndefined();
    for (const dsn of ["http://key@host/1", "https://host/1", "https://key:secret@host/1", "https://key@host/project", `${DSN}?secret=oops`, `${DSN}#oops`]) {
      secrets.SKILLHOOK_SENTRY_DSN = dsn;
      expect(sentry.capture("daemon error")).toBeUndefined();
    }
    secrets.SKILLHOOK_SENTRY_DSN = DSN;
    for (const kill of ["1", "true", "TRUE"]) {
      secrets.SKILLHOOK_NO_SENTRY = kill;
      expect(await sentry.verify()).toMatchObject({ enabled: false, delivered: false });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    delete secrets.SKILLHOOK_NO_SENTRY;
    expect(await sentry.verify()).toMatchObject({ enabled: true, delivered: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    delete secrets.SKILLHOOK_SENTRY_DSN;
    expect(sentry.status().enabled).toBe(false);
  });

  it("posts valid length-delimited envelopes to the DSN path prefix and verifies real HTTP acceptance", async () => {
    const received: { url: string; headers: Record<string, unknown>; body: string }[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      received.push({ url: req.url ?? "", headers: req.headers, body });
      res.writeHead(200); res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test port");
    try {
      const fetchImpl: typeof fetch = (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe("https://sentry.example");
        return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
      };
      const sentry = new DaemonSentry({ secrets: () => ({ SKILLHOOK_SENTRY_DSN: "https://key@sentry.example/prefix/123", SKILLHOOK_SENTRY_ENVIRONMENT: "staging" }), version: "0.14.0", fetchImpl });
      const result = await sentry.verify();
      expect(result).toMatchObject({ enabled: true, delivered: true, event_id: expect.stringMatching(/^[a-f0-9]{32}$/) });
      expect(received).toHaveLength(1);
      const request = received[0]!;
      expect(request.url).toBe("/prefix/api/123/envelope/");
      expect(request.headers["x-sentry-auth"]).toContain("sentry_key=key");
      expect(request.headers["content-type"]).toBe("application/x-sentry-envelope");
      const [header, item, payload] = request.body.trimEnd().split("\n") as [string, string, string];
      expect(JSON.parse(header).event_id).toBe(result.event_id);
      expect(JSON.parse(item)).toMatchObject({ type: "event", length: Buffer.byteLength(payload) });
      expect(JSON.parse(payload)).toMatchObject({ event_id: result.event_id, platform: "node", release: "@meterapp/skillhook@0.14.0", environment: "staging", exception: { values: [{ type: "Error", value: "Sentry daemon verification" }] } });
      expect(sentry.status().pending).toBe(0);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("never uploads raw exception messages, external stacks, fields, secrets, paths, or arbitrary operation strings", async () => {
    const bodies: string[] = [];
    const secret = "super-secret-token-123";
    const fetchImpl: typeof fetch = async (_input, init) => { bodies.push(String(init?.body)); return new Response(null); };
    const sentry = new DaemonSentry({ secrets: () => ({ SKILLHOOK_SENTRY_DSN: DSN, TOKEN: secret, SKILLHOOK_SENTRY_ENVIRONMENT: "https://private.example?q=secret" }), version: "../../private", fetchImpl });
    const error = new TypeError(`customer payload ${secret}`);
    error.stack = `TypeError: ${secret}\n    at privateFunction (/Users/private/customer-file.js:123:45)\n    at daemon (${fileURLToPath(new URL("./server.ts", import.meta.url))}:90:2)\n    at customer (/tmp/secret.js:20:1)`;
    sentry.capture(`dynamic ${secret}`, error);
    await sentry.flush();
    const body = bodies.join("");
    for (const raw of [secret, "customer payload", "/Users/", "/tmp/", "privateFunction", "private.example", "customer-file", "../../private"]) expect(body).not.toContain(raw);
    const event = JSON.parse(bodies[0]!.split("\n")[2]!);
    expect(event.exception.values[0]).toEqual({ type: "TypeError", value: "daemon error", stacktrace: { frames: [{ filename: "server.ts", lineno: 90, colno: 2, in_app: true }] } });
    expect(event.environment).toBe("production");
    expect(event.release).toBe("@meterapp/skillhook@unknown");
    for (const key of ["request", "user", "breadcrumbs", "server_name", "extra", "contexts"]) expect(event).not.toHaveProperty(key);
  });

  it("ignores giant or malformed stack locations without uploading them", async () => {
    const bodies: string[] = [];
    const sentry = new DaemonSentry({ secrets: () => ({ SKILLHOOK_SENTRY_DSN: DSN }), version: "0.14.0", fetchImpl: async (_input, init) => { bodies.push(String(init?.body)); return new Response(null); } });
    for (const stack of [
      `Error: private\n    at ${"(".repeat(100_000)}private`,
      `Error: private\n    at (${fileURLToPath(new URL("./server.ts", import.meta.url))}:999999999999999999:2)`,
      `Error: private\n    at (${fileURLToPath(new URL("./server.ts", import.meta.url))}:1:2:3)`,
    ]) {
      const error = new Error("private");
      error.stack = stack;
      expect(sentry.capture("daemon error", error)).toBeDefined();
    }
    await sentry.flush();
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body).not.toContain("private");
      expect(JSON.parse(body.split("\n")[2]!).exception.values[0]).not.toHaveProperty("stacktrace");
    }
  });

  it("caps pending work and bounds flush and requests even when the transport stalls", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const sentry = new DaemonSentry({ secrets: () => ({ SKILLHOOK_SENTRY_DSN: DSN }), version: "0.14.0", fetchImpl });
    for (let i = 0; i < 8; i++) expect(sentry.capture("daemon error")).toBeDefined();
    expect(sentry.capture("daemon error")).toBeUndefined();
    expect(sentry.status()).toMatchObject({ pending: 8, last_error: "busy" });
    const flushed = sentry.flush(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await flushed).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sentry.status()).toMatchObject({ pending: 0, last_error: "timeout" });
    expect(fetchImpl).toHaveBeenCalledTimes(8);
  });

  it("isolates network failures and reports rejected verification instead of just returning an ID", async () => {
    const fail: typeof fetch = async () => { throw new Error("private-network-detail"); };
    const sentry = new DaemonSentry({ secrets: () => ({ SKILLHOOK_SENTRY_DSN: DSN }), version: "0.14.0", fetchImpl: fail });
    expect(await sentry.verify()).toMatchObject({ enabled: true, event_id: expect.any(String), delivered: false, error: "transport_error" });
    expect(JSON.stringify(sentry.status())).not.toContain("private-network-detail");
    const rejected = new DaemonSentry({ secrets: () => ({ SKILLHOOK_SENTRY_DSN: DSN }), version: "0.14.0", fetchImpl: async () => new Response(null, { status: 403 }) });
    expect(await rejected.verify()).toMatchObject({ delivered: false, error: "rejected" });
  });

  it.each([429, 503, 200])("honors Sentry rate limits without retrying (HTTP %i)", async (status) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status, headers: status === 200 ? { "x-sentry-rate-limits": "5:error:organization" } : { "retry-after": "5" } }));
    const sentry = new DaemonSentry({ secrets: () => ({ SKILLHOOK_SENTRY_DSN: DSN }), version: "0.14.0", fetchImpl });
    expect((await sentry.verify()).delivered).toBe(status === 200);
    expect(sentry.capture("daemon error")).toBeUndefined();
    expect(sentry.status().rate_limited).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(sentry.capture("daemon error")).toBeDefined();
    await sentry.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not throw when secret loading or exception access fails", async () => {
    const sentry = new DaemonSentry({ secrets: () => { throw new Error("private file path"); }, version: "0.14.0", fetchImpl: ok });
    expect(sentry.capture("daemon error")).toBeUndefined();
    expect(await sentry.verify()).toMatchObject({ enabled: false, delivered: false });
    const enabled = new DaemonSentry({ secrets: () => ({ SKILLHOOK_SENTRY_DSN: DSN }), version: "0.14.0", fetchImpl: ok });
    const cause = new Error("secret");
    Object.defineProperty(cause, "stack", { get() { throw new Error("secret"); } });
    expect(enabled.capture("event listener failed", cause)).toBeDefined();
    expect(await enabled.flush()).toBe(true);
  });
});
