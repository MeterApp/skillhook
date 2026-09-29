import { ADMIN_TOKEN_ENV, type Secrets } from "./env.js";
import type { Paths } from "./paths.js";
import type { ScheduleStatus } from "./scheduler.js";
import type { ServerState } from "./server.js";
import { readJsonFileOr } from "./util.js";

export function readServerState(paths: Paths): ServerState | undefined {
  return readJsonFileOr<ServerState | undefined>(paths.serverStateFile, undefined);
}

export function localBaseUrl(state: { host: string; port: number }): string {
  const host = state.host === "0.0.0.0" || state.host === "::" ? "127.0.0.1" : state.host;
  return `http://${host.includes(":") ? `[${host}]` : host}:${state.port}`;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptime_seconds?: number;
  /** Only present for admin/local callers. */
  queue?: { running: number; queued: number; running_ids: string[] };
  /** The cloud link's status (admin/local callers of a server that runs one); null when the server has no link. */
  cloud?: import("./cloud/link.js").LinkStatusView | null;
  /** Only present for admin/local callers, and only when the server runs the scheduler. */
  schedules?: ScheduleStatus[];
}

/** Returns the health payload when a server answers at `baseUrl`, otherwise undefined. */
export async function probeServer(baseUrl: string, timeoutMs = 1500): Promise<HealthResponse | undefined> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    return (await response.json()) as HealthResponse;
  } catch {
    return undefined;
  }
}

/** Polls `${baseUrl}/health` until it answers. A fresh Tailscale Funnel URL needs a few seconds for its TLS certificate. */
export async function waitForUrl(baseUrl: string, timeoutMs = 45_000, intervalMs = 3_000): Promise<{ reachable: boolean; attempts: number; elapsedMs: number }> {
  const started = Date.now();
  let attempts = 0;
  while (Date.now() - started < timeoutMs) {
    attempts++;
    if (await probeServer(baseUrl, 8_000)) return { reachable: true, attempts, elapsedMs: Date.now() - started };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { reachable: false, attempts, elapsedMs: Date.now() - started };
}

/** The running server for this skillhook directory, if its state file is present and it answers. */
export async function findRunningServer(paths: Paths): Promise<{ state: ServerState; baseUrl: string; health: HealthResponse } | undefined> {
  const state = readServerState(paths);
  if (!state) return undefined;
  const baseUrl = localBaseUrl(state);
  const health = await probeServer(baseUrl);
  if (!health) return undefined;
  return { state, baseUrl, health };
}

export interface AdminResponse<T = unknown> {
  status: number;
  body: T;
}

/** One server-sent event: `data` is the raw (JSON) text of its `data:` lines joined with newlines. */
export interface StreamedEvent {
  id?: string;
  event?: string;
  data: string;
}

/** Incremental `text/event-stream` parser: feed it chunks, take the complete events. */
export class SseParser {
  private buffer = "";
  private current: { id?: string; event?: string; data: string[] } = { data: [] };

  push(chunk: string): StreamedEvent[] {
    const events: StreamedEvent[] = [];
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        const event = this.flush();
        if (event) events.push(event);
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") this.current.event = value;
        else if (field === "id") this.current.id = value;
        else if (field === "data") this.current.data.push(value);
      }
      newline = this.buffer.indexOf("\n");
    }
    return events;
  }

  /** The event under construction, if it has data (a stream that ends without a blank line). */
  flush(): StreamedEvent | undefined {
    if (!this.current.data.length) {
      this.current = { data: [] };
      return undefined;
    }
    const event: StreamedEvent = { data: this.current.data.join("\n") };
    if (this.current.id !== undefined) event.id = this.current.id;
    if (this.current.event !== undefined) event.event = this.current.event;
    this.current = { data: [] };
    return event;
  }
}

/**
 * Opens an admin SSE route (`/events`, `/jobs/<id>/events`) and calls `onEvent` for each message until the server
 * ends the stream or `signal` aborts. Resolves with the HTTP status; a non-2xx status ends the call at once.
 */
export async function openAdminEventStream(baseUrl: string, secrets: Secrets, path: string, onEvent: (event: StreamedEvent) => void, signal?: AbortSignal): Promise<{ status: number }> {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  const token = secrets[ADMIN_TOKEN_ENV];
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { headers, signal });
  if (!response.ok || !response.body) return { status: response.status };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) onEvent(event);
    }
    const last = parser.flush();
    if (last) onEvent(last);
  } catch (error) {
    if (!signal?.aborted) throw error;
  }
  return { status: response.status };
}

export async function adminRequest<T = unknown>(baseUrl: string, secrets: Secrets, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<AdminResponse<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  const token = secrets[ADMIN_TOKEN_ENV];
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), ...(init.timeoutMs ? { signal: AbortSignal.timeout(init.timeoutMs) } : {}) });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: response.status, body: body as T };
}
