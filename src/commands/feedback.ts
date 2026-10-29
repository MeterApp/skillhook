import { readFileSync } from "node:fs";
import path from "node:path";
import { CloudApiError, fleetClient, loginCommand, storedApiCredentials, type ApiFailure, type FleetClient } from "../cloud/api.js";
import { callTool } from "../cloud/tools.js";
import { printable, readJsonFileOr, writeJsonFile } from "../util.js";
import { VERSION } from "../version.js";
import { bool, CommandError, num, str, table, UsageError, type Ctx } from "./shared.js";

export const FEEDBACK_USAGE = `Usage:
  skillhook feedback list [--kind feature|issue] [--status S|active|all] [--sort top|new|recent_activity] [--search WORDS]
  skillhook feedback show <number>                     an item, its comments (the team's marked) and its timeline
  skillhook feedback mine                              what your organisation filed and follows
  skillhook feedback request "<title>" [--body T|--body -] [--force]
  skillhook feedback report "<title>" [--body T|--body -] [--request-id ID] [--last] [--job ID] [--delivery ID] [--machine M] [--skill S] [--kind bug|question|other] [--severity S] [--force]
  skillhook feedback upvote <number> [--remove]
  skillhook feedback comment <number> "<text>"

The Skillhook feedback board (https://skillhook.dev/feedback?ref=cli), with the organisation API key of skillhook cloud login.
request and report look for similar items first and list them instead of filing: upvote one of them, or add --force.
report --last attaches the last request the cloud refused from this computer (its request id and error); --job and
--delivery attach a job or delivery (the cloud's id or the machine's) and the machine it ran on. Reports stay private to
your organisation and the Skillhook team; feature requests are public.`;

export const REVIEW_USAGE = `Usage:
  skillhook review --rating 1-5 [--title T] [--body T] [--likes T] [--dislikes T] [--use-case T] [--name N] [--company C] [--consent]
  skillhook reviews [--sort new|top]

review posts your organisation's review of Skillhook, or edits it (once an hour); it needs a key with fleet:run.
--consent lets Skillhook quote it. reviews lists the published ones with the average.`;

const LAST_FAILURE_FILE = "cloud-last-failure.json";

/** Where the last refused cloud request is kept (`<home>/cloud-last-failure.json`) for `feedback report --last`. */
export function lastFailureFile(home: string): string {
  return path.join(home, LAST_FAILURE_FILE);
}

/** A client for the feedback tools that remembers what the cloud refuses, for a later `report --last`. */
function feedbackClient(ctx: Ctx): FleetClient {
  return fleetClient(ctx.io.env, ctx.config().cloud, storedApiCredentials(ctx.paths, ctx.io.env), {
    client: "cli",
    onFailure: (failure) => {
      // Asking for a report of the failure is not itself the failure worth reporting.
      if (!failure.path.endsWith("/tools/report_issue")) writeJsonFile(lastFailureFile(ctx.paths.home), failure);
    },
  });
}

interface Item {
  number: number;
  kind: string;
  title: string;
  body?: string | null;
  status: string;
  votes: number;
  comments: number;
  author: string;
  url: string;
  visibility?: string;
  duplicate_of?: number | null;
  external_ref?: string | null;
  viewer?: { voted?: boolean };
  report?: { number?: number; dashboard_url?: string; request_id?: string | null };
}

function itemRows(items: Item[]): string {
  if (!items.length) return "Nothing here.";
  return table(
    items.map((item) => [`#${item.number}`, item.kind, item.status.replace("_", " "), `${item.votes}${item.viewer?.voted ? "✓" : ""}`, String(item.comments), item.title + (item.visibility === "private" ? " (private)" : "")]),
    ["item", "kind", "status", "votes", "comments", "title"],
  );
}

function describeItem(data: { item: Item; comments?: { author: string; body: string; official: boolean; created_at: string }[]; timeline?: { kind: string; to: string | null; note: string | null; at: string }[] }): string {
  const { item } = data;
  const lines = [`#${item.number} ${item.title}`, `${item.kind}, ${item.status.replace("_", " ")}, ${item.votes} vote${item.votes === 1 ? "" : "s"}${item.viewer?.voted ? " (yours among them)" : ""}, by ${item.author}`, item.url];
  if (item.duplicate_of) lines.push(`Merged into #${item.duplicate_of}.`);
  if (item.external_ref) lines.push(`Tracked in ${item.external_ref}`);
  if (item.report?.dashboard_url) lines.push(`Your report #${item.report.number}: ${item.report.dashboard_url}`);
  if (item.body) lines.push("", item.body);
  if (data.timeline?.length) {
    lines.push("", "Timeline:");
    for (const event of data.timeline) lines.push(`  ${event.at.slice(0, 16).replace("T", " ")}  ${event.kind === "status" ? (event.to ?? "").replace("_", " ") : event.kind}${event.note && event.kind === "status" ? `: ${event.note}` : ""}`);
  }
  if (data.comments?.length) {
    lines.push("", "Comments:");
    for (const comment of data.comments) lines.push(`  ${comment.author}${comment.official ? " (Skillhook team)" : ""}, ${comment.created_at.slice(0, 10)}:`, ...comment.body.split("\n").map((line) => `    ${line}`));
  }
  return lines.join("\n");
}

function similarText(result: { similar?: Item[]; hint?: string }): string {
  return [`Similar items exist; nothing was filed:`, "", itemRows(result.similar ?? []), "", "Upvote the one you mean (skillhook feedback upvote <number>) and comment to add detail, or run again with --force to file anyway."].join("\n");
}

async function bodyText(ctx: Ctx): Promise<string | undefined> {
  const body = str(ctx.flags, "body");
  if (body === "-") return ctx.io.stdin ? await ctx.io.stdin() : readFileSync(0, "utf8");
  const file = str(ctx.flags, "body-file");
  if (file) return readFileSync(file, "utf8");
  return body;
}

function itemArg(ctx: Ctx, at = 1): string {
  const ref = ctx.args[at];
  if (!ref) throw new UsageError("Name the item by its number (as on the board).", FEEDBACK_USAGE);
  return ref.replace(/^#/, "");
}

async function run(ctx: Ctx, work: (client: FleetClient) => Promise<number>): Promise<number> {
  try {
    return await work(feedbackClient(ctx));
  } catch (error) {
    if (error instanceof CloudApiError) {
      if (error.status === 404 && /no tool/i.test(error.message)) throw new CommandError(`This cloud has no feedback board yet; update it or use ${loginCommand("https://skillhook.dev")}.`);
      throw new CommandError(error.message);
    }
    throw error;
  }
}

/** `skillhook feedback …`: the board's actions through the cloud's catalogue (list_feedback, request_feature, …). */
export async function feedbackCommand(ctx: Ctx): Promise<number> {
  const sub = ctx.args[0];
  switch (sub) {
    case undefined:
    case "list":
      return run(ctx, async (client) => {
        const input = { kind: str(ctx.flags, "kind"), status: str(ctx.flags, "status"), sort: str(ctx.flags, "sort"), q: str(ctx.flags, "search"), limit: num(ctx.flags, "limit") };
        const result = await callTool(client, "list_feedback", Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)));
        ctx.print(printable(itemRows((result.items as Item[]) ?? [])), result);
        return 0;
      });
    case "show":
      return run(ctx, async (client) => {
        const result = await callTool(client, "get_feedback", { item: itemArg(ctx) });
        ctx.print(printable(describeItem(result as never)), result);
        return 0;
      });
    case "mine":
      return run(ctx, async (client) => {
        const result = (await callTool(client, "list_my_feedback", {})) as { items?: Item[]; subscriptions?: Item[] };
        ctx.print(printable(["Filed by your organisation:", itemRows(result.items ?? []), "", "Following:", itemRows(result.subscriptions ?? [])].join("\n")), result);
        return 0;
      });
    case "request":
      return run(ctx, async (client) => {
        const title = ctx.args.slice(1).join(" ").trim();
        if (!title) throw new UsageError('Say what you want: skillhook feedback request "<title>"', FEEDBACK_USAGE);
        const body = await bodyText(ctx);
        const result = (await callTool(client, "request_feature", { title, ...(body ? { body } : {}), ...(bool(ctx.flags, "force") ? { force: true } : {}) })) as { created?: boolean; similar?: Item[]; item?: Item };
        if (result.created === false && result.similar?.length) {
          ctx.print(printable(similarText(result)), result);
          return 0;
        }
        ctx.print(printable(`Requested as #${result.item?.number}: ${result.item?.url}\nIt is public on the board with your organisation's vote; you get an email at every status change.`), result);
        return 0;
      });
    case "report":
      return run(ctx, async (client) => {
        const title = ctx.args.slice(1).join(" ").trim();
        if (!title) throw new UsageError('Say what is wrong: skillhook feedback report "<title>"', FEEDBACK_USAGE);
        const body = await bodyText(ctx);
        let requestId = str(ctx.flags, "request-id");
        const context: Record<string, unknown> = { client: "skillhook-cli", skillhook_version: VERSION, platform: `${process.platform}-${process.arch}`, node_version: process.versions.node };
        if (bool(ctx.flags, "last")) {
          const failure = readJsonFileOr<ApiFailure | null>(lastFailureFile(ctx.paths.home), null);
          if (!failure) throw new CommandError("No failed cloud request is remembered on this computer; pass --request-id instead.");
          requestId ??= failure.request_id;
          context.last_failure = { at: failure.at, endpoint: `${failure.method} ${failure.path}`, status: failure.status, error_code: failure.code, message: failure.message };
        }
        const input = {
          title,
          ...(body ? { body } : {}),
          ...(requestId ? { request_id: requestId } : {}),
          context,
          ...Object.fromEntries((["job", "delivery", "machine", "skill", "kind", "severity"] as const).flatMap((name) => (str(ctx.flags, name) ? [[name, str(ctx.flags, name)]] : []))),
          ...(str(ctx.flags, "email") ? { contact_email: str(ctx.flags, "email") } : {}),
          ...(bool(ctx.flags, "force") ? { force: true } : {}),
        };
        const result = (await callTool(client, "report_issue", input)) as { created?: boolean; similar?: Item[]; item?: Item; acknowledged?: boolean };
        if (result.created === false && result.similar?.length) {
          ctx.print(printable(similarText(result)), result);
          return 0;
        }
        ctx.print(printable([`Reported as #${result.item?.report?.number ?? result.item?.number} (board #${result.item?.number}): ${result.item?.report?.dashboard_url ?? result.item?.url}`, result.acknowledged ? "A confirmation email is on its way." : "No confirmation email was sent.", "It stays private to your organisation and the Skillhook team."].join("\n")), result);
        return 0;
      });
    case "upvote":
    case "vote":
      return run(ctx, async (client) => {
        const remove = bool(ctx.flags, "remove");
        const result = (await callTool(client, remove ? "remove_feedback_vote" : "upvote_feedback", { item: itemArg(ctx) })) as { votes?: number; new_vote?: boolean; removed?: boolean; item?: { number?: number; url?: string } };
        ctx.print(printable(remove ? `${result.removed ? "Vote removed" : "You had not voted"}: #${result.item?.number} has ${result.votes} vote${result.votes === 1 ? "" : "s"}.` : `${result.new_vote === false ? "Already voted" : "Voted"}: #${result.item?.number} has ${result.votes} vote${result.votes === 1 ? "" : "s"}. ${result.item?.url ?? ""}`), result);
        return 0;
      });
    case "comment":
      return run(ctx, async (client) => {
        const item = itemArg(ctx);
        const text = ctx.args.slice(2).join(" ").trim() || (await bodyText(ctx))?.trim();
        if (!text) throw new UsageError('Say something: skillhook feedback comment <number> "<text>"', FEEDBACK_USAGE);
        const result = (await callTool(client, "comment_on_feedback", { item, body: text })) as { item?: { number?: number; url?: string } };
        ctx.print(printable(`Commented on #${result.item?.number}: ${result.item?.url}`), result);
        return 0;
      });
    default:
      throw new UsageError(`Unknown feedback subcommand "${sub}"`, FEEDBACK_USAGE);
  }
}

/** `skillhook review`: posts or edits the organisation's review (submit_review). */
export async function reviewCommand(ctx: Ctx): Promise<number> {
  const rating = num(ctx.flags, "rating", "stars");
  if (rating === undefined) throw new UsageError("A review needs --rating 1 to 5.", REVIEW_USAGE);
  return run(ctx, async (client) => {
    const fields: Record<string, unknown> = { rating };
    for (const [flag, field] of [["title", "title"], ["body", "body"], ["likes", "likes"], ["dislikes", "dislikes"], ["use-case", "use_case"], ["name", "display_name"], ["company", "display_company"]] as const) {
      const value = str(ctx.flags, flag);
      if (value !== undefined) fields[field] = value;
    }
    if (bool(ctx.flags, "consent")) fields.marketing_consent = true;
    const result = (await callTool(client, "submit_review", fields)) as { created?: boolean; published?: boolean; note?: string };
    ctx.print(printable(`${result.created ? "Posted" : "Updated"}. ${result.published ? "It is live on https://skillhook.dev/reviews?ref=cli." : (result.note ?? "")}`.trim()), result);
    return 0;
  });
}

/** `skillhook reviews`: published reviews and the average (list_reviews). */
export async function reviewsCommand(ctx: Ctx): Promise<number> {
  return run(ctx, async (client) => {
    const result = (await callTool(client, "list_reviews", str(ctx.flags, "sort") ? { sort: str(ctx.flags, "sort") } : {})) as { aggregate?: { count: number; average: number | null }; reviews?: { rating: number; title: string | null; display_name: string; body: string | null; response: { body: string } | null }[] };
    const lines = [`${result.aggregate?.average ?? "–"} out of 5 from ${result.aggregate?.count ?? 0} review${result.aggregate?.count === 1 ? "" : "s"}`, ""];
    for (const review of result.reviews ?? []) {
      lines.push(`${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)}  ${review.title ?? ""} — ${review.display_name}`);
      if (review.body) lines.push(`  ${review.body.replace(/\s+/g, " ").slice(0, 300)}`);
      if (review.response) lines.push(`  Skillhook: ${review.response.body.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    ctx.print(printable(lines.join("\n")), result);
    return 0;
  });
}
