import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CloudHttpError, cloudRequest } from "./http.js";

// Placeholder values: nothing here is a real credential.
const KEY = "shc_placeholder-key-for-http-tests";

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop() as Server;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function answering(status: number, body: string, headers: Record<string, string>): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(status, headers);
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

async function failure(request: Promise<unknown>): Promise<CloudHttpError> {
  const error = await request.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CloudHttpError);
  return error as CloudHttpError;
}

describe("cloudRequest", () => {
  it("reads the public API's problems as well as the agent API's errors", async () => {
    const problem = await answering(403, JSON.stringify({ type: "https://cloud.example/docs/api#forbidden", title: "forbidden", status: 403, code: "forbidden", detail: "Sending job.answer needs the member role.", request_id: "req_7" }), { "content-type": "application/problem+json" });
    expect(await failure(cloudRequest(problem, "/api/v1/jobs", { method: "GET", token: KEY }))).toMatchObject({ status: 403, code: "forbidden", message: "Sending job.answer needs the member role.", requestId: "req_7" });
    const agent = await answering(429, JSON.stringify({ ok: false, error: "rate_limited", message: "slow down" }), { "content-type": "application/json", "retry-after": "30", "x-request-id": "req_8" });
    expect(await failure(cloudRequest(agent, "/api/agent/issues", { token: KEY, body: {} }))).toMatchObject({ status: 429, code: "rate_limited", message: "slow down", retryAfterMs: 30_000, requestId: "req_8" });
    const page = await answering(404, "<!DOCTYPE html><title>404</title>", { "content-type": "text/html" });
    expect(await failure(cloudRequest(page, "/api/agent/issues", { token: KEY, body: {} }))).toMatchObject({ status: 404, code: "http_404", message: "404 Not Found" });
  });

  it("never lets a credential into an error message", async () => {
    // A key pasted with a line break would make the runtime quote the whole header in its error.
    const twoLines = `${KEY}\nshc_placeholder-second-line`;
    const refused = await failure(cloudRequest("http://127.0.0.1:1", "/api/v1/me", { method: "GET", token: twoLines }));
    expect(refused).toMatchObject({ status: 0, code: "invalid_credentials" });
    expect(refused.message).not.toContain("shc_");
    // Whatever else the transport says about the header is redacted.
    const quoting: typeof fetch = async (_input, init) => {
      throw new TypeError(`invalid header value: ${String((init?.headers as Record<string, string>).authorization)}`);
    };
    const quoted = await failure(cloudRequest("http://127.0.0.1:1", "/api/v1/me", { method: "GET", token: KEY, fetchImpl: quoting }));
    expect(quoted.message).toBe("invalid header value: Bearer [redacted]");
  });
});
