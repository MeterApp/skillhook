import { Agent, setGlobalDispatcher } from "undici";

/**
 * Makes Node's built-in `fetch` speak HTTP/1.1 for the rest of the process, as it did on Node 22 (RA-020).
 *
 * Node 26's bundled undici offers `h2` in ALPN, so every HTTPS `fetch` (the cloud link, update checks, Sentry) ran
 * over a native HTTP/2 session; twice a daemon spun inside `Http2Session::SendPendingData` until macOS killed it.
 * Node documents a global dispatcher from the `undici` package as the way to configure the built-in `fetch`; with
 * `allowH2: false` it negotiates only `http/1.1`. Called by `src/cli.ts` before any command runs, so every command
 * behaves the same; the library entry (`src/index.ts`) leaves its host's dispatcher alone. When `NODE_USE_ENV_PROXY`
 * asked Node for its own proxy-aware dispatcher, that one is kept. `options` exists for tests (a CA to trust).
 */
export function useHttp1ForFetch(options: Agent.Options = {}): void {
  if (process.env.NODE_USE_ENV_PROXY === "1" || process.execArgv.includes("--use-env-proxy")) return;
  setGlobalDispatcher(new Agent({ ...options, allowH2: false }));
}
