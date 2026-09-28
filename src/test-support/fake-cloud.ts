// A stand-in for Skillhook Cloud's agent API on a local port: pairs machines with a known code, answers syncs from a
// script (commands and ingress items to hand out, an error mode), validates every body with the protocol schemas and
// keeps what it received for assertions.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { CommandResultSchema, PairRequestSchema, SyncRequestSchema, type Command, type CommandResult, type Hints, type IngressAck, type IngressItem, type PairRequest, type SyncRequest } from "../cloud/protocol.js";

export type FakeCloudMode = "ok" | "500" | "401" | "403" | "413" | "426" | "429" | "hang" | "garbage";

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
}
