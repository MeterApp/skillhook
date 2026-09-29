import { collectStats, formatStats, parseSince } from "../stats.js";
import { str, UsageError, type Ctx } from "./shared.js";

export const STATS_USAGE = `Usage:
  skillhook stats [--since 24h|7d|2w|ISO] [--until ISO] [--skill NAME]   jobs by status, outcome, runner and failure kind; durations, cost, tokens; deliveries by outcome; per skill`;

/** `skillhook stats`: numbers over the job directories and the delivery log on this machine. */
export async function statsCommand(ctx: Ctx): Promise<number> {
  const sinceRaw = str(ctx.flags, "since");
  const since = parseSince(sinceRaw);
  if (sinceRaw && !since) throw new UsageError("--since must be like 24h, 7d, 2w or an ISO-8601 instant", STATS_USAGE);
  const untilRaw = str(ctx.flags, "until");
  const until = parseSince(untilRaw);
  if (untilRaw && !until) throw new UsageError("--until must be an ISO-8601 instant", STATS_USAGE);
  const report = collectStats(ctx.store(), ctx.deliveryLog(), { since, until, skill: str(ctx.flags, "skill") });
  ctx.print(formatStats(report), report);
  return 0;
}
