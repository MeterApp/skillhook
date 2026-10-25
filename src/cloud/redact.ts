// Nothing secret leaves the machine: uploads are scrubbed against private `.env` values; headers are
// redacted like `event.json`, and command lines / environments never travel at all.
import { redactHeaders } from "../payload.js";

const MIN_SECRET_LENGTH = 8;
export const REDACTED = "[redacted]";
/** Keys never uploaded, whatever object they sit in. */
const DROPPED_KEYS = new Set(["command", "env", "argv", "stdin", "resume_command"]);

/** Only explicitly public configuration names may bypass value scrubbing; credentials never may. */
export function isPublicEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    && !/^SKILLHOOK_/i.test(name)
    && !/(TOKEN|SECRET|PASSWORD|PASSWD|KEY|AUTH|COOKIE|CREDENTIAL|SIGNATURE)/i.test(name);
}

/** Private `.env` values worth scrubbing (short ones would blank ordinary words). */
export function secretValues(secrets: Record<string, string>, publicEnv: readonly string[] = []): string[] {
  const values = new Set<string>();
  const publicNames = new Set(publicEnv.filter(isPublicEnvName));
  for (const [name, value] of Object.entries(secrets)) {
    // A value shared with a private variable is still a secret.
    if (!publicNames.has(name) && typeof value === "string" && value.length >= MIN_SECRET_LENGTH) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function scrubString(text: string, values: string[]): string {
  let out = text;
  for (const value of values) {
    if (out.includes(value)) out = out.replaceAll(value, REDACTED);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value && out.includes(escaped)) out = out.replaceAll(escaped, REDACTED);
  }
  return out;
}

/** A deep copy of `value` with every secret value replaced, raw or JSON-escaped, in every string. */
export function scrubSecrets<T>(value: T, secrets: Record<string, string> | string[]): T {
  const values = Array.isArray(secrets) ? secrets : secretValues(secrets);
  if (!values.length) return value;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return scrubString(node, values);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) out[key] = walk(child);
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

/** A deep copy with command lines and environments dropped and every `headers` object redacted. */
export function redactUpload<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (DROPPED_KEYS.has(key)) continue;
        if (key === "headers" && child && typeof child === "object" && !Array.isArray(child)) {
          const headers: Record<string, string> = {};
          for (const [name, v] of Object.entries(child as Record<string, unknown>)) if (typeof v === "string") headers[name] = v;
          out[key] = redactHeaders(headers);
          continue;
        }
        out[key] = walk(child);
      }
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

/** At most `maxBytes` of UTF-8, cut on a character boundary. */
export function capText(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { text, truncated: false, bytes };
  const buffer = Buffer.from(text).subarray(0, maxBytes);
  return { text: buffer.toString("utf8").replace(/�+$/u, ""), truncated: true, bytes };
}

// ---------------------------------------------------------------------------
// Accounts: what the cloud may know about the Claude Code / Codex accounts of `skillhook accounts`
// ---------------------------------------------------------------------------

const LOCAL_PART = /[A-Za-z0-9._%+-]/;
const DOMAIN_PART = /[A-Za-z0-9.-]/;
/** A free-text field about an account (a CLI's error, a limit's reason) is cut to this. */
const ACCOUNT_TEXT_BYTES = 500;

/** `ada@example.com` → `a…@example.com` in `text`: enough to tell two logins apart, not to write to anyone. */
export function maskEmails(text: string): string {
  if (!text.includes("@")) return text;
  let out = "";
  let last = 0;
  let at = text.indexOf("@");
  while (at !== -1) {
    let start = at;
    while (start > last && LOCAL_PART.test(text[start - 1] as string)) start--;
    let end = at + 1;
    while (end < text.length && DOMAIN_PART.test(text[end] as string)) end++;
    while (end > at + 1 && text[end - 1] === ".") end--;
    const domain = text.slice(at + 1, end);
    if (start < at && domain.includes(".")) {
      out += `${text.slice(last, start)}${text[start]}…@${domain}`;
      last = end;
    }
    at = text.indexOf("@", Math.max(end, at + 1));
  }
  return out + text.slice(last);
}

/** Only `keys` of `value` (when it is an object), each string with its emails masked and cut to `ACCOUNT_TEXT_BYTES`. */
function pickAccount(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) continue;
    out[key] = accountStrings(child);
  }
  return out;
}

function accountStrings(node: unknown): unknown {
  if (typeof node === "string") return capText(maskEmails(node), ACCOUNT_TEXT_BYTES).text;
  if (Array.isArray(node)) return node.map(accountStrings);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) out[key] = accountStrings(child);
    return out;
  }
  return node;
}

const IDENTITY_KEYS = ["email", "org", "plan", "subscription_until", "checked_at"] as const;
const FAILURE_KEYS = ["kind", "at", "job", "message"] as const;
const WINDOW_KEYS = ["id", "label", "used_percent", "resets_at", "window_minutes"] as const;
const CREDIT_KEYS = ["enabled", "used", "limit", "balance", "currency", "unlimited"] as const;
const READINESS_KEYS = ["runner", "account", "found", "version", "authenticated", "method", "expired", "detail", "hint", "ready", "identity", "checked_at"] as const;
const STATE_KEYS = ["last_used_at", "last_job", "last_success_at", "limited_until", "limited_reason"] as const;
const VIEW_KEYS = ["name", "runner", "kind", "label", "default_dir", "managed", "secret_env", "disabled", "status", "ready", "detail", "limited_until", "limited_reason", "last_used_at", "last_success_at", "jobs_24h", "skills", "default_for"] as const;

function usageForUpload(usage: unknown): Record<string, unknown> | undefined {
  const out = pickAccount(usage, ["fetched_at", "plan", "error"]);
  if (!out) return undefined;
  const { windows, credits } = usage as { windows?: unknown; credits?: unknown };
  if (Array.isArray(windows)) out.windows = windows.map((w) => pickAccount(w, WINDOW_KEYS)).filter(Boolean);
  const credit = pickAccount(credits, CREDIT_KEYS);
  if (credit) out.credits = credit;
  return out;
}

/** Adds the account's nested records to `out`, each through its own allow-list. */
function withAccountParts(out: Record<string, unknown>, from: Record<string, unknown>): Record<string, unknown> {
  const identity = pickAccount(from.identity, IDENTITY_KEYS);
  if (identity) out.identity = identity;
  const failure = pickAccount(from.last_failure, FAILURE_KEYS);
  if (failure) out.last_failure = failure;
  const usage = usageForUpload(from.usage);
  if (usage) out.usage = usage;
  return out;
}

/**
 * A runner's or account's readiness as the cloud may see it: no paths (the CLI's binary, the account's directory),
 * emails masked.
 */
export function readinessForUpload(readiness: object): Record<string, unknown> {
  return withAccountParts(pickAccount(readiness, READINESS_KEYS) ?? {}, readiness as Record<string, unknown>);
}

/** What runs taught about an account (`jobs/.accounts.json`), as the cloud may see it. */
export function accountStateForUpload(state: object): Record<string, unknown> {
  return withAccountParts(pickAccount(state, STATE_KEYS) ?? {}, state as Record<string, unknown>);
}

/** One account of `collectAccounts` as the cloud may see it: its directory and the readiness's paths stay home. */
export function accountViewForUpload(view: object): Record<string, unknown> {
  const from = view as Record<string, unknown>;
  const out = withAccountParts(pickAccount(view, VIEW_KEYS) ?? {}, from);
  if (Array.isArray(from.attention)) out.attention = from.attention.map((a) => pickAccount(a, ["level", "code", "message", "fix"])).filter(Boolean);
  if (from.readiness && typeof from.readiness === "object") out.readiness = readinessForUpload(from.readiness);
  return out;
}
