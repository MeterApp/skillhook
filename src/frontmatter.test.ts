import { describe, expect, it } from "vitest";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";

describe("frontmatter", () => {
  it("parses and round-trips", () => {
    const fm = parseFrontmatter(`---\nname: a\nnested:\n  k: v\n---\n\n# Body\n`);
    expect(fm.present).toBe(true);
    expect(fm.data).toEqual({ name: "a", nested: { k: "v" } });
    expect(fm.body.trim()).toBe("# Body");
    const text = stringifyFrontmatter(fm.data, fm.body);
    expect(parseFrontmatter(text).data).toEqual(fm.data);
  });

  it("handles missing and broken blocks", () => {
    expect(parseFrontmatter("plain").present).toBe(false);
    expect(() => parseFrontmatter("---\nname: a\n")).toThrow(/Unterminated/);
    expect(() => parseFrontmatter("---\n- list\n---\n")).toThrow(/mapping/);
  });
});
