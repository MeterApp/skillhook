import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { mergedPath } from "./runners/env.js";

const execFileAsync = promisify(execFile);

const CANDIDATES = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/bin/tailscale"];

export function findTailscale(): string | undefined {
  const fromPath = which("tailscale");
  if (fromPath) return fromPath;
  return CANDIDATES.find((candidate) => existsSync(candidate));
}

export function which(binary: string, pathVar = mergedPath(process.env.PATH)): string | undefined {
  for (const dir of pathVar.split(":")) {
    if (!dir) continue;
    const candidate = `${dir}/${binary}`;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(command: string, args: string[], options: { timeoutMs?: number; input?: string } = {}): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: options.timeoutMs ?? 30_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PATH: mergedPath(process.env.PATH) } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
  }
}

export interface TailscaleSelf {
  backendState: string;
  hostName: string;
  /** e.g. `jonathans-mbp.tail56cd97.ts.net` (no trailing dot). */
  dnsName: string;
  online: boolean;
  tailnet?: string;
  tailscaleIps: string[];
  /** True when the node's capabilities include Funnel. */
  funnelCapable?: boolean;
}

export function parseTailscaleStatus(json: unknown): TailscaleSelf | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const status = json as { BackendState?: string; Self?: { HostName?: string; DNSName?: string; Online?: boolean; TailscaleIPs?: string[]; CapMap?: Record<string, unknown> }; CurrentTailnet?: { Name?: string } };
  const self = status.Self;
  if (!self) return undefined;
  return {
    backendState: status.BackendState ?? "unknown",
    hostName: self.HostName ?? "",
    dnsName: (self.DNSName ?? "").replace(/\.$/, ""),
    online: Boolean(self.Online),
    tailnet: status.CurrentTailnet?.Name,
    tailscaleIps: self.TailscaleIPs ?? [],
    funnelCapable: self.CapMap ? Object.keys(self.CapMap).some((key) => key.includes("funnel")) : undefined,
  };
}

export async function tailscaleStatus(binary = findTailscale()): Promise<TailscaleSelf | undefined> {
  if (!binary) return undefined;
  const result = await run(binary, ["status", "--json"], { timeoutMs: 10_000 });
  if (result.code !== 0) return undefined;
  try {
    return parseTailscaleStatus(JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
}

export type ExposureMode = "funnel" | "serve";

export interface Exposure {
  /** Public (Funnel) or tailnet-only (Serve) HTTPS URL. */
  url: string;
  target: string;
  mode: ExposureMode;
  port: number;
  path: string;
}

/** Parses `tailscale serve|funnel status --json` (a ServeConfig) into the HTTPS listeners it describes. */
export function parseServeConfig(json: unknown): Exposure[] {
  if (typeof json !== "object" || json === null) return [];
  const config = json as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>; AllowFunnel?: Record<string, boolean> };
  const out: Exposure[] = [];
  for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
    const [host, portText] = hostPort.split(":");
    const port = Number(portText ?? 443);
    const funnel = Boolean(config.AllowFunnel?.[hostPort]);
    for (const [mount, handler] of Object.entries(web.Handlers ?? {})) {
      const target = handler.Proxy ?? handler.Path ?? handler.Text ?? "";
      const base = `https://${host}${port === 443 ? "" : `:${port}`}`;
      out.push({ url: `${base}${mount === "/" ? "" : mount}`, target, mode: funnel ? "funnel" : "serve", port, path: mount });
    }
  }
  return out;
}

export async function currentExposures(binary = findTailscale()): Promise<Exposure[]> {
  if (!binary) return [];
  const result = await run(binary, ["serve", "status", "--json"], { timeoutMs: 10_000 });
  if (result.code !== 0 || !result.stdout.trim()) return [];
  try {
    return parseServeConfig(JSON.parse(result.stdout));
  } catch {
    return [];
  }
}

export interface ExposeResult {
  ok: boolean;
  url?: string;
  output: string;
  /** Present when Tailscale asks a human to approve Funnel in the admin console. */
  approvalUrl?: string;
}

/**
 * `tailscale funnel --bg --yes <port>` (public internet) or `tailscale serve --bg --yes <port>`
 * (tailnet only). Both persist across reboots inside tailscaled's state.
 */
export async function enableExposure(mode: ExposureMode, localPort: number, binary = findTailscale()): Promise<ExposeResult> {
  if (!binary) return { ok: false, output: "tailscale CLI not found. Install Tailscale (https://tailscale.com/download) and sign in first." };
  const result = await run(binary, [mode, "--bg", "--yes", String(localPort)], { timeoutMs: 60_000 });
  const output = `${result.stdout}${result.stderr}`.trim();
  const approvalUrl = /https:\/\/login\.tailscale\.com\/\S+/.exec(output)?.[0];
  if (result.code !== 0) return { ok: false, output, approvalUrl };
  const exposures = await currentExposures(binary);
  const match = exposures.find((e) => e.target.endsWith(`:${localPort}`) && e.path === "/") ?? exposures.find((e) => e.target.endsWith(`:${localPort}`));
  const urlFromOutput = /https:\/\/[\w.-]+\.ts\.net(?::\d+)?/.exec(output)?.[0];
  return { ok: true, url: match?.url ?? urlFromOutput, output, approvalUrl };
}

export async function disableExposure(mode: ExposureMode, port = 443, binary = findTailscale()): Promise<ExposeResult> {
  if (!binary) return { ok: false, output: "tailscale CLI not found" };
  const result = await run(binary, [mode, `--https=${port}`, "off"], { timeoutMs: 30_000 });
  const output = `${result.stdout}${result.stderr}`.trim();
  return { ok: result.code === 0, output };
}

export function tailnetUrl(self: TailscaleSelf | undefined): string | undefined {
  return self?.dnsName ? `https://${self.dnsName}` : undefined;
}
