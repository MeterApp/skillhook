// A stand-in for Skillhook Cloud on a local port. The agent API: pairs machines with a known code, answers syncs from a
// script (commands and ingress items to hand out, an error mode), takes issue reports, validates every body with the
// protocol schemas and keeps what it received for assertions. The public API (`/api/v1`): answers the reads of the
// API-key commands for one organisation API key, with RFC 9457 problems like the real one.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { CommandResultSchema, IssueReportRequestSchema, PairRequestSchema, SyncRequestSchema, type Command, type CommandResult, type Hints, type IngressAck, type IngressItem, type IssueReportRequest, type PairRequest, type SyncRequest } from "../cloud/protocol.js";

export type FakeCloudMode = "ok" | "500" | "401" | "403" | "413" | "426" | "429" | "hang" | "garbage";

const MINUTE = 60_000;

/** Two machines and two jobs as `/api/v1` returns them (one job waits for a person). */
function fleet(url: string) {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const machines = [
    { id: "7d0c7a52-1c7e-4a39-9f1e-0d6a4b0c1a01", name: "mac-mini", hostname: "mac-mini.local", os: "darwin", arch: "arm64", skillhook_version: "0.6.0", status: "online", mode: "control", link_state: "connected", last_seen_at: ago(5_000), dashboard_url: `${url}/o/fake/machines/7d0c7a52-1c7e-4a39-9f1e-0d6a4b0c1a01` },
    { id: "3b9e2f11-8a4d-4c2e-b6f0-5e7d9c8b2a02", name: "build-box", hostname: "build-box", os: "linux", arch: "x64", skillhook_version: "0.5.0", status: "offline", mode: "observe", link_state: "disconnected", last_seen_at: ago(3 * 24 * 60 * MINUTE), dashboard_url: `${url}/o/fake/machines/3b9e2f11-8a4d-4c2e-b6f0-5e7d9c8b2a02` },
  ];
  const jobs = [
    { id: "c1f4e0aa-0b1c-4d2e-8f3a-9b8c7d6e5f01", local_id: "20260929T101500Z-a1b2c3", machine_id: machines[0]?.id, skill: "triage", status: "running", outcome: null, trigger: "webhook", runner: "claude", model: "sonnet", created_at: ago(2 * MINUTE), duration_ms: null, cost_usd: null, waiting_for_human: true, waiting_since: ago(MINUTE), question: { id: "q1", text: "Deploy the fix to production?", options: ["yes", "no"], asked_at: ago(MINUTE) }, answer: null, progress: { state: "waiting_human", message: "Asked whether to deploy" }, response: null, failure: null, result: null, dashboard_url: `${url}/o/fake/jobs/c1f4e0aa-0b1c-4d2e-8f3a-9b8c7d6e5f01` },
    { id: "d2a5f1bb-1c2d-4e3f-9a4b-0c9d8e7f6a02", local_id: "20260929T090000Z-d4e5f6", machine_id: machines[1]?.id, skill: "nightly-report", status: "succeeded", outcome: "completed", trigger: "schedule", runner: "codex", model: null, created_at: ago(90 * MINUTE), duration_ms: 42_000, cost_usd: 0.0123, waiting_for_human: false, waiting_since: null, question: null, answer: null, progress: null, response: { outcome: "completed", summary: "Report sent to #ops" }, failure: null, result: "Report sent to #ops\nThree incidents, all resolved.", dashboard_url: `${url}/o/fake/jobs/d2a5f1bb-1c2d-4e3f-9a4b-0c9d8e7f6a02` },
  ];
  return { machines, jobs };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as unknown) : {};
}

export class FakeCloud {
  readonly code = "ABCD-EFGH";
  readonly token = "fake-machine-token-0123456789abcdef";
  readonly machineId = "m_fake_1";
  readonly requests: SyncRequest[] = [];
  readonly pairs: PairRequest[] = [];
  readonly invalid: string[] = [];
  readonly results: CommandResult[] = [];
  readonly ingressAcks: IngressAck[] = [];
  readonly authHeaders: (string | undefined)[] = [];
  disconnects = 0;
  mode: FakeCloudMode = "ok";
  hangMs = 20_000;
  nextPollMs = 30;
  hints: Hints | undefined;
  rotateTo: string | undefined;
  ackEvents = true;
  /** Answer 413 to a sync that carries more events than this. */
  maxEventsPerRequest = Number.POSITIVE_INFINITY;
  tooLarge = 0;
  /** Artifact uploads by `<job>/<name>`: the chunks in arrival order, their Content-Range and the announced sha256. */
  readonly artifacts = new Map<string, { chunks: Buffer[]; ranges: string[]; sha256: string | undefined }>();
  /** Issue reports filed, once per `report_id` (invalid ones land in `invalid`), and every request, retries included. */
  readonly issues: IssueReportRequest[] = [];
  issueRequests = 0;
  /** How reports are answered; `404` like a cloud without the route (an HTML page). */
  issuesMode: "ok" | "401" | "403" | "404" | "413" | "429" | "500" | "garbage" = "ok";
  /** One answer each for the next report requests, before `issuesMode`: a 500, a 429 asking for a short pause, a dropped connection, or a report filed whose answer never comes (for `hangMs`). */
  readonly issuesScript: ("500" | "429" | "reset" | "filed-then-hang")[] = [];
  private readonly issueAnswers = new Map<string, unknown>();
  /** The organisation API key `/api/v1` accepts (a placeholder: nothing here is a real credential). */
  readonly apiKey = "shc_placeholder-organisation-key-0123456789abc";
  /** Every `/api/v1` request: method, path with its query, and the bearer it carried. */
  readonly apiRequests: { method: string; path: string; authorization: string | undefined }[] = [];
  /** `forbidden` answers every `/api/v1` read with 403, as for a key without the scope. */
  apiMode: "ok" | "forbidden" = "ok";
  machines: Record<string, unknown>[] = [];
  jobs: Record<string, unknown>[] = [];
  private readonly commands: Command[] = [];
  private readonly ingress: IngressItem[] = [];
  private readonly waiters: { predicate: () => boolean; resolve: () => void }[] = [];
  private server!: Server;
  url = "";

  static async start(): Promise<FakeCloud> {
    const cloud = new FakeCloud();
    cloud.server = createServer((req, res) => void cloud.handle(req, res).catch((error: unknown) => cloud.reply(res, 500, { ok: false, error: "server_error", message: String(error) })));
    await new Promise<void>((resolve) => cloud.server.listen(0, "127.0.0.1", () => resolve()));
    const address = cloud.server.address();
    cloud.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    ({ machines: cloud.machines, jobs: cloud.jobs } = fleet(cloud.url));
    return cloud;
  }

  queueCommand(command: Command): void {
    this.commands.push(command);
    this.notify();
  }

  queueIngress(item: IngressItem): void {
    this.ingress.push(item);
    this.notify();
  }

  /** Resolves once `predicate` holds (checked after every request), or rejects after `timeoutMs`. */
  waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fake cloud: waited too long")), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate()) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private reply(res: import("node:http").ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...headers });
    res.end(text);
  }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    if (req.method === "POST" && url.pathname === "/api/agent/pair") {
      const parsed = PairRequestSchema.safeParse(await readJson(req));
      if (!parsed.success) {
        this.invalid.push(`pair: ${parsed.error.message}`);
        return this.reply(res, 400, { ok: false, error: "invalid_request", message: "bad pair request" });
      }
      this.pairs.push(parsed.data);
      this.notify();
      if (parsed.data.code && parsed.data.code !== this.code) return this.reply(res, 404, { ok: false, error: "unknown_code", message: "that pairing code is unknown or expired" });
      if (parsed.data.token && parsed.data.token !== this.token) return this.reply(res, 401, { ok: false, error: "invalid_token", message: "bad token" });
      return this.reply(res, 200, { ok: true, machine_id: this.machineId, machine_token: this.token, mode: parsed.data.requested_mode, account: { org: "Fake Org", org_slug: "fake" }, dashboard_url: `${this.url}/o/fake`, protocol_version: 1, min_protocol_version: 1 });
    }
    if (req.method === "PUT" && url.pathname.startsWith("/api/agent/artifacts/")) {
      if (req.headers.authorization !== `Bearer ${this.token}`) return this.reply(res, 401, { ok: false, error: "invalid_token", message: "bad token" });
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const key = decodeURIComponent(url.pathname.slice("/api/agent/artifacts/".length));
      const entry = this.artifacts.get(key) ?? { chunks: [], ranges: [], sha256: undefined };
      entry.chunks.push(Buffer.concat(chunks));
      entry.ranges.push(String(req.headers["content-range"] ?? ""));
      entry.sha256 = typeof req.headers["x-skillhook-sha256"] === "string" ? req.headers["x-skillhook-sha256"] : entry.sha256;
      this.artifacts.set(key, entry);
      this.notify();
      return this.reply(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/agent/disconnect") {
      this.disconnects++;
      this.notify();
      return this.reply(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/agent/issues") {
      this.issueRequests++;
      if (req.headers.authorization !== `Bearer ${this.token}`) return this.reply(res, 401, { ok: false, error: "invalid_token", message: "unknown or revoked machine token" });
      const parsed = IssueReportRequestSchema.safeParse(await readJson(req));
      if (!parsed.success) {
        this.invalid.push(`issue: ${parsed.error.message}`);
        return this.reply(res, 400, { ok: false, error: "invalid_request", message: "bad issue report" });
      }
      const scripted = this.issuesScript.shift();
      if (scripted === "500") return this.reply(res, 500, { ok: false, error: "server_error", message: "internal error" });
      if (scripted === "429") return this.reply(res, 429, { ok: false, error: "rate_limited", message: "slow down", retry_after_ms: 20 });
      if (scripted === "reset") return void req.socket.destroy();
      if (scripted === "filed-then-hang") {
        this.fileIssue(parsed.data);
        await new Promise((r) => setTimeout(r, this.hangMs));
        return void req.socket.destroy();
      }
      switch (this.issuesMode) {
        case "401":
          return this.reply(res, 401, { ok: false, error: "invalid_token", message: "this machine was disconnected; pair it again" });
        case "403":
          return this.reply(res, 403, { ok: false, error: "machine_disabled", message: "disabled in the dashboard" });
        case "404":
          res.writeHead(404, { "content-type": "text/html" });
          return void res.end("<!DOCTYPE html><title>404: This page could not be found.</title>");
        case "413":
          return this.reply(res, 413, { ok: false, error: "payload_too_large", message: "at most 65536 bytes" });
        case "429":
          return this.reply(res, 429, { ok: false, error: "rate_limited", message: "at most 10 reports an hour", retry_after_ms: 90_000 }, { "retry-after": "90" });
        case "500":
          return this.reply(res, 500, { ok: false, error: "server_error", message: "internal error" });
        case "garbage":
          return this.reply(res, 200, { ok: true, nonsense: true });
        default:
          break;
      }
      return this.reply(res, 200, this.fileIssue(parsed.data));
    }
    if (url.pathname.startsWith("/api/v1/")) return this.handleApi(req, res, url);
    if (req.method === "POST" && url.pathname === "/api/agent/sync") {
      this.authHeaders.push(req.headers.authorization);
      if (req.headers.authorization !== `Bearer ${this.token}`) return this.reply(res, 401, { ok: false, error: "invalid_token", message: "bad token" });
      const raw = await readJson(req);
      const parsed = SyncRequestSchema.safeParse(raw);
      if (!parsed.success) {
        this.invalid.push(`sync: ${parsed.error.message}`);
        return this.reply(res, 400, { ok: false, error: "invalid_request", message: "bad sync request" });
      }
      const request = parsed.data;
      this.requests.push(request);
      if (request.events.length > this.maxEventsPerRequest) {
        this.tooLarge++;
        this.notify();
        return this.reply(res, 413, { ok: false, error: "payload_too_large", message: `at most ${this.maxEventsPerRequest} events` });
      }
      for (const result of request.command_results) if (CommandResultSchema.safeParse(result).success && !this.results.some((r) => r.command_id === result.command_id)) this.results.push(result);
      for (const ack of request.ingress_acks) if (!this.ingressAcks.some((a) => a.id === ack.id)) this.ingressAcks.push(ack);
      this.notify();
      switch (this.mode) {
        case "500":
          return this.reply(res, 500, { ok: false, error: "server_error", message: "boom" });
        case "401":
          return this.reply(res, 401, { ok: false, error: "invalid_token", message: "token revoked" });
        case "403":
          return this.reply(res, 403, { ok: false, error: "machine_disabled", message: "disabled in the dashboard" });
        case "413":
          return this.reply(res, 413, { ok: false, error: "payload_too_large", message: "too big" });
        case "426":
          return this.reply(res, 426, { ok: false, error: "upgrade_required", message: "too old", min_protocol_version: 2 });
        case "429":
          return this.reply(res, 429, { ok: false, error: "rate_limited", message: "slow down", retry_after_ms: 40 });
        case "garbage":
          return this.reply(res, 200, { ok: true, nonsense: true });
        case "hang":
          await new Promise((r) => setTimeout(r, this.hangMs));
          break;
        default:
          break;
      }
      const commands = this.commands.splice(0, 50);
      const ingress = this.ingress.splice(0, 20);
      const lastSeq = request.events.reduce((max, e) => Math.max(max, e.seq ?? 0), 0);
      const body = {
        ok: true,
        protocol_version: 1,
        min_protocol_version: 1,
        server_time: new Date().toISOString(),
        ack: { events_through: this.ackEvents ? lastSeq : 0, command_results: request.command_results.map((r) => r.command_id) },
        commands,
        ingress,
        next_poll_ms: this.nextPollMs,
        ...(this.hints ? { hints: this.hints } : {}),
        ...(this.rotateTo ? { rotate: { token: this.rotateTo, old_valid_until: new Date(Date.now() + 60_000).toISOString() } } : {}),
      };
      if (this.rotateTo) {
        (this as { token: string }).token = this.rotateTo;
        this.rotateTo = undefined;
      }
      return this.reply(res, 200, body);
    }
    this.reply(res, 404, { ok: false, error: "not_found", message: "no such route" });
  }

  /** Files a report once per `report_id`, as the cloud does: a retry gets the original answer, whether or not the first one arrived. */
  private fileIssue(report: IssueReportRequest): unknown {
    const known = report.report_id ? this.issueAnswers.get(report.report_id) : undefined;
    if (known) return known;
    this.issues.push(report);
    this.notify();
    const number = 40 + this.issues.length;
    const answer = { ok: true, issue_id: `iss_${number}`, number, url: `${this.url}/o/fake/issues/${number}`, acknowledged: Boolean(report.contact_email) };
    if (report.report_id) this.issueAnswers.set(report.report_id, answer);
    return answer;
  }

  /** RFC 9457 problem details, as the public API answers errors. */
  private problem(res: import("node:http").ServerResponse, status: number, code: string, detail: string, headers: Record<string, string> = {}): void {
    this.reply(res, status, { type: `${this.url}/docs/api#${code}`, title: code.replaceAll("_", " "), status, code, detail, request_id: `req_${this.apiRequests.length}` }, { "content-type": "application/problem+json", ...headers });
  }

  private handleApi(req: IncomingMessage, res: import("node:http").ServerResponse, url: URL): void {
    this.apiRequests.push({ method: req.method ?? "GET", path: `${url.pathname}${url.search}`, authorization: req.headers.authorization });
    this.notify();
    if (!req.headers.authorization) return this.problem(res, 401, "unauthorized", "Send an organisation API key as Authorization: Bearer shc_…", { "www-authenticate": `Bearer realm="Skillhook Cloud"` });
    if (req.headers.authorization !== `Bearer ${this.apiKey}`) return this.problem(res, 401, "invalid_key", "The API key is unknown, revoked or expired.");
    if (this.apiMode === "forbidden") return this.problem(res, 403, "forbidden", "This key may not read the fleet.");
    if (req.method !== "GET") return this.problem(res, 405, "method_not_allowed", "The fake cloud only answers reads.");
    const path = url.pathname.slice("/api/v1".length);
    if (path === "/me") return this.reply(res, 200, { organisation: { id: "org_fake", slug: "fake", name: "Fake Org" }, key: { id: "key_1", name: "laptop", scopes: ["fleet:read"] }, role: "viewer" });
    if (path === "/machines") return this.reply(res, 200, { machines: this.machines });
    if (path === "/jobs") {
      const q = url.searchParams;
      const machine = this.machines.find((m) => m.id === q.get("machine") || m.name === q.get("machine"));
      if (q.get("machine") && !machine) return this.problem(res, 404, "unknown_machine", `No machine "${q.get("machine")}" in Fake Org.`);
      const jobs = this.jobs.filter((j) => (!machine || j.machine_id === machine.id) && (!q.get("skill") || j.skill === q.get("skill")) && (!q.get("status") || j.status === q.get("status")) && (!q.get("outcome") || j.outcome === q.get("outcome")) && (q.get("waiting") !== "1" || j.waiting_for_human === true));
      const limited = jobs.slice(0, Number(q.get("limit") ?? 20));
      return this.reply(res, 200, { jobs: limited, next_before: limited.length ? `cursor-after-${String(limited[limited.length - 1]?.id)}` : null });
    }
    if (path.startsWith("/jobs/")) {
      const ref = decodeURIComponent(path.slice("/jobs/".length));
      const job = this.jobs.find((j) => j.id === ref || j.local_id === ref);
      if (!job) return this.problem(res, 404, "unknown_job", `No job "${ref}" in Fake Org.`);
      return this.reply(res, 200, { job: { ...job, timeline: [] } });
    }
    this.problem(res, 404, "not_found", "No such API route.");
  }
}
