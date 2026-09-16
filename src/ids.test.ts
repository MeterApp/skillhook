import { describe, expect, it } from "vitest";
import { generateSecret, isJobId, newJobId, randomToken } from "./ids.js";

describe("ids", () => {
  it("draws tokens from the alphabet without bias", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const token = randomToken(6);
      expect(token).toMatch(/^[0-9a-z]{6}$/);
      seen.add(token);
    }
    expect(seen.size).toBeGreaterThan(490);
    expect(randomToken(0)).toBe("");
    expect(randomToken(40)).toHaveLength(40);
  });

  it("builds sortable job ids and url-safe secrets", () => {
    const id = newJobId(new Date("2026-09-16T14:03:24.123Z"));
    expect(id).toMatch(/^20260916T140324Z-[0-9a-z]{6}$/);
    expect(isJobId(id)).toBe(true);
    expect(isJobId("../etc")).toBe(false);
    expect(generateSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSecret(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
