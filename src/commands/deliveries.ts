import { DELIVERY_OUTCOMES, readDeliveryBody, type DeliveryOutcome } from "../delivery-log.js";
import { replayCommand } from "./replay.js";
import { bool, CommandError, num, relativeTime, str, table, UsageError, type Ctx } from "./shared.js";

export const DELIVERIES_USAGE = `Usage:
  skillhook deliveries list [--skill NAME] [--outcome ${DELIVERY_OUTCOMES.join("|")}] [--since ISO] [--after ID] [--limit N]
  skillhook deliveries show <id> [--body]
  skillhook deliveries replay <id> [--force] [--skip-filters] [--runner R] [--model M] [--effort E] [--wait S]

Every request to /hooks/<skill> the server received, with what became of it: accepted (a job was created), duplicate,
in_flight, skipped (a when filter), rejected (401, 404, 413, 429, 503, …), challenge (Slack URL verification), error.
replay runs the original request again through the skill as it is now (no signature check; --force for a rejected one).`;

export async function deliveriesCommand(ctx: Ctx): Promise<number> {
  const [sub = "list", id] = ctx.args;
  const log = ctx.deliveryLog();
  switch (sub) {
    case "list":
    case "ls": {
      const outcome = str(ctx.flags, "outcome") as DeliveryOutcome | undefined;
      if (outcome && !DELIVERY_OUTCOMES.includes(outcome)) throw new UsageError(`--outcome must be one of ${DELIVERY_OUTCOMES.join(", ")}`, DELIVERIES_USAGE);
      const since = str(ctx.flags, "since");
      if (since && Number.isNaN(Date.parse(since))) throw new UsageError("--since must be an ISO-8601 instant", DELIVERIES_USAGE);
      const page = log.list({ skill: str(ctx.flags, "skill"), outcome, since, after: str(ctx.flags, "after"), limit: num(ctx.flags, "limit") ?? 30 });
      const rows = page.deliveries.map((d) => {
        const code = d.code && d.code !== d.outcome ? d.code : "";
        const detail = [code, d.reason].filter(Boolean).join(": ").split("\n")[0] ?? "";
        return [d.id, d.skill, d.outcome, String(d.http_status), detail.slice(0, 60), d.job_id ?? "", relativeTime(d.received_at)];
      });
      const human = rows.length ? `${table(rows, ["delivery", "skill", "outcome", "http", "detail", "job", "when"])}${page.next_after ? `\n(more: --after ${page.next_after})` : ""}` : `No deliveries recorded in ${log.dir}`;
      ctx.print(human, page);
      return 0;
    }
    case "show":
    case "get": {
      if (!id) throw new UsageError("Missing delivery id", DELIVERIES_USAGE);
      const delivery = log.get(id);
      if (!delivery) throw new CommandError(`Unknown delivery ${id}`);
      const wantBody = bool(ctx.flags, "body");
      const body = wantBody ? readDeliveryBody(log, ctx.store(), delivery) : undefined;
      const query = Object.keys(delivery.query).length ? `?${new URLSearchParams(delivery.query).toString()}` : "";
      const stored = delivery.body_stored ? `stored${delivery.body_truncated ? " (truncated)" : ""}` : delivery.job_id ? "in the job directory" : "not stored";
      const lines = [
        `${delivery.id}  ${delivery.skill}  ${delivery.outcome} (${delivery.http_status}${delivery.code ? ` ${delivery.code}` : ""})`,
        ...(delivery.reason ? [`  reason:    ${delivery.reason}`] : []),
        `  received:  ${delivery.received_at} (decided in ${delivery.duration_ms}ms)`,
        `  from:      ${delivery.ip}  ${delivery.method} ${delivery.path}${query}${delivery.user_agent ? `  (${delivery.user_agent})` : ""}`,
        `  body:      ${delivery.content_type ?? "n/a"}, ${delivery.bytes} bytes${delivery.body_kind ? ` (${delivery.body_kind})` : ""}, ${stored}`,
        ...(delivery.delivery_id ? [`  delivery:  ${delivery.delivery_id}`] : []),
        ...(delivery.job_id ? [`  job:       ${delivery.job_id}`] : []),
        "  headers:",
        ...Object.entries(delivery.headers).map(([name, value]) => `    ${name}: ${value}`),
        ...(body ? ["", `--- body (${body.encoding}${body.truncated ? ", truncated" : ""}, from ${body.source}) ---`, body.text] : wantBody ? ["", "(no body available)"] : []),
      ];
      ctx.print(lines.join("\n"), { delivery, ...(wantBody ? { body: body ?? null } : {}) });
      return 0;
    }
    case "replay":
    case "rerun":
      return replayCommand(ctx, "delivery", id, DELIVERIES_USAGE);
    default:
      throw new UsageError(`Unknown deliveries subcommand "${sub}"`, DELIVERIES_USAGE);
  }
}
