import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRunningServer } from "./client.js";
import type { Paths } from "./paths.js";
import { restartService, serviceStatus } from "./service.js";
import { mergedPath } from "./runners/env.js";
import { run } from "./tailscale.js";
import { execTool, parseClaudePlugins, parseCodexPlugins, resolveCommand, type ToolExecResult } from "./tools.js";
import { isDirectory, isPlainObject, readJsonFileOr, trimTrailing, writeJsonFile } from "./util.js";
import { PACKAGE, VERSION } from "./version.js";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
/** How long the registry's answer stands; after that the next command asks again, in the background. */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const UPDATE_CACHE_FILENAME = "update-check.json";
export const UPDATE_LOCK_FILENAME = "update.lock";
/** In `<home>/logs`: the package manager's output from the last background install. */
export const UPDATE_LOG_FILENAME = "update.log";
export const RELEASES_URL = "https://github.com/MeterApp/skillhook/releases";
/** A background install of one version that failed is tried again after a day; `skillhook update --install` tries now. */
export const AUTO_INSTALL_RETRY_MS = 24 * 60 * 60 * 1000;
/** An update lock older than this was left by a process that died. */
export const UPDATE_LOCK_STALE_MS = 10 * 60 * 1000;
export const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** `<home>/update-check.json`: what the registry said last time, so most commands never wait for the network. */
export interface UpdateCache {
  checked_at: string;
  latest: string | null;
  /** The version that ran the check; a cache written by another version is ignored. */
  current: string;
  /** Kept across versions, so the version it installed can say so once. */
  last_install?: InstallRecord;
}

/** The last install skillhook ran itself: in the background (`auto_update`) or for `skillhook update --install`. */
export interface InstallRecord {
  version: string;
  /** The version that installed it. */
  from: string;
  at: string;
  ok: boolean;
  /** One line; the package manager's output is in `<home>/logs/update.log`. */
  error?: string;
  /** A person has been told (at a terminal, or by `update --install` itself). */
  announced?: boolean;
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

/** `"auto_update": false` in skillhook.json keeps the check and the notices but installs nothing by itself. */
export function autoUpdateEnabled(config?: { auto_update?: boolean }): boolean {
  return config?.auto_update !== false;
}

/** `SKILLHOOK_NPM_REGISTRY` for mirrors and tests; otherwise the public registry. */
export function registryUrl(env: NodeJS.ProcessEnv = process.env): string {
  return trimTrailing(env.SKILLHOOK_NPM_REGISTRY?.trim() || DEFAULT_REGISTRY, "/");
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
  const registry = trimTrailing(options.registry ?? DEFAULT_REGISTRY, "/");
  const name = (options.name ?? PACKAGE.name).replaceAll("/", "%2F"); // scoped packages: @scope%2Fname
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 3000), ...(options.signal ? [options.signal] : [])];
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${registry}/${name}/latest`, {
      headers: { accept: "application/json", "user-agent": `skillhook/${VERSION} (update check)` }, // a product token cannot contain the scope's "@" or "/"
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

function installRecord(value: unknown): InstallRecord | undefined {
  if (!isPlainObject(value) || typeof value.version !== "string" || typeof value.from !== "string" || typeof value.at !== "string" || typeof value.ok !== "boolean") return undefined;
  return { version: value.version, from: value.from, at: value.at, ok: value.ok, ...(typeof value.error === "string" ? { error: value.error } : {}), ...(value.announced === true ? { announced: true } : {}) };
}

export function readUpdateCache(paths: Paths): UpdateCache | undefined {
  const cache = readJsonFileOr<Partial<UpdateCache> | undefined>(updateCacheFile(paths), undefined);
  if (!cache || typeof cache.checked_at !== "string" || Number.isNaN(Date.parse(cache.checked_at))) return undefined;
  const record = installRecord(cache.last_install);
  return { checked_at: cache.checked_at, latest: typeof cache.latest === "string" ? cache.latest : null, current: typeof cache.current === "string" ? cache.current : "", ...(record ? { last_install: record } : {}) };
}

/** The last install skillhook ran itself, whichever version wrote the cache. */
export function lastInstall(paths: Paths): InstallRecord | undefined {
  return readUpdateCache(paths)?.last_install;
}

/** Records an install in the cache (merged: the registry's answer stays). */
export function recordInstall(paths: Paths, record: InstallRecord): void {
  if (!isDirectory(paths.home)) return;
  const cache = readUpdateCache(paths) ?? { checked_at: record.at, latest: record.version, current: VERSION };
  try {
    writeJsonFile(updateCacheFile(paths), { ...cache, last_install: record } satisfies UpdateCache);
  } catch {
    /* read-only home: nothing to remember */
  }
}

/** Marks the last install as told, so the "updated itself" line shows once. */
export function markInstallAnnounced(paths: Paths): void {
  const record = lastInstall(paths);
  if (record && !record.announced) recordInstall(paths, { ...record, announced: true });
}

/** True when the last install tried `version` recently enough that the background update should not try it again yet. */
export function attemptedRecently(record: InstallRecord | undefined, version: string, now = Date.now()): boolean {
  return Boolean(record && record.version === version && now - Date.parse(record.at) < AUTO_INSTALL_RETRY_MS);
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
    const record = lastInstall(paths);
    try {
      writeJsonFile(updateCacheFile(paths), { checked_at: checkedAt, latest: remembered, current: VERSION, ...(record ? { last_install: record } : {}) } satisfies UpdateCache);
    } catch {
      /* read-only home: the check still answers */
    }
  }
  return statusFrom(remembered, checkedAt, latest === null && remembered !== null);
}

// ---------------------------------------------------------------------------
// Install method, notice, background refresh
// ---------------------------------------------------------------------------

export type InstallMethod = "npm" | "pnpm" | "yarn" | "bun" | "volta" | "npx" | "project" | "source";

export interface InstallInfo {
  method: InstallMethod;
  /** argv that upgrades this install; absent when the user has to do it by hand (source checkout, npx cache, a project's dependency). */
  command?: string[];
  /** The same as one line for humans. */
  display: string;
  /** Why skillhook cannot run `command` itself: the global directory is not writable by this user. */
  blocked?: string;
}

export interface DetectInstallOptions {
  platform?: NodeJS.Platform;
  /** The Node binary running skillhook: the npm beside it installs into the same prefix. */
  execPath?: string;
  exists?: (file: string) => boolean;
  writable?: (dir: string) => boolean;
}

function thisModulePath(): string {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return "";
  }
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** npm's own entry point beside the Node binary, so an install needs no shell and lands where that Node's npm puts globals. */
function npmCliPath(execPath: string, platform: NodeJS.Platform, exists: (file: string) => boolean): string | undefined {
  const dir = path.posix.dirname(execPath.replace(/\\/g, "/"));
  const candidate = path.posix.normalize(platform === "win32" ? `${dir}/node_modules/npm/bin/npm-cli.js` : `${dir}/../lib/node_modules/npm/bin/npm-cli.js`);
  return exists(candidate) ? candidate : undefined;
}

/**
 * Guesses how skillhook was installed from where this file lives, so an upgrade goes through the same package manager
 * into the same place: a global npm install (`<prefix>/lib/node_modules`, `<prefix>/node_modules` on Windows, with the
 * `skillhook` command beside it; installed again with `--prefix`), pnpm, bun, yarn or Volta, an npx cache, a project's
 * dependency or a git checkout.
 */
export function detectInstall(modulePath: string = thisModulePath(), version = "latest", options: DetectInstallOptions = {}): InstallInfo {
  const p = modulePath.replace(/\\/g, "/");
  const spec = `${PACKAGE.name}@${version}`;
  const at = p.lastIndexOf(`/node_modules/${PACKAGE.name}/`);
  if (at < 0) return { method: "source", display: "git pull && npm ci && npm run build" };
  if (p.includes("/_npx/") || /\/dlx[-/]/.test(p)) return { method: "npx", display: `npx ${spec}` };
  const exists = options.exists ?? existsSync;
  const writable = options.writable ?? isWritable;
  const nodeModules = p.slice(0, at + "/node_modules".length);
  const blockedUnless = (dir: string) => (writable(dir) ? undefined : `${dir} is not writable by this user`);
  const managed = (method: InstallMethod, command: string[]): InstallInfo => {
    const blocked = blockedUnless(nodeModules);
    return { method, command, display: command.join(" "), ...(blocked ? { blocked } : {}) };
  };
  if (p.includes("/.volta/")) return managed("volta", ["volta", "install", spec]);
  if (p.includes("/pnpm/")) return managed("pnpm", ["pnpm", "add", "-g", spec]);
  if (p.includes("/.bun/")) return managed("bun", ["bun", "add", "-g", spec]);
  if (p.includes("/yarn/")) return managed("yarn", ["yarn", "global", "add", spec]);
  const platform = options.platform ?? process.platform;
  const parent = path.posix.dirname(nodeModules);
  const prefix = platform === "win32" ? parent : path.posix.basename(parent) === "lib" ? path.posix.dirname(parent) : undefined;
  const bin = prefix === undefined ? undefined : platform === "win32" ? `${prefix}/skillhook.cmd` : `${prefix}/bin/skillhook`;
  if (prefix === undefined || bin === undefined || !exists(bin)) return { method: "project", display: `npm install ${spec} in the project that depends on it` };
  const execPath = options.execPath ?? process.execPath;
  const npmCli = npmCliPath(execPath, platform, exists);
  const args = ["install", "-g", "--prefix", prefix, spec];
  const blocked = blockedUnless(nodeModules) ?? blockedUnless(path.posix.dirname(bin));
  return { method: "npm", command: npmCli ? [execPath, npmCli, ...args] : ["npm", ...args], display: `npm install -g ${spec}`, ...(blocked ? { blocked } : {}) };
}

export function releaseNotesUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`;
}

/** Three lines for stderr: what is new, how to get it, where to read about it. */
export function formatUpdateNotice(status: UpdateStatus, install: InstallInfo = detectInstall()): string {
  const how = install.blocked ? `${install.display}   (${install.blocked})` : install.command ? `skillhook update --install   (or: ${install.display})` : install.display;
  return [`Update available: ${PACKAGE.name} ${status.current} → ${status.latest}`, `  ${how}`, `  ${releaseNotesUrl(status.latest ?? "")}`].join("\n");
}

export interface ApplyUpdateOptions {
  env?: NodeJS.ProcessEnv;
  /** Run the package manager that installed skillhook (only when a newer version exists). */
  install?: boolean;
  /** After an install, restart the background service when it runs and has no jobs in progress (default true; the server's own route passes false). */
  restartService?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  runInstall?: (target: InstallInfo) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface ApplyUpdateResult {
  ok: boolean;
  current: string;
  latest: string | null;
  available: boolean;
  checked_at: string | null;
  registry: string;
  cached: boolean;
  install: { method: InstallInfo["method"]; command: string };
  release_notes: string | null;
  installed: boolean;
  service_restarted: boolean;
  service_note: string | null;
  /** Why nothing could be installed (the registry did not answer, a source checkout, the package manager failed). */
  error?: string;
}

/** The update check and, when asked, the upgrade: what `skillhook update`, `POST /update` and the MCP tool `check_update` share. */
export async function applyUpdate(paths: Paths, options: ApplyUpdateOptions = {}): Promise<ApplyUpdateResult> {
  const env = options.env ?? process.env;
  const registry = registryUrl(env);
  const status = await checkForUpdate(paths, { env, force: true, timeoutMs: options.timeoutMs ?? 8_000, fetchImpl: options.fetchImpl });
  const install = detectInstall();
  const result: ApplyUpdateResult = { ok: true, current: status.current, latest: status.latest, available: status.available, checked_at: status.checked_at, registry, cached: status.cached, install: { method: install.method, command: install.display }, release_notes: status.latest ? releaseNotesUrl(status.latest) : null, installed: false, service_restarted: false, service_note: null };
  if (status.latest === null) return { ...result, ok: false, error: `could not reach ${registry} to check for updates` };
  if (!options.install || !status.available) return result;
  const target = detectInstall(undefined, status.latest);
  if (!target.command) return { ...result, ok: false, error: `skillhook ${VERSION} runs from ${target.method === "npx" ? "the npx cache" : target.method === "project" ? "a project's node_modules" : "a source checkout"}; upgrade with: ${target.display}` };
  if (target.blocked) return { ...result, ok: false, error: `cannot upgrade here: ${target.blocked}; run ${target.display} as a user who can write there` };
  const runInstall = options.runInstall ?? ((t: InstallInfo) => run(t.command![0] as string, t.command!.slice(1), { timeoutMs: INSTALL_TIMEOUT_MS }));
  const output = await runInstall(target);
  recordInstall(paths, { version: status.latest, from: VERSION, at: new Date().toISOString(), ok: output.code === 0, ...(output.code === 0 ? {} : { error: `${target.display} exited with ${output.code}` }), announced: true });
  if (output.code !== 0) return { ...result, ok: false, error: `${target.display} failed (exit ${output.code}):\n${(output.stderr || output.stdout).trim()}` };
  result.installed = true;
  result.install = { method: target.method, command: target.display };
  // A running service keeps executing the old code until it restarts; do that only when no job would be interrupted.
  const service = await serviceStatus(paths);
  if (!service.running) return result;
  if (options.restartService === false) return { ...result, service_note: `The background service still runs ${VERSION}; it restarts itself onto ${status.latest} once no job is running when auto_update is on (otherwise: POST /control/restart, or skillhook service restart)` };
  const running = await findRunningServer(paths);
  const busy = running?.health.queue ? running.health.queue.running + running.health.queue.queued : 0;
  if (busy > 0) return { ...result, service_note: `The background service still runs ${VERSION} and has ${busy} job(s) in progress; it restarts itself once they finish when auto_update is on (or later: skillhook service restart)` };
  const restart = await restartService();
  return { ...result, service_restarted: restart.ok, service_note: restart.ok ? `Background service restarted; it now runs ${status.latest}.` : `Could not restart the background service (${restart.output}). Run: skillhook service restart` };
}

export interface UpdateNoticePlan {
  /** The cache is older than the interval. */
  stale: boolean;
  /** Start `skillhook update --refresh` in the background: the cache is stale, or a newer version waits to be installed. */
  refresh: boolean;
  /** At a terminal, after the command: a newer version skillhook will not install by itself (npx, a checkout, a project's copy, a directory this user cannot write, `auto_update: false`, a failed install). */
  notice?: string;
  /** At a terminal, once: the background update installed the version now running. */
  announce?: string;
}

/**
 * What a command does about updates, from the cache alone (no network): whether to start the background update, and
 * what to tell a person at a terminal afterwards. A newer version the background update installs needs no word until
 * it is the one running.
 */
export function planUpdateNotice(paths: Paths, options: { env?: NodeJS.ProcessEnv; config?: { update_check?: boolean; auto_update?: boolean }; now?: number; install?: InstallInfo } = {}): UpdateNoticePlan {
  if (updateChecksDisabled(options.env ?? process.env, options.config)) return { stale: false, refresh: false };
  const cache = usableCache(paths);
  const now = options.now ?? Date.now();
  const stale = !cache || now - Date.parse(cache.checked_at) >= UPDATE_CHECK_INTERVAL_MS;
  const status = cache ? statusFrom(cache.latest, cache.checked_at, true) : undefined;
  const record = lastInstall(paths);
  const announce = record?.ok && !record.announced && record.version === VERSION ? `skillhook updated itself: ${record.from} → ${record.version}   (${releaseNotesUrl(record.version)})` : undefined;
  if (!status?.available || !status.latest) return { stale, refresh: stale, ...(announce ? { announce } : {}) };
  const install = options.install ?? detectInstall(undefined, status.latest);
  const automatic = autoUpdateEnabled(options.config) && Boolean(install.command) && !install.blocked;
  const failed = record && !record.ok && record.version === status.latest ? record : undefined;
  const pending = automatic && !attemptedRecently(record, status.latest, now);
  const notice = !automatic || failed ? `${formatUpdateNotice(status, install)}${failed ? `\n  The automatic update failed (${failed.error ?? "see logs/update.log"}).` : ""}` : undefined;
  return { stale, refresh: stale || pending, ...(notice ? { notice } : {}), ...(announce ? { announce } : {}) };
}

function defaultCliPath(): string | undefined {
  try {
    return fileURLToPath(new URL("./cli.js", import.meta.url));
  } catch {
    return undefined;
  }
}

/**
 * Starts `skillhook update --refresh` detached: the registry check and, with `auto_update` on, the install (see
 * `runBackgroundUpdate`), so the command that asked never waits for either. Returns false when there is nothing to run
 * (source checkout) or nowhere to write.
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

// ---------------------------------------------------------------------------
// The background update
// ---------------------------------------------------------------------------

function lockFile(paths: Paths): string {
  return path.join(paths.home, UPDATE_LOCK_FILENAME);
}

/** One background update at a time: `<home>/update.lock`, created exclusively; a lock left by a process that died is broken. */
export function acquireUpdateLock(paths: Paths, now = Date.now()): boolean {
  if (!isDirectory(paths.home)) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lockFile(paths), "wx", 0o600));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        if (now - statSync(lockFile(paths)).mtimeMs < UPDATE_LOCK_STALE_MS) return false;
        unlinkSync(lockFile(paths));
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function releaseUpdateLock(paths: Paths): void {
  try {
    unlinkSync(lockFile(paths));
  } catch {
    /* already gone */
  }
}

/** Runs the install with its output in `logFile` (truncated each time); resolves with the exit code, never throws. */
export function runInstallLogged(target: InstallInfo, logFile: string, timeoutMs = INSTALL_TIMEOUT_MS): Promise<{ code: number; error?: string }> {
  const argv = target.command;
  if (!argv?.length) return Promise.resolve({ code: 1, error: `cannot upgrade this copy automatically: ${target.display}` });
  let fd: number | undefined;
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    fd = openSync(logFile, "w", 0o600);
    writeSync(fd, `${new Date().toISOString()} skillhook ${VERSION}: ${target.display}\n`);
  } catch {
    fd = undefined;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { code: number; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fd !== undefined) closeSync(fd);
      resolve(result);
    };
    const child = spawn(argv[0] as string, argv.slice(1), { stdio: fd === undefined ? "ignore" : ["ignore", fd, fd], env: { ...process.env, PATH: mergedPath(process.env.PATH) }, windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: 1, error: `${target.display} took longer than ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    child.on("error", (error) => finish({ code: 1, error: `could not start ${argv[0]}: ${error.message}` }));
    child.on("exit", (code, signal) => finish(code === 0 ? { code: 0 } : { code: code ?? 1, error: `${target.display} ${signal ? `stopped (${signal})` : `exited with ${code}`}` }));
  });
}

export interface BackgroundUpdateOptions {
  env?: NodeJS.ProcessEnv;
  /** skillhook.json as written (`update_check`, `auto_update`). */
  config?: { update_check?: boolean; auto_update?: boolean };
  now?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  target?: InstallInfo;
  install?: (target: InstallInfo) => Promise<{ code: number; error?: string }>;
}

/**
 * What `skillhook update --refresh` does (commands and `serve` start it detached): ask the registry and, with
 * `auto_update` on, install a newer version with the package manager that installed this one. The next command runs it;
 * the background service restarts itself onto it once no job is running (`serve`). Only a version the registry has
 * just named is installed, one update runs at a time, and a version that failed is tried again after a day.
 */
export async function runBackgroundUpdate(paths: Paths, options: BackgroundUpdateOptions = {}): Promise<UpdateStatus | undefined> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  if (!acquireUpdateLock(paths, now)) return undefined;
  try {
    const status = await checkForUpdate(paths, { env, force: true, timeoutMs: options.timeoutMs ?? 15_000, fetchImpl: options.fetchImpl, now });
    if (status.cached || !status.available || !status.latest) return status;
    if (updateChecksDisabled(env, options.config) || !autoUpdateEnabled(options.config) || attemptedRecently(lastInstall(paths), status.latest, now)) return status;
    // The `latest` dist-tag, not the number the registry sent: nothing that came over the network reaches the command
    // line. What was installed is read back from disk.
    const target = options.target ?? detectInstall(undefined, "latest");
    if (!target.command || target.blocked) return status;
    const outcome = await (options.install ?? ((t: InstallInfo) => runInstallLogged(t, path.join(paths.logsDir, UPDATE_LOG_FILENAME))))(target);
    const onDisk = installedVersion();
    const version = outcome.code === 0 && onDisk && isNewerVersion(onDisk, VERSION) ? onDisk : status.latest;
    recordInstall(paths, { version, from: VERSION, at: new Date(now).toISOString(), ok: outcome.code === 0, ...(outcome.error ? { error: outcome.error } : {}) });
    return status;
  } finally {
    releaseUpdateLock(paths);
  }
}

/** The version installed on disk now, which a running server may not be (it read its package.json when it started). */
export function installedVersion(file: string | URL = new URL("../package.json", import.meta.url)): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && parseVersion(pkg.version) ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The plugin, in Claude Code and Codex
// ---------------------------------------------------------------------------

export interface PluginRefresh {
  host: "Claude Code" | "Codex";
  /** `skillhook@<marketplace>` */
  id: string;
  ok: boolean;
  detail: string;
}

export interface RefreshPluginsOptions {
  /** The commands skillhook runs them with (`runners.claude.command`, `runners.codex.command`). */
  claude: string | string[];
  codex: string | string[];
  /** The environment to run them with; its PATH decides what is found. */
  env: Record<string, string>;
  plugin?: string;
  /** Injectable for tests. */
  exec?: (command: string, args: string[], timeoutMs: number) => Promise<ToolExecResult>;
}

function lastLine(text: string): string {
  return text.trim().split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";
}

/** The `message` of the one-line JSON result `claude plugin … --json` prints. */
function claudeMessage(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { message?: unknown };
      if (typeof parsed.message === "string") return parsed.message;
    } catch {
      /* not the result line */
    }
  }
  return undefined;
}

/**
 * What `skillhook update --install` does for the plugin: wherever Claude Code has it installed, refresh that
 * marketplace and update the plugin (`claude plugin marketplace update`, `claude plugin update`); wherever Codex has it,
 * refresh the marketplace snapshot (`codex plugin marketplace upgrade`). A host that is missing, or does not have the
 * plugin, is skipped without a word.
 */
export async function refreshPlugins(options: RefreshPluginsOptions): Promise<PluginRefresh[]> {
  const plugin = options.plugin ?? "skillhook";
  const results: PluginRefresh[] = [];
  const execFor = (configured: string | string[]) => {
    const resolved = resolveCommand(configured, options.env.PATH);
    if (!resolved.path) return undefined;
    return (args: string[], timeoutMs: number) => (options.exec ?? ((command, argv, ms) => execTool(command, argv, { env: options.env, timeoutMs: ms })))(resolved.path!, [...resolved.lead, ...args], timeoutMs);
  };

  const claude = execFor(options.claude);
  const listed = claude ? await claude(["plugin", "list", "--json"], 30_000) : undefined;
  if (claude && listed?.code === 0) {
    const installs = parseClaudePlugins(listed.stdout).filter((entry) => entry.id.split("@")[0] === plugin && entry.id.includes("@"));
    const failed = new Map<string, string>();
    for (const marketplace of new Set(installs.map((entry) => entry.id.split("@")[1] as string))) {
      const refreshed = await claude(["plugin", "marketplace", "update", marketplace, "--json"], 120_000);
      if (refreshed.code !== 0) failed.set(marketplace, claudeMessage(refreshed.stdout) ?? (lastLine(refreshed.stderr || refreshed.stdout) || `exit ${refreshed.code ?? "?"}`));
    }
    for (const entry of installs) {
      const marketplace = entry.id.split("@")[1] as string;
      const problem = failed.get(marketplace);
      if (problem) {
        results.push({ host: "Claude Code", id: entry.id, ok: false, detail: `marketplace ${marketplace}: ${problem}` });
        continue;
      }
      const updated = await claude(["plugin", "update", entry.id, "--json", ...(entry.scope ? ["--scope", entry.scope] : [])], 120_000);
      const detail = claudeMessage(updated.stdout) ?? (lastLine(updated.code === 0 ? updated.stdout : updated.stderr || updated.stdout) || (updated.code === 0 ? "up to date" : `exit ${updated.code ?? "?"}`));
      results.push({ host: "Claude Code", id: entry.id, ok: updated.code === 0, detail });
    }
  }

  const codex = execFor(options.codex);
  const codexList = codex ? await codex(["plugin", "list"], 30_000) : undefined;
  if (codex && codexList?.code === 0) {
    const marketplaces = new Set(parseCodexPlugins(codexList.stdout).filter((entry) => entry.name === plugin && entry.installed).map((entry) => entry.marketplace));
    for (const marketplace of marketplaces) {
      const upgraded = await codex(["plugin", "marketplace", "upgrade", marketplace], 120_000);
      const detail = lastLine(upgraded.code === 0 ? upgraded.stdout : upgraded.stderr || upgraded.stdout) || (upgraded.code === 0 ? "marketplace refreshed" : `exit ${upgraded.code ?? "?"}`);
      results.push({ host: "Codex", id: `${plugin}@${marketplace}`, ok: upgraded.code === 0, detail });
    }
  }
  return results;
}
