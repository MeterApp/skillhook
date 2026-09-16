import { createOps, resolveBaseUrl, sendSignedWebhook } from "../ops.js";
import { bool, CommandError, list, num, parseHeaderFlags, readPayloadArg, str, UsageError, type Ctx } from "./shared.js";

const USAGE = `Usage: skillhook send <skill> [--payload JSON|@file|-] [--wait SECONDS] [--url BASE_URL | --public | --local]
                            [--header "Name: value"]... [--json]

Signs the payload the way the skill's auth expects (bearer, HMAC, Standard Webhooks, …) and POSTs it to
/hooks/<skill> on the running server (default), the public URL (--public) or any base URL (--url).`;

export async function sendCommand(ctx: Ctx): Promise<number> {
  const [name] = ctx.args;
  if (!name) throw new UsageError("Missing skill name", USAGE);
  const ops = createOps(ctx.paths, { env: ctx.io.env });
  const skill = ops.registry.get(name);
  if (!skill) throw new CommandError(`No skill named "${name}"`);
  const { payload } = await readPayloadArg(ctx, str(ctx.flags, "payload", "p"));
  const explicit = str(ctx.flags, "url");
  const { baseUrl, source } = explicit ? { baseUrl: explicit, source: "flag" as const } : await resolveBaseUrl(ops, { prefer: bool(ctx.flags, "public") ? "public" : "local" });
  if (source === "local" && !explicit) {
    const { findRunningServer } = await import("../client.js");
    if (!(await findRunningServer(ctx.paths))) throw new CommandError(`No server is running for ${ctx.paths.home}. Start one with: skillhook serve   (or use --url / --public)`);
  }
  const result = await sendSignedWebhook(ops, { skill, payload, baseUrl, waitSeconds: num(ctx.flags, "wait"), headers: parseHeaderFlags(list(ctx.flags, "header", "H")) });
  const ok = result.status >= 200 && result.status < 300;
  const body = result.body;
  const lines = [`${ok ? "✓" : "✗"} POST ${result.url} → ${result.status}`, `  signed with: ${result.signedHeaders.join(", ") || "nothing (auth none)"}`, "", typeof body === "string" ? body : JSON.stringify(body, null, 2)];
  ctx.print(lines.join("\n"), { ok, url: result.url, status: result.status, signed_headers: result.signedHeaders, response: body });
  return ok ? 0 : 1;
}
