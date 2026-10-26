// Minimal error-only Sentry envelopes, explicitly enabled by a private DSN.
// Protocol: https://develop.sentry.dev/sdk/foundations/envelopes/
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Secrets } from "./env.js";

const OPERATIONS = new Set([
  "daemon error", "unhandled request error", "event listener failed", "scheduler tick failed",
  "could not write schedule state", "scheduler could not list skills", "skill failed to load",
  "skill secret missing", "config file is invalid; keeping the running settings",
  "cloud link loop ended", "deferred cloud command action failed", "cloud command failed",
  "daemon uncaught exception", "daemon unhandled rejection", "daemon startup failed",
  "Sentry daemon verification",
]);
const TYPES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError"]);
// A finite module allow-list prevents an invented stack from uploading arbitrary paths or names.
const MODULES = new Set(["sentry", "server", "logger", "events", "scheduler", "queue", "jobs", "config", "registry", "skills", "projects", "health", "account-watch", "commands/serve", "commands/main", "cloud/link", "cloud/commands", "cloud/control"]);
const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REQUEST_TIMEOUT = 3_000;
const MAX_PENDING = 8;

type Failure = "invalid_dsn" | "disabled" | "busy" | "rate_limited" | "transport_error" | "timeout" | "rejected";
type Result = { delivered: boolean; error?: Failure };
interface Destination { url: string; key: string; }

function destination(raw: string | undefined): Destination | undefined {
  if (!raw || raw.length > 2_048 || raw.includes("?") || raw.includes("#")) return undefined;
  try {
    const dsn = new URL(raw);
    if (dsn.protocol !== "https:" || !dsn.hostname || dsn.password || dsn.search || dsn.hash || !/^[a-zA-Z0-9]+$/.test(dsn.username)) return undefined;
    const segments = dsn.pathname.split("/");
    const project = segments.pop();
    if (!project || !/^\d+$/.test(project) || segments.some((s) => s === "." || s === ".." || (s && !/^[a-zA-Z0-9_-]+$/.test(s)))) return undefined;
    const prefix = segments.join("/");
    return { url: `${dsn.origin}${prefix}/api/${project}/envelope/`, key: dsn.username };
  } catch { return undefined; }
}

function frames(cause: unknown): { filename: string; lineno: number; colno: number; in_app: true }[] {
  if (!(cause instanceof Error)) return [];
  try {
    const out: ReturnType<typeof frames> = [];
    const stack = cause.stack;
    // Reject giant stacks rather than scanning or allocating unbounded attacker-controlled input.
    if (typeof stack !== "string" || stack.length > 65_536) return [];
    for (const line of stack.split("\n").slice(1, 41)) {
      if (line.length > 4_096) continue;
      const entry = line.trim();
      if (!entry.startsWith("at ")) continue;
      const end = entry.endsWith(")") ? entry.length - 1 : entry.length;
      const columnColon = entry.lastIndexOf(":", end - 1);
      if (columnColon < 0) continue;
      const lineColon = entry.lastIndexOf(":", columnColon - 1);
      if (lineColon < 0) continue;
      const lineText = entry.slice(lineColon + 1, columnColon);
      const columnText = entry.slice(columnColon + 1, end);
      if (!/^\d{1,7}$/.test(lineText) || !/^\d{1,6}$/.test(columnText)) continue;
      const opening = entry.lastIndexOf("(", lineColon);
      const raw = entry.slice(opening < 0 ? 3 : opening + 1, lineColon);
      if (!raw.startsWith("/") && !raw.startsWith("file:///")) continue;
      const file = raw.startsWith("file://") ? fileURLToPath(raw) : raw;
      const relative = path.relative(SOURCE_DIR, file).replaceAll(path.sep, "/");
      const module = relative.replace(/\.(?:js|ts)$/, "");
      if (!MODULES.has(module) || !/\.(?:js|ts)$/.test(relative)) continue;
      const lineno = Number(lineText);
      const colno = Number(columnText);
      if (lineno > 0 && lineno < 10_000_000 && colno > 0 && colno < 1_000_000) out.push({ filename: relative, lineno, colno, in_app: true });
    }
    return out.reverse().slice(-20);
  } catch { return []; }
}

/** No message, cause chain, logger fields, hostname, request, environment dump, or job data leaves the daemon. */
export class DaemonSentry {
  private readonly pending = new Map<string, Promise<Result>>();
  private blockedUntil = 0;
  private lastError: Failure | undefined;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: { secrets: () => Secrets; version: string; fetchImpl?: typeof fetch }) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private settings(): { enabled: boolean; configured: boolean; target?: Destination; environment: string } {
    try {
      const secrets = this.options.secrets();
      const raw = secrets.SKILLHOOK_SENTRY_DSN;
      const target = destination(raw);
      const disabled = ["1", "true"].includes((secrets.SKILLHOOK_NO_SENTRY ?? "").toLowerCase());
      // Only short deployment labels are meaningful; invalid values never leave the machine.
      const label = secrets.SKILLHOOK_SENTRY_ENVIRONMENT ?? "production";
      const environment = /^[a-zA-Z0-9_-]{1,40}$/.test(label) ? label : "production";
      return { enabled: Boolean(target) && !disabled, configured: Boolean(raw), target, environment };
    } catch { return { enabled: false, configured: false, environment: "production" }; }
  }

  status(): { enabled: boolean; configured: boolean; pending: number; rate_limited: boolean; last_error?: Failure } {
    const settings = this.settings();
    return { enabled: settings.enabled, configured: settings.configured, pending: this.pending.size, rate_limited: Date.now() < this.blockedUntil, ...(this.lastError ? { last_error: this.lastError } : {}) };
  }

  capture(operation: string, cause?: unknown): string | undefined {
    try {
      const settings = this.settings();
      if (!settings.enabled || !settings.target) { this.lastError = settings.configured && !settings.target ? "invalid_dsn" : "disabled"; return undefined; }
      if (Date.now() < this.blockedUntil) { this.lastError = "rate_limited"; return undefined; }
      if (this.pending.size >= MAX_PENDING) { this.lastError = "busy"; return undefined; }
      const value = OPERATIONS.has(operation) ? operation : "daemon error";
      let type = "Error";
      try { if (cause instanceof Error && TYPES.has(cause.name)) type = cause.name; } catch { /* ignore hostile properties */ }
      const ownFrames = frames(cause);
      const eventId = randomUUID().replaceAll("-", "");
      const event = {
        event_id: eventId, timestamp: Date.now() / 1000, platform: "node", level: "error",
        release: `skillhook-daemon@${this.options.version.length <= 128 && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(this.options.version) ? this.options.version : "unknown"}`,
        environment: settings.environment, logger: "skillhook.daemon",
        exception: { values: [{ type, value, ...(ownFrames.length ? { stacktrace: { frames: ownFrames } } : {}) }] },
        tags: { component: "daemon" }, fingerprint: ["skillhook.daemon", value],
      };
      const payload = JSON.stringify(event);
      const envelope = `${JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event", length: Buffer.byteLength(payload), content_type: "application/json" })}\n${payload}\n`;
      const task = this.send(settings.target, envelope).then((result) => { this.lastError = result.error; return result; });
      this.pending.set(eventId, task);
      void task.finally(() => this.pending.delete(eventId));
      return eventId;
    } catch { this.lastError = "transport_error"; return undefined; }
  }

  private async send(target: Destination, body: string): Promise<Result> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<Result>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve({ delivered: false, error: "timeout" }); }, REQUEST_TIMEOUT);
    });
    const request = (async (): Promise<Result> => {
      try {
        const response = await this.fetchImpl(target.url, { method: "POST", redirect: "error", signal: controller.signal,
          headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": `Sentry sentry_version=7, sentry_client=skillhook.daemon/1, sentry_key=${target.key}` }, body });
        // Do not read or retain the response body (Sentry responses can contain arbitrary diagnostic text).
        void response.body?.cancel().catch(() => {});
        const limits = response.headers.get("x-sentry-rate-limits");
        if (limits) {
          // A global pause is conservative: this client sends only error events.
          for (const limit of limits.split(",").slice(0, 20)) {
            const seconds = Number(limit.trim().split(":")[0]);
            if (Number.isFinite(seconds) && seconds > 0) this.blockedUntil = Math.max(this.blockedUntil, Date.now() + Math.min(3_600_000, seconds * 1000));
          }
        }
        if (response.status === 429 || response.status >= 500) {
          const retry = response.headers.get("retry-after");
          const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : undefined;
          const date = retry ? Date.parse(retry) : NaN;
          const delay = seconds !== undefined ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : 60_000;
          this.blockedUntil = Math.max(this.blockedUntil, Date.now() + Math.min(3_600_000, Math.max(1_000, delay)));
        }
        return response.ok ? { delivered: true } : { delivered: false, error: response.status === 429 ? "rate_limited" : "rejected" };
      } catch { return { delivered: false, error: controller.signal.aborted ? "timeout" : "transport_error" }; }
    })();
    const result = await Promise.race([request, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  async flush(timeoutMs = 4_000): Promise<boolean> {
    const tasks = [...this.pending.values()];
    if (!tasks.length) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, Math.min(timeoutMs, 10_000))); });
    const complete = Promise.all(tasks).then((results) => results.every((result) => result.delivered));
    const result = await Promise.race([complete, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  async verify(): Promise<{ enabled: boolean; event_id?: string; delivered: boolean; error?: string }> {
    const enabled = this.status().enabled;
    const eventId = this.capture("Sentry daemon verification", new Error("Sentry daemon verification"));
    if (!eventId) return { enabled, delivered: false, error: this.lastError ?? "disabled" };
    const result = await this.pending.get(eventId);
    return { enabled, event_id: eventId, delivered: result?.delivered ?? false, ...(result?.error ? { error: result.error } : {}) };
  }
}
