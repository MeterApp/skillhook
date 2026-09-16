export type BodyKind = "json" | "form" | "text" | "empty" | "binary";

export interface ParsedBody {
  payload: unknown;
  kind: BodyKind;
}

const SENSITIVE_HEADER_RE = /(signature|token|secret|api-?key|authorization|cookie|password)/i;

function isUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/** Parses a request body by content type. JSON is preferred; form bodies become objects (GitHub's `payload=` form is unwrapped). */
export function parseBody(contentType: string | undefined, raw: Buffer): ParsedBody {
  if (raw.length === 0) return { payload: null, kind: "empty" };
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const text = isUtf8(raw) ? raw.toString("utf8") : null;

  if (type.endsWith("/json") || type.endsWith("+json") || (type === "" && text && looksLikeJson(text))) {
    if (text === null) return { payload: { binary: true, bytes: raw.length }, kind: "binary" };
    try {
      return { payload: JSON.parse(text), kind: "json" };
    } catch {
      return { payload: text, kind: "text" };
    }
  }
  if (type === "application/x-www-form-urlencoded" && text !== null) {
    const params = new URLSearchParams(text);
    const object: Record<string, string | string[]> = {};
    for (const [key, value] of params) {
      const existing = object[key];
      if (existing === undefined) object[key] = value;
      else object[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    }
    const keys = Object.keys(object);
    if (keys.length === 1 && keys[0] === "payload" && typeof object.payload === "string") {
      try {
        return { payload: JSON.parse(object.payload), kind: "json" };
      } catch {
        /* fall through */
      }
    }
    return { payload: object, kind: "form" };
  }
  if (text !== null && (type.startsWith("text/") || type === "" || type === "application/xml" || type.endsWith("+xml"))) {
    if (looksLikeJson(text)) {
      try {
        return { payload: JSON.parse(text), kind: "json" };
      } catch {
        /* keep as text */
      }
    }
    return { payload: text, kind: "text" };
  }
  if (text !== null && raw.length <= 256 * 1024) return { payload: text, kind: "text" };
  return { payload: { binary: true, bytes: raw.length, content_type: type || null }, kind: "binary" };
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

/** Drops credentials and signatures before headers are stored or shown to the agent. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_RE.test(name)) continue;
    out[name] = value;
  }
  return out;
}

export type Trigger = "webhook" | "cli" | "mcp" | "api";

/** Everything the skill learns about one delivery. Persisted as `event.json` in the job directory. */
export interface WebhookEvent {
  id: string;
  skill: string;
  trigger: Trigger;
  received_at: string;
  method: string;
  path: string;
  query: Record<string, string>;
  /** Redacted (no auth/signature headers). */
  headers: Record<string, string>;
  source_ip: string;
  content_type: string | null;
  content_length: number;
  body_kind: BodyKind;
  delivery_id?: string;
  payload: unknown;
}
