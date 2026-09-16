import { describe, expect, it } from "vitest";
import { evaluateConditions } from "./filters.js";

const input = {
  payload: { action: "created", data: { issue: { level: "error", tags: ["a", "b"], count: "3" } } },
  headers: { "x-github-event": "issues", "sentry-hook-resource": "issue" },
  query: { env: "prod" },
};

describe("evaluateConditions", () => {
  it("matches equals/in/matches/exists/contains/header/query", () => {
    expect(evaluateConditions([{ path: "action", equals: "created" }], input).ok).toBe(true);
    expect(evaluateConditions([{ path: "data.issue.level", in: ["error", "fatal"] }], input).ok).toBe(true);
    expect(evaluateConditions([{ path: "data.issue.count", equals: 3 }], input).ok).toBe(true);
    expect(evaluateConditions([{ path: "data.issue.tags", contains: "b" }], input).ok).toBe(true);
    expect(evaluateConditions([{ path: "action", matches: "^cre" }], input).ok).toBe(true);
    expect(evaluateConditions([{ path: "data.issue" }], input).ok).toBe(true);
    expect(evaluateConditions([{ path: "data.nope", exists: false }], input).ok).toBe(true);
    expect(evaluateConditions([{ header: "Sentry-Hook-Resource", equals: "issue" }], input).ok).toBe(true);
    expect(evaluateConditions([{ query: "env", equals: "prod" }], input).ok).toBe(true);
  });

  it("reports the failing condition", () => {
    const outcome = evaluateConditions([{ path: "action", equals: "created" }, { path: "data.issue.level", not_equals: "error" }], input);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.condition.path).toBe("data.issue.level");
    expect(evaluateConditions([{ path: "missing" }], input).ok).toBe(false);
    expect(evaluateConditions([{ path: "action", matches: "(" }], input).ok).toBe(false);
  });

  it("passes with no conditions", () => {
    expect(evaluateConditions(undefined, input).ok).toBe(true);
    expect(evaluateConditions([], input).ok).toBe(true);
  });
});
