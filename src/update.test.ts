import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkForUpdate, compareVersions, detectInstall, fetchLatestVersion, formatUpdateNotice, isNewerVersion, parseVersion, planUpdateNotice, readUpdateCache, registryUrl as registryUrlOf, spawnBackgroundRefresh, updateCacheFile, updateChecksDisabled, updateStatusFromCache, UPDATE_CHECK_INTERVAL_MS } from "./update.js";
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
    expect(detectInstall("/opt/homebrew/lib/node_modules/@meterapp/skillhook/dist/update.js")).toEqual({ method: "npm", command: ["npm", "install", "-g", "@meterapp/skillhook@latest"], display: "npm install -g @meterapp/skillhook@latest" });
    expect(detectInstall("/Users/me/Library/pnpm/global/5/node_modules/@meterapp/skillhook/dist/update.js", "2.0.0").command).toEqual(["pnpm", "add", "-g", "@meterapp/skillhook@2.0.0"]);
    expect(detectInstall("/Users/me/.bun/install/global/node_modules/@meterapp/skillhook/dist/update.js").method).toBe("bun");
    expect(detectInstall("/Users/me/.config/yarn/global/node_modules/@meterapp/skillhook/dist/update.js").method).toBe("yarn");
    expect(detectInstall("/Users/me/.npm/_npx/abc123/node_modules/@meterapp/skillhook/dist/update.js")).toEqual({ method: "npx", display: "npx @meterapp/skillhook@latest" });
    expect(detectInstall("/Users/me/dev/skillhook/dist/update.js").method).toBe("source");
    expect(detectInstall("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@meterapp\\skillhook\\dist\\update.js").method).toBe("npm");
  });

  it("formats a notice with the matching upgrade command", () => {
    const status = { current: "0.1.0", latest: "0.2.0", available: true, checked_at: null, disabled: false, cached: true };
    const npm = formatUpdateNotice(status, detectInstall("/usr/lib/node_modules/@meterapp/skillhook/dist/update.js"));
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
    expect(planUpdateNotice(paths, { env: { ...env, CI: "1" } })).toEqual({ stale: false });
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
