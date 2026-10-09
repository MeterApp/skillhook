// `skillhook cloud login` signing in with the browser, and the `skillhook_cloud_setup` tool of `skillhook mcp --cloud`
// doing the same for an agent: RFC 8628's device authorization grant against Skillhook Cloud. One request starts it
// (`POST /api/auth/device/code`): a device code that only this process holds, and a user code with the page to approve
// it on (`/activate`), which is opened in the person's browser. Then `POST /api/auth/device/token` with the device code
// every few seconds until the person approved the code there (or cancelled, or ten minutes passed): the answer is a new
// organisation API key, made by the cloud at that moment and handed over once. Nothing else goes with these requests:
// no key, no machine token, only the name this computer gives itself ("skillhook CLI on <hostname>"), which becomes the
// key's name on the dashboard. The key is then checked and kept like one given with `--key` (`keepApiKey`).
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { z } from "zod";
import { printable } from "../util.js";
import { CloudApiError } from "./api.js";
import { cloudDisabledByEnv, InsecureCloudUrlError, isSecureCloudUrl } from "./config.js";
import { CloudHttpError, cloudRequest } from "./http.js";

/** `POST /api/auth/device/code` (RFC 8628, section 3.2), parsed loosely: a newer cloud may say more. */
export const DeviceCodeSchema = z
  .object({
    device_code: z.string().min(1).max(512),
    user_code: z.string().min(1).max(64),
    verification_uri: z.string().min(1).max(2048),
    verification_uri_complete: z.string().min(1).max(2048).optional(),
    expires_in: z.number().positive(),
    interval: z.number().positive().optional(),
  })
  .loose();
export type DeviceCode = z.infer<typeof DeviceCodeSchema>;

/** `POST /api/auth/device/token` once the person approved (RFC 6749, section 5.1). */
const TokenSchema = z.object({ access_token: z.string().min(1), token_type: z.string().nullish(), scope: z.string().nullish() }).loose();

/** What the person needs to approve the sign-in: the page (with the code in it when the cloud gives one) and the code. */
export interface SignInPrompt {
  url: string;
  code: string;
  expiresInSeconds: number;
}

export interface BrowserLoginOptions {
  /** The cloud, already resolved; nothing is sent to it under `SKILLHOOK_NO_CLOUD` or in plain http (`env` says). */
  url: string;
  clientName?: string;
  /** Told once the sign-in started: show the page and the code, open the browser. */
  onPrompt: (prompt: SignInPrompt) => void | Promise<void>;
  /** The kill switch, and plain http only where it is allowed (`SKILLHOOK_CLOUD_ALLOW_INSECURE`), for the cloud and its page. */
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The longest wait between two polls, after network trouble or `slow_down`. */
const MAX_INTERVAL_MS = 30_000;

/** "skillhook CLI on mac-mini": how the key is named on the dashboard, where the person revokes it. */
export function defaultClientName(): string {
  const host = hostname().replace(/\.local$/, "") || "this computer";
  return `skillhook CLI on ${host}`.slice(0, 80);
}

/**
 * Starts a sign-in at `options.url`, tells `onPrompt` what to show, and polls until the person decided. Resolves with the
 * new key; rejects with a `CloudApiError` whose code says why not: `unsupported` (a cloud from before browser sign-in),
 * `denied`, `expired`, or what the cloud answered. Network trouble, 5xx and 429 answers only make it wait longer.
 */
export async function browserLogin(options: BrowserLoginOptions): Promise<{ key: string; scope: string | null }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  if (cloudDisabledByEnv(options.env)) throw new CloudApiError("SKILLHOOK_NO_CLOUD is set: nothing goes to Skillhook Cloud from this environment. Unset it to log in.", undefined, "disabled");
  if (!isSecureCloudUrl(options.url, options.env)) throw new CloudApiError(new InsecureCloudUrlError(options.url).message, undefined, "insecure_url");
  let started;
  try {
    started = await cloudRequest(options.url, "/api/auth/device/code", { body: { client_name: options.clientName ?? defaultClientName() }, fetchImpl: options.fetchImpl, timeoutMs: 20_000 });
  } catch (error) {
    if (!(error instanceof CloudHttpError)) throw error;
    if (error.status === 404 || error.status === 405) throw new CloudApiError(`${options.url} does not offer signing in with the browser. Log in with a key from its dashboard (Settings → API keys) instead: skillhook cloud login --url ${options.url} --key`, error.status, "unsupported");
    if (error.status === 0) throw new CloudApiError(`Could not reach ${options.url} (${error.message}).`, 0, error.code);
    throw new CloudApiError(`${options.url} could not start a sign-in: ${error.code}: ${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`, error.status, error.code);
  }
  const parsed = DeviceCodeSchema.safeParse(started.body);
  if (!parsed.success) throw new CloudApiError(`${options.url} answered POST /api/auth/device/code with something this version does not understand`, started.status, "unsupported");
  const device = parsed.data;
  const page = device.verification_uri_complete ?? device.verification_uri;
  // The page is opened in a browser: only a web address, and only one as safe as the cloud's own would have to be.
  if (!isSecureCloudUrl(page, options.env) || printable(page) !== page || /\s/.test(page)) throw new CloudApiError(`${options.url} gave a sign-in page that is not an https address`, started.status, "unsupported");
  await options.onPrompt({ url: page, code: printable(device.user_code), expiresInSeconds: device.expires_in });

  const deadline = now() + device.expires_in * 1000;
  let interval = Math.max(1, device.interval ?? 5) * 1000;
  while (now() < deadline) {
    await sleep(interval);
    let answer;
    try {
      answer = await cloudRequest(options.url, "/api/auth/device/token", { body: { device_code: device.device_code }, fetchImpl: options.fetchImpl, timeoutMs: 20_000 });
    } catch (error) {
      if (!(error instanceof CloudHttpError)) throw error;
      if (error.code === "authorization_pending") continue;
      if (error.code === "slow_down") {
        interval = Math.min(interval + 5_000, MAX_INTERVAL_MS);
        continue;
      }
      if (error.code === "access_denied") throw new CloudApiError(`The sign-in was not approved: ${error.message}`, error.status, "denied");
      if (error.code === "expired_token") throw new CloudApiError("The code expired before it was approved. Run skillhook cloud login again.", error.status, "expired");
      if (error.code === "invalid_grant") throw new CloudApiError("The cloud knows this sign-in no longer (it was used already). Run skillhook cloud login again.", error.status, "expired");
      if (error.status === 0 || error.status === 429 || error.status >= 500) {
        interval = Math.min(interval * 2, MAX_INTERVAL_MS);
        continue;
      }
      throw new CloudApiError(`${options.url} refused the sign-in: ${error.code}: ${error.message}`, error.status, error.code);
    }
    const token = TokenSchema.safeParse(answer.body);
    if (!token.success) throw new CloudApiError(`${options.url} answered the sign-in with something this version does not understand`, answer.status, "unsupported");
    return { key: token.data.access_token.trim(), scope: token.data.scope ?? null };
  }
  throw new CloudApiError("The code expired before it was approved. Run skillhook cloud login again.", undefined, "expired");
}

/**
 * Opens `url` in the person's browser without waiting for it (argv, never a shell). Not over SSH, where it would open on
 * the far machine's screen or nowhere, nor on Linux without a display: false then, and the caller's printed link is the
 * way.
 */
export function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, run: typeof spawn = spawn): boolean {
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return false;
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform !== "darwin" && platform !== "win32" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const [command, args] = platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    const child = run(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
      // No opener on this system: the link is printed anyway.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
