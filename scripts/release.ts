// Keeps the version in package.json, package-lock.json, the plugin manifests and CHANGELOG.md in step.
//
//   npm run release -- --check              verify that they agree (runs in CI and in `npm run check`)
//   npm run release -- patch|minor|major    bump everything and move the "Unreleased" changelog entries under the new version
//   npm run release -- 1.2.3                set an explicit version (must be higher than the current one)
//   npm run release -- --notes [version]    print the changelog section of a version (the GitHub release body)
//   npm run release -- --version            print the current version
//
// Options: --root <dir> (default: the repository), --date YYYY-MM-DD (default: today, UTC),
//          --allow-empty (bump even when "Unreleased" has no entries).
//
// The script never touches git. After a bump: commit, open a pull request, merge. The Release workflow
// tags the merged version and the Publish workflow puts it on npm (see CONTRIBUTING.md → Releasing).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Files that carry the package version, relative to the repository root. */
export const VERSIONED_MANIFESTS = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json"];
export const CHANGELOG = "CHANGELOG.md";

export class ReleaseError extends Error {}

export interface ReleaseIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface Version {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(text: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (!match) throw new ReleaseError(`"${text}" is not a plain X.Y.Z version`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

export function bumpVersion(current: string, spec: string): string {
  const v = parseVersion(current);
  switch (spec) {
    case "major":
      return `${v.major + 1}.0.0`;
    case "minor":
      return `${v.major}.${v.minor + 1}.0`;
    case "patch":
      return `${v.major}.${v.minor}.${v.patch + 1}`;
    default: {
      const next = spec.replace(/^v/, "");
      parseVersion(next);
      if (compareVersions(next, current) <= 0) throw new ReleaseError(`${next} is not higher than the current version ${current}`);
      return next;
    }
  }
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rewrites the first `"version": "<current>"` after `from` in `text`; returns the new text and whether anything changed. */
function replaceVersionLine(text: string, current: string, next: string, from = 0): { text: string; changed: boolean } {
  const pattern = new RegExp(`("version"\\s*:\\s*")${escapeRegExp(current)}(")`);
  const head = text.slice(0, from);
  const tail = text.slice(from);
  if (!pattern.test(tail)) return { text, changed: false };
  return { text: head + tail.replace(pattern, `$1${next}$2`), changed: true };
}

export interface ChangelogSections {
  unreleased: { start: number; end: number; body: string } | undefined;
  versions: { version: string; heading: string; start: number; end: number; body: string }[];
}

/** Splits CHANGELOG.md on `## ` headings: an `Unreleased` section and `X.Y.Z (date)` sections, newest first. */
export function parseChangelog(text: string): ChangelogSections {
  const lines = text.split("\n");
  const headings: { index: number; title: string }[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith("## ")) headings.push({ index, title: line.slice(3).trim() });
  });
  const sections: ChangelogSections = { unreleased: undefined, versions: [] };
  headings.forEach((heading, i) => {
    const end = i + 1 < headings.length ? (headings[i + 1] as { index: number }).index : lines.length;
    const body = lines.slice(heading.index + 1, end).join("\n").trim();
    if (/^unreleased$/i.test(heading.title)) {
      if (!sections.unreleased) sections.unreleased = { start: heading.index, end, body };
      return;
    }
    const match = /^v?(\d+\.\d+\.\d+)\b/.exec(heading.title);
    if (match) sections.versions.push({ version: match[1] as string, heading: heading.title, start: heading.index, end, body });
  });
  return sections;
}

export function releaseNotes(root: string, version: string): string {
  const sections = parseChangelog(readFileSync(path.join(root, CHANGELOG), "utf8"));
  const section = sections.versions.find((s) => s.version === version);
  if (!section) throw new ReleaseError(`${CHANGELOG} has no "## ${version}" section`);
  if (!section.body) throw new ReleaseError(`${CHANGELOG} section "## ${section.heading}" is empty`);
  return section.body;
}

export function currentVersion(root: string): string {
  const version = readJson(path.join(root, "package.json")).version;
  if (typeof version !== "string") throw new ReleaseError("package.json has no version");
  return version;
}

/** Every place that states the version must agree, and the changelog must describe it. Returns the problems found. */
export function checkRelease(root: string): { version: string; problems: string[] } {
  const version = currentVersion(root);
  const problems: string[] = [];
  const lockFile = path.join(root, "package-lock.json");
  if (existsSync(lockFile)) {
    const lock = readJson(lockFile) as { version?: string; packages?: Record<string, { version?: string }> };
    if (lock.version !== version) problems.push(`package-lock.json version is ${lock.version ?? "missing"}, package.json says ${version}`);
    if (lock.packages?.[""]?.version !== version) problems.push(`package-lock.json packages[""].version is ${lock.packages?.[""]?.version ?? "missing"}, package.json says ${version}`);
  }
  for (const manifest of VERSIONED_MANIFESTS) {
    const file = path.join(root, manifest);
    if (!existsSync(file)) continue;
    const found = readJson(file).version;
    if (found !== version) problems.push(`${manifest} version is ${String(found ?? "missing")}, package.json says ${version}`);
  }
  const changelogFile = path.join(root, CHANGELOG);
  if (!existsSync(changelogFile)) problems.push(`${CHANGELOG} is missing`);
  else {
    const sections = parseChangelog(readFileSync(changelogFile, "utf8"));
    if (!sections.unreleased) problems.push(`${CHANGELOG} needs a "## Unreleased" section at the top`);
    const matching = sections.versions.filter((s) => s.version === version);
    if (matching.length === 0) problems.push(`${CHANGELOG} has no "## ${version}" section (run: npm run release -- ${version}, or write it)`);
    else if (matching.length > 1) problems.push(`${CHANGELOG} lists ${version} ${matching.length} times`);
    else if (!matching[0]?.body) problems.push(`${CHANGELOG} section "## ${matching[0]?.heading}" is empty`);
    if (sections.versions[0] && sections.versions[0].version !== version) problems.push(`${CHANGELOG} lists ${sections.versions[0].version} before ${version}; newest first`);
    if (sections.unreleased && sections.versions[0] && sections.unreleased.start > sections.versions[0].start) problems.push(`${CHANGELOG}: "## Unreleased" must come before the version sections`);
  }
  return { version, problems };
}

export interface BumpOptions {
  date?: string;
  allowEmpty?: boolean;
}

/** Applies the new version to every file and moves the Unreleased entries into a dated section. */
export function bumpRelease(root: string, spec: string, options: BumpOptions = {}): { previous: string; version: string; files: string[] } {
  const previous = currentVersion(root);
  const version = bumpVersion(previous, spec);
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ReleaseError(`--date must be YYYY-MM-DD, got ${date}`);

  // Changelog first: it is the one that can legitimately refuse.
  const changelogFile = path.join(root, CHANGELOG);
  if (!existsSync(changelogFile)) throw new ReleaseError(`${CHANGELOG} is missing`);
  const changelog = readFileSync(changelogFile, "utf8");
  const sections = parseChangelog(changelog);
  if (!sections.unreleased) throw new ReleaseError(`${CHANGELOG} needs a "## Unreleased" section to take the entries from`);
  if (sections.versions.some((s) => s.version === version)) throw new ReleaseError(`${CHANGELOG} already has a "## ${version}" section`);
  if (!sections.unreleased.body && !options.allowEmpty) throw new ReleaseError(`${CHANGELOG} has nothing under "## Unreleased"; describe the release there first (or pass --allow-empty)`);
  const lines = changelog.split("\n");
  const entries = sections.unreleased.body || "- Maintenance release.";
  const replaced = [...lines.slice(0, sections.unreleased.start), "## Unreleased", "", `## ${version} (${date})`, "", entries, "", ...lines.slice(sections.unreleased.end)];
  const nextChangelog = `${replaced.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;

  const writes: { file: string; text: string }[] = [{ file: changelogFile, text: nextChangelog }];
  const packageFile = path.join(root, "package.json");
  const pkg = replaceVersionLine(readFileSync(packageFile, "utf8"), previous, version);
  if (!pkg.changed) throw new ReleaseError(`package.json does not contain "version": "${previous}"`);
  writes.push({ file: packageFile, text: pkg.text });

  const lockFile = path.join(root, "package-lock.json");
  if (existsSync(lockFile)) {
    const lockText = readFileSync(lockFile, "utf8");
    const rootPart = replaceVersionLine(lockText, previous, version);
    const packagesAt = rootPart.text.indexOf('"packages": {');
    const both = packagesAt >= 0 ? replaceVersionLine(rootPart.text, previous, version, packagesAt) : rootPart;
    const check = JSON.parse(both.text) as { version?: string; packages?: Record<string, { version?: string }> };
    if (check.version !== version || (check.packages?.[""] && check.packages[""].version !== version)) throw new ReleaseError("package-lock.json could not be updated; run npm install and try again");
    writes.push({ file: lockFile, text: both.text });
  }
  for (const manifest of VERSIONED_MANIFESTS) {
    const file = path.join(root, manifest);
    if (!existsSync(file)) continue;
    const next = replaceVersionLine(readFileSync(file, "utf8"), previous, version);
    if (!next.changed) throw new ReleaseError(`${manifest} does not contain "version": "${previous}"`);
    writes.push({ file, text: next.text });
  }
  for (const write of writes) writeFileSync(write.file, write.text);
  return { previous, version, files: writes.map((w) => path.relative(root, w.file)) };
}

function usage(): string {
  return readFileSync(fileURLToPath(import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("//"))
    .map((line) => line.replace(/^\/\/ ?/, ""))
    .join("\n");
}

export function runRelease(argv: string[], io: ReleaseIO, defaultRoot: string): number {
  let root = defaultRoot;
  let date: string | undefined;
  let allowEmpty = false;
  const positional: string[] = [];
  let mode: "check" | "notes" | "version" | "bump" | "help" = "bump";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--root") root = path.resolve(argv[++i] ?? ".");
    else if (arg === "--date") date = argv[++i];
    else if (arg === "--allow-empty") allowEmpty = true;
    else if (arg === "--check") mode = "check";
    else if (arg === "--notes") mode = "notes";
    else if (arg === "--version") mode = "version";
    else if (arg === "--help" || arg === "-h") mode = "help";
    else if (arg.startsWith("-")) {
      io.stderr(`Unknown option ${arg}\n\n${usage()}\n`);
      return 2;
    } else positional.push(arg);
  }
  try {
    switch (mode) {
      case "help":
        io.stdout(`${usage()}\n`);
        return 0;
      case "version":
        io.stdout(`${currentVersion(root)}\n`);
        return 0;
      case "check": {
        const { version, problems } = checkRelease(root);
        if (problems.length) {
          io.stderr(`Release metadata for ${version} is inconsistent:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
          return 1;
        }
        io.stdout(`release metadata ok: ${version} in package.json, package-lock.json, ${VERSIONED_MANIFESTS.length} plugin manifests and ${CHANGELOG}\n`);
        return 0;
      }
      case "notes": {
        const version = positional[0]?.replace(/^v/, "") ?? currentVersion(root);
        io.stdout(`${releaseNotes(root, version)}\n`);
        return 0;
      }
      case "bump": {
        const spec = positional[0];
        if (!spec) {
          io.stderr(`${usage()}\n`);
          return 2;
        }
        const result = bumpRelease(root, spec, { date, allowEmpty });
        io.stdout(
          [
            `Bumped ${result.previous} → ${result.version} in ${result.files.join(", ")}.`,
            "",
            "Next:",
            `  git switch -c release/${result.version}`,
            `  git commit -am "Release ${result.version}" && git push -u origin HEAD`,
            "  Open a pull request. When it merges, the Release workflow tags the version and the Publish workflow puts it on npm.",
          ].join("\n") + "\n",
        );
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof ReleaseError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  process.exitCode = runRelease(process.argv.slice(2), { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) }, root);
}
