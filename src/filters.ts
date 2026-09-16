import type { Condition } from "./skills.js";
import { getPath } from "./util.js";

export interface FilterInput {
  payload: unknown;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  query: Record<string, string>;
}

export type FilterOutcome = { ok: true } | { ok: false; condition: Condition; actual: unknown; reason: string };

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}

function subject(condition: Condition, input: FilterInput): unknown {
  if (condition.path !== undefined) return getPath(input.payload, condition.path);
  if (condition.header !== undefined) return input.headers[condition.header.toLowerCase()];
  if (condition.query !== undefined) return input.query[condition.query];
  return undefined;
}

export function evaluateCondition(condition: Condition, input: FilterInput): FilterOutcome {
  const actual = subject(condition, input);
  const failWith = (reason: string): FilterOutcome => ({ ok: false, condition, actual, reason });
  const hasOperator = ["equals", "not_equals", "in", "matches", "exists", "contains"].some((k) => (condition as Record<string, unknown>)[k] !== undefined);
  if (!hasOperator || condition.exists !== undefined) {
    const wantExists = condition.exists ?? true;
    const exists = actual !== undefined && actual !== null;
    if (exists !== wantExists) return failWith(wantExists ? "value is missing" : "value is present");
  }
  if (condition.equals !== undefined && !looseEquals(actual, condition.equals)) return failWith(`expected ${JSON.stringify(condition.equals)}`);
  if (condition.not_equals !== undefined && looseEquals(actual, condition.not_equals)) return failWith(`must not equal ${JSON.stringify(condition.not_equals)}`);
  if (condition.in !== undefined && !condition.in.some((v) => looseEquals(actual, v))) return failWith(`expected one of ${JSON.stringify(condition.in)}`);
  if (condition.matches !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(condition.matches);
    } catch {
      return failWith(`invalid regular expression ${JSON.stringify(condition.matches)}`);
    }
    if (actual === undefined || actual === null || !re.test(typeof actual === "string" ? actual : JSON.stringify(actual))) return failWith(`expected to match /${condition.matches}/`);
  }
  if (condition.contains !== undefined) {
    const needle = condition.contains;
    const holds = Array.isArray(actual) ? actual.some((v) => looseEquals(v, needle)) : typeof actual === "string" ? actual.includes(needle) : false;
    if (!holds) return failWith(`expected to contain ${JSON.stringify(needle)}`);
  }
  return { ok: true };
}

export function evaluateConditions(conditions: Condition[] | undefined, input: FilterInput): FilterOutcome {
  for (const condition of conditions ?? []) {
    const outcome = evaluateCondition(condition, input);
    if (!outcome.ok) return outcome;
  }
  return { ok: true };
}

export function describeCondition(condition: Condition): string {
  const where = condition.path !== undefined ? `payload.${condition.path}` : condition.header !== undefined ? `header ${condition.header}` : `query ${condition.query}`;
  const ops = Object.entries(condition)
    .filter(([k]) => !["path", "header", "query"].includes(k))
    .map(([k, v]) => `${k} ${JSON.stringify(v)}`);
  return `${where} ${ops.join(", ") || "exists"}`;
}
