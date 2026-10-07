import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildResponse, DEFAULT_RESPONSE_SCHEMA, deriveOutcome, jobOutcome, parseResponseObject, readResponseFile, resolveJobResponse, responseSchemaFor } from "./response.js";
import { parseSkillDocument } from "./skills.js";
import { tempHome } from "./test-support/helpers.js";

describe("parseResponseObject", () => {
  it("reads the standard shape, caps the summary and links, and keeps data", () => {
    const response = parseResponseObject({ outcome: "needs_human", summary: "Ask Ada", links: ["https://x", 5, "https://y"], data: { n: 1 } }, { ok: true });
    expect(response).toEqual({ outcome: "needs_human", summary: "Ask Ada", links: ["https://x", "https://y"], data: { n: 1 } });
    const long = parseResponseObject({ outcome: "completed", summary: "s".repeat(5000) }, { ok: true });
    expect(long?.summary.length).toBeLessThanOrEqual(4000);
    expect(parseResponseObject({ outcome: "completed", summary: "x", links: [] }, { ok: true })).toEqual({ outcome: "completed", summary: "x" });
    const big = parseResponseObject({ outcome: "completed", summary: "s", data: { blob: "x".repeat(70_000) } }, { ok: true });
    expect(big?.data).toMatchObject({ truncated: true });
  });

  it("reads a title, a headline, typed links and choices", () => {
    const response = parseResponseObject(
      {
        outcome: "needs_human",
        title: "  Fix the sync 500\n",
        headline: "PR #7 is ready; merge it?",
        summary: "**Found** the null org.",
        links: [{ url: "https://sentry.io/issues/1/", title: "SYNC-500", kind: "source" }, "https://github.com/acme/api/pull/7", { url: "https://x.test", kind: "tweet" }, { title: "no url" }],
        options: ["Merge", "Close", "Merge"],
        recommended: "Merge",
        multiple: false,
      },
      { ok: true },
    );
    expect(response).toEqual({ outcome: "needs_human", title: "Fix the sync 500", headline: "PR #7 is ready; merge it?", summary: "**Found** the null org.", links: [{ url: "https://sentry.io/issues/1/", title: "SYNC-500", kind: "source" }, "https://github.com/acme/api/pull/7", "https://x.test"], options: ["Merge", "Close"], recommended: "Merge" });
    // A custom schema's own fields are data, never a title or links.
    expect(parseResponseObject({ title: "Ticket title", links: ["https://x.test"] }, { ok: true, result: "done" })).toEqual({ outcome: "completed", summary: "done", data: { title: "Ticket title", links: ["https://x.test"] } });
  });

  it("builds what job_set_outcome writes, keeping data whole", () => {
    const blob = "x".repeat(70_000);
    const response = buildResponse({ outcome: "completed", summary: "s", headline: "  done  ", links: ["https://a.test", "https://a.test"], options: [], data: { blob } });
    expect(response).toEqual({ outcome: "completed", headline: "done", summary: "s", links: ["https://a.test"], data: { blob } });
  });

  it("falls back to how the run ended for unknown outcomes and custom shapes", () => {
    expect(parseResponseObject({ outcome: "sideways", summary: "?" }, { ok: true })).toMatchObject({ outcome: "completed", summary: "?" });
    expect(parseResponseObject({ outcome: "sideways" }, { ok: false, result: "boom" })).toEqual({ outcome: "failed", summary: "boom" });
    expect(parseResponseObject({ ticket: "T-1", severity: "high" }, { ok: true, result: "done" })).toEqual({ outcome: "completed", summary: "done", data: { ticket: "T-1", severity: "high" } });
    expect(parseResponseObject("nope", { ok: true })).toBeUndefined();
    expect(parseResponseObject(["a"], { ok: true })).toBeUndefined();
    expect(parseResponseObject(null, { ok: true })).toBeUndefined();
  });
});

describe("response files and outcomes", () => {
  it("reads response.json from the job directory; a structured answer wins over the file", () => {
    const paths = tempHome();
    const dir = path.join(paths.jobsDir, "20260928T100000Z-abcdef");
    mkdirSync(dir, { recursive: true });
    expect(readResponseFile(dir)).toBeUndefined();
    writeFileSync(path.join(dir, "response.json"), JSON.stringify({ outcome: "partial", summary: "half" }));
    expect(readResponseFile(dir)).toEqual({ outcome: "partial", summary: "half" });
    expect(resolveJobResponse({ jobDir: dir, ok: true, result: "r" })).toEqual({ outcome: "partial", summary: "half" });
    expect(resolveJobResponse({ jobDir: dir, structured: { outcome: "completed", summary: "done" }, ok: true })).toEqual({ outcome: "completed", summary: "done" });
    writeFileSync(path.join(dir, "response.json"), "{ not json");
    expect(readResponseFile(dir)).toBeUndefined();
    expect(resolveJobResponse({ jobDir: dir, ok: true })).toBeUndefined();
  });

  it("derives the outcome from status, runner and what was reported", () => {
    expect(deriveOutcome("queued", "claude")).toBeUndefined();
    expect(deriveOutcome("running", "claude")).toBeUndefined();
    expect(deriveOutcome("failed", "claude", { outcome: "completed", summary: "" })).toBe("failed");
    expect(deriveOutcome("timed_out", "shell")).toBe("failed");
    expect(deriveOutcome("interrupted", "codex")).toBe("failed");
    expect(deriveOutcome("succeeded", "shell")).toBe("completed");
    expect(deriveOutcome("succeeded", "claude")).toBe("unknown");
    expect(deriveOutcome("succeeded", "codex", { outcome: "nothing_to_do", summary: "" })).toBe("nothing_to_do");
    expect(jobOutcome({ status: "succeeded", runner: "claude" })).toBe("unknown");
    expect(jobOutcome({ status: "succeeded", runner: "claude", outcome: "partial" })).toBe("partial");
    expect(jobOutcome({ status: "succeeded", runner: "claude", response: { outcome: "needs_human", summary: "" } })).toBe("needs_human");
    expect(jobOutcome({ status: "cancelled", runner: "codex" })).toBe("failed");
    expect(jobOutcome({ status: "running", runner: "codex" })).toBeUndefined();
  });

  it("uses the skill's own schema when it has one", () => {
    const plain = parseSkillDocument("---\nname: d\ndescription: d\nskillhook:\n  response:\n    mode: structured\n---\nb", "/tmp/d");
    expect(responseSchemaFor(plain)).toBe(DEFAULT_RESPONSE_SCHEMA);
    expect((DEFAULT_RESPONSE_SCHEMA.required as string[]).sort()).toEqual(["outcome", "summary"]);
    expect(Object.keys(DEFAULT_RESPONSE_SCHEMA.properties as object)).toEqual(["outcome", "title", "headline", "summary", "links", "options", "recommended", "multiple", "data"]);
    const custom = parseSkillDocument("---\nname: d\ndescription: d\nskillhook:\n  response:\n    mode: structured\n    schema:\n      type: object\n      properties:\n        ticket: { type: string }\n---\nb", "/tmp/d");
    expect(responseSchemaFor(custom)).toEqual({ type: "object", properties: { ticket: { type: "string" } } });
  });
});
