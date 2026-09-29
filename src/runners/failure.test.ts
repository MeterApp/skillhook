import { describe, expect, it } from "vitest";
import { classifyFailure, FAILURE_KINDS, FallbackSchema, RetrySchema } from "./failure.js";

describe("classifyFailure", () => {
  it("recognises the failures the CLIs print", () => {
    // Claude Code reports an auth failure as an is_error result with subtype "success".
    expect(classifyFailure({ status: "failed", error: "Failed to authenticate: OAuth session expired and could not be refreshed", exitCode: 1, signal: null, resultEvent: { subtype: "success", is_error: true } })).toEqual({ kind: "auth", retryable: false, message: "Failed to authenticate: OAuth session expired and could not be refreshed" });
    expect(classifyFailure({ status: "failed", error: "Not logged in. Run `codex login` to authenticate.", exitCode: 1, signal: null })).toMatchObject({ kind: "auth", retryable: false });
    expect(classifyFailure({ status: "failed", error: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage or try again at Sep 19th.", exitCode: 1, signal: null })).toMatchObject({ kind: "usage_limit", retryable: false });
    expect(classifyFailure({ status: "failed", error: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}', exitCode: 1, signal: null, resultEvent: { subtype: "error_during_execution" } })).toEqual({ kind: "rate_limit", code: "error_during_execution", retryable: true, message: expect.stringContaining("429") });
    expect(classifyFailure({ status: "failed", error: "Rate limit reached for gpt-5-codex (429). Try again in 20s.", exitCode: 1, signal: null })).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(classifyFailure({ status: "failed", error: "Reached max turns (1)", exitCode: 1, signal: null, resultEvent: { subtype: "error_max_turns" } })).toEqual({ kind: "max_turns", code: "error_max_turns", retryable: false, message: "Reached max turns (1)" });
    expect(classifyFailure({ status: "failed", error: "Reached max budget ($0.01)", exitCode: 1, signal: null, resultEvent: { subtype: "error_max_budget_usd" } })).toMatchObject({ kind: "budget", code: "error_max_budget_usd" });
    expect(classifyFailure({ status: "failed", error: "failed to start claude: spawn claude ENOENT", exitCode: null, signal: null, spawnFailed: true })).toMatchObject({ kind: "not_found", retryable: false });
    expect(classifyFailure({ status: "failed", error: "spawn codex ENOENT", exitCode: null, signal: null })).toMatchObject({ kind: "not_found" });
    expect(classifyFailure({ status: "timed_out", error: "timed out after 900s", exitCode: null, signal: "SIGTERM" })).toEqual({ kind: "timeout", retryable: false, message: "timed out after 900s" });
    expect(classifyFailure({ status: "failed", error: "command exited with code 137 (SIGKILL)", exitCode: null, signal: "SIGKILL" })).toMatchObject({ kind: "crash", retryable: true });
    expect(classifyFailure({ status: "failed", error: "boom\nreal error here", exitCode: 2, signal: null })).toEqual({ kind: "crash", retryable: true, message: "boom" });
    expect(classifyFailure({ status: "failed", exitCode: 0, signal: null })).toEqual({ kind: "unknown", retryable: false });
    // An error the runner reported itself is not a crash, even with a non-zero exit.
    expect(classifyFailure({ status: "failed", error: "simulated failure", exitCode: 1, signal: null, resultEvent: { subtype: "error", is_error: true }, reported: true })).toEqual({ kind: "unknown", code: "error", retryable: false, message: "simulated failure" });
    // The last stderr lines count when the error text says nothing.
    expect(classifyFailure({ status: "failed", error: "claude exited with code 1", exitCode: 1, signal: null, stderr: "Error: Invalid API key · Please run /login" })).toMatchObject({ kind: "auth" });
    expect(FAILURE_KINDS).toHaveLength(9);
  });

  it("validates fallback and retry policies", () => {
    expect(FallbackSchema.parse({ runners: ["codex"] })).toEqual({ runners: ["codex"] });
    expect(FallbackSchema.parse({ runners: ["codex", "shell"], on: ["not_ready", "rate_limit"] })).toMatchObject({ on: ["not_ready", "rate_limit"] });
    expect(FallbackSchema.safeParse({ runners: [] }).success).toBe(false);
    expect(FallbackSchema.safeParse({ runners: ["gemini"] }).success).toBe(false);
    expect(FallbackSchema.safeParse({ runners: ["codex"], on: ["timeout"] }).success).toBe(false);
    expect(RetrySchema.parse({ attempts: 2 })).toEqual({ attempts: 2 });
    expect(RetrySchema.parse({ attempts: 1, on: ["rate_limit"], backoff_seconds: 0 })).toEqual({ attempts: 1, on: ["rate_limit"], backoff_seconds: 0 });
    expect(RetrySchema.safeParse({ attempts: 4 }).success).toBe(false);
    expect(RetrySchema.safeParse({ attempts: 1, on: ["nope"] }).success).toBe(false);
  });
});
