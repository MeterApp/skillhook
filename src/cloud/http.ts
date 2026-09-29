// The one HTTP client for Skillhook Cloud (the link, pairing, `cloud report` and the API-key commands): bearer token,
// protocol header, a timeout, JSON in and out. The token is never logged or included in an error message.
import { VERSION } from "../version.js";
import { PROTOCOL_VERSION } from "./protocol.js";

export class CloudHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterMs?: number,
    public readonly minProtocolVersion?: number,
    /** The cloud's id for the request (`request_id` of a problem answer, or `x-request-id`), for support. */
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "CloudHttpError";
  }
}

export interface CloudRequestOptions {
  method?: "GET" | "POST" | "PUT";
  token?: string;
  body?: unknown;
  /** Raw bytes instead of JSON (artifact chunks). */
  raw?: { body: Uint8Array; contentType: string; headers?: Record<string, string> };
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface CloudResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

/**
 * Sends one request; non-2xx answers become `CloudHttpError` with what the body says when it is JSON: `error` / `message`
 * from the agent API, `code` / `detail` / `request_id` from the public API's RFC 9457 problems.
 */
export async function cloudRequest<T = unknown>(baseUrl: string, path: string, options: CloudRequestOptions = {}): Promise<CloudResponse<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: "application/json", "user-agent": `skillhook/${VERSION} (cloud link)`, "x-skillhook-protocol": String(PROTOCOL_VERSION), ...(options.raw?.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  type FetchBody = NonNullable<Parameters<typeof fetch>[1]>["body"];
  let body: FetchBody | undefined;
  if (options.raw) {
    headers["content-type"] = options.raw.contentType;
    body = options.raw.body as unknown as FetchBody;
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, { method: options.method ?? "POST", headers, body, signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "";
    throw new CloudHttpError(0, name === "TimeoutError" ? "timeout" : name === "AbortError" ? "aborted" : "network", message);
  }
  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = undefined;
    }
  }
  if (!response.ok) {
    const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const field = (...keys: string[]) => keys.map((key) => record[key]).find((value): value is string => typeof value === "string" && value !== "");
    const retryHeader = Number(response.headers.get("retry-after"));
    const retryAfterMs = typeof record.retry_after_ms === "number" ? record.retry_after_ms : Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader * 1000 : undefined;
    const requestId = field("request_id") ?? response.headers.get("x-request-id") ?? undefined;
    throw new CloudHttpError(response.status, field("error", "code") ?? `http_${response.status}`, field("message", "detail", "title") ?? `${response.status} ${response.statusText}`.trim(), retryAfterMs, typeof record.min_protocol_version === "number" ? record.min_protocol_version : undefined, requestId);
  }
  return { status: response.status, body: parsed as T, headers: response.headers };
}
