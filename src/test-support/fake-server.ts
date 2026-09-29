// A stand-in for a running `skillhook serve` as the other commands find it: `server.json` in the home and, on a local
// port, `GET /health` (with the cloud link's status, as a local caller sees it), `GET /health/checks` and `GET /runners`
// answered from a script. A route without an answer is a 404, like a server that predates it.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { LinkStatusView } from "../cloud/link.js";
import type { HealthReport } from "../health.js";
import type { Paths } from "../paths.js";
import type { RunnerReadiness } from "../readiness.js";
import { VERSION } from "../version.js";

export interface FakeServerAnswers {
  cloud?: Partial<LinkStatusView> | null;
  checks?: Partial<HealthReport>;
  runners?: Partial<RunnerReadiness>[];
}

export interface FakeServer {
  /** Every request's path and query. */
  requests: string[];
  close(): Promise<void>;
}

export async function startFakeServer(paths: Paths, answers: FakeServerAnswers): Promise<FakeServer> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "/");
    const route = new URL(req.url ?? "/", "http://skillhook.local").pathname;
    const body = route === "/health" ? { ok: true, version: VERSION, cloud: answers.cloud ?? null } : route === "/health/checks" ? answers.checks : route === "/runners" && answers.runners ? { runners: answers.runners, default_runner: "claude" } : undefined;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { ok: false, error: "not_found", message: "no such route" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  writeFileSync(paths.serverStateFile, JSON.stringify({ pid: process.pid, host: "127.0.0.1", port, started_at: new Date().toISOString(), version: VERSION }));
  return { requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
