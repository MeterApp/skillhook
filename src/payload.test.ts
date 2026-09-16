import { describe, expect, it } from "vitest";
import { parseBody, redactHeaders } from "./payload.js";

describe("parseBody", () => {
  it("parses JSON, forms, GitHub form payloads, text and binary", () => {
    expect(parseBody("application/json", Buffer.from('{"a":1}'))).toEqual({ payload: { a: 1 }, kind: "json" });
    expect(parseBody("application/vnd.api+json; charset=utf-8", Buffer.from("[1]"))).toEqual({ payload: [1], kind: "json" });
    expect(parseBody(undefined, Buffer.from(' {"guess":true}'))).toEqual({ payload: { guess: true }, kind: "json" });
    expect(parseBody("application/x-www-form-urlencoded", Buffer.from("a=1&a=2&b=x"))).toEqual({ payload: { a: ["1", "2"], b: "x" }, kind: "form" });
    expect(parseBody("application/x-www-form-urlencoded", Buffer.from(`payload=${encodeURIComponent('{"gh":1}')}`))).toEqual({ payload: { gh: 1 }, kind: "json" });
    expect(parseBody("text/plain", Buffer.from("hello"))).toEqual({ payload: "hello", kind: "text" });
    expect(parseBody("application/json", Buffer.from("not json"))).toEqual({ payload: "not json", kind: "text" });
    expect(parseBody("application/json", Buffer.alloc(0))).toEqual({ payload: null, kind: "empty" });
    const binary = parseBody("application/octet-stream", Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    expect(binary.kind).toBe("binary");
  });
});

describe("redactHeaders", () => {
  it("drops credentials and signatures but keeps routing headers", () => {
    const out = redactHeaders({ authorization: "Bearer x", cookie: "c", "x-hub-signature-256": "sha256=…", "webhook-signature": "v1,…", "x-api-key": "k", "content-type": "application/json", "x-github-event": "push", "webhook-id": "evt_1" });
    expect(out).toEqual({ "content-type": "application/json", "x-github-event": "push", "webhook-id": "evt_1" });
  });
});

describe("delivery fingerprints", () => {
  it("canonicalizes JSON so key order and whitespace do not matter", async () => {
    const { canonicalJson, deliveryFingerprint } = await import("./payload.js");
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson(undefined)).toBe("null");
    const one = deliveryFingerprint({ kind: "json", payload: { b: 1, a: 2 } });
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(deliveryFingerprint({ kind: "json", payload: { a: 2, b: 1 } })).toBe(one);
    expect(deliveryFingerprint({ kind: "json", payload: { a: 2, b: 2 } })).not.toBe(one);
    expect(deliveryFingerprint({ kind: "json", payload: { b: 1, a: 2 }, query: { x: "1" } })).not.toBe(one);
    expect(deliveryFingerprint({ kind: "text", payload: '{"b":1,"a":2}' })).not.toBe(one);
    const bin = Buffer.from([1, 2, 3]);
    expect(deliveryFingerprint({ kind: "binary", payload: { binary: true, bytes: 3 }, rawBody: bin })).not.toBe(deliveryFingerprint({ kind: "binary", payload: { binary: true, bytes: 3 }, rawBody: Buffer.from([3, 2, 1]) }));
  });
});
