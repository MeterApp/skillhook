import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ipMatches, signRequest, standardWebhooksKey, verifyRequest, type InboundRequest } from "./auth.js";
import { normalizeAuth, type AuthConfig } from "./skills.js";

const body = Buffer.from(JSON.stringify({ hello: "world", n: 1 }));
const secrets = { SECRET: "s3cret-value", SKILLHOOK_SECRET_DEMO: "default-secret", WHSEC: `whsec_${Buffer.from("raw-key-bytes").toString("base64")}` };

function request(headers: Record<string, string>, overrides: Partial<InboundRequest> = {}): InboundRequest {
  return { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), rawBody: body, query: new URLSearchParams(), ip: "203.0.113.5", ...overrides };
}

function roundTrip(auth: AuthConfig, secretEnv = "SECRET") {
  const normalized = normalizeAuth("demo", { ...auth, secret_env: secretEnv } as AuthConfig);
  const headers = signRequest(normalized, secrets[secretEnv as keyof typeof secrets], body);
  return { normalized, headers };
}

describe("verifyRequest", () => {
  it("defaults to a bearer token in SKILLHOOK_SECRET_<NAME>", () => {
    const auth = normalizeAuth("demo", undefined);
    expect(auth).toMatchObject({ type: "bearer", secret_env: "SKILLHOOK_SECRET_DEMO" });
    expect(verifyRequest(auth, secrets, request({ Authorization: "Bearer default-secret" })).ok).toBe(true);
    expect(verifyRequest(auth, secrets, request({ Authorization: "Bearer nope" }))).toMatchObject({ ok: false, status: 401, code: "invalid_token" });
    expect(verifyRequest(auth, secrets, request({}))).toMatchObject({ ok: false, status: 401, code: "missing_token" });
  });

  it("reports a missing secret as 503 without accepting anything", () => {
    const auth = normalizeAuth("other", undefined);
    expect(verifyRequest(auth, secrets, request({ Authorization: "Bearer x" }))).toMatchObject({ ok: false, status: 503, code: "secret_missing" });
  });

  it("supports bearer in a custom header and an opt-in query token", () => {
    const auth = normalizeAuth("demo", { type: "bearer", secret_env: "SECRET", header: "X-Api-Key", allow_query_token: true });
    expect(verifyRequest(auth, secrets, request({ "X-Api-Key": "s3cret-value" })).ok).toBe(true);
    expect(verifyRequest(auth, secrets, request({}, { query: new URLSearchParams("token=s3cret-value") })).ok).toBe(true);
    const noQuery = normalizeAuth("demo", { type: "bearer", secret_env: "SECRET" });
    expect(verifyRequest(noQuery, secrets, request({}, { query: new URLSearchParams("token=s3cret-value") })).ok).toBe(false);
  });

  it("verifies basic auth", () => {
    const { normalized, headers } = roundTrip({ type: "basic" });
    expect(verifyRequest(normalized, secrets, request(headers)).ok).toBe(true);
    expect(verifyRequest(normalized, secrets, request({ Authorization: `Basic ${Buffer.from("wrong").toString("base64")}` })).ok).toBe(false);
  });

  it("verifies GitHub-style HMAC with prefix and returns the delivery id", () => {
    const auth = normalizeAuth("demo", { type: "github", secret_env: "SECRET" });
    const sig = `sha256=${createHmac("sha256", "s3cret-value").update(body).digest("hex")}`;
    const ok = verifyRequest(auth, secrets, request({ "X-Hub-Signature-256": sig, "X-GitHub-Delivery": "d-123" }));
    expect(ok).toEqual({ ok: true, deliveryId: "d-123" });
    const tampered = verifyRequest(auth, secrets, request({ "X-Hub-Signature-256": sig }, { rawBody: Buffer.from("{}") }));
    expect(tampered).toMatchObject({ ok: false, code: "invalid_signature" });
  });

  it("verifies Sentry and Linear presets (plain hex digest)", () => {
    for (const [type, header] of [
      ["sentry", "Sentry-Hook-Signature"],
      ["linear", "Linear-Signature"],
    ] as const) {
      const auth = normalizeAuth("demo", { type, secret_env: "SECRET" });
      const sig = createHmac("sha256", "s3cret-value").update(body).digest("hex");
      expect(verifyRequest(auth, secrets, request({ [header]: sig })).ok).toBe(true);
      expect(verifyRequest(auth, secrets, request({ [header]: "00" })).ok).toBe(false);
    }
  });

  it("verifies generic HMAC with timestamp binding and base64 encoding", () => {
    const auth = normalizeAuth("demo", { type: "hmac", secret_env: "SECRET", header: "X-Sig", encoding: "base64", timestamp_header: "X-Ts", tolerance_seconds: 60 });
    const now = 1_760_000_000;
    const headers = signRequest(auth, "s3cret-value", body, { nowSeconds: now });
    expect(headers["x-ts"]).toBe(String(now));
    expect(verifyRequest(auth, secrets, request(headers, { nowSeconds: now + 10 })).ok).toBe(true);
    expect(verifyRequest(auth, secrets, request(headers, { nowSeconds: now + 120 }))).toMatchObject({ ok: false, code: "stale_timestamp" });
  });

  it("verifies Standard Webhooks (Granola/Svix) signatures with whsec_ secrets", () => {
    const auth = normalizeAuth("demo", { type: "granola", secret_env: "WHSEC" });
    expect(auth).toMatchObject({ type: "standard-webhooks", preset: "granola" });
    const now = 1_760_000_000;
    const key = standardWebhooksKey(secrets.WHSEC);
    expect(key.toString()).toBe("raw-key-bytes");
    const sig = createHmac("sha256", key).update(`evt_1.${now}.${body.toString()}`).digest("base64");
    const headers = { "webhook-id": "evt_1", "webhook-timestamp": String(now), "webhook-signature": `v1,AAAA v1,${sig}` };
    expect(verifyRequest(auth, secrets, request(headers, { nowSeconds: now + 5 }))).toEqual({ ok: true, deliveryId: "evt_1" });
    expect(verifyRequest(auth, secrets, request(headers, { nowSeconds: now + 3600 }))).toMatchObject({ ok: false, code: "stale_timestamp" });
    expect(verifyRequest(auth, secrets, request({ ...headers, "webhook-signature": "v1,bogus" }, { nowSeconds: now }))).toMatchObject({ ok: false, code: "invalid_signature" });
    const signed = signRequest(auth, secrets.WHSEC, body, { nowSeconds: now, deliveryId: "evt_2" });
    expect(verifyRequest(auth, secrets, request(signed, { nowSeconds: now })).ok).toBe(true);
    const svix = verifyRequest(auth, secrets, request({ "svix-id": "evt_1", "svix-timestamp": String(now), "svix-signature": `v1,${sig}` }, { nowSeconds: now }));
    expect(svix.ok).toBe(true);
  });

  it("verifies Stripe signatures", () => {
    const auth = normalizeAuth("demo", { type: "stripe", secret_env: "SECRET" });
    const now = 1_760_000_000;
    const headers = signRequest(auth, "s3cret-value", body, { nowSeconds: now });
    expect(headers["stripe-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyRequest(auth, secrets, request(headers, { nowSeconds: now + 1 })).ok).toBe(true);
    expect(verifyRequest(auth, secrets, request(headers, { nowSeconds: now + 1000 })).ok).toBe(false);
  });

  it("verifies Slack signatures", () => {
    const auth = normalizeAuth("demo", { type: "slack", secret_env: "SECRET" });
    const now = 1_760_000_000;
    const headers = signRequest(auth, "s3cret-value", body, { nowSeconds: now });
    expect(headers["x-slack-signature"]).toMatch(/^v0=[0-9a-f]{64}$/);
    expect(verifyRequest(auth, secrets, request(headers, { nowSeconds: now })).ok).toBe(true);
    expect(verifyRequest(auth, secrets, request({ ...headers, "x-slack-signature": "v0=00" }, { nowSeconds: now })).ok).toBe(false);
  });

  it("enforces allow_ips before anything else, including for auth none", () => {
    const auth = normalizeAuth("demo", { type: "none", allow_ips: ["10.0.0.0/8", "100.64.1.2"] });
    expect(verifyRequest(auth, secrets, request({}, { ip: "10.1.2.3" })).ok).toBe(true);
    expect(verifyRequest(auth, secrets, request({}, { ip: "::ffff:100.64.1.2" })).ok).toBe(true);
    expect(verifyRequest(auth, secrets, request({}, { ip: "203.0.113.9" }))).toMatchObject({ ok: false, status: 403 });
  });
});

describe("ipMatches", () => {
  it("handles exact, CIDR, localhost and mapped addresses", () => {
    expect(ipMatches("127.0.0.1", ["localhost"])).toBe(true);
    expect(ipMatches("::1", ["127.0.0.1"])).toBe(true);
    expect(ipMatches("192.168.1.77", ["192.168.0.0/16"])).toBe(true);
    expect(ipMatches("192.169.1.77", ["192.168.0.0/16"])).toBe(false);
    expect(ipMatches("fd7a:115c::1", ["fd7a:115c::1"])).toBe(true);
  });
});
