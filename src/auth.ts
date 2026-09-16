import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Secrets } from "./env.js";
import type { NormalizedAuth } from "./skills.js";

export interface InboundRequest {
  /** Lower-cased header names; repeated headers joined with ", ". */
  headers: Record<string, string>;
  rawBody: Buffer;
  query: URLSearchParams;
  ip: string;
  /** Override for tests. */
  nowSeconds?: number;
}

export type AuthOutcome =
  | { ok: true; deliveryId?: string }
  | { ok: false; status: 401 | 403 | 503; code: string; reason: string };

/** Constant-time comparison that does not leak length (compares SHA-256 digests). */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

function fail(status: 401 | 403 | 503, code: string, reason: string): AuthOutcome {
  return { ok: false, status, code, reason };
}

function hmac(algorithm: string, secret: string | Buffer, data: string | Buffer): Buffer {
  return createHmac(algorithm, secret).update(data).digest();
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.trim());
  if (!Number.isFinite(n)) return null;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n); // accept milliseconds too
}

function fresh(ts: number, now: number, tolerance: number): boolean {
  return Math.abs(now - ts) <= tolerance;
}

function candidates(headerValue: string | undefined): string[] {
  if (!headerValue) return [];
  return headerValue
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// IP allow-lists
// ---------------------------------------------------------------------------

export function normalizeIp(ip: string): string {
  let out = ip.trim();
  if (out.startsWith("::ffff:")) out = out.slice(7);
  if (out === "::1") return "127.0.0.1";
  const zone = out.indexOf("%");
  if (zone > 0) out = out.slice(0, zone);
  return out;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

export function ipMatches(ip: string, patterns: string[]): boolean {
  const target = normalizeIp(ip);
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    if (pattern === "localhost" && target === "127.0.0.1") return true;
    if (normalizeIp(pattern) === target) return true;
    const slash = pattern.indexOf("/");
    if (slash > 0) {
      const base = ipv4ToInt(pattern.slice(0, slash));
      const bits = Number(pattern.slice(slash + 1));
      const value = ipv4ToInt(target);
      if (base !== null && value !== null && Number.isInteger(bits) && bits >= 0 && bits <= 32) {
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        if (((base & mask) >>> 0) === ((value & mask) >>> 0)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Splits an `Authorization`-style header value into scheme and parameter with plain string operations: a regex such
 * as `/^\s*Bearer\s+(.+?)\s*$/` backtracks quadratically on long runs of whitespace, and the header is attacker
 * controlled. Returns the trimmed parameter when the scheme matches case-insensitively and is followed by whitespace.
 */
export function parseAuthorizationScheme(headerValue: string | undefined, scheme: string): string | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed.length <= scheme.length || trimmed.slice(0, scheme.length).toLowerCase() !== scheme.toLowerCase()) return undefined;
  if (trimmed.charAt(scheme.length).trim() !== "") return undefined; // the scheme must be followed by whitespace
  const parameter = trimmed.slice(scheme.length + 1).trim();
  return parameter || undefined;
}

const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

export function verifyRequest(auth: NormalizedAuth, secrets: Secrets, req: InboundRequest): AuthOutcome {
  if (auth.allow_ips && auth.allow_ips.length > 0 && !ipMatches(req.ip, auth.allow_ips)) {
    return fail(403, "ip_not_allowed", "source address is not allowed for this skill");
  }
  if (auth.type === "none") return { ok: true };

  const secret = secrets[auth.secret_env];
  if (!secret) return fail(503, "secret_missing", `skill secret is not configured (${auth.secret_env})`);
  const now = req.nowSeconds ?? Math.floor(Date.now() / 1000);

  switch (auth.type) {
    case "bearer": {
      let presented: string | undefined;
      const headerValue = req.headers[auth.header];
      if (auth.header === "authorization") presented = parseAuthorizationScheme(headerValue, "Bearer");
      else presented = headerValue?.trim();
      if (!presented && auth.allow_query_token) presented = req.query.get("token") ?? undefined;
      if (!presented) return fail(401, "missing_token", "missing bearer token");
      return safeEqual(presented, secret) ? { ok: true } : fail(401, "invalid_token", "invalid token");
    }
    case "basic": {
      const credential = parseAuthorizationScheme(req.headers.authorization, "Basic");
      if (!credential || !BASE64_RE.test(credential)) return fail(401, "missing_credentials", "missing basic credentials");
      const decoded = Buffer.from(credential, "base64").toString("utf8");
      return safeEqual(decoded, secret) ? { ok: true } : fail(401, "invalid_credentials", "invalid credentials");
    }
    case "hmac": {
      const provided = candidates(req.headers[auth.header]).map((c) => (auth.prefix && c.startsWith(auth.prefix) ? c.slice(auth.prefix.length) : c));
      if (provided.length === 0) return fail(401, "missing_signature", `missing ${auth.header} header`);
      let signed: Buffer | string = req.rawBody;
      if (auth.timestamp_header) {
        const ts = parseTimestamp(req.headers[auth.timestamp_header]);
        if (ts === null) return fail(401, "missing_timestamp", `missing ${auth.timestamp_header} header`);
        if (!fresh(ts, now, auth.tolerance_seconds)) return fail(401, "stale_timestamp", "timestamp outside tolerance");
        signed = Buffer.concat([Buffer.from(`${ts}.`), req.rawBody]);
      }
      const expected = hmac(auth.algorithm, secret, signed).toString(auth.encoding);
      const ok = provided.some((p) => safeEqual(p, expected));
      if (!ok) return fail(401, "invalid_signature", "invalid signature");
      const deliveryId = auth.delivery_id_header ? req.headers[auth.delivery_id_header] : undefined;
      return { ok: true, deliveryId };
    }
    case "standard-webhooks": {
      const id = req.headers["webhook-id"] ?? req.headers["svix-id"];
      const tsRaw = req.headers["webhook-timestamp"] ?? req.headers["svix-timestamp"];
      const sigHeader = req.headers["webhook-signature"] ?? req.headers["svix-signature"];
      if (!id || !tsRaw || !sigHeader) return fail(401, "missing_signature", "missing webhook-id, webhook-timestamp or webhook-signature");
      const ts = parseTimestamp(tsRaw);
      if (ts === null) return fail(401, "invalid_timestamp", "invalid webhook-timestamp");
      if (!fresh(ts, now, auth.tolerance_seconds)) return fail(401, "stale_timestamp", "timestamp outside tolerance");
      const key = standardWebhooksKey(secret);
      const expected = hmac("sha256", key, Buffer.concat([Buffer.from(`${id}.${tsRaw.trim()}.`), req.rawBody])).toString("base64");
      const provided = sigHeader
        .split(/\s+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith("v1,"))
        .map((entry) => entry.slice(3));
      if (provided.length === 0) return fail(401, "invalid_signature", "no v1 signature present");
      return provided.some((p) => safeEqual(p, expected)) ? { ok: true, deliveryId: id } : fail(401, "invalid_signature", "invalid signature");
    }
    case "stripe": {
      const header = req.headers["stripe-signature"];
      if (!header) return fail(401, "missing_signature", "missing Stripe-Signature header");
      let t: string | undefined;
      const v1: string[] = [];
      for (const part of header.split(",")) {
        const [k, v] = part.split("=", 2).map((s) => s.trim());
        if (k === "t" && v) t = v;
        if (k === "v1" && v) v1.push(v);
      }
      const ts = parseTimestamp(t);
      if (ts === null || v1.length === 0) return fail(401, "invalid_signature", "malformed Stripe-Signature header");
      if (!fresh(ts, now, auth.tolerance_seconds)) return fail(401, "stale_timestamp", "timestamp outside tolerance");
      const expected = hmac("sha256", secret, Buffer.concat([Buffer.from(`${t}.`), req.rawBody])).toString("hex");
      return v1.some((p) => safeEqual(p, expected)) ? { ok: true } : fail(401, "invalid_signature", "invalid signature");
    }
    case "slack": {
      const tsRaw = req.headers["x-slack-request-timestamp"];
      const sig = req.headers["x-slack-signature"];
      if (!tsRaw || !sig) return fail(401, "missing_signature", "missing X-Slack-Signature or X-Slack-Request-Timestamp");
      const ts = parseTimestamp(tsRaw);
      if (ts === null) return fail(401, "invalid_timestamp", "invalid X-Slack-Request-Timestamp");
      if (!fresh(ts, now, auth.tolerance_seconds)) return fail(401, "stale_timestamp", "timestamp outside tolerance");
      const expected = `v0=${hmac("sha256", secret, Buffer.concat([Buffer.from(`v0:${tsRaw.trim()}:`), req.rawBody])).toString("hex")}`;
      return safeEqual(sig.trim(), expected) ? { ok: true } : fail(401, "invalid_signature", "invalid signature");
    }
  }
}

/** Standard Webhooks secrets are `whsec_` + base64; anything else is used as raw bytes. */
export function standardWebhooksKey(secret: string): Buffer {
  if (secret.startsWith("whsec_")) return Buffer.from(secret.slice(6), "base64");
  return Buffer.from(secret, "utf8");
}

// ---------------------------------------------------------------------------
// Signing (used by `skillhook send`, the MCP test tool and the test-suite)
// ---------------------------------------------------------------------------

export interface SignOptions {
  nowSeconds?: number;
  deliveryId?: string;
}

/** Produces the headers a real sender would attach for the given auth scheme. */
export function signRequest(auth: NormalizedAuth, secret: string, rawBody: Buffer, options: SignOptions = {}): Record<string, string> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const deliveryId = options.deliveryId ?? `skillhook-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  switch (auth.type) {
    case "none":
      return {};
    case "bearer":
      return auth.header === "authorization" ? { authorization: `Bearer ${secret}` } : { [auth.header]: secret };
    case "basic":
      return { authorization: `Basic ${Buffer.from(secret, "utf8").toString("base64")}` };
    case "hmac": {
      const headers: Record<string, string> = {};
      let signed: Buffer = rawBody;
      if (auth.timestamp_header) {
        headers[auth.timestamp_header] = String(now);
        signed = Buffer.concat([Buffer.from(`${now}.`), rawBody]);
      }
      headers[auth.header] = `${auth.prefix}${hmac(auth.algorithm, secret, signed).toString(auth.encoding)}`;
      if (auth.delivery_id_header) headers[auth.delivery_id_header] = deliveryId;
      return headers;
    }
    case "standard-webhooks": {
      const sig = hmac("sha256", standardWebhooksKey(secret), Buffer.concat([Buffer.from(`${deliveryId}.${now}.`), rawBody])).toString("base64");
      return { "webhook-id": deliveryId, "webhook-timestamp": String(now), "webhook-signature": `v1,${sig}` };
    }
    case "stripe": {
      const sig = hmac("sha256", secret, Buffer.concat([Buffer.from(`${now}.`), rawBody])).toString("hex");
      return { "stripe-signature": `t=${now},v1=${sig}` };
    }
    case "slack": {
      const sig = hmac("sha256", secret, Buffer.concat([Buffer.from(`v0:${now}:`), rawBody])).toString("hex");
      return { "x-slack-request-timestamp": String(now), "x-slack-signature": `v0=${sig}` };
    }
  }
}
