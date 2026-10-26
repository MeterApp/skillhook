import { adminRequest, findRunningServer } from "../client.js";
import { ADMIN_TOKEN_ENV } from "../env.js";
import { CommandError, UsageError, type Ctx } from "./shared.js";

export const SENTRY_USAGE = `Usage: skillhook sentry [status|test]

Read the running daemon's opt-in error reporting status, or send a fixed verification error through that daemon.
Configure SKILLHOOK_SENTRY_DSN in the daemon's .env to opt in; SKILLHOOK_NO_SENTRY=1 disables reporting.
The test requires SKILLHOOK_ADMIN_TOKEN even on loopback (run: skillhook secret generate admin).
No CLI-side fallback: the daemon must be running. --json prints the response; test exits 1 unless delivered.`;

interface SentryResponse {
  enabled?: boolean;
  configured?: boolean;
  pending?: number;
  rate_limited?: boolean;
  last_error?: string | null;
  event_id?: string;
  delivered?: boolean;
  error?: string;
}

export async function sentryCommand(ctx: Ctx): Promise<number> {
  const action = ctx.args[0] ?? "status";
  if ((action !== "status" && action !== "test") || ctx.args.length > 1) throw new UsageError("Expected sentry status or sentry test", SENTRY_USAGE);
  const secrets = ctx.secrets();
  if (action === "test" && !secrets[ADMIN_TOKEN_ENV]) throw new CommandError("Sentry verification requires SKILLHOOK_ADMIN_TOKEN, even on loopback. Run: skillhook secret generate admin");
  const running = await findRunningServer(ctx.paths);
  if (!running) throw new CommandError("No running skillhook daemon found. Start skillhook serve or skillhook service install, then retry.");
  let response;
  try {
    response = await adminRequest<SentryResponse>(running.baseUrl, secrets, "/diagnostics/sentry", { method: action === "test" ? "POST" : "GET", timeoutMs: 15_000 });
  } catch {
    throw new CommandError("Could not reach the daemon's Sentry diagnostics. Check skillhook service status and retry.");
  }
  if (response.status >= 400) {
    // Never echo arbitrary HTTP bodies, which could contain credentials or private diagnostic data.
    throw new CommandError(`Daemon Sentry ${action} failed (HTTP ${response.status}). Check skillhook sentry status, the daemon's Sentry configuration and its admin token; verification is limited to once per minute.`);
  }
  const body = response.body;
  if (action === "test") {
    const delivered = body.enabled === true && body.delivered === true && typeof body.event_id === "string" && /^[a-f0-9]{32}$/.test(body.event_id);
    const result = { enabled: body.enabled === true, delivered, ...(delivered ? { event_id: body.event_id } : {}) };
    ctx.print(delivered ? `Sentry accepted daemon verification error ${body.event_id}. Find this event ID in your Sentry project to confirm ingestion.` : "Daemon verification was not delivered. Check skillhook sentry status and configure SKILLHOOK_SENTRY_DSN in the daemon's .env.", result);
    return delivered ? 0 : 1;
  }
  // The endpoint exposes only sanitized status; omit any unexpected fields from CLI output.
  const status = { enabled: body.enabled === true, configured: body.configured === true, pending: body.pending ?? 0, rate_limited: body.rate_limited === true, last_error: body.last_error ?? null };
  ctx.print(status.enabled ? `Daemon Sentry reporting enabled; pending: ${status.pending}; rate limited: ${status.rate_limited}.` : "Daemon Sentry reporting disabled. To opt in, set SKILLHOOK_SENTRY_DSN in the daemon's .env; SKILLHOOK_NO_SENTRY=1 disables it.", status);
  return 0;
}
