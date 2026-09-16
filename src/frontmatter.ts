import YAML from "yaml";

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
  /** True when the file had a `---` block at all. */
  present: boolean;
}

const OPEN_RE = /^---[ \t]*\r?\n/;

/** Splits `---\nyaml\n---\nbody`. A missing block yields empty data and the whole text as body. */
export function parseFrontmatter(text: string): Frontmatter {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  if (!OPEN_RE.test(source)) return { data: {}, body: source, present: false };
  const afterOpen = source.replace(OPEN_RE, "");
  const closeMatch = /^---[ \t]*(?:\r?\n|$)/m.exec(afterOpen);
  if (!closeMatch) throw new Error("Unterminated frontmatter: missing closing ---");
  const yamlText = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  const parsed = YAML.parse(yamlText) ?? {};
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Frontmatter must be a YAML mapping");
  }
  return { data: parsed as Record<string, unknown>, body, present: true };
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const yamlText = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
  return `---\n${yamlText}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}
