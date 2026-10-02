import { describe, expect, it } from "vitest";
import { getPath, printable, slugify, trimTrailing, truncate } from "./util.js";

describe("util", () => {
  it("trims trailing characters in linear time", () => {
    expect(trimTrailing("a///", "/")).toBe("a");
    expect(trimTrailing("a", "/")).toBe("a");
    expect(trimTrailing("", "/")).toBe("");
    expect(trimTrailing("///", "/")).toBe("");
    expect(trimTrailing("a\n\nb\n", "\n")).toBe("a\n\nb");
    const started = Date.now();
    expect(trimTrailing(`x${"/".repeat(1_000_000)}`, "/")).toBe("x");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reads dotted paths, truncates and slugifies", () => {
    expect(getPath({ a: { b: [1, { c: "d" }] } }, "a.b.1.c")).toBe("d");
    expect(getPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(getPath({ a: 1 }, "")).toEqual({ a: 1 });
    expect(truncate("abcdef", 5, "…")).toBe("abcd…");
    expect(slugify("Hello, World!!")).toBe("hello-world");
  });

  it("keeps text a terminal shows as text: no control characters, no bidirectional overrides", () => {
    expect(printable("line 1\n\tline 2 · déjà vu · 日本 · 🙂 · مرحبا")).toBe("line 1\n\tline 2 · déjà vu · 日本 · 🙂 · مرحبا");
    expect(printable("a\u001b[31mb\u0007c\rd\u007fe")).toBe("a[31mbcde");
    expect(printable("x\u009b2Jy\u0085z")).toBe("x2Jyz"); // C1: CSI and NEL
    expect(printable("pay \u202eusd 01\u202c · \u2066iso\u2069 · \u202ab\u202bc\u202dd")).toBe("pay usd 01 · iso · bcd");
  });
});
