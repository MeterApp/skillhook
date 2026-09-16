import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Paths } from "./paths.js";
import { isDirectory, readJsonFileOr, writeJsonFile } from "./util.js";
import { PACKAGE, VERSION } from "./version.js";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CACHE_FILENAME = "update-check.json";
export const RELEASES_URL = "https://github.com/MeterApp/skillhook/releases";

/** `<home>/update-check.json`: what the registry said last time, so most commands never wait for the network. */
export interface UpdateCache {
  checked_at: string;
  latest: string | null;
  /** The version that ran the check; a cache written by another version is ignored. */
  current: string;
}

export interface UpdateStatus {
  current: string;
  /** Newest version on the registry, or null when unknown (never checked, offline, disabled). */
  latest: string | null;
  available: boolean;
  checked_at: string | null;
  /** The check was skipped because of the environment or `update_check: false`. */
  disabled: boolean;
  /** The answer comes from the cache file rather than a fresh request. */
  cached: boolean;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
}

export function parseVersion(text: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!match) return null;
  const prerelease = match[4] ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : [];
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

/** Semantic-version ordering; build metadata is ignored and unparseable strings sort lowest. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (const key of ["major", "minor", "patch"] as const) if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  if (pa.prerelease.length === 0 || pb.prerelease.length === 0) {
    if (pa.prerelease.length === pb.prerelease.length) return 0;
    return pa.prerelease.length ? -1 : 1; // a pre-release sorts before the release it precedes
  }
  const length = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < length; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1; // numeric identifiers rank below alphanumeric ones
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function isNewerVersion(candidate: string, current: string = VERSION): boolean {
  return compareVersions(candidate, current) > 0;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/** `SKILLHOOK_NO_UPDATE_CHECK=1`, the conventional `NO_UPDATE_NOTIFIER=1`, `CI`, or `"update_check": false` in skillhook.json. */
export function updateChecksDisabled(env: NodeJS.ProcessEnv = process.env, config?: { update_check?: boolean }): boolean {
  if (config?.update_check === false) return true;
  return truthy(env.SKILLHOOK_NO_UPDATE_CHECK) || truthy(env.NO_UPDATE_NOTIFIER) || truthy(env.CI);
}

/** `SKILLHOOK_NPM_REGISTRY` for mirrors and tests; otherwise the public registry. */
export function registryUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SKILLHOOK_NPM_REGISTRY?.trim() || DEFAULT_REGISTRY).replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Registry lookup and cache
// ---------------------------------------------------------------------------

export interface FetchLatestOptions {
  registry?: string;
  name?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** The registry's `latest` dist-tag, or null on any problem (offline, 404, timeout, garbage). Never throws. */
export async function fetchLatestVersion(options: FetchLatestOptions = {}): Promise<string | null> {
  const registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  const name = (options.name ?? PACKAGE.name).replace("/", "%2F");
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 3000), ...(options.signal ? [options.signal] : [])];
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${registry}/${name}/latest`, {
      headers: { accept: "application/json", "user-agent": `${PACKAGE.name}/${VERSION} (update check)` },
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" && parseVersion(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

export function updateCacheFile(paths: Paths): string {
  return path.join(paths.home, UPDATE_CACHE_FILENAME);
}

export function readUpdateCache(paths: Paths): UpdateCache | undefined {
  const cache = readJsonFileOr<Partial<UpdateCache> | undefined>(updateCacheFile(paths), undefined);
  if (!cache || typeof cache.checked_at !== "string" || Number.isNaN(Date.parse(cache.checked_at))) return undefined;
  return { checked_at: cache.checked_at, latest: typeof cache.latest === "string" ? cache.latest : null, current: typeof cache.current === "string" ? cache.current : "" };
}

function statusFrom(latest: string | null, checkedAt: string | null, cached: boolean, disabled = false): UpdateStatus {
  return { current: VERSION, latest, available: latest !== null && isNewerVersion(latest, VERSION), checked_at: checkedAt, disabled, cached };
}

function usableCache(paths: Paths): UpdateCache | undefined {
  const cache = readUpdateCache(paths);
  return cache && cache.current === VERSION ? cache : undefined;
}

/** What the last check found, without touching the network. */
export function updateStatusFromCache(paths: Paths): UpdateStatus {
  const cache = usableCache(paths);
  return cache ? statusFrom(cache.latest, cache.checked_at, true) : statusFrom(null, null, true);
}

export interface CheckForUpdateOptions {
  env?: NodeJS.ProcessEnv;
  config?: { update_check?: boolean };
  /** Ask the registry even when the cached answer is fresh or checks are disabled. */
  force?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: number;
}

/**
 * Cached for 24 hours in `<home>/update-check.json`. A lookup that fails keeps the previous answer and is not retried
 * before the next interval, so an offline machine does not pay for the check on every command.
 */
export async function checkForUpdate(paths: Paths, options: CheckForUpdateOptions = {}): Promise<UpdateStatus> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  if (!options.force && updateChecksDisabled(env, options.config)) return statusFrom(null, null, false, true);
  const cache = usableCache(paths);
  if (!options.force && cache && now - Date.parse(cache.checked_at) < UPDATE_CHECK_INTERVAL_MS) return statusFrom(cache.latest, cache.checked_at, true);
  const latest = await fetchLatestVersion({ registry: registryUrl(env), timeoutMs: options.timeoutMs, signal: options.signal, fetchImpl: options.fetchImpl });
  if (latest === null && options.signal?.aborted) return cache ? statusFrom(cache.latest, cache.checked_at, true) : statusFrom(null, null, true);
  const checkedAt = new Date(now).toISOString();
  const remembered = latest ?? cache?.latest ?? null;
  if (isDirectory(paths.home)) {
    try {
      writeJsonFile(updateCacheFile(paths), { checked_at: checkedAt, latest: remembered, current: VERSION } satisfies UpdateCache);
    } catch {
      /* read-only home: the check still answers */
    }
  }
  return statusFrom(remembered, checkedAt, latest === null && remembered !== null);
}

// ---------------------------------------------------------------------------
// Install method, notice, background refresh
// ---------------------------------------------------------------------------

export type InstallMethod = "npm" | "pnpm" | "yarn" | "bun" | "npx" | "source";

export interface InstallInfo {
  method: InstallMethod;
  /** argv that upgrades this install; absent when the user has to do it by hand (source checkout, npx cache). */
  command?: string[];
  /** The same as one line for humans. */
  display: string;
}

function thisModulePath(): string {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return "";
  }
}

/** Guesses how skillhook was installed from where this file lives, so the upgrade hint matches (npm, pnpm, bun, yarn, npx, git). */
export function detectInstall(modulePath: string = thisModulePath(), version = "latest"): InstallInfo {
  const p = modulePath.replace(/\\/g, "/");
  const spec = `${PACKAGE.name}@${version}`;
  if (!p.includes(`/node_modules/${PACKAGE.name}/`)) return { method: "source", display: "git pull && npm ci && npm run build" };
  if (p.includes("/_npx/")) return { method: "npx", display: `npx ${spec}` };
  if (p.includes("/pnpm/")) return { method: "pnpm", command: ["pnpm", "add", "-g", spec], display: `pnpm add -g ${spec}` };
  if (p.includes("/.bun/")) return { method: "bun", command: ["bun", "add", "-g", spec], display: `bun add -g ${spec}` };
  if (p.includes("/yarn/")) return { method: "yarn", command: ["yarn", "global", "add", spec], display: `yarn global add ${spec}` };
  return { method: "npm", command: ["npm", "install", "-g", spec], display: `npm install -g ${spec}` };
}

export function releaseNotesUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`;
}

/** Three lines for stderr: what is new, how to get it, where to read about it. */
export function formatUpdateNotice(status: UpdateStatus, install: InstallInfo = detectInstall()): string {
  const how = install.command ? `skillhook update --install   (or: ${install.display})` : install.display;
  return [`Update available: ${PACKAGE.name} ${status.current} → ${status.latest}`, `  ${how}`, `  ${releaseNotesUrl(status.latest ?? "")}`].join("\n");
}

/** For the end of a CLI command: the notice to print (when a newer version is already known) and whether the cache needs a refresh. */
export function planUpdateNotice(paths: Paths, options: { env?: NodeJS.ProcessEnv; config?: { update_check?: boolean }; now?: number } = {}): { notice?: string; stale: boolean } {
  if (updateChecksDisabled(options.env ?? process.env, options.config)) return { stale: false };
  const cache = usableCache(paths);
  const now = options.now ?? Date.now();
  const stale = !cache || now - Date.parse(cache.checked_at) >= UPDATE_CHECK_INTERVAL_MS;
  const status = cache ? statusFrom(cache.latest, cache.checked_at, true) : undefined;
  return { notice: status?.available ? formatUpdateNotice(status) : undefined, stale };
}

function defaultCliPath(): string | undefined {
  try {
    return fileURLToPath(new URL("./cli.js", import.meta.url));
  } catch {
    return undefined;
  }
}

/**
 * Refreshes the cache in a detached `skillhook update --refresh` process so the command that noticed the stale cache
 * does not wait for the registry. Returns false when there is nothing to run (source checkout) or nowhere to write.
 */
export function spawnBackgroundRefresh(paths: Paths, env: NodeJS.ProcessEnv = process.env, cliPath: string | undefined = defaultCliPath()): boolean {
  if (!cliPath || !existsSync(cliPath) || !isDirectory(paths.home)) return false;
  try {
    const child = spawn(process.execPath, [cliPath, "update", "--refresh", "--dir", paths.home], { detached: true, stdio: "ignore", env, windowsHide: true });
    child.on("error", () => {
      /* nothing to report: the next command tries again */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
