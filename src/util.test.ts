import { describe, expect, it } from "vitest";
import { getPath, slugify, trimTrailing, truncate } from "./util.js";

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
});
