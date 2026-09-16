import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bumpRelease, bumpVersion, checkRelease, parseChangelog, releaseNotes, runRelease, VERSIONED_MANIFESTS } from "./release.js";

const CHANGELOG = `# Changelog

Intro text.

## Unreleased

- Something new.
- Something fixed.

## 0.1.0 (2026-09-16)

Initial release.

- Everything.
`;

function fakeRepo(changelog = CHANGELOG, version = "0.1.0"): string {
  const root = mkdtempSync(path.join(tmpdir(), "skillhook-release-"));
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "skillhook", version, dependencies: { zod: "^4.0.0" } }, null, 2)}\n`);
  writeFileSync(
    path.join(root, "package-lock.json"),
    `${JSON.stringify({ name: "skillhook", version, lockfileVersion: 3, packages: { "": { name: "skillhook", version, dependencies: { zod: "^4.0.0" } }, "node_modules/zod": { version, resolved: "x" } } }, null, 2)}\n`,
  );
  for (const manifest of VERSIONED_MANIFESTS) {
    mkdirSync(path.join(root, path.dirname(manifest)), { recursive: true });
    writeFileSync(path.join(root, manifest), `{\n  "name": "skillhook",\n  "version": "${version}",\n  "keywords": ["a", "b"]\n}\n`);
  }
  writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
  return root;
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }, out: () => out.join(""), err: () => err.join("") };
}

describe("release script", () => {
  it("bumps versions", () => {
    expect(bumpVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(bumpVersion("0.1.9", "minor")).toBe("0.2.0");
    expect(bumpVersion("0.1.0", "major")).toBe("1.0.0");
    expect(bumpVersion("0.1.0", "v0.3.0")).toBe("0.3.0");
    expect(() => bumpVersion("0.2.0", "0.1.5")).toThrow(/not higher/);
    expect(() => bumpVersion("0.2.0", "0.2")).toThrow(/X\.Y\.Z/);
  });

  it("parses the changelog and extracts release notes", () => {
    const sections = parseChangelog(CHANGELOG);
    expect(sections.unreleased?.body).toBe("- Something new.\n- Something fixed.");
    expect(sections.versions.map((s) => s.version)).toEqual(["0.1.0"]);
    const root = fakeRepo();
    expect(releaseNotes(root, "0.1.0")).toBe("Initial release.\n\n- Everything.");
    expect(() => releaseNotes(root, "0.9.0")).toThrow(/no "## 0.9.0"/);
  });

  it("passes the check when everything agrees and names each mismatch otherwise", () => {
    const root = fakeRepo();
    expect(checkRelease(root)).toEqual({ version: "0.1.0", problems: [] });
    writeFileSync(path.join(root, ".codex-plugin/plugin.json"), JSON.stringify({ name: "skillhook", version: "0.0.9" }));
    writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## 0.0.9 (2026-01-01)\n\n- old\n");
    const { problems } = checkRelease(root);
    expect(problems.some((p) => p.includes(".codex-plugin/plugin.json version is 0.0.9"))).toBe(true);
    expect(problems.some((p) => p.includes('"## Unreleased"'))).toBe(true);
    expect(problems.some((p) => p.includes('no "## 0.1.0" section'))).toBe(true);
    const r = io();
    expect(runRelease(["--check", "--root", root], r.io, "/nowhere")).toBe(1);
    expect(r.err()).toContain("inconsistent");
  });

  it("moves Unreleased entries under the new version and updates every file", () => {
    const root = fakeRepo();
    const result = bumpRelease(root, "minor", { date: "2026-10-01" });
    expect(result).toMatchObject({ previous: "0.1.0", version: "0.2.0" });
    expect(result.files).toEqual(["CHANGELOG.md", "package.json", "package-lock.json", ...VERSIONED_MANIFESTS]);
    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version).toBe("0.2.0");
    const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
    expect(lock.version).toBe("0.2.0");
    expect(lock.packages[""].version).toBe("0.2.0");
    expect(lock.packages["node_modules/zod"].version).toBe("0.1.0"); // an unrelated package with the same version string is untouched
    for (const manifest of VERSIONED_MANIFESTS) {
      const text = readFileSync(path.join(root, manifest), "utf8");
      expect(text).toContain('"version": "0.2.0"');
      expect(text).toContain('"keywords": ["a", "b"]'); // formatting preserved
    }
    const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("## Unreleased\n\n## 0.2.0 (2026-10-01)\n\n- Something new.\n- Something fixed.\n\n## 0.1.0 (2026-09-16)");
    expect(checkRelease(root).problems).toEqual([]);
    expect(releaseNotes(root, "0.2.0")).toBe("- Something new.\n- Something fixed.");
    expect(() => bumpRelease(root, "patch")).toThrow(/nothing under "## Unreleased"/);
    expect(bumpRelease(root, "patch", { allowEmpty: true, date: "2026-10-02" }).version).toBe("0.2.1");
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toContain("## 0.2.1 (2026-10-02)\n\n- Maintenance release.");
  });

  it("drives everything from the command line", () => {
    const root = fakeRepo();
    const v = io();
    expect(runRelease(["--version", "--root", root], v.io, "/nowhere")).toBe(0);
    expect(v.out().trim()).toBe("0.1.0");
    const notes = io();
    expect(runRelease(["--notes", "v0.1.0", "--root", root], notes.io, "/nowhere")).toBe(0);
    expect(notes.out()).toContain("Initial release.");
    const bump = io();
    expect(runRelease(["0.5.0", "--root", root, "--date", "2026-11-05"], bump.io, "/nowhere")).toBe(0);
    expect(bump.out()).toContain("Bumped 0.1.0 → 0.5.0");
    expect(bump.out()).toContain("release/0.5.0");
    const check = io();
    expect(runRelease(["--check", "--root", root], check.io, "/nowhere")).toBe(0);
    expect(check.out()).toContain("release metadata ok: 0.5.0");
    const bad = io();
    expect(runRelease(["--bogus"], bad.io, root)).toBe(2);
    const none = io();
    expect(runRelease(["--root", root], none.io, "/nowhere")).toBe(2);
    const help = io();
    expect(runRelease(["--help"], help.io, root)).toBe(0);
    expect(help.out()).toContain("npm run release -- --check");
  });
});
