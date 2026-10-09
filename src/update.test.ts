import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireUpdateLock, AUTO_INSTALL_RETRY_MS, checkForUpdate, compareVersions, detectInstall, fetchLatestVersion, formatUpdateNotice, installedVersion, isNewerVersion, lastInstall, markInstallAnnounced, parseVersion, planUpdateNotice, readUpdateCache, recordInstall, refreshPlugins, registryUrl as registryUrlOf, releaseUpdateLock, runBackgroundUpdate, spawnBackgroundRefresh, updateCacheFile, updateChecksDisabled, updateStatusFromCache, UPDATE_CHECK_INTERVAL_MS, UPDATE_LOCK_STALE_MS, type InstallInfo } from "./update.js";
import type { ToolExecResult } from "./tools.js";
import { tempHome } from "./test-support/helpers.js";
import { VERSION } from "./version.js";

const NEWER = `${Number(VERSION.split(".")[0]) + 1}.0.0`;

/** A stand-in registry: answers `/@meterapp%2Fskillhook/latest` with whatever `latest` is at the time, or 404 when null. */
let registry: Server;
let registryUrl = "";
let latest: string | null = NEWER;
let hits = 0;

beforeAll(async () => {
  registry = createServer((req, res) => {
    hits++;
    if (req.url === "/@meterapp%2Fskillhook/latest" && latest) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "@meterapp/skillhook", version: latest }));
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
  await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", () => resolve()));
  const address = registry.address();
  registryUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => registry.close());

describe("versions", () => {
  it("parses and orders semantic versions", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion("v1.2.3-beta.2+build.7")?.prerelease).toEqual(["beta", 2]);
    expect(parseVersion("1.2")).toBeNull();
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.0-alpha", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
    expect(compareVersions("1.0.0-beta.11", "1.0.0-beta.2")).toBe(1);
    expect(compareVersions("garbage", "1.0.0")).toBe(-1);
    expect(isNewerVersion(NEWER)).toBe(true);
    expect(isNewerVersion(VERSION)).toBe(false);
    expect(isNewerVersion("0.0.1")).toBe(false);
  });
});

describe("policy", () => {
  it("honours the opt-outs", () => {
    expect(registryUrlOf({})).toBe("https://registry.npmjs.org");
    expect(registryUrlOf({ SKILLHOOK_NPM_REGISTRY: "https://mirror.example/npm///" })).toBe("https://mirror.example/npm");
    expect(updateChecksDisabled({})).toBe(false);
    expect(updateChecksDisabled({ SKILLHOOK_NO_UPDATE_CHECK: "1" })).toBe(true);
    expect(updateChecksDisabled({ NO_UPDATE_NOTIFIER: "true" })).toBe(true);
    expect(updateChecksDisabled({ CI: "true" })).toBe(true);
    expect(updateChecksDisabled({ CI: "false" })).toBe(false);
    expect(updateChecksDisabled({ CI: "0" })).toBe(false);
    expect(updateChecksDisabled({}, { update_check: false })).toBe(true);
  });

  it("guesses the install method from the module path", () => {
    const all = { exists: () => true, writable: () => true };
    // A global npm install is upgraded in its own prefix, with the npm beside the Node that runs skillhook.
    expect(detectInstall("/opt/homebrew/lib/node_modules/@meterapp/skillhook/dist/update.js", "latest", { ...all, platform: "darwin", execPath: "/opt/homebrew/bin/node" })).toEqual({
      method: "npm",
      command: ["/opt/homebrew/bin/node", "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js", "install", "-g", "--prefix", "/opt/homebrew", "@meterapp/skillhook@latest"],
      display: "npm install -g @meterapp/skillhook@latest",
    });
    const noNpmCli = { exists: (file: string) => !file.endsWith("npm-cli.js"), writable: () => false, platform: "linux" as const };
    expect(detectInstall("/usr/lib/node_modules/@meterapp/skillhook/dist/update.js", "2.0.0", noNpmCli)).toEqual({ method: "npm", command: ["npm", "install", "-g", "--prefix", "/usr", "@meterapp/skillhook@2.0.0"], display: "npm install -g @meterapp/skillhook@2.0.0", blocked: "/usr/lib/node_modules is not writable by this user" });
    expect(detectInstall("/Users/me/Library/pnpm/global/5/node_modules/@meterapp/skillhook/dist/update.js", "2.0.0", all).command).toEqual(["pnpm", "add", "-g", "@meterapp/skillhook@2.0.0"]);
    expect(detectInstall("/Users/me/.bun/install/global/node_modules/@meterapp/skillhook/dist/update.js", "latest", all).method).toBe("bun");
    expect(detectInstall("/Users/me/.config/yarn/global/node_modules/@meterapp/skillhook/dist/update.js", "latest", all).method).toBe("yarn");
    expect(detectInstall("/Users/me/.volta/tools/image/packages/@meterapp/skillhook/lib/node_modules/@meterapp/skillhook/dist/update.js", "latest", all).command).toEqual(["volta", "install", "@meterapp/skillhook@latest"]);
    expect(detectInstall("/Users/me/.npm/_npx/abc123/node_modules/@meterapp/skillhook/dist/update.js")).toEqual({ method: "npx", display: "npx @meterapp/skillhook@latest" });
    expect(detectInstall("/Users/me/dev/skillhook/dist/update.js").method).toBe("source");
    expect(detectInstall("/Users/me/app/node_modules/@meterapp/skillhook/dist/update.js", "latest", { ...all, exists: () => false })).toMatchObject({ method: "project" });
    expect(detectInstall("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@meterapp\\skillhook\\dist\\update.js", "latest", { ...all, platform: "win32", exists: (file) => file === "C:/Users/me/AppData/Roaming/npm/skillhook.cmd" })).toMatchObject({ method: "npm", command: ["npm", "install", "-g", "--prefix", "C:/Users/me/AppData/Roaming/npm", "@meterapp/skillhook@latest"] });
  });

  it("formats a notice with the matching upgrade command", () => {
    const status = { current: "0.1.0", latest: "0.2.0", available: true, checked_at: null, disabled: false, cached: true };
    const npm = formatUpdateNotice(status, detectInstall("/usr/lib/node_modules/@meterapp/skillhook/dist/update.js", "latest", { exists: () => true, writable: () => true, platform: "linux" }));
    expect(npm).toContain("0.1.0 → 0.2.0");
    expect(npm).toContain("skillhook update --install");
    expect(npm).toContain("npm install -g @meterapp/skillhook@latest");
    expect(npm).toContain("/releases/tag/v0.2.0");
    expect(formatUpdateNotice(status, detectInstall("/src/skillhook/dist/update.js"))).toContain("git pull");
  });
});

describe("registry lookup and cache", () => {
  it("fetches the latest dist-tag and tolerates failures", async () => {
    expect(await fetchLatestVersion({ registry: registryUrl })).toBe(NEWER);
    expect(await fetchLatestVersion({ registry: `${registryUrl}///` })).toBe(NEWER);
    const urls: string[] = [];
    const agents: (string | null)[] = [];
    const capture: typeof fetch = async (input, init) => {
      urls.push(String(input));
      agents.push(new Headers(init?.headers).get("user-agent"));
      return new Response(JSON.stringify({ version: "1.0.0" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    expect(await fetchLatestVersion({ registry: "https://mirror.example/npm/", name: "@meterapp/skill/hook", fetchImpl: capture })).toBe("1.0.0");
    expect(urls).toEqual(["https://mirror.example/npm/@meterapp%2Fskill%2Fhook/latest"]);
    expect(agents).toEqual([`skillhook/${VERSION} (update check)`]);
    expect(await fetchLatestVersion({ registry: registryUrl, name: "nope" })).toBeNull();
    expect(await fetchLatestVersion({ registry: "http://127.0.0.1:1", timeoutMs: 500 })).toBeNull();
    const bogus = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "not-a-version" }));
    });
    await new Promise<void>((resolve) => bogus.listen(0, "127.0.0.1", () => resolve()));
    const address = bogus.address();
    expect(await fetchLatestVersion({ registry: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}` })).toBeNull();
    bogus.close();
  });

  it("checks once per interval, writes the cache and serves it afterwards", async () => {
    const paths = tempHome();
    const env = { SKILLHOOK_NPM_REGISTRY: registryUrl };
    hits = 0;
    const first = await checkForUpdate(paths, { env, now: 1_000_000 });
    expect(first).toMatchObject({ current: VERSION, latest: NEWER, available: true, cached: false, disabled: false });
    expect(existsSync(updateCacheFile(paths))).toBe(true);
    expect(readUpdateCache(paths)).toEqual({ checked_at: new Date(1_000_000).toISOString(), latest: NEWER, current: VERSION });
    const second = await checkForUpdate(paths, { env, now: 1_000_000 + 60_000 });
    expect(second.cached).toBe(true);
    expect(second.latest).toBe(NEWER);
    expect(hits).toBe(1);
    const stale = await checkForUpdate(paths, { env, now: 1_000_000 + UPDATE_CHECK_INTERVAL_MS + 1 });
    expect(stale.cached).toBe(false);
    expect(hits).toBe(2);
    expect(updateStatusFromCache(paths).available).toBe(true);
    expect(planUpdateNotice(paths, { env, now: 1_000_000 + UPDATE_CHECK_INTERVAL_MS + 2 })).toMatchObject({ stale: false });
    expect(planUpdateNotice(paths, { env, now: 1_000_000 + UPDATE_CHECK_INTERVAL_MS + 2 }).notice).toContain(NEWER);
    expect(planUpdateNotice(paths, { env, now: 1_000_000 + 2 * UPDATE_CHECK_INTERVAL_MS + 5 }).stale).toBe(true);
    expect(planUpdateNotice(paths, { env: { ...env, CI: "1" } })).toEqual({ stale: false, refresh: false });
  });

  it("keeps the last known answer when the registry is unreachable, and is quiet when disabled", async () => {
    const paths = tempHome();
    await checkForUpdate(paths, { env: { SKILLHOOK_NPM_REGISTRY: registryUrl }, now: 5_000_000 });
    const offline = await checkForUpdate(paths, { env: { SKILLHOOK_NPM_REGISTRY: "http://127.0.0.1:1" }, force: true, timeoutMs: 500, now: 6_000_000 });
    expect(offline.latest).toBe(NEWER);
    expect(offline.cached).toBe(true);
    expect(readUpdateCache(paths)?.checked_at).toBe(new Date(6_000_000).toISOString());
    const disabled = await checkForUpdate(paths, { env: { SKILLHOOK_NPM_REGISTRY: registryUrl, SKILLHOOK_NO_UPDATE_CHECK: "1" } });
    expect(disabled).toMatchObject({ disabled: true, available: false, latest: null });
    const forced = await checkForUpdate(paths, { env: { SKILLHOOK_NPM_REGISTRY: registryUrl, SKILLHOOK_NO_UPDATE_CHECK: "1" }, force: true });
    expect(forced.latest).toBe(NEWER);
  });

  it("ignores a cache written by another version and an aborted lookup", async () => {
    const paths = tempHome();
    writeFileSync(updateCacheFile(paths), JSON.stringify({ checked_at: new Date().toISOString(), latest: "0.0.1", current: "0.0.0" }));
    expect(updateStatusFromCache(paths).checked_at).toBeNull();
    const controller = new AbortController();
    controller.abort();
    const aborted = await checkForUpdate(paths, { env: { SKILLHOOK_NPM_REGISTRY: registryUrl }, force: true, signal: controller.signal });
    expect(aborted.latest).toBeNull();
    expect(readUpdateCache(paths)?.current).toBe("0.0.0");
    const missingHome = tempHome();
    const noDir = path.join(missingHome.home, "nested-home");
    const status = await checkForUpdate({ ...missingHome, home: noDir }, { env: { SKILLHOOK_NPM_REGISTRY: registryUrl }, force: true });
    expect(status.latest).toBe(NEWER);
    expect(existsSync(path.join(noDir, "update-check.json"))).toBe(false);
  });

  it("refreshes the cache from a detached process", async () => {
    const paths = tempHome();
    const fakeCli = path.join(paths.home, "fake-cli.mjs");
    mkdirSync(path.dirname(fakeCli), { recursive: true });
    writeFileSync(fakeCli, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[5] + "/update-check.json", JSON.stringify({ argv: process.argv.slice(2) }));\n`);
    expect(spawnBackgroundRefresh(paths, {}, path.join(paths.home, "does-not-exist.js"))).toBe(false);
    expect(spawnBackgroundRefresh(paths, {}, fakeCli)).toBe(true);
    const deadline = Date.now() + 10_000;
    while (!existsSync(updateCacheFile(paths)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(readFileSync(updateCacheFile(paths), "utf8"))).toEqual({ argv: ["update", "--refresh", "--dir", paths.home] });
  });
});

describe("automatic updates", () => {
  const npm: InstallInfo = { method: "npm", command: ["npm", "install", "-g", `@meterapp/skillhook@${NEWER}`], display: `npm install -g @meterapp/skillhook@${NEWER}` };

  it("keeps the last install across checks and says once that it happened", async () => {
    const paths = tempHome();
    recordInstall(paths, { version: VERSION, from: "0.0.1", at: new Date(1_000).toISOString(), ok: true });
    await checkForUpdate(paths, { env: { SKILLHOOK_NPM_REGISTRY: registryUrl }, force: true, now: 2_000 });
    expect(readUpdateCache(paths)).toMatchObject({ latest: NEWER, last_install: { version: VERSION, from: "0.0.1", ok: true } });
    latest = VERSION;
    try {
      await checkForUpdate(paths, { env: { SKILLHOOK_NPM_REGISTRY: registryUrl }, force: true, now: 3_000 });
    } finally {
      latest = NEWER;
    }
    expect(planUpdateNotice(paths, { env: {}, now: 3_000, install: npm }).announce).toBe(`skillhook updated itself: 0.0.1 → ${VERSION}   (https://github.com/MeterApp/skillhook/releases/tag/v${VERSION})`);
    markInstallAnnounced(paths);
    expect(planUpdateNotice(paths, { env: {}, now: 3_000, install: npm }).announce).toBeUndefined();
  });

  it("installs a newer version in the background quietly, and only says what it cannot do itself", async () => {
    const paths = tempHome();
    const now = 10_000_000;
    await checkForUpdate(paths, { env: { SKILLHOOK_NPM_REGISTRY: registryUrl }, now });
    expect(planUpdateNotice(paths, { env: {}, now, install: npm })).toEqual({ stale: false, refresh: true });
    expect(planUpdateNotice(paths, { env: {}, now, install: npm, config: { auto_update: false } })).toMatchObject({ refresh: false, notice: expect.stringContaining(NEWER) });
    expect(planUpdateNotice(paths, { env: {}, now, install: { ...npm, blocked: "/usr/lib/node_modules is not writable by this user" } }).notice).toContain("not writable");
    expect(planUpdateNotice(paths, { env: {}, now, install: { method: "npx", display: "npx @meterapp/skillhook@latest" } })).toMatchObject({ refresh: false, notice: expect.stringContaining("npx @meterapp/skillhook@latest") });
    // A version that was tried is not tried again before the retry interval, and a failure is reported.
    recordInstall(paths, { version: NEWER, from: VERSION, at: new Date(now).toISOString(), ok: false, error: "npm exited with 1" });
    expect(planUpdateNotice(paths, { env: {}, now: now + 60_000, install: npm })).toMatchObject({ refresh: false, notice: expect.stringContaining("The automatic update failed (npm exited with 1)") });
    expect(planUpdateNotice(paths, { env: {}, now: now + AUTO_INSTALL_RETRY_MS, install: npm }).refresh).toBe(true);
  });

  it("runs the install from the background update and records it, one at a time", async () => {
    const paths = tempHome();
    const env = { SKILLHOOK_NPM_REGISTRY: registryUrl };
    const installs: InstallInfo[] = [];
    const install = async (target: InstallInfo) => {
      installs.push(target);
      return { code: 0 };
    };
    expect(await runBackgroundUpdate(paths, { env, now: 1_000, target: npm, install })).toMatchObject({ latest: NEWER, available: true });
    expect(installs).toEqual([npm]);
    expect(lastInstall(paths)).toEqual({ version: NEWER, from: VERSION, at: new Date(1_000).toISOString(), ok: true });
    // Tried already: not again until the retry interval.
    await runBackgroundUpdate(paths, { env, now: 2_000, target: npm, install });
    expect(installs).toHaveLength(1);
    // Off, offline, a copy it cannot replace, or another update holding the lock: a check at most, no install.
    const other = tempHome();
    await runBackgroundUpdate(other, { env, config: { auto_update: false }, target: npm, install });
    await runBackgroundUpdate(other, { env: { SKILLHOOK_NPM_REGISTRY: "http://127.0.0.1:1" }, timeoutMs: 500, target: npm, install });
    await runBackgroundUpdate(other, { env, target: { method: "source", display: "git pull && npm ci && npm run build" }, install });
    await runBackgroundUpdate(other, { env, target: { ...npm, blocked: "not writable" }, install });
    expect(installs).toHaveLength(1);
    expect(acquireUpdateLock(other)).toBe(true);
    expect(await runBackgroundUpdate(other, { env, target: npm, install })).toBeUndefined();
    releaseUpdateLock(other);
    // A failure is recorded with its reason.
    const failing = tempHome();
    await runBackgroundUpdate(failing, { env, target: npm, install: async () => ({ code: 1, error: "npm exited with 1" }) });
    expect(lastInstall(failing)).toMatchObject({ version: NEWER, ok: false, error: "npm exited with 1" });
  });

  it("breaks a lock left behind by a process that died", () => {
    const paths = tempHome();
    expect(acquireUpdateLock(paths)).toBe(true);
    expect(acquireUpdateLock(paths)).toBe(false);
    const old = new Date(Date.now() - UPDATE_LOCK_STALE_MS - 1_000);
    utimesSync(path.join(paths.home, "update.lock"), old, old);
    expect(acquireUpdateLock(paths)).toBe(true);
    releaseUpdateLock(paths);
  });

  it("reads the version installed on disk", () => {
    const paths = tempHome();
    const file = path.join(paths.home, "package.json");
    writeFileSync(file, JSON.stringify({ name: "@meterapp/skillhook", version: NEWER }));
    expect(installedVersion(file)).toBe(NEWER);
    writeFileSync(file, "{");
    expect(installedVersion(file)).toBeUndefined();
    expect(installedVersion()).toBe(VERSION);
  });
});

describe("plugin updates", () => {
  const result = (stdout: string, code = 0): ToolExecResult => ({ code, stdout, stderr: "", timedOut: false });
  const CLAUDE_LIST = JSON.stringify([
    { id: "supabase@claude-plugins-official", version: "0.1.15", scope: "user", enabled: true },
    { id: "skillhook@meterapp-skillhook", version: "0.7.1", scope: "user", enabled: true },
  ]);
  const CODEX_LIST = "Marketplace `meterapp-skillhook`\n\nPLUGIN                        STATUS              VERSION  SOURCE\nskillhook@meterapp-skillhook  installed, enabled  0.7.1    /Users/me/.codex/.tmp/marketplaces/meterapp-skillhook\n";
  const env = { PATH: "/usr/bin" };

  it("refreshes the marketplace, then the plugin, wherever Claude Code and Codex have it", async () => {
    const calls: string[] = [];
    const answers: Record<string, ToolExecResult> = {
      "plugin list --json": result(CLAUDE_LIST),
      "plugin marketplace update meterapp-skillhook --json": result(""),
      "plugin update skillhook@meterapp-skillhook --json --scope user": result('{"command":"update","outcome":"updated","message":"Updated skillhook to 0.8.0"}\n'),
      "plugin list": result(CODEX_LIST),
      "plugin marketplace upgrade meterapp-skillhook": result("Upgraded marketplace `meterapp-skillhook`\n"),
    };
    const exec = async (command: string, args: string[]) => {
      calls.push(`${path.basename(command)} ${args.join(" ")}`);
      return answers[args.join(" ")] ?? result("", 1);
    };
    expect(await refreshPlugins({ claude: process.execPath, codex: process.execPath, env, exec })).toEqual([
      { host: "Claude Code", id: "skillhook@meterapp-skillhook", ok: true, detail: "Updated skillhook to 0.8.0" },
      { host: "Codex", id: "skillhook@meterapp-skillhook", ok: true, detail: "Upgraded marketplace `meterapp-skillhook`" },
    ]);
    const node = path.basename(process.execPath);
    expect(calls).toEqual([`${node} plugin list --json`, `${node} plugin marketplace update meterapp-skillhook --json`, `${node} plugin update skillhook@meterapp-skillhook --json --scope user`, `${node} plugin list`, `${node} plugin marketplace upgrade meterapp-skillhook`]);
  });

  it("skips a host that is missing or lacks the plugin, and reports a marketplace that failed", async () => {
    expect(await refreshPlugins({ claude: "/nonexistent/claude", codex: "/nonexistent/codex", env, exec: async () => result("", 1) })).toEqual([]);
    const exec = async (_command: string, args: string[]) => (args.join(" ") === "plugin list --json" ? result(CLAUDE_LIST) : args.join(" ").startsWith("plugin marketplace update") ? result('{"outcome":"failed","message":"could not fetch MeterApp/skillhook"}\n', 1) : result("", 1));
    expect(await refreshPlugins({ claude: process.execPath, codex: process.execPath, env, exec })).toEqual([{ host: "Claude Code", id: "skillhook@meterapp-skillhook", ok: false, detail: "marketplace meterapp-skillhook: could not fetch MeterApp/skillhook" }]);
  });
});
