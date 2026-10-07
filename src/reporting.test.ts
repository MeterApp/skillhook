import { describe, expect, it } from "vitest";
import { cleanLine, formatChoices, formatLink, HEADLINE_MAX, LINKS_MAX, normalizeChoices, normalizeLink, normalizeLinks, OPTIONS_MAX, parseLinkArg, pickedOptions } from "./reporting.js";

describe("titles and headlines", () => {
  it("keeps one trimmed line, capped", () => {
    expect(cleanLine("  Fix the sync 500 \n on /api/sync\r\n\n", 200)).toBe("Fix the sync 500 on /api/sync");
    expect(cleanLine(" \n\t ", 200)).toBeUndefined();
    expect(cleanLine(42, 200)).toBeUndefined();
    const long = cleanLine("x".repeat(500), HEADLINE_MAX);
    expect(long).toHaveLength(HEADLINE_MAX);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("stays linear on long runs of whitespace", () => {
    const started = Date.now();
    expect(cleanLine(`${" ".repeat(200_000)}\n${"\t".repeat(200_000)}x`, 200)).toBe("x");
    expect(cleanLine(" ".repeat(400_000), 200)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("links", () => {
  it("keeps bare URLs as they were and gives titled links an object", () => {
    expect(normalizeLink(" https://github.com/acme/api/pull/7 ")).toBe("https://github.com/acme/api/pull/7");
    expect(normalizeLink({ url: "https://github.com/acme/api/pull/7" })).toBe("https://github.com/acme/api/pull/7");
    expect(normalizeLink({ url: "https://github.com/acme/api/pull/7", title: " Fix the\nsync 500 ", kind: "pull_request" })).toEqual({ url: "https://github.com/acme/api/pull/7", title: "Fix the sync 500", kind: "pull_request" });
    // An unknown kind is dropped (the dashboard guesses one from the URL); no URL, no link.
    expect(normalizeLink({ url: "https://x.test", kind: "tweet" })).toBe("https://x.test");
    expect(normalizeLink({ title: "nowhere" })).toBeUndefined();
    expect(normalizeLink({ url: "" })).toBeUndefined();
    expect(normalizeLink(`https://x.test/${"a".repeat(3000)}`)).toBeUndefined();
    expect(normalizeLink(7)).toBeUndefined();
    expect(normalizeLink(["https://x.test"])).toBeUndefined();
  });

  it("keeps the first of each URL, at most LINKS_MAX", () => {
    expect(normalizeLinks(["https://a.test", { url: "https://a.test", title: "again" }, 5, { url: "https://b.test", kind: "source" }])).toEqual(["https://a.test", { url: "https://b.test", kind: "source" }]);
    expect(normalizeLinks([])).toBeUndefined();
    expect(normalizeLinks("https://a.test")).toBeUndefined();
    expect(normalizeLinks(Array.from({ length: 80 }, (_, i) => `https://x.test/${i}`))).toHaveLength(LINKS_MAX);
  });

  it("reads --link as a URL or [title](URL), optionally after a kind", () => {
    expect(parseLinkArg("https://github.com/acme/api/pull/7")).toBe("https://github.com/acme/api/pull/7");
    expect(parseLinkArg("pull_request:https://github.com/acme/api/pull/7")).toEqual({ url: "https://github.com/acme/api/pull/7", kind: "pull_request" });
    expect(parseLinkArg("[Fix the sync 500](https://github.com/acme/api/pull/7)")).toEqual({ url: "https://github.com/acme/api/pull/7", title: "Fix the sync 500" });
    expect(parseLinkArg("source:[Weekly sync [notes]](https://notes.granola.ai/d/abc)")).toEqual({ url: "https://notes.granola.ai/d/abc", title: "Weekly sync [notes]", kind: "source" });
    // Schemes are not kinds; an unknown prefix stays part of the URL.
    expect(parseLinkArg("mailto:ada@example.com")).toBe("mailto:ada@example.com");
    expect(parseLinkArg("tweet:https://x.test")).toBe("tweet:https://x.test");
    expect(parseLinkArg("test:")).toBeUndefined();
    expect(parseLinkArg("  ")).toBeUndefined();
  });

  it("prints a link on one line", () => {
    expect(formatLink("https://a.test")).toBe("https://a.test");
    expect(formatLink({ url: "https://a.test", title: "A", kind: "deploy" })).toBe("A <https://a.test> (deploy)");
    expect(formatLink({ url: "https://a.test", kind: "log" })).toBe("https://a.test (log)");
  });
});

describe("choices", () => {
  it("keeps unique labels, a recommendation that is one of them, and multiple only with two or more", () => {
    expect(normalizeChoices({})).toEqual({});
    expect(normalizeChoices({ options: [], recommended: "A", multiple: true })).toEqual({});
    expect(normalizeChoices({ options: [" Merge ", "Merge", "Close", "", 3], recommended: "Close", multiple: true })).toEqual({ options: ["Merge", "Close", "3"], recommended: "Close", multiple: true });
    expect(normalizeChoices({ options: ["Merge", "Close"], recommended: "Rebase" })).toEqual({ options: ["Merge", "Close"] });
    expect(normalizeChoices({ options: ["Only"], multiple: true })).toEqual({ options: ["Only"] });
    expect(normalizeChoices({ options: Array.from({ length: 30 }, (_, i) => `o${i}`) }).options).toHaveLength(OPTIONS_MAX);
    expect(formatChoices({ options: ["Merge", "Close"], recommended: "Merge", multiple: true })).toBe(" [Merge* | Close] (pick several)");
    expect(formatChoices({})).toBe("");
  });

  it("reads the picks of a multiple-choice answer from its lines", () => {
    expect(pickedOptions("Close #51\nMerge #48\n  Close #51  \nand ping Ada", ["Merge #48", "Close #51", "Wait"])).toEqual(["Close #51", "Merge #48"]);
    expect(pickedOptions("none of these", ["A", "B"])).toEqual([]);
  });
});
