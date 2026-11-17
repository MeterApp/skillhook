import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "./commands/main.js";
import type { CliIO } from "./commands/shared.js";
import { cloneDestination, cloneRemote, parseRemote } from "./project-clone.js";
import { tempHome } from "./test-support/helpers.js";

function captureIo() {
  const out: string[] = [];
  const cli: CliIO = { stdout: (t) => out.push(t), stderr: () => undefined, env: { PATH: process.env.PATH, HOME: process.env.HOME, SKILLHOOK_NO_UPDATE_CHECK: "1" }, isTTY: false };
  return { cli, json: () => JSON.parse(out.join("")) as Record<string, unknown> };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Skillhook Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A bare "remote" on disk with one commit on `branch`; `files` are written before it. */
function remote(root: string, name: string, files: Record<string, string>, branch = "main"): string {
  const origin = path.join(root, "remotes", "acme", `${name}.git`);
  const writer = path.join(root, "writers", name);
  mkdirSync(path.dirname(origin), { recursive: true });
  mkdirSync(path.dirname(writer), { recursive: true });
  git(root, "init", "--quiet", "--bare", "-b", branch, origin);
  git(root, "clone", "--quiet", origin, writer);
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(writer, file), content);
  git(writer, "add", "-A");
  git(writer, "commit", "--quiet", "-m", "first");
  git(writer, "push", "--quiet", "origin", `HEAD:${branch}`);
  return pathToFileURL(origin).href;
}

describe("parseRemote", () => {
  it("reads the remotes link clones and leaves paths alone", () => {
    expect(parseRemote("github:acme/api")).toEqual({ url: "https://github.com/acme/api.git", segments: ["acme", "api"] });
    expect(parseRemote("gh:acme/api.git")).toEqual({ url: "https://github.com/acme/api.git", segments: ["acme", "api"] });
    expect(parseRemote("https://gitlab.example.com/group/sub/tool.git")).toEqual({ url: "https://gitlab.example.com/group/sub/tool.git", segments: ["sub", "tool"] });
    expect(parseRemote("git@github.com:acme/api.git")).toEqual({ url: "git@github.com:acme/api.git", segments: ["acme", "api"] });
    expect(parseRemote("ssh://git@example.com/acme/api")).toEqual({ url: "ssh://git@example.com/acme/api", segments: ["acme", "api"] });
    for (const local of [".", "repo", "acme/api", "~/dev/repo", "/srv/repo", "./skillhook.yaml", "C:repo"]) expect(parseRemote(local)).toBeUndefined();
  });

  it("refuses a credential in the URL, an unencrypted transport and a path it cannot name", () => {
    expect(() => parseRemote("https://user:fake-token@github.com/acme/api.git")).toThrow(/credential/);
    expect(() => parseRemote("https://fake-token@github.com/acme/api.git")).toThrow(/credential/);
    expect(() => parseRemote("http://example.com/acme/api.git")).toThrow(/not http/);
    expect(() => parseRemote("git://example.com/acme/api.git")).toThrow(/not git/);
    expect(() => parseRemote("https://example.com/")).toThrow(/Cannot name/);
    expect(() => parseRemote("github:acme/..")).toThrow(/owner\/repo/);
    expect(() => parseRemote("https://example.com/acme/-rf.git")).toThrow(/Cannot name/);
  });

  it("puts a clone under <home>/repos unless told where", () => {
    const spec = parseRemote("github:acme/api")!;
    expect(cloneDestination("/h", spec)).toBe(path.join("/h", "repos", "acme", "api"));
    expect(cloneDestination("/h", spec, "/srv/api")).toBe("/srv/api");
  });
});

describe("skillhook link <remote>", () => {
  it("clones, links and keeps the checkout current; a second run changes nothing", async () => {
    const paths = tempHome();
    const home = realpathSync(paths.home);
    const url = remote(home, "api", { "skillhook.yaml": "hooks:\n  where:\n    run: pwd\n" });
    const dir = ["--dir", paths.home];
    const first = captureIo();
    expect(await main(["link", url, ...dir, "--json"], first.cli)).toBe(0);
    const checkout = path.join(home, "repos", "acme", "api");
    expect(first.json()).toMatchObject({ ok: true, remote: url, dir: checkout, cloned: true, branch: "main", linked: true, refresh: true, added: true });
    expect(existsSync(path.join(checkout, "skillhook.yaml"))).toBe(true);
    const config = JSON.parse(readFileSync(paths.configFile, "utf8"));
    expect(config.projects).toEqual([checkout]);
    expect(config.project_refresh).toEqual([checkout]);

    const again = captureIo();
    expect(await main(["link", url, ...dir, "--json"], again.cli)).toBe(0);
    expect(again.json()).toMatchObject({ cloned: false, added: false, refresh: true });
    expect(JSON.parse(readFileSync(paths.configFile, "utf8")).project_refresh).toEqual([checkout]);
  });

  it("links a default branch other than main without refreshing it, and honours --into and --no-refresh", async () => {
    const paths = tempHome();
    const home = realpathSync(paths.home);
    const dir = ["--dir", paths.home];
    const trunk = captureIo();
    expect(await main(["link", remote(home, "trunk", { "skillhook.yaml": "hooks:\n  where:\n    run: pwd\n" }, "trunk"), ...dir, "--json"], trunk.cli)).toBe(0);
    expect(trunk.json()).toMatchObject({ branch: "trunk", linked: true, refresh: false });
    const into = path.join(home, "elsewhere");
    const manual = captureIo();
    expect(await main(["link", remote(home, "manual", { "skillhook.yaml": "hooks:\n  there:\n    run: pwd\n" }), "--into", into, "--no-refresh", ...dir, "--json"], manual.cli)).toBe(0);
    expect(manual.json()).toMatchObject({ dir: into, linked: true, refresh: false });
    expect(JSON.parse(readFileSync(paths.configFile, "utf8")).project_refresh).toBeUndefined();
  });

  it("keeps a clone without skillhook.yaml and says how to start one; refuses a directory that holds something else", async () => {
    const paths = tempHome();
    const home = realpathSync(paths.home);
    const dir = ["--dir", paths.home];
    const url = remote(home, "plain", { "README.md": "hello\n" });
    const plain = captureIo();
    expect(await main(["link", url, ...dir, "--json"], plain.cli)).toBe(1);
    expect(plain.json()).toMatchObject({ ok: false, cloned: true, linked: false });
    expect(existsSync(paths.configFile)).toBe(false);

    const taken = path.join(home, "taken");
    mkdirSync(taken);
    writeFileSync(path.join(taken, "file"), "x");
    await expect(cloneRemote(parseRemote(url)!, taken)).rejects.toThrow(/not a Git checkout root/);
    await expect(cloneRemote(parseRemote(remote(home, "other", { a: "b" }))!, path.join(home, "repos", "acme", "plain"))).rejects.toThrow(/another remote/);
    await expect(cloneRemote(parseRemote(pathToFileURL(path.join(home, "missing.git")).href)!, path.join(home, "nowhere"))).rejects.toThrow(/git clone failed/);
    const bad = captureIo();
    expect(await main(["link", "https://user:fake-token@example.com/acme/api.git", ...dir, "--json"], bad.cli)).toBe(1);
    expect(JSON.stringify(bad.json())).not.toContain("fake-token");
  });
});
