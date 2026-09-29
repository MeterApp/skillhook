// Why a run failed, in one word: text heuristics over what the CLIs print, pinned by their captured real lines in the
// tests. The kind never changes a job's `status`; it tells operators (and the fallback/retry policy) whether the failure
// was the account (auth, usage_limit, budget), the moment (rate_limit, crash) or the run itself (max_turns, timeout).
import { z } from "zod";

export type FailureKind = "auth" | "usage_limit" | "rate_limit" | "budget" | "max_turns" | "not_found" | "timeout" | "crash" | "unknown";
export const FAILURE_KINDS: FailureKind[] = ["auth", "usage_limit", "rate_limit", "budget", "max_turns", "not_found", "timeout", "crash", "unknown"];
export const FailureKindSchema = z.enum(FAILURE_KINDS as [FailureKind, ...FailureKind[]]);

export interface JobFailure {
  kind: FailureKind;
  /** The runner's own code when it has one (Claude's result `subtype`). */
  code?: string;
  /** Whether trying again soon could succeed (a rate limit, a crash); an account problem is not. */
  retryable: boolean;
  /** The first line of the error, for people. */
  message?: string;
}

/** When a `fallback:` runner takes over: before the run (`not_ready`) or after a run failed that way before the agent produced anything. */
export type FallbackTrigger = "not_ready" | "auth" | "usage_limit" | "rate_limit" | "crash";
export const FALLBACK_TRIGGERS: FallbackTrigger[] = ["not_ready", "auth", "usage_limit", "rate_limit", "crash"];
export const FallbackSchema = z
  .object({
    /** Runners to use instead, in order of preference; `shell` only for a skill that has a `shell.command`. */
    runners: z.array(z.enum(["claude", "codex", "shell"])).min(1),
    /** When to fall back. Default `[not_ready]`: only before the run, when the runner is not installed or not logged in. The others re-run a failed job on the next runner and are safe only for idempotent skills. */
    on: z.array(z.enum(FALLBACK_TRIGGERS as [FallbackTrigger, ...FallbackTrigger[]])).optional(),
  })
  .strict();
export type FallbackConfig = z.infer<typeof FallbackSchema>;

export const RetrySchema = z
  .object({
    /** How many more times to run on the same runner (1–3). */
    attempts: z.number().int().min(1).max(3),
    /** Failure kinds worth a retry. Default `[rate_limit, crash]`. */
    on: z.array(FailureKindSchema).optional(),
    /** Seconds to wait before the next attempt. Default 30. */
    backoff_seconds: z.number().int().min(0).optional(),
  })
  .strict();
export type RetryConfig = z.infer<typeof RetrySchema>;

const RETRYABLE: FailureKind[] = ["rate_limit", "crash"];

const PATTERNS: { kind: FailureKind; needles: string[] }[] = [
  { kind: "rate_limit", needles: ["rate limit", "rate_limit", "too many requests", "overloaded", " 429", "429 "] },
  { kind: "usage_limit", needles: ["usage limit", "usage_limit", "hit your limit", "out of extra usage", "quota", "insufficient_quota", "limit will reset"] },
  { kind: "auth", needles: ["failed to authenticate", "not logged in", "please run /login", "claude login", "codex login", "oauth", "invalid api key", "invalid x-api-key", "authentication", "unauthorized", "unauthenticated", " 401", "401 ", "credentials", "login required", "please log in"] },
  { kind: "budget", needles: ["max_budget", "max budget", "budget"] },
  { kind: "max_turns", needles: ["max_turns", "max turns", "maximum turns", "maximum number of turns"] },
  { kind: "not_found", needles: ["enoent", "not found on path", "failed to start", "command not found"] },
];

const CLAUDE_SUBTYPES: Record<string, FailureKind> = { error_max_turns: "max_turns", error_max_budget_usd: "budget" };

export interface ClassifyInput {
  status: "failed" | "timed_out";
  error?: string;
  exitCode: number | null;
  signal: string | null;
  /** Claude's result event, when one was seen. */
  resultEvent?: Record<string, unknown>;
  /** The process could not be started at all. */
  spawnFailed?: boolean;
  /** The last lines of stderr, when the error text says nothing. */
  stderr?: string;
  /** The runner reported the failure itself (Claude's result event, Codex's error event) rather than just dying. */
  reported?: boolean;
}

export function classifyFailure(input: ClassifyInput): JobFailure {
  const message = (input.error ?? "").split("\n")[0]?.trim().slice(0, 300) || undefined;
  const subtype = typeof input.resultEvent?.subtype === "string" ? input.resultEvent.subtype : undefined;
  const code = subtype && subtype !== "success" ? subtype : undefined;
  const done = (kind: FailureKind): JobFailure => ({ kind, ...(code ? { code } : {}), retryable: RETRYABLE.includes(kind), ...(message ? { message } : {}) });
  if (input.status === "timed_out") return done("timeout");
  if (input.spawnFailed) return done("not_found");
  if (subtype && CLAUDE_SUBTYPES[subtype]) return done(CLAUDE_SUBTYPES[subtype]!);
  const text = `${input.error ?? ""}\n${input.stderr ?? ""}`.toLowerCase();
  for (const { kind, needles } of PATTERNS) if (needles.some((needle) => text.includes(needle))) return done(kind);
  if (input.signal || (input.exitCode !== null && input.exitCode !== 0 && !input.reported)) return done("crash");
  return done("unknown");
}
