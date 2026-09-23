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

export async function adminRequest<T = unknown>(baseUrl: string, secrets: Secrets, path: string, init: { method?: string; body?: unknown } = {}): Promise<AdminResponse<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  const token = secrets[ADMIN_TOKEN_ENV];
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: response.status, body: body as T };
}
