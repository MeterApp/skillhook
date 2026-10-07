// What an agent reports for the people who follow its jobs besides the outcome: a title for the job, the result in one
// line, typed links (where the event came from, what the run opened or changed, how to check it) and choices a person
// can pick from. The job MCP tools, `skillhook job …` and response.json all go through these functions, so every front
// end accepts the same shapes and stores the same values. Skillhook Cloud's inbox shows them (docs/skills.md).
import { truncate } from "./util.js";

export const TITLE_MAX = 200;
export const HEADLINE_MAX = 280;
export const LINK_TITLE_MAX = 200;
export const LINK_URL_MAX = 2048;
export const LINKS_MAX = 50;
export const OPTIONS_MAX = 20;
export const OPTION_MAX = 200;

/** What a link points at, so a dashboard can group it and give it an icon. The cloud protocol repeats the list (`LINK_KINDS`). */
export const LINK_KINDS = ["source", "pull_request", "commit", "issue", "message", "document", "deploy", "test", "log", "result", "other"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const LINK_KIND_DESCRIPTIONS: Record<LinkKind, string> = {
  source: "what started the run: the Sentry issue, the GitHub issue or pull request, the Granola meeting, the Slack thread, the form",
  pull_request: "a pull or merge request the run opened, updated, reviewed or merged",
  commit: "a commit",
  issue: "an issue, ticket or task it opened or updated (GitHub, Linear, Jira, Asana)",
  message: "a message it sent or answered (Slack, email, a comment)",
  document: "a document it wrote or changed (Notion, Google Docs, a wiki page, a file)",
  deploy: "a deployment or a preview",
  test: "how to check the result: a CI run, a preview to try, a test report",
  log: "logs, traces or a dashboard it looked at",
  result: "the result itself when it lives elsewhere (a report, a generated file, a dataset)",
  other: "anything else",
};

export interface ReportLink {
  url: string;
  title?: string;
  kind?: LinkKind;
}

/** A link as stored: a bare URL (what earlier versions wrote) or a URL with a title and a kind. */
export type ResponseLink = string | ReportLink;

export interface Choices {
  /** What a person can pick from: unique labels. */
  options?: string[];
  /** The option the agent suggests (one of `options`). */
  recommended?: string;
  /** The person may pick several options; the answer then lists them one per line. */
  multiple?: boolean;
}

const LINK_KIND_SET: ReadonlySet<string> = new Set(LINK_KINDS);

export function isLinkKind(value: unknown): value is LinkKind {
  return typeof value === "string" && LINK_KIND_SET.has(value);
}

/** One line of text: trimmed, inner line breaks turned into spaces, capped; undefined when nothing is left. */
export function cleanLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // Split and trim rather than one regex with neighbouring \s* (polynomial on long runs of whitespace).
  const line = value
    .split(/[\r\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  return line ? truncate(line, max, "…") : undefined;
}

/** A link from any front end, or undefined when it has no usable URL. Unknown kinds are dropped (a dashboard guesses one from the URL). */
export function normalizeLink(value: unknown): ResponseLink | undefined {
  if (typeof value === "string") {
    const url = value.trim();
    return url && url.length <= LINK_URL_MAX ? url : undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url || url.length > LINK_URL_MAX) return undefined;
  const title = cleanLine(raw.title, LINK_TITLE_MAX);
  const kind = isLinkKind(raw.kind) ? raw.kind : undefined;
  return title || kind ? { url, ...(title ? { title } : {}), ...(kind ? { kind } : {}) } : url;
}

export function linkUrl(link: ResponseLink): string {
  return typeof link === "string" ? link : link.url;
}

/** The links of a report: usable ones only, the first of each URL, at most `LINKS_MAX`; undefined when none are left. */
export function normalizeLinks(value: unknown): ResponseLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const links: ResponseLink[] = [];
  for (const item of value) {
    const link = normalizeLink(item);
    if (!link || seen.has(linkUrl(link))) continue;
    seen.add(linkUrl(link));
    links.push(link);
    if (links.length >= LINKS_MAX) break;
  }
  return links.length ? links : undefined;
}

/**
 * A `--link` argument: `URL` or `[title](URL)`, either one optionally prefixed with a kind and a colon
 * (`pull_request:https://github.com/acme/api/pull/7`, `source:[Weekly sync](https://notes.granola.ai/d/…)`).
 * Parsed with string operations, not a regex over the whole argument.
 */
export function parseLinkArg(text: string): ResponseLink | undefined {
  let rest = text.trim();
  let kind: LinkKind | undefined;
  const colon = rest.indexOf(":");
  if (colon > 0 && isLinkKind(rest.slice(0, colon))) {
    kind = rest.slice(0, colon) as LinkKind;
    rest = rest.slice(colon + 1).trim();
  }
  let title: string | undefined;
  if (rest.startsWith("[") && rest.endsWith(")")) {
    const split = rest.lastIndexOf("](");
    if (split > 0) {
      title = rest.slice(1, split);
      rest = rest.slice(split + 2, -1).trim();
    }
  }
  return normalizeLink({ url: rest, title, kind });
}

/** A link on one line of terminal output: `title <url> (kind)`, or the bare URL. */
export function formatLink(link: ResponseLink): string {
  if (typeof link === "string") return link;
  return `${link.title ? `${link.title} <${link.url}>` : link.url}${link.kind ? ` (${link.kind})` : ""}`;
}

/** Choices on one line: `[A* | B]` with the recommended one starred, `(pick several)` when multiple. */
export function formatChoices(choices: Choices): string {
  if (!choices.options?.length) return "";
  return ` [${choices.options.map((option) => (option === choices.recommended ? `${option}*` : option)).join(" | ")}]${choices.multiple ? " (pick several)" : ""}`;
}

/** The choices of a question or of a `needs_human` outcome: unique, non-empty labels; a recommendation only when it is one of them. */
export function normalizeChoices(input: { options?: unknown; recommended?: unknown; multiple?: unknown }): Choices {
  const options: string[] = [];
  if (Array.isArray(input.options)) {
    for (const item of input.options) {
      const label = cleanLine(typeof item === "number" ? String(item) : item, OPTION_MAX);
      if (label && !options.includes(label)) options.push(label);
      if (options.length >= OPTIONS_MAX) break;
    }
  }
  if (!options.length) return {};
  const recommended = cleanLine(input.recommended, OPTION_MAX);
  return { options, ...(recommended && options.includes(recommended) ? { recommended } : {}), ...(input.multiple === true && options.length > 1 ? { multiple: true } : {}) };
}

/** The options a multiple-choice answer picked: the lines of its text that are options, each once, in the order given. */
export function pickedOptions(text: string, options: readonly string[]): string[] {
  const picked: string[] = [];
  for (const line of text.split("\n")) {
    const label = line.trim();
    if (label && options.includes(label) && !picked.includes(label)) picked.push(label);
  }
  return picked;
}
