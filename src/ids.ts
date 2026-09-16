import { randomBytes, randomInt } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** `length` characters from the alphabet, each drawn with `crypto.randomInt` (a byte modulo 36 would be biased). */
export function randomToken(length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)] as string;
  return out;
}

/** Sortable, human-readable job id: `20260915T221501Z-k3x9q2` (UTC timestamp + random suffix). */
export function newJobId(date = new Date()): string {
  const ts = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${ts}-${randomToken(6)}`;
}

export const JOB_ID_RE = /^\d{8}T\d{6}Z-[0-9a-z]{6}$/;

export function isJobId(value: string): boolean {
  return JOB_ID_RE.test(value);
}

/** URL-safe random secret (43 chars for 32 bytes). */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
