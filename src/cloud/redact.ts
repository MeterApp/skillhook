// Nothing secret leaves the machine: every string uploaded is scrubbed against every value in `.env`, headers are
// redacted like `event.json`, and command lines / environments never travel at all.
import { redactHeaders } from "../payload.js";

const MIN_SECRET_LENGTH = 8;
export const REDACTED = "[redacted]";
/** Keys never uploaded, whatever object they sit in. */
const DROPPED_KEYS = new Set(["command", "env", "argv", "stdin", "resume_command"]);

/** The `.env` values worth scrubbing (short ones would blank ordinary words). */
export function secretValues(secrets: Record<string, string>): string[] {
  const values = new Set<string>();
  for (const value of Object.values(secrets)) if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) values.add(value);
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
