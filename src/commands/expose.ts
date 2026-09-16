import { findRunningServer, waitForUrl } from "../client.js";
import { setConfigValue } from "../config.js";
import { createOps, resolveBaseUrl, webhookUrl } from "../ops.js";
import { currentExposures, disableExposure, enableExposure, findTailscale, tailscaleStatus, type ExposureMode } from "../tailscale.js";
import { bool, CommandError, num, table, UsageError, type Ctx } from "./shared.js";

const USAGE = `Usage:
  skillhook expose tailscale [--serve] [--port N]   Funnel (public HTTPS, default) or Serve (tailnet only)
  skillhook expose status
  skillhook expose off
  skillhook expose cloudflare | ngrok               print the recipe for other tunnels
  skillhook url [skill]                             print webhook URLs`;

export async function exposeCommand(ctx: Ctx): Promise<number> {
  const [sub = "status"] = ctx.args;
  switch (sub) {
    case "tailscale":
    case "funnel":
    case "serve":
      return exposeTailscale(ctx, sub === "serve" || bool(ctx.flags, "serve") ? "serve" : "funnel");
    case "status":
      return exposeStatus(ctx);
    case "off":
    case "disable":
      return exposeOff(ctx);
    case "cloudflare":
    case "cloudflared":
      return recipe(ctx, "cloudflare");
    case "ngrok":
      return recipe(ctx, "ngrok");
    default:
      throw new UsageError(`Unknown expose subcommand "${sub}"`, USAGE);
  }
}

async function exposeTailscale(ctx: Ctx, mode: ExposureMode): Promise<number> {
  const config = ctx.config();
  const port = num(ctx.flags, "port") ?? config.port;
  if (!findTailscale()) throw new CommandError("tailscale CLI not found. Install Tailscale (https://tailscale.com/download), sign in, then retry.");
  const status = await tailscaleStatus();
  if (!status || status.backendState !== "Running") throw new CommandError(`Tailscale is ${status?.backendState ?? "not running"}. Open the Tailscale app and sign in first.`);
  const result = await enableExposure(mode, port);
  if (!result.ok) {
    const lines = [`Could not enable Tailscale ${mode}:`, result.output];
    if (result.approvalUrl) lines.push("", `Funnel needs a one-time approval in the Tailscale admin console: ${result.approvalUrl}`, "Approve it, then run this command again.");
    ctx.print(lines.join("\n"), { ok: false, mode, port, output: result.output, approval_url: result.approvalUrl ?? null });
    return 1;
  }
  const url = result.url ?? `https://${status.dnsName}`;
  setConfigValue(ctx.paths, "public_url", url);
  const skills = ctx.registry().list().skills;
  // Verify the public URL end to end when a local server is up (the first HTTPS certificate can take a while).
  let verification = "  server not running locally, so the public URL was not verified (start it: skillhook service install)";
  let verified: boolean | null = null;
  if (await findRunningServer(ctx.paths)) {
    if (!ctx.json) ctx.warn(`Verifying ${url}/health (the first TLS certificate can take up to a minute)…`);
    const probe = await waitForUrl(url, 60_000);
    verified = probe.reachable;
    verification = probe.reachable ? `  ✓ verified: ${url}/health answered after ${Math.round(probe.elapsedMs / 1000)}s` : `  ! ${url} did not answer within 60s (${probe.attempts} attempts). Tailscale may still be issuing the certificate; check again with: skillhook expose status`;
  }
  const lines = [
    `✓ Tailscale ${mode === "funnel" ? "Funnel (public internet)" : "Serve (your tailnet only)"} → http://127.0.0.1:${port}`,
    `  ${url}`,
    "  Persistent: survives reboots (stored by tailscaled). Turn off with: skillhook expose off",
    verification,
    "",
    ...(skills.length ? ["Webhook URLs:", ...skills.map((s) => `  ${s.name.padEnd(24)} ${webhookUrl(url, s.name)}`)] : ["No skills yet: skillhook skills new <name>"]),
    "",
    config.host === "127.0.0.1" || config.host === "localhost" ? "The server stays bound to 127.0.0.1; only Tailscale's TLS proxy reaches it." : `Note: server host is ${config.host}; consider 127.0.0.1 so only the proxy can reach it.`,
  ];
  ctx.print(lines.join("\n"), { ok: true, mode, port, url, verified, webhooks: Object.fromEntries(skills.map((s) => [s.name, webhookUrl(url, s.name)])), output: result.output });
  return 0;
}

async function exposeStatus(ctx: Ctx): Promise<number> {
  const config = ctx.config();
  const binary = findTailscale();
  const status = binary ? await tailscaleStatus(binary) : undefined;
  const exposures = binary ? await currentExposures(binary) : [];
  const ours = exposures.filter((e) => e.target.endsWith(`:${config.port}`));
  const lines: string[] = [];
  if (!binary) lines.push("tailscale: not installed (https://tailscale.com/download)");
  else if (!status) lines.push("tailscale: installed but not running");
  else lines.push(`tailscale: ${status.backendState}, node ${status.dnsName}${status.tailnet ? ` (${status.tailnet})` : ""}`);
  if (exposures.length) lines.push("", table(exposures.map((e) => [e.mode === "funnel" ? "funnel (public)" : "serve (tailnet)", e.url, e.target, e.target.endsWith(`:${config.port}`) ? "← skillhook" : ""]), ["mode", "url", "target", ""]));
  else if (binary) lines.push("no serve/funnel configuration on this node");
  lines.push("", `public_url in config: ${config.public_url ?? "(unset)"}`);
  if (!ours.length) lines.push("", "Expose the server with: skillhook expose tailscale");
  ctx.print(lines.join("\n"), { tailscale: status ?? null, exposures, skillhook_exposures: ours, public_url: config.public_url ?? null, port: config.port });
  return 0;
}

async function exposeOff(ctx: Ctx): Promise<number> {
  // Funnel and Serve share the :443 listener; turning both off leaves nothing behind.
  const funnel = await disableExposure("funnel");
  const serve = await disableExposure("serve");
  const ok = funnel.ok || serve.ok;
  if (ok) setConfigValue(ctx.paths, "public_url", undefined);
  const output = [funnel.output, serve.output].filter(Boolean).join("\n");
  ctx.print(ok ? "Disabled Tailscale Funnel/Serve on :443 and cleared public_url" : `Nothing to disable (or tailscale refused): ${output}`, { ok, output });
  return ok ? 0 : 1;
}

function recipe(ctx: Ctx, provider: "cloudflare" | "ngrok"): number {
  const port = ctx.config().port;
  const text =
    provider === "cloudflare"
      ? [
          "Cloudflare Tunnel (free, needs a domain on Cloudflare):",
          "  brew install cloudflared",
          "  cloudflared tunnel login",
          "  cloudflared tunnel create skillhook",
          "  cloudflared tunnel route dns skillhook hooks.example.com",
          `  cloudflared tunnel run --url http://127.0.0.1:${port} skillhook      # or: cloudflared service install`,
          "  skillhook config set public_url https://hooks.example.com",
        ].join("\n")
      : [
          "ngrok (free tier includes one static domain):",
          "  brew install ngrok && ngrok config add-authtoken <token>",
          "  # claim a static domain at https://dashboard.ngrok.com/domains",
          `  ngrok http --url=<your-name>.ngrok-free.app ${port}`,
          "  skillhook config set public_url https://<your-name>.ngrok-free.app",
        ].join("\n");
  ctx.print(text, { provider, port, steps: text.split("\n").slice(1).map((s) => s.trim()) });
  return 0;
}

export async function urlCommand(ctx: Ctx): Promise<number> {
  const ops = createOps(ctx.paths, { env: ctx.io.env });
  const [name] = ctx.args;
  const { baseUrl, source } = await resolveBaseUrl(ops, { prefer: bool(ctx.flags, "local") ? "local" : bool(ctx.flags, "public") ? "public" : undefined });
  if (name) {
    const skill = ops.registry.get(name);
    if (!skill) throw new CommandError(`No skill named "${name}"`);
    ctx.print(webhookUrl(baseUrl, name), { skill: name, url: webhookUrl(baseUrl, name), base_url: baseUrl, source });
    return 0;
  }
  const skills = ops.registry.list().skills;
  const urls = Object.fromEntries(skills.map((s) => [s.name, webhookUrl(baseUrl, s.name)]));
  const lines = [`base URL (${source}): ${baseUrl}`, ...(source === "local" ? ["  (no public URL yet: skillhook expose tailscale)"] : []), "", ...Object.entries(urls).map(([k, v]) => `${k.padEnd(24)} ${v}`)];
  ctx.print(lines.join("\n"), { base_url: baseUrl, source, urls });
  return 0;
}
