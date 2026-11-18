import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDefinition, collectDefinition, DEFINITION_LIMITS, DefinitionCache, definitionDigest, hookYaml, listDefinitionFiles, sha256Hex } from "./definitions.js";
import { SkillRegistry } from "./registry.js";
import { tempHome, writeSkill } from "./test-support/helpers.js";

const SKILL = "description: hashed\nskillhook:\n  runner: shell\n  shell:\n    command: [\"true\"]";

describe("skill definitions", () => {
  it("hashes the same files alike wherever they sit, and sorts them", () => {
    const a = tempHome();
    const b = tempHome();
    for (const paths of [a, b]) {
      const dir = writeSkill(paths, "same", SKILL);
      mkdirSync(path.join(dir, "references"));
      writeFileSync(path.join(dir, "references", "notes.md"), "# notes\n");
      writeFileSync(path.join(dir, "a.txt"), "a");
    }
    const first = collectDefinition(new SkillRegistry(a.skillsDir).get("same")!)!;
    const second = collectDefinition(new SkillRegistry(b.skillsDir).get("same")!)!;
    expect(first.sha256).toBe(second.sha256);
    expect(first.kind).toBe("skill");
    expect(first.files.map((f) => f.path)).toEqual(["SKILL.md", "a.txt", "references/notes.md"]);
    expect(first.files[1]).toEqual({ path: "a.txt", sha256: sha256Hex("a"), bytes: 1, text: "a" });
    expect(first.bytes).toBe(first.files.reduce((sum, f) => sum + f.bytes, 0));
    // The digest covers the kind, the name and the (path, hash) pairs: a renamed file or another name is another definition.
    expect(definitionDigest("skill", "same", first.files)).toBe(first.sha256);
    expect(definitionDigest("skill", "other", first.files)).not.toBe(first.sha256);
    expect(definitionDigest("hook", "same", first.files)).not.toBe(first.sha256);
    expect(buildDefinition("skill", "same", { "SKILL.md": "x", "a.txt": "a" }).files.map((f) => f.path)).toEqual(["SKILL.md", "a.txt"]);
  });

  it("lists the text of UTF-8 files within the limits and only the hash of the rest", () => {
    const big = Buffer.alloc(DEFINITION_LIMITS.max_file_bytes + 1, 0x61);
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    const definition = buildDefinition("skill", "x", { "SKILL.md": "---\n", "big.txt": big, "logo.png": binary });
    expect(definition.files.find((f) => f.path === "big.txt")).toEqual({ path: "big.txt", sha256: sha256Hex(big), bytes: big.length, text_omitted: "too_large" });
    expect(definition.files.find((f) => f.path === "logo.png")).toEqual({ path: "logo.png", sha256: sha256Hex(binary), bytes: 4, text_omitted: "binary" });
    expect(definition.files.find((f) => f.path === "SKILL.md")?.text).toBe("---\n");
    expect(definition.bytes).toBe(4 + big.length + 4);
    // The total cap: once it is reached, later files travel without text.
    const chunk = Buffer.alloc(DEFINITION_LIMITS.max_file_bytes, 0x62);
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.txt`, chunk]));
    const capped = buildDefinition("skill", "x", files);
    expect(capped.files.filter((f) => f.text !== undefined)).toHaveLength(DEFINITION_LIMITS.max_bytes / DEFINITION_LIMITS.max_file_bytes);
    expect(capped.files.filter((f) => f.text_omitted === "too_large")).toHaveLength(6 - DEFINITION_LIMITS.max_bytes / DEFINITION_LIMITS.max_file_bytes);
  });

  it("skips dotfiles, node_modules and symlinks when listing a skill directory", () => {
    const paths = tempHome();
    const dir = writeSkill(paths, "tidy", SKILL);
    writeFileSync(path.join(dir, ".env"), "SECRET=x");
    mkdirSync(path.join(dir, ".git"));
    writeFileSync(path.join(dir, ".git", "HEAD"), "ref");
    mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), "x");
    mkdirSync(path.join(dir, "refs"));
    writeFileSync(path.join(dir, "refs", "one.md"), "1");
    symlinkSync(path.join(dir, "refs", "one.md"), path.join(dir, "refs", "link.md"));
    expect(listDefinitionFiles(dir)).toEqual(["SKILL.md", "refs/one.md"]);
    const definition = collectDefinition(new SkillRegistry(paths.skillsDir).get("tidy")!)!;
    expect(JSON.stringify(definition)).not.toContain("SECRET=x");
  });

  it("describes a hook by its own block (and its SKILL.md for a skill hook), unmoved by the other hooks of the file", () => {
    const paths = tempHome();
    const repo = path.join(paths.home, "repo");
    mkdirSync(path.join(repo, ".claude", "skills", "triage"), { recursive: true });
    writeFileSync(path.join(repo, ".claude", "skills", "triage", "SKILL.md"), "---\nname: triage\ndescription: Triage.\n---\nTriage it.\n");
    const yaml = (extra: string) => `claude:\n  config_dir: ~/.claude-acme\nhooks:\n  deploy:\n    run: ./deploy.sh\n  issue:\n    skill: .claude/skills/triage\n    model: sonnet\n${extra}`;
    writeFileSync(path.join(repo, "skillhook.yaml"), yaml(""));
    const registry = new SkillRegistry(paths.skillsDir, { projects: () => [repo] });
    const deploy = collectDefinition(registry.get("deploy")!)!;
    expect(deploy.kind).toBe("hook");
    expect(deploy.files.map((f) => f.path)).toEqual(["hook.yaml"]);
    expect(deploy.files[0]?.text).toBe("claude:\n  config_dir: ~/.claude-acme\nhooks:\n  deploy:\n    run: ./deploy.sh\n");
    const issue = collectDefinition(registry.get("issue")!)!;
    expect(issue.files.map((f) => f.path)).toEqual([".claude/skills/triage/SKILL.md", "hook.yaml"].sort());
    expect(issue.files.find((f) => f.path === "hook.yaml")?.text).toContain("model: sonnet");
    // Another hook changes: this one's definition does not.
    writeFileSync(path.join(repo, "skillhook.yaml"), yaml("  other:\n    prompt: Something else.\n"));
    utimesSync(path.join(repo, "skillhook.yaml"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(collectDefinition(registry.get("issue")!)!.sha256).toBe(issue.sha256);
    expect(collectDefinition(registry.get("deploy")!)!.sha256).toBe(deploy.sha256);
    expect(hookYaml("hooks: {}\n", "missing")).toBe("hooks:\n  missing: {}\n");
    // Hooks that are not valid YAML mappings still hash (the loader reports the error separately).
    expect(hookYaml("- a\n- b\n", "x")).toBe("hooks:\n  x: {}\n");
  });

  it("recomputes a summary only when a file of the definition changed", () => {
    const paths = tempHome();
    const dir = writeSkill(paths, "cached", SKILL);
    const registry = new SkillRegistry(paths.skillsDir);
    const cache = new DefinitionCache();
    const first = cache.summary(registry.get("cached")!)!;
    expect(first).toEqual({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/), kind: "skill", bytes: expect.any(Number), files: 1 });
    expect(cache.summary(registry.get("cached")!)).toBe(first); // the same object: nothing was read again
    writeFileSync(path.join(dir, "extra.md"), "more");
    const future = new Date(Date.now() + 5000);
    utimesSync(dir, future, future);
    const second = cache.summary(registry.get("cached")!)!;
    expect(second.files).toBe(2);
    expect(second.sha256).not.toBe(first.sha256);
    // The registry attaches the summary to every skill it serves and says so in change notices.
    const changes: { name: string; definition_sha256: string | null }[] = [];
    const watched = new SkillRegistry(paths.skillsDir, { onChange: (c) => changes.push({ name: c.name, definition_sha256: c.definition_sha256 }) });
    expect(watched.list().skills[0]?.definition?.sha256).toBe(second.sha256);
    writeFileSync(path.join(dir, "SKILL.md"), `---\nname: cached\n${SKILL}\n---\n\nchanged body\n`);
    utimesSync(path.join(dir, "SKILL.md"), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    const third = watched.get("cached")!;
    expect(changes).toEqual([{ name: "cached", definition_sha256: third.definition?.sha256 }]);
    expect(third.definition?.sha256).not.toBe(second.sha256);
  });
});
